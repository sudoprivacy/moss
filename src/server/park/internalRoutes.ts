import type http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { HttpError, writeJson } from '../httpRespond.js'
import type { AuthContext } from '../auth/token.js'
import type { AuthService } from '../auth/service.js'
import type { DocumentStore } from '../documentStore.js'
import { parkCompliance, parkLeadSummary, parkMonthlyReport, parkOverview } from './aggregates.js'
import { shanghaiMonth } from './statistics.js'
import { requestedStatisticsRange } from './statisticsPeriod.js'
import type { LeadStatus, ParkRole, ParkStore } from './store.js'
import type { BoxOperations } from './boxOperations.js'
import { getModelProviderApiKey } from '../modelListCache.js'
import { resolveModelSelection } from '../modelProviders.js'
import { publishParkPublicAssistant } from './publicAssistant.js'
import type { ManagedImageStore } from '../configuration/managedImageStore.js'
import { getParkWikiSources } from './wikiSources.js'
import { saveParkLogo } from './logoUpload.js'
import { validatePolicyUpload } from './policyUpload.js'
import { DEFAULT_REDACTION_SUMMARY_LENGTH } from './rules.js'
import { parkAuditContext, presentStoredParkAudit, recordParkAudit, type ParkAuditDetails } from './audit.js'

export { recordParkAudit, parkAuditContext } from './audit.js'

export interface InternalRouteDeps {
  store: ParkStore
  orgId: string | null
  authService: AuthService
  readBody: (req: http.IncomingMessage) => Promise<Record<string, unknown>>
  boxOperations?: BoxOperations
  documentStore?: DocumentStore
  managedImages?: ManagedImageStore
  /** Repo-bundled park-consultation-tools files, materialised into the org's skills on publish. */
  parkSkillEntries?: Promise<Array<{ path: string; contentBase64: string }>>
}

const ROLES: ParkRole[] = ['park_leader', 'park_recruiter', 'park_system_operator']
const STATUSES: LeadStatus[] = ['proposed', 'claimed', 'following_up', 'converted', 'invalid', 'closed']
const qrcode = createRequire(import.meta.url)('qrcode') as { toDataURL: (value: string, options: { width: number; margin: number }) => Promise<string> }

