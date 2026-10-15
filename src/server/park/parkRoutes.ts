import type { DbDriver } from '../db/driver.js'
import type { AuthContext } from '../auth/token.js'
import type { AuthService } from '../auth/service.js'
import type { DocumentStore } from '../documentStore.js'
import { getParkRole, ParkApiError, requireEnterpriseOfPark, requireParkMember } from './parkAuthorization.js'
import { InquiryService } from './inquiryService.js'
import { LeadService } from './leadService.js'
import { MetricsService } from './metricsService.js'
import { ParkAuditService } from './parkAuditService.js'
import { ParkRegistrationService } from './parkRegistrationService.js'
import { ParkRepository, type LeadStatus, type ParkAuditEvent } from './parkRepository.js'
import { PolicyCatalogService } from './policyCatalogService.js'
import { PolicySearchService } from './policySearchService.js'
import { defaultParkRegisterLimiter, type ParkRateLimiter } from './parkRateLimit.js'
import { parkErrorToResponse, type ParkApiDeps, type ParkRouteResult } from './parkRoutesShared.js'

/**
 * User-side park business API dispatcher (plan 2.3), mounted inside the auth
 * wall by server.ts (cron-style per-endpoint dispatch). All organization
 * context derives from `auth` — path org ids are verified against the caller.
 *
 * Visibility rules (plan 2.3 口径):
 *   - inquiry redacted_* content: visible to park roles; question_ref/answer_ref
 *     never leave this module for park callers (原文硬边界).
 *   - lead list: whole park visible (default filter proposed + own);
 *     mutations owner-only; dispatch leader-only; watch leader-only.
 */

const PARK_ROLE = { LEADER: 'park_leader', OPS: 'park_ops', SYSTEM: 'park_system_operator' } as const

