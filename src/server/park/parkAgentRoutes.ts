import type { IncomingMessage } from 'node:http'
import type { DbDriver } from '../db/driver.js'
import type { AuthContext } from '../auth/token.js'
import type { DocumentStore } from '../documentStore.js'
import { resolveParkScopedResources } from './parkAuthorization.js'
import { InquiryService } from './inquiryService.js'
import { LeadService } from './leadService.js'
import { PolicyCatalogService } from './policyCatalogService.js'
import { PolicySearchService } from './policySearchService.js'
import { ParkRepository } from './parkRepository.js'
import { readParkBody, type ParkApiDeps, type ParkRouteResult } from './parkRoutesShared.js'

/**
 * Agent-facing park tool endpoints (plan 2.4), called from inside the scode
 * session container via SESSION_TOKEN. Auth model mirrors /api/v1/agent/wikis
 * (server.ts:5088): the in-container token carries assistantId; access is
 * granted only when that assistant is assigned (park_assistant_assignments)
 * to the caller's enterprise org. All organization context is derived from
 * the token — client-submitted org fields are ignored (§6.2).
 */
export async function dispatchParkAgentApi(
  deps: ParkApiDeps,
  auth: AuthContext,
  method: string,
  pathname: string,
  url: URL,
  req: IncomingMessage,
  documentStore: DocumentStore,
): Promise<ParkRouteResult> {
  if (!pathname.startsWith('/api/v1/agent/park/')) return null
  const driver: DbDriver = deps.driver

  const grant = await resolveParkScopedResources(driver, auth.orgId, auth.assistantId ?? null)
  if (!grant) {
    return { status: 403, body: { error: { code: 'park_agent_forbidden', message: '会话智能体未分配给当前组织' } } }
  }
  const parkOrgId = grant.parkOrgId
  const assistantId = grant.agentIds[0]!
  const enterpriseOrgId = auth.orgId

  const inquiryService = new InquiryService(driver)
  const leadService = new LeadService(driver)
  const policySearch = new PolicySearchService(driver, documentStore)
  const catalog = new PolicyCatalogService(driver)
  const repo = new ParkRepository(driver)

  // GET /api/v1/agent/park/policies/search?q=
  if (method === 'GET' && pathname === '/api/v1/agent/park/policies/search') {
    if (!auth.sessionId) return missingSession()
    const query = url.searchParams.get('q') ?? ''
    const matches = await policySearch.search(
      { parkOrgId, assistantId, query },
      deps.vectorSearchOptions ? { vector: deps.vectorSearchOptions } : {},
    )
    recordSessionSearch(auth.sessionId, matches)
    return { status: 200, body: { matches } }
  }

  // POST /api/v1/agent/park/inquiries  (inquiry.append)
  if (method === 'POST' && pathname === '/api/v1/agent/park/inquiries') {
    if (!auth.sessionId) return missingSession()
    const body = await readParkBody(req)
    // Confidence input "本轮 policy.search 命中数" is taken from the
    // server-side record of this session's latest search — NOT from the
    // caller-declared policy_matches array, which could otherwise inflate
    // confidence and lead score unchecked.
    const verifiedMatches = takeSessionSearch(auth.sessionId)
    const inquiry = await inquiryService.append({
      parkOrgId,
      enterpriseOrgId,
      userId: auth.userId,
      assistantSessionId: auth.sessionId,
      question: typeof body.question === 'string' ? body.question : '',
      answer: typeof body.answer === 'string' ? body.answer : null,
      category: 'consultation',
      intent: typeof body.intent === 'string' ? body.intent : null,
      industryTags: readStringArray(body.industry_tags),
      policyHitCount: verifiedMatches.length,
      sourceRefs: verifiedMatches,
    })
    return { status: 200, body: { inquiry_id: inquiry.inquiryId, confidence: inquiry.confidence } }
  }

  // POST /api/v1/agent/park/service-requests  (service_request.propose → inquiries)
  if (method === 'POST' && pathname === '/api/v1/agent/park/service-requests') {
    if (!auth.sessionId) return missingSession()
    const body = await readParkBody(req)
    const inquiry = await inquiryService.append({
      parkOrgId,
      enterpriseOrgId,
      userId: auth.userId,
      assistantSessionId: auth.sessionId,
      question: typeof body.request === 'string' ? body.request : '',
      answer: null,
      category: 'service_request',
      intent: 'service_request',
      industryTags: [],
      policyHitCount: 0,
      sourceRefs: [],
    })
    return { status: 200, body: { inquiry_id: inquiry.inquiryId } }
  }

  // POST /api/v1/agent/park/leads/propose  (lead.propose — idempotent per inquiry)
  if (method === 'POST' && pathname === '/api/v1/agent/park/leads/propose') {
    if (!auth.sessionId) return missingSession()
    const body = await readParkBody(req)
    const sourceInquiryId = typeof body.source_inquiry_id === 'string' ? body.source_inquiry_id : ''
    if (!sourceInquiryId) {
      return { status: 400, body: { error: { code: 'source_inquiry_id_required', message: 'source_inquiry_id 必填' } } }
    }
    const sourceInquiry = await repo.getInquiry(sourceInquiryId)
    if (!sourceInquiry || sourceInquiry.enterpriseOrgId !== enterpriseOrgId
      || sourceInquiry.parkOrgId !== parkOrgId || sourceInquiry.assistantSessionId !== auth.sessionId) {
      return { status: 404, body: { error: { code: 'inquiry_not_found', message: '咨询记录不存在' } } }
    }
    const policyMatches = parseSourceRefs(sourceInquiry.sourceRefsJson)
    const lead = await leadService.propose({
      parkOrgId,
      enterpriseOrgId,
      sourceInquiryId,
      actorUserId: auth.userId,
      inquiryConfidence: sourceInquiry.confidence,
      policyMatches,
      industryTags: readStringArray(body.industry_tags),
      suggestedAction: typeof body.suggested_action === 'string' ? body.suggested_action : null,
    })
    return {
      status: 200,
      body: { lead_id: lead.leadId, status: lead.status, score: lead.score },
    }
  }

  // GET /api/v1/agent/park/service-catalog
  if (method === 'GET' && pathname === '/api/v1/agent/park/service-catalog') {
    return { status: 200, body: await catalog.getServiceCatalog(parkOrgId) }
  }

  // GET /api/v1/agent/park/profile  (park_profile.read_public)
  if (method === 'GET' && pathname === '/api/v1/agent/park/profile') {
    const profile = await repo.getOrgProfile(parkOrgId)
    return { status: 200, body: { park_org_id: parkOrgId, display_name: profile?.displayName ?? '' } }
  }

  return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } }
}

