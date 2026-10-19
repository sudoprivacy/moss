import type http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { HttpError, writeJson } from '../httpRespond.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import type { AuthContext } from '../auth/token.js'
import type { AuthService } from '../auth/service.js'
import { parkCompliance, parkLeadSummary, parkMonthlyReport, parkOverview } from './aggregates.js'
import type { LeadStatus, ParkRole, ParkStore } from './store.js'
import type { BoxOperations } from './boxOperations.js'
import { getModelProviderApiKey } from '../modelListCache.js'
import { resolveModelSelection } from '../modelProviders.js'

export interface InternalRouteDeps {
  store: ParkStore
  orgId: string | null
  authService: AuthService
  readBody: (req: http.IncomingMessage) => Promise<Record<string, unknown>>
  boxOperations?: BoxOperations
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
  for (const key of ['message_max_length', 'session_message_max', 'session_token_budget', 'concurrent_max', 'box_per_minute', 'ip_per_minute', 'subnet_per_minute']) {
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
  if (value.model !== undefined && (typeof value.model !== 'string' || value.model.length > 150)) throw new HttpError(400, 'Invalid model')
  if (value.temperature !== undefined && (typeof value.temperature !== 'number' || value.temperature < 0 || value.temperature > 2)) throw new HttpError(400, 'Invalid temperature')
  if (value.system_prompt !== undefined && (typeof value.system_prompt !== 'string' || value.system_prompt.length > 4000)) throw new HttpError(400, 'Invalid assistant prompt')
  if (status === 'published' && !String(value.model ?? '').trim()) throw new HttpError(400, 'Published assistant requires a model')
}

export async function recordParkAudit(store: ParkStore, orgId: string, pathname: string, method: string, status: number, actorId: string | null, message?: string): Promise<void> {
  const repository = new IdentityRepository(store.db)
  const id = randomUUID()
  await repository.insertOperationAudit({
    id, orgId, actorUserId: actorId, action: `park.${method.toLowerCase()}`,
    resource: 'park', resourceId: null, method, path: pathname,
    responseStatus: status, errorMessage: message ?? null, idempotencyKey: id,
  })
}

export async function handleInternalParkRoute(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, auth: AuthContext, deps: InternalRouteDeps): Promise<boolean> {
  const route = /^\/api\/v1\/parks\/([^/]+)(?:\/(.*))?$/.exec(pathname)
  if (!route) return false
  res.setHeader('Cache-Control', 'no-store')
  if (!deps.orgId) throw new HttpError(503, 'Park box is not configured')
  const parkId = route[1]!
  if (parkId !== deps.orgId || auth.orgId !== parkId) throw new HttpError(403, 'Park access denied')
  const suffix = route[2] ?? ''
  const role = await deps.store.role(parkId, auth.userId)
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
    const body = await deps.readBody(req)
    if (!ROLES.includes(body.park_role as ParkRole)) throw new HttpError(400, 'Invalid park role')
    await deps.store.grantRole(parkId, targetId, body.park_role as ParkRole, auth.userId)
    await recordParkAudit(deps.store, parkId, pathname, req.method, 200, auth.userId)
    writeJson(res, 200, { user_id: targetId, park_role: body.park_role })
    return true
  }