export async function dispatchParkApi(
  deps: ParkApiDeps,
  auth: AuthContext,
  method: string,
  url: URL,
  body: Record<string, unknown>,
  documentStore: DocumentStore,
): Promise<ParkRouteResult> {
  const driver: DbDriver = deps.driver
  const repo = new ParkRepository(driver)
  const audit = new ParkAuditService(driver)
  const path = url.pathname.replace(/\/$/, '')
  const parkBase = /^\/api\/v1\/parks\/([^/]+)(\/.*)?$/
  const parkMatch = path.match(parkBase)

  try {
    // ============ 企业侧 /api/v1/enterprise/* ============
    if (path.startsWith('/api/v1/enterprise/')) {
      return await dispatchEnterpriseSide(deps, auth, method, path, url, documentStore)
    }

    // ============ GET /api/v1/park/context ============
    if (method === 'GET' && path === '/api/v1/park/context') {
      const profile = await repo.getOrgProfile(auth.orgId)
      const orgType = profile?.orgType ?? null
      let parkRole: string | null = null
      if (orgType === 'park') parkRole = await getParkRole(driver, auth.orgId, auth.userId)
      const parkOrgId = orgType === 'enterprise'
        ? (await repo.getBindingByEnterprise(auth.orgId))?.parkOrgId ?? null
        : auth.orgId
      return {
        status: 200,
        body: {
          org_type: orgType,
          park_role: parkRole,
          park_org_id: parkOrgId,
          display_name: profile?.displayName ?? null,
        },
      }
    }

    if (!parkMatch) return null
    const parkOrgId = decodeURIComponent(parkMatch[1]!)
    const rest = parkMatch[2] ?? '/'

    // ---- settings ----
    if (rest === '/settings') {
      if (method === 'GET') {
        await requireParkMember(driver, auth, parkOrgId)
        return { status: 200, body: await projectSettings(repo, parkOrgId) }
      }
      if (method === 'PUT') {
        await requireParkMember(driver, auth, parkOrgId, [PARK_ROLE.SYSTEM])
        const before = await projectSettings(repo, parkOrgId)
        await repo.upsertOrgProfile({
          mossOrgId: parkOrgId,
          orgType: 'park',
          displayName: typeof body.display_name === 'string' && body.display_name.trim()
            ? body.display_name.trim()
            : (before as { display_name: string | null }).display_name ?? parkOrgId,
          isDefaultPark: body.is_default_park === true,
          metadataJson: typeof body.metadata_json === 'string' ? body.metadata_json : undefined,
        })
        await audit.record({
          parkOrgId, actorUserId: auth.userId, actorOrgId: auth.orgId,
          action: 'park.settings_update', targetType: 'park_settings', targetId: parkOrgId,
          before, after: await projectSettings(repo, parkOrgId),
        })
        return { status: 200, body: await projectSettings(repo, parkOrgId) }
      }
    }

    // ---- enterprises list ----
    if (rest === '/enterprises' && method === 'GET') {
      const role = await requireParkMember(driver, auth, parkOrgId)
      const profiles = await repo.listEnterpriseProfiles(parkOrgId)
      const bindings = await repo.listBindingsByPark(parkOrgId)
      const bindingByEnterprise = new Map(bindings.map(b => [b.enterpriseOrgId, b]))
      const leadCounts = await repo.countLeadsByEnterprise(parkOrgId)
      const isLeader = role === PARK_ROLE.LEADER
      const items = profiles.map(profile => {
        const binding = bindingByEnterprise.get(profile.enterpriseOrgId)
        const base = {
          enterprise_org_id: profile.enterpriseOrgId,
          enterprise_name: profile.enterpriseName,
          lifecycle: binding?.lifecycle ?? profile.lifecycle,
          tags: parseStringArray(profile.tagsJson),
          assigned_owner_id: profile.assignedOwnerId,
          created_at: profile.createdAt,
        }
        // Leader gets the aggregate view (§4.2): counts, no contact details.
        return isLeader
          ? { ...base, lead_count: leadCounts[profile.enterpriseOrgId] ?? 0 }
          : {
              ...base,
              industry: profile.industry,
              scale: profile.scale,
              contact_name: profile.contactName,
              contact_phone: profile.contactPhone,
            }
      })
      return { status: 200, body: { items } }
    }

    // ---- enterprise detail / follow-up ----
    const enterpriseMatch = rest.match(/^\/enterprises\/([^/]+)$/)
    if (enterpriseMatch) {
      const enterpriseOrgId = decodeURIComponent(enterpriseMatch[1]!)
      if (method === 'GET') {
        await requireParkMember(driver, auth, parkOrgId)
        return { status: 200, body: await projectEnterpriseDetail(repo, parkOrgId, enterpriseOrgId) }
      }
      if (method === 'PATCH') {
        await requireParkMember(driver, auth, parkOrgId, [PARK_ROLE.OPS, PARK_ROLE.SYSTEM])
        const before = await projectEnterpriseDetail(repo, parkOrgId, enterpriseOrgId)
        await repo.updateEnterpriseFollowUp(enterpriseOrgId, {
          tagsJson: Array.isArray(body.tags) ? JSON.stringify(body.tags.filter((v): v is string => typeof v === 'string')) : undefined,
          assignedOwnerId: typeof body.assigned_owner_id === 'string' ? body.assigned_owner_id : undefined,
          industry: typeof body.industry === 'string' ? body.industry : undefined,
          scale: typeof body.scale === 'string' ? body.scale : undefined,
        })
        await audit.record({
          parkOrgId, actorUserId: auth.userId, actorOrgId: auth.orgId,
          action: 'park.enterprise_followup_update', targetType: 'enterprise_org', targetId: enterpriseOrgId,
          before, after: await projectEnterpriseDetail(repo, parkOrgId, enterpriseOrgId),
        })
        return { status: 200, body: await projectEnterpriseDetail(repo, parkOrgId, enterpriseOrgId) }
      }
    }

    // ---- enterprise bindings ----
    if (rest === '/enterprise-bindings' && method === 'POST') {
      await requireParkMember(driver, auth, parkOrgId, [PARK_ROLE.SYSTEM])
      const enterpriseOrgId = typeof body.enterprise_org_id === 'string' ? body.enterprise_org_id : ''
      if (!enterpriseOrgId) throw new ParkApiError(400, 'invalid_payload', 'enterprise_org_id 必填')
      const enterprise = await repo.getOrgProfile(enterpriseOrgId)
      if (enterprise?.orgType !== 'enterprise') throw new ParkApiError(400, 'enterprise_invalid', '企业组织不存在或类型不正确')
      const existing = await repo.getBinding(parkOrgId, enterpriseOrgId)
      if (existing) throw new ParkApiError(409, 'binding_exists', '该企业已绑定本园区')
      const binding = await repo.insertBinding({
        parkOrgId,
        enterpriseOrgId,
        lifecycle: readEnum<'prospect' | 'active' | 'exiting' | 'exited'>(body.lifecycle, ['prospect', 'active', 'exiting', 'exited'], null) ?? 'prospect',
      })
      await audit.record({
        parkOrgId, actorUserId: auth.userId, actorOrgId: auth.orgId,
        action: 'park.binding_create', targetType: 'enterprise_org', targetId: enterpriseOrgId,
        after: { lifecycle: binding.lifecycle },
      })
      return { status: 200, body: { binding_id: binding.bindingId } }
    }

    // ---- consultations (咨询摘要列表, §5.4: 按企业/时间筛选) ----
    if (rest === '/consultations' && method === 'GET') {
      await requireParkMember(driver, auth, parkOrgId)
      const inquiryService = new InquiryService(driver)
      const readDateParam = (name: string): number | undefined => {
        const raw = url.searchParams.get(name)
        const value = raw === null ? NaN : Number(raw)
        return Number.isFinite(value) ? value : undefined
      }
      const items = await inquiryService.listForPark(parkOrgId, {
        enterpriseOrgId: url.searchParams.get('enterprise_org_id') ?? undefined,
        beforeCreatedAt: readDateParam('before_created_at'),
        afterCreatedAt: readDateParam('after_created_at'),
      })
      const profiles = new Map((await repo.listEnterpriseProfiles(parkOrgId))
        .map(p => [p.enterpriseOrgId, p.enterpriseName]))
      return {
        status: 200,
        body: {
          items: items.map(item => ({
            ...item,
            enterprise_name: profiles.get(item.enterprise_org_id) ?? item.enterprise_org_id,
          })),
        },
      }
    }

    // ---- leads list / manual create ----
    if (rest === '/leads') {
      if (method === 'GET') {
        await requireParkMember(driver, auth, parkOrgId)
        const statusParam = url.searchParams.get('status')
        const statusFilter = statusParam
          ? statusParam.split(',').filter(Boolean) as LeadStatus[]
          : undefined
        const watchedOnly = url.searchParams.get('watched') === '1'
        const leads = await repo.listLeads(parkOrgId, {
          statuses: statusFilter && statusFilter.length > 0 ? statusFilter : undefined,
          watchedBy: watchedOnly ? auth.userId : undefined,
        })
        const names = await enterpriseNameMap(repo, parkOrgId)
        const ownerNames = await repo.userNamesByIds(
          leads.map(l => l.ownerId).filter((id): id is string => id != null),
        )
        return {
          status: 200,
          body: {
            items: leads.map(l =>
              projectLead(l, names.get(l.enterpriseOrgId), l.ownerId ? ownerNames.get(l.ownerId) : undefined),
            ),
          },
        }
      }
      if (method === 'POST') {
        const role = await requireParkMember(driver, auth, parkOrgId, [PARK_ROLE.OPS])
        const enterpriseOrgId = typeof body.enterprise_org_id === 'string' ? body.enterprise_org_id : ''
        if (!enterpriseOrgId) throw new ParkApiError(400, 'invalid_payload', 'enterprise_org_id 必填')
        const binding = await repo.getBinding(parkOrgId, enterpriseOrgId)
        if (!binding) throw new ParkApiError(404, 'enterprise_not_bound', '该企业未绑定本园区')
        const leadService = new LeadService(driver)
        const lead = await leadService.createManual({
          parkOrgId,
          enterpriseOrgId,
          ownerId: auth.userId,
          note: typeof body.note === 'string' ? body.note : '',
          industryTags: Array.isArray(body.industry_tags)
            ? body.industry_tags.filter((v): v is string => typeof v === 'string')
            : [],
        })
        await audit.record({
          parkOrgId, actorUserId: auth.userId, actorOrgId: auth.orgId,
          action: 'park.lead_create_manual', targetType: 'lead', targetId: lead.leadId,
          after: { status: lead.status, source: 'manual' },
          reason: `role=${role}`,
        })
        return { status: 200, body: projectLead(lead) }
      }
    }

    // ---- lead detail / claim / transition / watch ----
    const leadMatch = rest.match(/^\/leads\/([^/]+)(\/.*)?$/)
    if (leadMatch) {
      const leadId = decodeURIComponent(leadMatch[1]!)
      const leadRest = leadMatch[2] ?? ''
      const leadService = new LeadService(driver)
      const role = await requireParkMember(driver, auth, parkOrgId)

      if (leadRest === '' && method === 'GET') {
        const lead = await leadService.requireLead(parkOrgId, leadId)
        const inquiry = lead.sourceInquiryId ? await repo.getInquiry(lead.sourceInquiryId) : null
        const leadName = (await enterpriseNameMap(repo, parkOrgId)).get(lead.enterpriseOrgId)
        const ownerName = lead.ownerId ? (await repo.userNamesByIds([lead.ownerId])).get(lead.ownerId) : undefined
        return {
          status: 200,
          body: {
            ...projectLead(lead, leadName, ownerName),
            inquiry_summary: inquiry
              ? {
                  inquiry_id: inquiry.inquiryId,
                  redacted_question: inquiry.redactedQuestion,
                  redacted_answer: inquiry.redactedAnswer,
                  intent: inquiry.intent,
                  confidence: inquiry.confidence,
                  created_at: inquiry.createdAt,
                }
              : null,
          },
        }
      }

      if (leadRest === '/claim' && method === 'POST') {
        if (role !== PARK_ROLE.OPS) throw new ParkApiError(403, 'park_role_denied', '仅招商运营可认领线索')
        const before = await leadService.requireLead(parkOrgId, leadId)
        const after = await leadService.claim(parkOrgId, leadId, auth.userId)
        const claimName = (await enterpriseNameMap(repo, parkOrgId)).get(after.enterpriseOrgId)
        await audit.record({
          parkOrgId, actorUserId: auth.userId, actorOrgId: auth.orgId,
          action: 'park.lead_claim', targetType: 'lead', targetId: leadId,
          before: { status: before.status, owner_id: before.ownerId },
          after: { status: after.status, owner_id: after.ownerId },
        })
        return { status: 200, body: projectLead(after, claimName) }
      }

      if (leadRest === '' && method === 'PATCH') {
        const nextStatus = typeof body.status === 'string' ? body.status as LeadStatus : undefined
        if (nextStatus !== undefined && role !== PARK_ROLE.OPS) {
          throw new ParkApiError(403, 'park_role_denied', '仅招商运营可更新线索状态')
        }
        const ownerId = typeof body.owner_id === 'string' ? body.owner_id : undefined
        if (ownerId !== undefined) {
          if (role !== PARK_ROLE.LEADER) {
            throw new ParkApiError(403, 'park_role_denied', '仅园区领导可分派线索')
          }
          if (await getParkRole(driver, parkOrgId, ownerId) !== PARK_ROLE.OPS) {
            throw new ParkApiError(400, 'lead_owner_invalid', '线索只能分派给本园区招商运营')
          }
        }
        const isLeader = role === PARK_ROLE.LEADER
        const { before, after } = await leadService.transition({
          parkOrgId, leadId, actorUserId: auth.userId, actorIsLeader: isLeader,
          nextStatus, ownerId,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          suggestedAction: typeof body.suggested_action === 'string' ? body.suggested_action : undefined,
        })
        await audit.record({
          parkOrgId, actorUserId: auth.userId, actorOrgId: auth.orgId,
          action: ownerId !== undefined && ownerId !== before.ownerId ? 'park.lead_dispatch' : 'park.lead_transition',
          targetType: 'lead', targetId: leadId,
          reason: typeof body.reason === 'string' ? body.reason : null,
          before: { status: before.status, owner_id: before.ownerId },
          after: { status: after.status, owner_id: after.ownerId },
        })
        return { status: 200, body: projectLead(after) }
      }

      if (leadRest === '/watch') {
        if (role !== PARK_ROLE.LEADER) {
          throw new ParkApiError(403, 'leader_only', '仅园区领导可关注线索')
        }
        const lead = await leadService.requireLead(parkOrgId, leadId)
        if (method === 'POST') {
          await repo.addLeadWatch(leadId, auth.userId)
          await audit.record({
            parkOrgId, actorUserId: auth.userId, actorOrgId: auth.orgId,
            action: 'park.lead_watch', targetType: 'lead', targetId: leadId, after: { watched: true },
          })
          return { status: 200, body: { watched: true } }
        }
        if (method === 'DELETE') {
          await repo.removeLeadWatch(leadId, auth.userId)
          await audit.record({
            parkOrgId, actorUserId: auth.userId, actorOrgId: auth.orgId,
            action: 'park.lead_unwatch', targetType: 'lead', targetId: leadId, after: { watched: false },
          })
          return { status: 200, body: { watched: false } }
        }
        void lead
      }
    }

    // ---- metrics ----
    if (rest === '/metrics' && method === 'GET') {
      await requireParkMember(driver, auth, parkOrgId)
      const metrics = new MetricsService(driver)
      return { status: 200, body: await metrics.getMetrics(parkOrgId) }
    }

    // ---- audit events (角色过滤: system=全量 / leader=全量聚合 / ops=本人) ----
    if (rest === '/audit-events' && method === 'GET') {
      const role = await requireParkMember(driver, auth, parkOrgId)
      const actorUserId = role === PARK_ROLE.OPS ? auth.userId : undefined
      const events = await repo.listAuditEvents({ parkOrgId, actorUserId })
      return { status: 200, body: { items: await projectAuditEvents(repo, parkOrgId, events) } }
    }

    // ---- members ----
    if (rest === '/members') {
      if (method === 'GET') {
        await requireParkMember(driver, auth, parkOrgId)
        const members = await repo.listMembers(parkOrgId)
        const userNames = await repo.userNamesByIds(members.map(member => member.userId))
        return {
          status: 200,
          body: { items: members.map(member => projectMember(member, userNames.get(member.userId))) },
        }
      }
      if (method === 'POST') {
        await requireParkMember(driver, auth, parkOrgId, [PARK_ROLE.SYSTEM])
        const userId = typeof body.user_id === 'string' ? body.user_id : ''
        const parkRole = readEnum(body.park_role, ['park_leader', 'park_ops', 'park_system_operator'], null)
        if (!userId || !parkRole) throw new ParkApiError(400, 'invalid_payload', 'user_id 与 park_role 必填')
        const member = await repo.insertMember({ parkOrgId, userId, parkRole: parkRole as 'park_leader' | 'park_ops' | 'park_system_operator' })
        await audit.record({
          parkOrgId, actorUserId: auth.userId, actorOrgId: auth.orgId,
          action: 'park.member_add', targetType: 'park_member', targetId: userId,
          after: { park_role: parkRole },
        })
        return { status: 200, body: projectMember(member) }
      }
      if (method === 'DELETE') {
        await requireParkMember(driver, auth, parkOrgId, [PARK_ROLE.SYSTEM])
        const userId = typeof body.user_id === 'string' ? body.user_id : url.searchParams.get('user_id') ?? ''
        if (!userId) throw new ParkApiError(400, 'invalid_payload', 'user_id 必填')
        await repo.deleteMember(parkOrgId, userId)
        await audit.record({
          parkOrgId, actorUserId: auth.userId, actorOrgId: auth.orgId,
          action: 'park.member_remove', targetType: 'park_member', targetId: userId,
        })
        return { status: 200, body: { removed: true } }
      }
    }

    // ---- assistant assignments ----
    if (rest === '/assistant-assignments') {
      if (method === 'GET') {
        await requireParkMember(driver, auth, parkOrgId)
        const assignments = await repo.listAssignmentsByPark(parkOrgId)
        const assistantNames = await repo.assistantNamesByIds(assignments.map(a => a.assistantId))
        const enterpriseNames = await enterpriseNameMap(repo, parkOrgId)
        return {
          status: 200,
          body: {
            items: assignments.map(a => ({
              id: a.id, park_org_id: a.parkOrgId, assistant_id: a.assistantId,
              assistant_name: assistantNames.get(a.assistantId) ?? null,
              enterprise_org_id: a.enterpriseOrgId,
              enterprise_name: enterpriseNames.get(a.enterpriseOrgId) ?? null,
              created_at: a.createdAt,
            })),
          },
        }
      }
      if (method === 'POST') {
        await requireParkMember(driver, auth, parkOrgId, [PARK_ROLE.SYSTEM])
        const assistantId = typeof body.assistant_id === 'string' ? body.assistant_id : ''
        const enterpriseOrgId = typeof body.enterprise_org_id === 'string' ? body.enterprise_org_id : ''
        if (!assistantId || !enterpriseOrgId) throw new ParkApiError(400, 'invalid_payload', 'assistant_id 与 enterprise_org_id 必填')
        const assistant = await driver.get<{ id: string }>(
          `SELECT id FROM tenant_assistants WHERE id = ? AND org_id = ? AND status = 'approved'`,
          [assistantId, parkOrgId],
        )
        if (!assistant) throw new ParkApiError(400, 'assistant_invalid', '智能体不属于当前园区或尚未发布')
        if (!(await repo.getBinding(parkOrgId, enterpriseOrgId))) {
          throw new ParkApiError(400, 'enterprise_not_bound', '企业尚未绑定当前园区')
        }
        const assignment = await repo.insertAssignment({ parkOrgId, assistantId, enterpriseOrgId })
        await audit.record({
          parkOrgId, actorUserId: auth.userId, actorOrgId: auth.orgId,
          action: 'park.assistant_assign', targetType: 'assistant', targetId: assistantId,
          after: { enterprise_org_id: enterpriseOrgId },
        })
        return { status: 200, body: { id: assignment.id } }
      }
      if (method === 'DELETE') {
        await requireParkMember(driver, auth, parkOrgId, [PARK_ROLE.SYSTEM])
        const assistantId = typeof body.assistant_id === 'string' ? body.assistant_id : url.searchParams.get('assistant_id') ?? ''
        const enterpriseOrgId = typeof body.enterprise_org_id === 'string' ? body.enterprise_org_id : url.searchParams.get('enterprise_org_id') ?? ''
        if (!assistantId || !enterpriseOrgId) throw new ParkApiError(400, 'invalid_payload', 'assistant_id 与 enterprise_org_id 必填')
        await repo.deleteAssignment(parkOrgId, assistantId, enterpriseOrgId)
        await audit.record({
          parkOrgId, actorUserId: auth.userId, actorOrgId: auth.orgId,
          action: 'park.assistant_unassign', targetType: 'assistant', targetId: assistantId,
          after: { enterprise_org_id: enterpriseOrgId },
        })
        return { status: 200, body: { removed: true } }
      }
    }

    // ---- candidate lists（admin Modal 下拉候选；权限与对应写操作一致）----
    if (rest === '/assistant-candidates' && method === 'GET') {
      await requireParkMember(driver, auth, parkOrgId, [PARK_ROLE.SYSTEM])
      const candidates = await repo.listApprovedAssistants(parkOrgId)
      return {
        status: 200,
        body: {
          items: candidates.map(candidate => ({
            assistant_id: candidate.assistantId,
            name: candidate.name,
            display_name: candidate.displayName,
          })),
        },
      }
    }

    if (rest === '/bindable-enterprises' && method === 'GET') {
      await requireParkMember(driver, auth, parkOrgId, [PARK_ROLE.SYSTEM])
      const candidates = await repo.listBindableEnterpriseOrgs()
      return {
        status: 200,
        body: {
          items: candidates.map(candidate => ({
            enterprise_org_id: candidate.enterpriseOrgId,
            display_name: candidate.displayName,
          })),
        },
      }
    }

    if (rest === '/member-candidates' && method === 'GET') {
      await requireParkMember(driver, auth, parkOrgId, [PARK_ROLE.SYSTEM])
      const candidates = await repo.searchUsersForMembership(parkOrgId, url.searchParams.get('q') ?? '')
      return {
        status: 200,
        body: { items: candidates.map(candidate => ({ user_id: candidate.userId, display_name: candidate.displayName })) },
      }
    }

    return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } }
  } catch (err) {
    return parkErrorToResponse(err)
  }
}