function str(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function requireRole(actual: ParkRole | null, expected: ParkRole): void {
  if (actual !== expected) throw new HttpError(403, 'Park role is required')
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Configuration must be an object')
  return value as Record<string, unknown>
}

function validateRateConfig(value: Record<string, unknown>): void {
  for (const key of ['message_max_length', 'session_message_max', 'session_token_budget', 'concurrent_max', 'box_per_minute', 'ip_per_minute', 'subnet_per_minute', 'sms_ip_per_minute', 'sms_box_per_minute', 'anonymous_session_max', 'anonymous_session_idle_minutes']) {
    const number = value[key]
    if (number !== undefined && (!Number.isSafeInteger(number) || Number(number) < 1 || Number(number) > 1_000_000)) throw new HttpError(400, `Invalid ${key}`)
  }
  if (value.captcha_enabled !== undefined && typeof value.captcha_enabled !== 'boolean') throw new HttpError(400, 'Invalid CAPTCHA setting')
  if (value.automated_traffic_detection !== undefined && typeof value.automated_traffic_detection !== 'boolean') throw new HttpError(400, 'Invalid automated traffic setting')
  if (value.captcha_enabled === true && (!process.env.PARK_CAPTCHA_HMAC_KEY || process.env.PARK_CAPTCHA_HMAC_KEY.length < 32)) throw new HttpError(400, 'CAPTCHA key is not configured')
  if (value.blacklist_ips !== undefined && (!Array.isArray(value.blacklist_ips) || value.blacklist_ips.length > 1000 || value.blacklist_ips.some(item => typeof item !== 'string' || item.length > 100))) throw new HttpError(400, 'Invalid blacklist')
}

function validateRedactionConfig(value: Record<string, unknown>): void {
  if (value.summary_max_length !== undefined && (!Number.isSafeInteger(value.summary_max_length) || Number(value.summary_max_length) < 100 || Number(value.summary_max_length) > 4000)) throw new HttpError(400, 'Invalid summary length')
  if (value.extra_terms !== undefined && (!Array.isArray(value.extra_terms) || value.extra_terms.length > 200 || value.extra_terms.some(item => typeof item !== 'string' || item.length < 2 || item.length > 100))) throw new HttpError(400, 'Invalid redaction terms')
}

function validateAssistantConfig(value: Record<string, unknown>, status: string): void {
  if (value.system_prompt !== undefined && (typeof value.system_prompt !== 'string' || value.system_prompt.length > 4000)) throw new HttpError(400, 'Invalid assistant prompt')
  if (status === 'published' && (typeof value.policy_wiki_id !== 'string' || !value.policy_wiki_id.trim())) throw new HttpError(400, 'Published assistant requires a policy wiki')
}

export async function handleInternalParkRoute(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, auth: AuthContext, deps: InternalRouteDeps): Promise<boolean> {
  const route = /^\/api\/v1\/parks\/([^/]+)(?:\/(.*))?$/.exec(pathname)
  if (!route) return false
  res.setHeader('Cache-Control', 'no-store')
  if (!deps.orgId) throw new HttpError(503, 'Park box is not configured')
  const parkId = route[1]!
  if (parkId !== deps.orgId || auth.orgId !== parkId) throw new HttpError(403, 'Park access denied')
  const suffix = route[2] ?? ''
  const context = parkAuditContext(req)
  const readBody = async () => {
    const body = await deps.readBody(req)
    const requested = body.file_name ?? body.name ?? body.question ?? body.label
    if (typeof requested === 'string') context.requestedName = str(requested, 300)
    return body
  }
  const role = await deps.store.role(parkId, auth.userId)
  const audit = async (status: number, details: ParkAuditDetails = {}) => {
    const actorName = await deps.authService.getUserName?.(auth.userId)
    await recordParkAudit(deps.store, parkId, pathname, req.method!, status, auth.userId, undefined, { ...context, ...details, actorName })
  }
  const presentLead = async (lead: Awaited<ReturnType<ParkStore['listLeads']>>[number]) => {
    const [session, contact] = await Promise.all([
      deps.store.session(parkId, lead.source_session_id),
      deps.store.contact(parkId, lead.id),
    ])
    return {
      ...lead,
      tags: JSON.parse(lead.tags_json),
      tags_json: undefined,
      source_channel: session?.source_channel ?? 'other',
      has_contact: Boolean(contact),
      display_name: contact ? '已留联线索' : '匿名潜在线索（待补充联系方式/待人工观察）',
    }
  }

  if (req.method === 'GET' && suffix === 'me') {
    writeJson(res, 200, { park_role: role })
    return true
  }
  if (req.method === 'PUT' && /^roles\/[^/]+$/.test(suffix)) {
    if (!['admin', 'super_admin'].includes(auth.role)) throw new HttpError(403, 'Organization administrator required')
    const targetId = suffix.split('/')[1]!
    const target = await deps.authService.getUserOrNull(targetId, parkId, auth)
    if (!target || target.status !== 'active') throw new HttpError(404, 'User is unavailable')
    Object.assign(context, { resourceId: targetId, objectName: target.displayName?.trim() || target.name })
    const body = await readBody()
    if (!ROLES.includes(body.park_role as ParkRole)) throw new HttpError(400, 'Invalid park role')
    await deps.store.grantRole(parkId, targetId, body.park_role as ParkRole, auth.userId)
    await audit(200, { resourceId: targetId, objectName: target.displayName?.trim() || target.name })
    writeJson(res, 200, { user_id: targetId, park_role: body.park_role })
    return true
  }

  if (suffix === 'metrics' && req.method === 'GET') {
    requireRole(role, 'park_leader')
    writeJson(res, 200, await parkOverview(deps.store, parkId, Date.now(), requestedStatisticsRange(req.url!)))
    return true
  }
  if (suffix === 'leads/summary' && req.method === 'GET') {
    requireRole(role, 'park_leader')
    writeJson(res, 200, await parkLeadSummary(deps.store, parkId, Date.now(), requestedStatisticsRange(req.url!)))
    return true
  }
  if (suffix === 'reports' && req.method === 'GET') {
    requireRole(role, 'park_leader')
    const month = new URL(req.url!, 'http://localhost').searchParams.get('month') ?? shanghaiMonth()
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > shanghaiMonth()) throw new HttpError(400, 'Invalid month')
    writeJson(res, 200, await parkMonthlyReport(deps.store, parkId, month))
    return true
  }
  if (suffix === 'compliance/summary' && req.method === 'GET') {
    requireRole(role, 'park_leader')
    writeJson(res, 200, await parkCompliance(deps.store, parkId, Date.now(), requestedStatisticsRange(req.url!)))
    return true
  }

  if (suffix === 'leads' && req.method === 'GET') {
    requireRole(role, 'park_recruiter')
    const status = new URL(req.url!, 'http://localhost').searchParams.get('status') ?? undefined
    if (status && !STATUSES.includes(status as LeadStatus)) throw new HttpError(400, 'Invalid lead status')
    const leads = await deps.store.listLeads(parkId, status)
    const data = await Promise.all(leads.map(presentLead))
    writeJson(res, 200, data)
    return true
  }
  if (suffix === 'follow-ups' && req.method === 'GET') {
    requireRole(role, 'park_recruiter')
    const rows = (await deps.store.listLeads(parkId)).filter(lead => lead.owner_id === auth.userId)
    writeJson(res, 200, await Promise.all(rows.map(presentLead)))
    return true
  }
  const leadRoute = /^leads\/([^/]+)(?:\/(claim|follow-ups))?$/.exec(suffix)
  if (leadRoute) {
    requireRole(role, 'park_recruiter')
    const leadId = leadRoute[1]!
    const lead = await deps.store.lead(parkId, leadId)
    if (!lead) throw new HttpError(404, 'Lead not found')
    Object.assign(context, { resourceId: leadId, objectName: `线索（${leadId}）` })
    if (req.method === 'GET' && !leadRoute[2]) {
      const [contact, followUps, inquiries] = await Promise.all([
        deps.store.contact(parkId, leadId), deps.store.followUps(parkId, leadId),
        deps.store.db.all('SELECT id, redacted_question, redacted_answer, intent, industry, scale, urgency, concerns_json, completion_status, extraction_status, extraction_version, created_at FROM park_inquiries WHERE org_id = ? AND session_id = ? ORDER BY created_at', [parkId, lead.source_session_id]),
      ])
      writeJson(res, 200, { ...lead, tags: JSON.parse(lead.tags_json), tags_json: undefined,
        contact: contact ?? null, follow_ups: followUps, inquiries })
      return true
    }
    if (req.method === 'POST' && leadRoute[2] === 'claim') {
      if (!(await deps.store.claimLead(parkId, leadId, auth.userId))) throw new HttpError(409, 'Lead is not awaiting claim')
      await audit(200, { resourceId: leadId, objectName: `线索（${leadId}）` })
      writeJson(res, 200, { status: 'claimed', owner_id: auth.userId })
      return true
    }
    if (req.method === 'POST' && leadRoute[2] === 'follow-ups') {
      if (lead.owner_id !== auth.userId) throw new HttpError(403, 'Lead must be claimed by the actor')
      const body = await readBody()
      const note = str(body.note, 2000)
      if (!note) throw new HttpError(400, 'Follow-up note is required')
      const id = await deps.store.addFollowUp(parkId, leadId, auth.userId, note, str(body.outcome, 80) || null)
      if (!id) throw new HttpError(409, 'Lead is not available for follow-up')
      await audit(201, { resourceId: leadId, objectName: `线索（${leadId}）` })
      writeJson(res, 201, { id, status: 'following_up' })
      return true
    }
    if (req.method === 'PATCH' && !leadRoute[2]) {
      if (lead.owner_id !== auth.userId) throw new HttpError(403, 'Lead must be claimed by the actor')
      const body = await readBody()
      const status = str(body.status) as LeadStatus
      if (!['converted', 'invalid', 'closed'].includes(status)) throw new HttpError(400, 'Invalid closing status')
      if (!(await deps.store.closeLead(parkId, leadId, auth.userId, status as 'converted' | 'invalid' | 'closed'))) throw new HttpError(409, 'Lead is not available for closing')
      await audit(200, { resourceId: leadId, objectName: `线索（${leadId}）` })
      writeJson(res, 200, { status })
      return true
    }
  }

  if (suffix.startsWith('admin/')) requireRole(role, 'park_system_operator')
  if (suffix === 'admin/config') {
    if (req.method === 'GET') { writeJson(res, 200, await deps.store.config(parkId)); return true }
    if (req.method === 'PUT') {
      const body = await readBody()
      if (body.service_catalog !== undefined && !Array.isArray(body.service_catalog)) throw new HttpError(400, 'Service catalog must be a list')
      let savedLogo: { filename: string; publicPath: string } | undefined
      if (body.logo_upload !== undefined) {
        savedLogo = await saveParkLogo(deps.managedImages, body.logo_upload)
      }
      let updated
      try {
        updated = await deps.store.putConfig(parkId, {
          display_name: str(body.display_name, 150),
          logo_url: savedLogo ? `/public/consult/logo/${savedLogo.filename}` : body.logo_url === undefined ? undefined : str(body.logo_url, 400) || null,
          welcome_text: str(body.welcome_text, 1000), park_profile: str(body.park_profile, 8000),
          service_catalog: JSON.stringify(body.service_catalog ?? []),
          service_catalog_version: str(body.service_catalog_version, 40) || '1',
          contact_enabled: body.contact_enabled === false ? 0 : 1,
          consent_text: str(body.consent_text, 2000),
        })
      } catch (error) {
        if (savedLogo) await deps.managedImages!.remove('park-logo', savedLogo.filename)
        throw error
      }
      await audit(200, { objectName: updated.display_name || '园区内容设置' })
      writeJson(res, 200, updated)
      return true
    }
  }
  // ---- Policy knowledge base (Document Center + wiki; replaces entry-based policies) ----
  const requireDocumentStore = (): DocumentStore => {
    if (!deps.documentStore) throw new HttpError(503, 'Document store is unavailable')
    return deps.documentStore
  }
  if (suffix === 'admin/policy/tree' && req.method === 'GET') {
    writeJson(res, 200, { nodes: await requireDocumentStore().listTree(parkId) }); return true
  }
  if (suffix === 'admin/policy/tree/nodes' && req.method === 'POST') {
    const documentStore = requireDocumentStore()
    const body = await readBody()
    const name = str(body.name, 120)
    if (!name) throw new HttpError(400, 'Node name is required')
    const parentId = body.parent_id === null ? null : str(body.parent_id, 100) || null
    if (parentId) {
      const parent = await documentStore.getNode(parentId, parkId)
      if (!parent) throw new HttpError(404, 'Parent node not found')
      if (parent.autoManaged) throw new HttpError(400, 'Parent node is managed by an external source')
    }
    let node
    try { node = await documentStore.createNode({ orgId: parkId, parentId, name }) }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Node creation failed') }
    await audit(200, { resourceId: node.id, objectName: node.name })
    writeJson(res, 200, node)
    return true
  }
  const policyDocs = /^admin\/policy\/nodes\/([^/]+)\/documents$/.exec(suffix)
  if (policyDocs && req.method === 'GET') {
    writeJson(res, 200, { documents: await requireDocumentStore().listDocumentsForNode(policyDocs[1]!, parkId) }); return true
  }
  if (policyDocs && req.method === 'POST') {
    const documentStore = requireDocumentStore()
    const body = await readBody()
    const fileName = str(body.file_name, 255)
    const mimeType = str(body.mime_type, 120) || 'application/octet-stream'
    const contentBase64 = typeof body.content_base64 === 'string' ? body.content_base64 : ''
    if (!fileName || !contentBase64) throw new HttpError(400, 'file_name and content_base64 are required')
    const content = Buffer.from(contentBase64, 'base64')
    const parent = await documentStore.getNode(policyDocs[1]!, parkId)
    if (!parent) throw new HttpError(404, 'Node not found')
    Object.assign(context, { parentId: parent.id, parentName: parent.name })
    await validatePolicyUpload(fileName, content)
    const document = await documentStore.uploadDocument({
      orgId: parkId, nodeId: policyDocs[1]!, fileName, mimeType, content, uploadedBy: auth.userId,
    })
    await audit(201, { resourceId: document.id, objectName: document.fileName })
    writeJson(res, 201, document); return true
  }
  const policyDocQuery = /^admin\/policy\/documents\/([^/]+)$/.exec(suffix)
  if (policyDocQuery && req.method === 'GET') {
    const documentStore = requireDocumentStore()
    const documentId = policyDocQuery[1]!
    const document = await documentStore.getDocument(documentId, parkId)
    if (!document) throw new HttpError(404, 'Document not found')
    Object.assign(context, { resourceId: document.id, objectName: document.fileName })
    const node = await documentStore.getNode(document.nodeId, parkId)
    writeJson(res, 200, { ...document, node_name: node?.name ?? '' })
    return true
  }
  const policyDocDelete = /^admin\/policy\/documents\/([^/]+)$/.exec(suffix)
  if (policyDocDelete && req.method === 'DELETE') {
    const documentStore = requireDocumentStore()
    const document = await documentStore.getDocument(policyDocDelete[1]!, parkId)
    if (!document) throw new HttpError(404, 'Document not found')
    Object.assign(context, { resourceId: document.id, objectName: document.fileName })
    const node = await documentStore.getNode(document.nodeId, parkId)
    await deps.store.rememberDocument(parkId, { id: document.id, fileName: document.fileName, nodeName: node?.name ?? '', sizeBytes: document.sizeBytes })
    await documentStore.deleteDocument(policyDocDelete[1]!, parkId)
    await audit(204, { resourceId: document.id, objectName: document.fileName })
    res.writeHead(204); res.end(); return true
  }
  if (suffix === 'admin/policy/wikis' && req.method === 'GET') {
    writeJson(res, 200, { wikis: await requireDocumentStore().listWikis(parkId) }); return true
  }
  if (suffix === 'admin/policy/wikis' && req.method === 'POST') {
    const documentStore = requireDocumentStore()
    const body = await readBody()
    const name = str(body.name, 150)
    const sourceDocumentIds = Array.isArray(body.source_document_ids)
      ? body.source_document_ids.filter((item): item is string => typeof item === 'string')
      : []
    if (!name || sourceDocumentIds.length === 0) throw new HttpError(400, 'Wiki name and source documents are required')
    for (const documentId of sourceDocumentIds) {
      if (!(await documentStore.getDocument(documentId, parkId))) throw new HttpError(404, `Document not found: ${documentId}`)
    }
    const wiki = await documentStore.createWiki({
      orgId: parkId, name, sourceDocumentIds, sourceMode: 'files', createdBy: auth.userId,
    })
    await audit(201, { resourceId: wiki.id, objectName: wiki.name })
    writeJson(res, 201, wiki); return true
  }
  const policyWiki = /^admin\/policy\/wikis\/([^/]+)$/.exec(suffix)
  if (policyWiki && req.method === 'PATCH') {
    const documentStore = requireDocumentStore()
    const body = await readBody()
    const wikiId = policyWiki[1]!
    const existing = await documentStore.getWiki(wikiId, parkId)
    if (!existing) throw new HttpError(404, 'Wiki not found')
    Object.assign(context, { resourceId: existing.id, objectName: existing.name })
    const sourceDocumentIds = Array.isArray(body.source_document_ids)
      ? body.source_document_ids.filter((item): item is string => typeof item === 'string')
      : undefined
    if (sourceDocumentIds) {
      if (sourceDocumentIds.length === 0) throw new HttpError(400, 'Wiki requires at least one source document')
      for (const documentId of sourceDocumentIds) {
        if (!(await documentStore.getDocument(documentId, parkId))) throw new HttpError(404, `Document not found: ${documentId}`)
      }
    }
    const updated = await documentStore.updateWiki(wikiId, parkId, {
      name: body.name !== undefined ? str(body.name, 150) || undefined : undefined,
      sourceDocumentIds, sourceMode: 'files',
    })
    await audit(200, { resourceId: wikiId, objectName: updated?.name })
    writeJson(res, 200, updated); return true
  }
  const policyWikiBuild = /^admin\/policy\/wikis\/([^/]+)\/build$/.exec(suffix)
  if (policyWikiBuild && req.method === 'POST') {
    const documentStore = requireDocumentStore()
    const wikiId = policyWikiBuild[1]!
    const wiki = await documentStore.getWiki(wikiId, parkId)
    if (!wiki) throw new HttpError(404, 'Wiki not found')
    Object.assign(context, { resourceId: wiki.id, objectName: wiki.name })
    const job = await documentStore.createBuildJob({ wikiId, triggeredBy: auth.userId })
    await documentStore.setWikiBuildResult(wikiId, { status: 'pending' })
    await audit(200, { resourceId: wiki.id, objectName: wiki.name })
    writeJson(res, 200, { job_id: job.id, wiki_id: wikiId }); return true
  }
  const policyWikiStatus = /^admin\/policy\/wikis\/([^/]+)\/build-status$/.exec(suffix)
  const policyWikiSources = /^admin\/policy\/wikis\/([^/]+)\/sources$/.exec(suffix)
  if (policyWikiSources && req.method === 'GET') {
    writeJson(res, 200, await getParkWikiSources(deps.store, requireDocumentStore(), parkId, policyWikiSources[1]!))
    return true
  }
  if (policyWikiStatus && req.method === 'GET') {
    const documentStore = requireDocumentStore()
    const wikiId = policyWikiStatus[1]!
    const wiki = await documentStore.getWiki(wikiId, parkId)
    if (!wiki) throw new HttpError(404, 'Wiki not found')
    const latestJob = await documentStore.getLatestBuildJob(wikiId)
    writeJson(res, 200, {
      wiki_build_status: wiki.buildStatus,
      last_built_at: wiki.lastBuiltAt,
      last_build_error: wiki.lastBuildError,
      latest_job: latestJob,
    }); return true
  }
  if (suffix === 'admin/quick-questions') {
    if (req.method === 'GET') { writeJson(res, 200, await deps.store.quickQuestions(parkId)); return true }
    if (req.method === 'POST') {
      const body = await readBody()
      const question = str(body.question, 300)
      if (!question) throw new HttpError(400, 'Question is required')
      const id = await deps.store.putQuickQuestion(parkId, { id: str(body.id, 100) || undefined,
        question, sortOrder: Number(body.sort_order) || 0, enabled: body.enabled !== false })
      await audit(200, { resourceId: id, objectName: question })
      writeJson(res, 200, { id }); return true
    }
  }
  const questionDelete = /^admin\/quick-questions\/([^/]+)$/.exec(suffix)
  if (questionDelete && req.method === 'DELETE') {
    const question = (await deps.store.quickQuestions(parkId)).find(row => row.id === questionDelete[1])
    if (question) Object.assign(context, { resourceId: question.id, objectName: question.question })
    if (!(await deps.store.deleteQuickQuestion(parkId, questionDelete[1]!))) throw new HttpError(404, 'Question not found')
    await audit(204, { resourceId: questionDelete[1], objectName: str(question?.question) || undefined })
    res.writeHead(204); res.end(); return true
  }
  if (suffix === 'admin/assistant' || suffix === 'admin/rate-limits' || suffix === 'admin/redaction') {
    const config = await deps.store.config(parkId)
    if (!config) throw new HttpError(404, 'Park configuration not found')
    const field = suffix === 'admin/assistant' ? 'assistant_config' : suffix === 'admin/rate-limits' ? 'rate_config' : 'redaction_config'
    if (req.method === 'GET') {
      const value = JSON.parse(config[field]) as Record<string, unknown>
      if (field === 'redaction_config') value.summary_max_length ??= DEFAULT_REDACTION_SUMMARY_LENGTH
      writeJson(res, 200, { value, ...(field === 'assistant_config' ? { status: config.assistant_status } : {}) }); return true
    }
    if (req.method === 'PUT') {
      const body = await readBody()
      const value = objectValue(body.value ?? {})
      const patch = { [field]: JSON.stringify(value) } as Record<typeof field, string> & { assistant_status?: string }
      if (field === 'assistant_config') {
        const status = str(body.status)
        if (!['draft', 'pending_review', 'published', 'disabled'].includes(status)) throw new HttpError(400, 'Invalid assistant status')
        validateAssistantConfig(value, status)
        if (status === 'published') {
          const settings = await deps.authService.getOrganizationSystemSettings(parkId)
          let selection: ReturnType<typeof resolveModelSelection>
          try {
            selection = resolveModelSelection(settings.modelProviders, settings.defaultModelProviderId, settings.model, settings.model)
          } catch { throw new HttpError(400, 'No model provider is configured') }
          if (selection.provider.protocol !== 'openai-completions') throw new HttpError(400, '园区模型服务协议不符合要求，需要 openai-completions。')
          if (!getModelProviderApiKey(selection.provider.id, settings.apiKey, parkId)) throw new HttpError(400, '未取得园区模型服务的可用凭据，请在组织模型设置中配置。')
          if (!deps.documentStore || !deps.parkSkillEntries) throw new HttpError(503, 'Policy knowledge base is unavailable')
          patch.assistant_config = JSON.stringify(await publishParkPublicAssistant(deps.store.db, parkId, value, {
            documentStore: deps.documentStore,
            skillEntries: await deps.parkSkillEntries,
          }))
        } else {
          const previous = JSON.parse(config.assistant_config || '{}') as Record<string, unknown>
          patch.assistant_config = JSON.stringify({ ...value, assistant_id: previous.assistant_id, policy_wiki_id: previous.policy_wiki_id })
        }
        patch.assistant_status = status
      } else if (field === 'rate_config') validateRateConfig(value)
      else validateRedactionConfig(value)
      await deps.store.putConfig(parkId, patch)
      await audit(200, field === 'assistant_config' ? {
        action: body.status === 'published' ? '发布咨询助手' : body.status === 'disabled' ? '下线咨询助手' : '保存咨询助手配置',
        resourceId: (JSON.parse(patch.assistant_config!) as { assistant_id?: string }).assistant_id,
        objectName: '园区公开咨询助手',
      } : {})
      writeJson(res, 200, { ok: true }); return true
    }
  }
  if (suffix === 'admin/public-links') {
    if (req.method === 'GET') {
      const links = await deps.store.db.all('SELECT * FROM park_public_links WHERE org_id = ? ORDER BY created_at', [parkId])
      writeJson(res, 200, { public_url: process.env.PARK_PUBLIC_URL ?? null, links }); return true
    }
    if (req.method === 'POST') {
      const body = await readBody()
      const channel = str(body.channel, 60); const label = str(body.label, 120)
      if (!/^[a-z0-9_-]{1,60}$/.test(channel) || !label) throw new HttpError(400, 'Invalid channel or label')
      const id = randomUUID()
      await deps.store.db.run(`INSERT INTO park_public_links (id, org_id, channel, label, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (org_id, channel) DO UPDATE SET label = excluded.label, enabled = excluded.enabled`,
      [id, parkId, channel, label, Number(body.enabled !== false), Date.now()])
      await audit(200, { resourceId: channel, objectName: `${label}（${channel}）` })
      writeJson(res, 200, { channel }); return true
    }
  }
  const linkDelete = /^admin\/public-links\/([^/]+)$/.exec(suffix)
  if (linkDelete && req.method === 'DELETE') {
    const link = await deps.store.db.get<{ label: string; channel: string }>('SELECT label, channel FROM park_public_links WHERE org_id = ? AND id = ?', [parkId, linkDelete[1]!])
    if (link) Object.assign(context, { resourceId: linkDelete[1], objectName: `${link.label}（${link.channel}）` })
    const result = await deps.store.deletePublicLink(parkId, linkDelete[1]!)
    if (result === 'missing') throw new HttpError(404, 'Public link not found')
    if (result === 'enabled') throw new HttpError(409, 'Disable the public link before deleting it')
    await audit(204, { resourceId: linkDelete[1], objectName: link ? `${link.label}（${link.channel}）` : undefined })
    res.writeHead(204); res.end(); return true
  }
  const linkQr = /^admin\/public-links\/([^/]+)\/qr$/.exec(suffix)
  if (linkQr && req.method === 'GET') {
    const publicUrl = process.env.PARK_PUBLIC_URL
    if (!publicUrl) throw new HttpError(503, 'Public URL is not configured')
    const channel = linkQr[1]!
    const link = await deps.store.db.get('SELECT channel FROM park_public_links WHERE org_id = ? AND channel = ? AND enabled = 1', [parkId, channel])
    if (!link) throw new HttpError(404, 'Public link not found')
    let url: URL
    try { url = new URL(publicUrl) } catch { throw new HttpError(503, 'Public URL is invalid') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(503, 'Public URL is invalid')
    url.searchParams.set('channel', channel)
    writeJson(res, 200, { data_url: await qrcode.toDataURL(url.toString(), { width: 512, margin: 2 }) })
    return true
  }
  if (suffix === 'admin/audit-events' && req.method === 'GET') {
    const rows = await deps.store.db.all<{ id: string; actor_user_id: string | null; actor_name: string | null; action: string; resource: string; resource_id: string | null; method: string; path: string; request_data_json: string | null; response_status: number; ip_address: string | null; created_at: number }>('SELECT id, actor_user_id, actor_name, action, resource, resource_id, method, path, request_data_json, response_status, ip_address, created_at FROM operation_audit_events WHERE org_id = ? ORDER BY created_at DESC LIMIT 200', [parkId])
    const names = new Map<string, string | undefined>()
    for (const row of rows) {
      if (!row.actor_name?.trim() && row.actor_user_id && !names.has(row.actor_user_id)) names.set(row.actor_user_id, await deps.authService.getUserName?.(row.actor_user_id))
    }
    writeJson(res, 200, await Promise.all(rows.map(async ({ request_data_json, ...row }) => ({
      ...row, actor_name: row.actor_name?.trim() || (row.actor_user_id ? names.get(row.actor_user_id) : undefined) || null,
      ...await presentStoredParkAudit(deps.store, parkId, { ...row, request_data_json }),
    })))); return true
  }
  if (suffix === 'admin/operations' && req.method === 'GET') {
    if (!deps.boxOperations) throw new HttpError(503, 'Box operations are unavailable')
    writeJson(res, 200, await deps.boxOperations.status()); return true
  }
  const taskRoute = /^admin\/operations\/tasks\/([a-f0-9-]+)$/.exec(suffix)
  if (taskRoute && req.method === 'GET') {
    if (!deps.boxOperations) throw new HttpError(503, 'Box operations are unavailable')
    writeJson(res, 200, await deps.boxOperations.task(taskRoute[1]!)); return true
  }
  const operation = /^admin\/operations\/(backup|restore|verify-upgrade|upgrade|rollback|reindex|model-check)$/.exec(suffix)
  if (operation && req.method === 'POST') {
    if (!deps.boxOperations) throw new HttpError(503, 'Box operations are unavailable')
    const body = await readBody()
    const name = str(body.name, 255)
    const action = operation[1]!
    if (deps.boxOperations.usesAgent) {
      const task = await deps.boxOperations.submit(action, parkId, auth.userId, str(body.request_id, 128), name)
      await audit(202, { objectName: name || '园区盒子' })
      writeJson(res, 202, task); return true
    }
    const result = action === 'backup' ? await deps.boxOperations.backup()
      : action === 'restore' ? await deps.boxOperations.restore(name)
      : action === 'verify-upgrade' ? await deps.boxOperations.verifyUpgrade(name)
      : action === 'upgrade' ? await deps.boxOperations.upgrade(name)
      : action === 'rollback' ? await deps.boxOperations.rollback()
      : await deps.boxOperations.reindex()
    await audit(200, { objectName: name || '园区盒子' })
    writeJson(res, 200, { result }); return true
  }
  return false
}