  if (suffix === 'metrics' && req.method === 'GET') {
    requireRole(role, 'park_leader')
    writeJson(res, 200, await parkOverview(deps.store, parkId))
    return true
  }
  if (suffix === 'leads/summary' && req.method === 'GET') {
    requireRole(role, 'park_leader')
    writeJson(res, 200, await parkLeadSummary(deps.store, parkId))
    return true
  }
  if (suffix === 'reports' && req.method === 'GET') {
    requireRole(role, 'park_leader')
    const month = new URL(req.url!, 'http://localhost').searchParams.get('month') ?? new Date().toISOString().slice(0, 7)
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'Invalid month')
    writeJson(res, 200, await parkMonthlyReport(deps.store, parkId, month))
    return true
  }
  if (suffix === 'compliance/summary' && req.method === 'GET') {
    requireRole(role, 'park_leader')
    writeJson(res, 200, await parkCompliance(deps.store, parkId))
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
    if (req.method === 'GET' && !leadRoute[2]) {
      const [contact, followUps, inquiries] = await Promise.all([
        deps.store.contact(parkId, leadId), deps.store.followUps(parkId, leadId),
        deps.store.db.all('SELECT id, redacted_question, redacted_answer, intent, industry, scale, urgency, concerns_json, created_at FROM park_inquiries WHERE org_id = ? AND session_id = ? ORDER BY created_at', [parkId, lead.source_session_id]),
      ])
      writeJson(res, 200, { ...lead, tags: JSON.parse(lead.tags_json), tags_json: undefined,
        contact: contact ?? null, follow_ups: followUps, inquiries })
      return true
    }
    if (req.method === 'POST' && leadRoute[2] === 'claim') {
      if (!(await deps.store.claimLead(parkId, leadId, auth.userId))) throw new HttpError(409, 'Lead is not awaiting claim')
      await recordParkAudit(deps.store, parkId, pathname, req.method, 200, auth.userId)
      writeJson(res, 200, { status: 'claimed', owner_id: auth.userId })
      return true
    }
    if (req.method === 'POST' && leadRoute[2] === 'follow-ups') {
      if (lead.owner_id !== auth.userId) throw new HttpError(403, 'Lead must be claimed by the actor')
      const body = await deps.readBody(req)
      const note = str(body.note, 2000)
      if (!note) throw new HttpError(400, 'Follow-up note is required')
      const id = await deps.store.addFollowUp(parkId, leadId, auth.userId, note, str(body.outcome, 80) || null)
      if (!id) throw new HttpError(409, 'Lead is not available for follow-up')
      await recordParkAudit(deps.store, parkId, pathname, req.method, 201, auth.userId)
      writeJson(res, 201, { id, status: 'following_up' })
      return true
    }
    if (req.method === 'PATCH' && !leadRoute[2]) {
      if (lead.owner_id !== auth.userId) throw new HttpError(403, 'Lead must be claimed by the actor')
      const body = await deps.readBody(req)
      const status = str(body.status) as LeadStatus
      if (!['converted', 'invalid', 'closed'].includes(status)) throw new HttpError(400, 'Invalid closing status')
      if (!(await deps.store.closeLead(parkId, leadId, auth.userId, status as 'converted' | 'invalid' | 'closed'))) throw new HttpError(409, 'Lead is not available for closing')
      await recordParkAudit(deps.store, parkId, pathname, req.method, 200, auth.userId)
      writeJson(res, 200, { status })
      return true
    }
  }

  if (suffix.startsWith('admin/')) requireRole(role, 'park_system_operator')
  if (suffix === 'admin/config') {
    if (req.method === 'GET') { writeJson(res, 200, await deps.store.config(parkId)); return true }
    if (req.method === 'PUT') {
      const body = await deps.readBody(req)
      if (body.service_catalog !== undefined && !Array.isArray(body.service_catalog)) throw new HttpError(400, 'Service catalog must be a list')
      const updated = await deps.store.putConfig(parkId, {
        display_name: str(body.display_name, 150), logo_url: str(body.logo_url, 400) || null,
        welcome_text: str(body.welcome_text, 1000), park_profile: str(body.park_profile, 8000),
        service_catalog: JSON.stringify(body.service_catalog ?? []),
        service_catalog_version: str(body.service_catalog_version, 40) || '1',
        contact_enabled: body.contact_enabled === false ? 0 : 1,
      })
      await recordParkAudit(deps.store, parkId, pathname, req.method, 200, auth.userId)
      writeJson(res, 200, updated)
      return true
    }
  }
  if (suffix === 'admin/policies' && req.method === 'GET') {
    writeJson(res, 200, await deps.store.listPolicies(parkId)); return true
  }
  if (suffix === 'admin/policies' && req.method === 'POST') {
    const body = await deps.readBody(req)
    const title = str(body.title, 200); const version = str(body.version, 80)
    const section = str(body.section, 120); const content = str(body.content, 10_000)
    if (!title || !version || !section || !content) throw new HttpError(400, 'Policy title, version, section and content are required')
    const effectiveFrom = Number(body.effective_from)
    const effectiveUntil = body.effective_until == null ? null : Number(body.effective_until)
    if (!Number.isFinite(effectiveFrom) || (effectiveUntil !== null && (!Number.isFinite(effectiveUntil) || effectiveUntil < effectiveFrom))) throw new HttpError(400, 'Invalid effective dates')
    const id = await deps.store.putPolicy(parkId, { title, version, section, content, status: 'draft', effectiveFrom, effectiveUntil })
    await recordParkAudit(deps.store, parkId, pathname, req.method, 201, auth.userId)
    writeJson(res, 201, { id }); return true
  }
  const policyStatus = /^admin\/policies\/([^/]+)\/status$/.exec(suffix)
  if (policyStatus && req.method === 'PATCH') {
    const body = await deps.readBody(req)
    const status = str(body.status)
    if (!['draft', 'published', 'offline'].includes(status)) throw new HttpError(400, 'Invalid policy status')
    if (!(await deps.store.setPolicyStatus(parkId, policyStatus[1]!, status as 'draft' | 'published' | 'offline'))) throw new HttpError(404, 'Policy not found')
    await recordParkAudit(deps.store, parkId, pathname, req.method, 200, auth.userId)
    writeJson(res, 200, { status }); return true
  }
  if (suffix === 'admin/quick-questions') {
    if (req.method === 'GET') { writeJson(res, 200, await deps.store.quickQuestions(parkId)); return true }
    if (req.method === 'POST') {
      const body = await deps.readBody(req)
      const question = str(body.question, 300)
      if (!question) throw new HttpError(400, 'Question is required')
      const id = await deps.store.putQuickQuestion(parkId, { id: str(body.id, 100) || undefined,
        question, sortOrder: Number(body.sort_order) || 0, enabled: body.enabled !== false })
      await recordParkAudit(deps.store, parkId, pathname, req.method, 200, auth.userId)
      writeJson(res, 200, { id }); return true
    }
  }
  const questionDelete = /^admin\/quick-questions\/([^/]+)$/.exec(suffix)
  if (questionDelete && req.method === 'DELETE') {
    if (!(await deps.store.deleteQuickQuestion(parkId, questionDelete[1]!))) throw new HttpError(404, 'Question not found')
    await recordParkAudit(deps.store, parkId, pathname, req.method, 204, auth.userId)
    res.writeHead(204); res.end(); return true
  }
  if (suffix === 'admin/assistant' || suffix === 'admin/rate-limits' || suffix === 'admin/redaction') {
    const config = await deps.store.config(parkId)
    if (!config) throw new HttpError(404, 'Park configuration not found')
    const field = suffix === 'admin/assistant' ? 'assistant_config' : suffix === 'admin/rate-limits' ? 'rate_config' : 'redaction_config'
    if (req.method === 'GET') { writeJson(res, 200, { value: JSON.parse(config[field]), ...(field === 'assistant_config' ? { status: config.assistant_status } : {}) }); return true }
    if (req.method === 'PUT') {
      const body = await deps.readBody(req)
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
            selection = resolveModelSelection(settings.modelProviders, settings.defaultModelProviderId, settings.model, String(value.model))
          } catch { throw new HttpError(400, 'No model provider is configured') }
          if (selection.provider.protocol !== 'openai-completions' || !getModelProviderApiKey(selection.provider.id, settings.apiKey, parkId)) {
            throw new HttpError(400, 'Assistant requires an available chat completion provider')
          }
        }
        patch.assistant_status = status
      } else if (field === 'rate_config') validateRateConfig(value)
      else validateRedactionConfig(value)
      await deps.store.putConfig(parkId, patch)
      await recordParkAudit(deps.store, parkId, pathname, req.method, 200, auth.userId)
      writeJson(res, 200, { ok: true }); return true
    }
  }
  if (suffix === 'admin/public-links') {
    if (req.method === 'GET') {
      const links = await deps.store.db.all('SELECT * FROM park_public_links WHERE org_id = ? ORDER BY created_at', [parkId])
      writeJson(res, 200, { public_url: process.env.PARK_PUBLIC_URL ?? null, links }); return true
    }
    if (req.method === 'POST') {
      const body = await deps.readBody(req)
      const channel = str(body.channel, 60); const label = str(body.label, 120)
      if (!/^[a-z0-9_-]{1,60}$/.test(channel) || !label) throw new HttpError(400, 'Invalid channel or label')
      const id = randomUUID()
      await deps.store.db.run(`INSERT INTO park_public_links (id, org_id, channel, label, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (org_id, channel) DO UPDATE SET label = excluded.label, enabled = excluded.enabled`,
      [id, parkId, channel, label, Number(body.enabled !== false), Date.now()])
      await recordParkAudit(deps.store, parkId, pathname, req.method, 200, auth.userId)
      writeJson(res, 200, { channel }); return true
    }
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
    const rows = await deps.store.db.all('SELECT id, actor_user_id, action, resource, method, path, response_status, ip_address, created_at FROM operation_audit_events WHERE org_id = ? ORDER BY created_at DESC LIMIT 200', [parkId])
    writeJson(res, 200, rows); return true
  }
  if (suffix === 'admin/operations' && req.method === 'GET') {
    if (!deps.boxOperations) throw new HttpError(503, 'Box operations are unavailable')
    writeJson(res, 200, await deps.boxOperations.status()); return true
  }
  const operation = /^admin\/operations\/(backup|restore|verify-upgrade|upgrade|rollback|reindex)$/.exec(suffix)
  if (operation && req.method === 'POST') {
    if (!deps.boxOperations) throw new HttpError(503, 'Box operations are unavailable')
    const body = await deps.readBody(req)
    const name = str(body.name, 255)
    const action = operation[1]!
    const result = action === 'backup' ? await deps.boxOperations.backup()
      : action === 'restore' ? await deps.boxOperations.restore(name)
      : action === 'verify-upgrade' ? await deps.boxOperations.verifyUpgrade(name)
      : action === 'upgrade' ? await deps.boxOperations.upgrade(name)
      : action === 'rollback' ? await deps.boxOperations.rollback()
      : await deps.boxOperations.reindex()
    await recordParkAudit(deps.store, parkId, pathname, req.method, 200, auth.userId)
    writeJson(res, 200, { result }); return true
  }
  return false
}