/**
 * Registration endpoint handler — mounted ABOVE the bearer-JWT wall by
 * server.ts (eventTriggerIngest precedent, server.ts:2492). Rate limiting is
 * layered twice: here in the park module (fixed window per client IP,
 * plan 2.6 #1) and at the BFF (webui express-rate-limit), plus the SMS code
 * attempt counter on phone_login_codes.
 */
export async function handleParkEnterpriseRegister(
  deps: ParkApiDeps & {
    authService: AuthService
    /** Client IP as seen by moss (XFF first entry via BFF/proxy, else socket address). */
    clientIp?: string
    /** Injectable for tests; defaults to the module-level limiter. */
    rateLimiter?: ParkRateLimiter
  },
  body: Record<string, unknown>,
): Promise<ParkRouteResult> {
  try {
    const limiter = deps.rateLimiter ?? defaultParkRegisterLimiter
    const clientIp = deps.clientIp ?? 'unknown'
    if (!limiter.check(clientIp)) {
      return { status: 429, body: { error: { code: 'rate_limited', message: '注册请求过于频繁，请稍后再试' } } }
    }
    const registration = new ParkRegistrationService(deps.driver, deps.authService)
    const result = await registration.registerEnterprise({
      phone: typeof body.phone === 'string' ? body.phone : '',
      smsCode: typeof body.sms_code === 'string' ? body.sms_code : '',
      enterpriseName: typeof body.enterprise_name === 'string' ? body.enterprise_name : '',
      contactName: typeof body.contact_name === 'string' ? body.contact_name : '',
      inviteToken: typeof body.invite_token === 'string' ? body.invite_token : null,
    })
    return { status: 200, body: result }
  } catch (err) {
    return parkErrorToResponse(err)
  }
}