function missingSession(): ParkRouteResult {
  return { status: 403, body: { error: { code: 'park_session_required', message: '需要有效的会话标识' } } }
}

function readStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

type PolicyMatch = { file: string; line_no: number; line: string }

/**
 * Per-session record of the latest policy.search results (plan 2.4: the
 * confidence input is "本轮 policy.search 命中数", which must be
 * server-verified, not caller-declared). In-memory and per-process — same
 * single-instance constraint as the webui BFF rate limiter; a multi-instance
 * deployment would need DB-backed storage.
 *
 * Take semantics (read + delete): each search record can feed exactly one
 * subsequent inquiry.append, so inflating confidence always requires a fresh
 * real search. service-request.propose deliberately does NOT consume the
 * record — SKILL.md rule 4 fires it as soon as a service is requested with
 * no ordering constraint against the end-of-turn append (rule 1), and the
 * legal combination search → service-request → append must keep its hits.
 */
const SESSION_SEARCH_TTL_MS = 10 * 60_000
const sessionSearchRecords = new Map<string, { matches: PolicyMatch[]; ts: number }>()

function recordSessionSearch(sessionId: string, matches: PolicyMatch[]): void {
  sessionSearchRecords.set(sessionId, { matches, ts: Date.now() })
}

function takeSessionSearch(sessionId: string): PolicyMatch[] {
  const entry = sessionSearchRecords.get(sessionId)
  sessionSearchRecords.delete(sessionId)
  if (!entry || Date.now() - entry.ts >= SESSION_SEARCH_TTL_MS) return []
  return entry.matches
}

function parseSourceRefs(raw: string | null): PolicyMatch[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((m): m is PolicyMatch =>
      typeof m === 'object' && m !== null && typeof (m as { file?: unknown }).file === 'string') : []
  } catch {
    return []
  }
}