// ---- enterprise side ----

async function dispatchEnterpriseSide(
  deps: ParkApiDeps,
  auth: AuthContext,
  method: string,
  path: string,
  url: URL,
  documentStore: DocumentStore,
): Promise<ParkRouteResult> {
  const driver = deps.driver
  const repo = new ParkRepository(driver)
  const parkOrgId = await requireEnterpriseOfPark(driver, auth)

  if (method !== 'GET') {
    return { status: 405, body: { error: { code: 'method_not_allowed', message: 'Method not allowed' } } }
  }

  if (path === '/api/v1/enterprise/profile') {
    const profile = await repo.getEnterpriseProfile(auth.orgId)
    if (!profile) throw new ParkApiError(404, 'profile_not_found', '企业档案不存在')
    const binding = await repo.getBindingByEnterprise(auth.orgId)
    return {
      status: 200,
      body: {
        enterprise_org_id: profile.enterpriseOrgId,
        park_org_id: profile.parkOrgId,
        enterprise_name: profile.enterpriseName,
        industry: profile.industry,
        scale: profile.scale,
        contact_name: profile.contactName,
        contact_phone: profile.contactPhone,
        lifecycle: binding?.lifecycle ?? profile.lifecycle,
        tags: parseStringArray(profile.tagsJson),
        created_at: profile.createdAt,
      },
    }
  }

  if (path === '/api/v1/enterprise/policies') {
    const policySearch = new PolicySearchService(driver, documentStore)
    const wikis = await policySearch.listPolicyFiles(parkOrgId)
    return { status: 200, body: { wikis } }
  }

  if (path === '/api/v1/enterprise/services') {
    const catalog = new PolicyCatalogService(driver)
    return { status: 200, body: await catalog.getServiceCatalog(parkOrgId) }
  }

  if (path === '/api/v1/enterprise/inquiries') {
    const inquiryService = new InquiryService(driver)
    const items = await inquiryService.listForEnterprise(auth.orgId)
    void url
    return { status: 200, body: { items } }
  }

  if (path === '/api/v1/enterprise/assistant') {
    const catalog = new PolicyCatalogService(driver)
    const assistants = await catalog.getAssignedAssistants(auth.orgId)
    return { status: 200, body: { items: assistants } }
  }

  return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } }
}

/** org_id -> enterprise_name 映射（leads 列表展示用） */
async function enterpriseNameMap(repo: import('./parkRepository.js').ParkRepository, parkOrgId: string): Promise<Map<string, string>> {
  const profiles = await repo.listEnterpriseProfiles(parkOrgId)
  return new Map(profiles.map(p => [p.enterpriseOrgId, p.enterpriseName]))
}

/** 审计事件展示名解析：actor 一律取用户名；target 按 target_type 分流，查不到给 null（前端回退 ID）。 */
async function projectAuditEvents(
  repo: ParkRepository,
  parkOrgId: string,
  events: ParkAuditEvent[],
): Promise<Array<Record<string, unknown>>> {
  const actorNames = await repo.userNamesByIds(events.map(event => event.actorUserId))
  const targetIds = (type: string): string[] =>
    events.filter(event => event.targetType === type && event.targetId).map(event => event.targetId!)
  const enterpriseNames = await enterpriseNameMap(repo, parkOrgId)
  const leadEnterprises = await repo.leadEnterprisesByIds(targetIds('lead'))
  const assistantNames = await repo.assistantNamesByIds(targetIds('assistant'))
  const memberNames = await repo.userNamesByIds(targetIds('park_member'))
  const settingsName = events.some(event => event.targetType === 'park_settings')
    ? (await repo.getOrgProfile(parkOrgId))?.displayName ?? null
    : null

  const targetName = (event: ParkAuditEvent): string | null => {
    if (!event.targetId) return null
    switch (event.targetType) {
      case 'enterprise_org':
        return enterpriseNames.get(event.targetId) ?? null
      case 'lead': {
        const enterpriseOrgId = leadEnterprises.get(event.targetId)
        return enterpriseOrgId ? enterpriseNames.get(enterpriseOrgId) ?? null : null
      }
      case 'assistant':
        return assistantNames.get(event.targetId) ?? null
      case 'park_member':
        return memberNames.get(event.targetId) ?? null
      case 'park_settings':
        return settingsName
      default:
        return null
    }
  }

  return events.map(event => ({
    audit_id: event.auditId,
    action: event.action,
    target_type: event.targetType,
    target_id: event.targetId,
    target_name: targetName(event),
    actor_user_id: event.actorUserId,
    actor_name: actorNames.get(event.actorUserId) ?? null,
    reason: event.reason,
    before: parseJsonOrRaw(event.beforeSummaryJson),
    after: parseJsonOrRaw(event.afterSummaryJson),
    result: event.result,
    created_at: event.createdAt,
  }))
}

// ---- projections ----

function projectLead(
  lead: import('./parkRepository.js').Lead,
  enterpriseName?: string | null,
  ownerName?: string | null,
) {
  return {
    lead_id: lead.leadId,
    park_org_id: lead.parkOrgId,
    enterprise_org_id: lead.enterpriseOrgId,
    enterprise_name: enterpriseName ?? null,
    source: lead.source,
    source_inquiry_id: lead.sourceInquiryId,
    score: lead.score,
    score_explanation: lead.scoreExplanation,
    industry_tags: parseStringArray(lead.industryTagsJson),
    policy_matches: parseJsonOrRaw(lead.policyMatchesJson),
    suggested_action: lead.suggestedAction,
    owner_id: lead.ownerId,
    owner_name: ownerName ?? null,
    status: lead.status,
    created_at: lead.createdAt,
    updated_at: lead.updatedAt,
  }
}

function projectMember(member: import('./parkRepository.js').ParkMember, userName?: string) {
  return {
    id: member.id,
    park_org_id: member.parkOrgId,
    user_id: member.userId,
    user_name: userName ?? null,
    park_role: member.parkRole,
    created_at: member.createdAt,
  }
}

async function projectSettings(repo: ParkRepository, parkOrgId: string) {
  const profile = await repo.getOrgProfile(parkOrgId)
  if (!profile) return { display_name: null, is_default_park: false, metadata_json: null }
  return {
    display_name: profile.displayName,
    is_default_park: profile.isDefaultPark,
    metadata_json: profile.metadataJson ? parseJsonOrRaw(profile.metadataJson) : null,
  }
}

async function projectEnterpriseDetail(repo: ParkRepository, parkOrgId: string, enterpriseOrgId: string) {
  const profile = await repo.getEnterpriseProfile(enterpriseOrgId)
  const binding = await repo.getBinding(parkOrgId, enterpriseOrgId)
  if (!profile) throw new ParkApiError(404, 'enterprise_not_found', '企业不存在')
  const leads = await repo.listLeads(parkOrgId, {}, 10_000)
  const enterpriseLeads = leads.filter(l => l.enterpriseOrgId === enterpriseOrgId)
  return {
    enterprise_org_id: profile.enterpriseOrgId,
    park_org_id: profile.parkOrgId,
    enterprise_name: profile.enterpriseName,
    industry: profile.industry,
    scale: profile.scale,
    contact_name: profile.contactName,
    contact_phone: profile.contactPhone,
    assigned_owner_id: profile.assignedOwnerId,
    assigned_owner_name: profile.assignedOwnerId
      ? (await repo.userNamesByIds([profile.assignedOwnerId])).get(profile.assignedOwnerId) ?? null
      : null,
    tags: parseStringArray(profile.tagsJson),
    lifecycle: binding?.lifecycle ?? profile.lifecycle,
    lead_summary: {
      total: enterpriseLeads.length,
      by_status: enterpriseLeads.reduce<Record<string, number>>((acc, lead) => {
        acc[lead.status] = (acc[lead.status] ?? 0) + 1
        return acc
      }, {}),
    },
    created_at: profile.createdAt,
  }
}

// ---- helpers ----

function parseStringArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function parseJsonOrRaw(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T | null): T | null {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  return fallback
}
