import { isDeepStrictEqual } from 'node:util'
import type { DbDriver } from '../db/driver.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import type { ExecutionModelCall } from './executionModelGateway.js'
import type { AgentUsageCall, AgentUsageGroup, AgentUsageReport, AgentUsageTotals, AgentUsageWindow } from './usageViews.js'

const MAX_CALLS = 2000
const hash = (v: unknown): v is string => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v)
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
function invalid(): never { throw new ExternalProviderError(503, 'AGENT_USAGE_EVIDENCE_INVALID') }
export function usageWindow(params: URLSearchParams): AgentUsageWindow {
  if ([...params.keys()].some(k => !['from', 'to', 'mode'].includes(k)) || ['from', 'to', 'mode'].some(k => params.getAll(k).length > 1))
    throw new ExternalProviderError(400, 'INVALID_USAGE_WINDOW')
  const from = Number(params.get('from')), to = Number(params.get('to')), mode = params.get('mode') ?? 'run'
  if (!params.get('from') || !params.get('to') || !integer(from) || !integer(to) || from >= to
    || from % 1000 || to % 1000 || to - from > 31 * 86400_000 || !['run', 'evaluation'].includes(mode))
    throw new ExternalProviderError(400, 'INVALID_USAGE_WINDOW')
  return { from, to, mode: mode as AgentUsageWindow['mode'] }
}
const empty = (): AgentUsageTotals => ({ calls: 0, pending_calls: 0, unknown_calls: 0, missing_attribution_calls: 0,
  not_invoked_calls: 0, verified_entries: 0, verified_quota: 0, input_tokens: 0, output_tokens: 0 })
function add(target: AgentUsageTotals, call: AgentUsageCall) {
  target.calls++
  if (call.ledger_status === 'pending') target.pending_calls++
  if (call.status === 'unknown' || call.status === 'preparing' || call.status === 'dispatching') target.unknown_calls++
  if (!call.platform || !call.router_authority_id) target.missing_attribution_calls++
  if (call.ledger_status === 'not_invoked') target.not_invoked_calls++
  for (const item of call.entries) {
    target.verified_entries++; target.verified_quota += item.quota
    target.input_tokens += item.input_tokens; target.output_tokens += item.output_tokens
  }
  if (!Object.values(target).filter(v => typeof v === 'number').every(integer)) invalid()
}

/** Pure projection of one DB statement. Never calls/reconciles Router or rewrites old attribution. */
export function projectAgentUsage(orgId: string, window: AgentUsageWindow, rows: ExecutionModelCall[], capturedAt = Date.now()): AgentUsageReport {
  const groups = new Map<string, AgentUsageGroup>(), authorities = new Map<string | null, AgentUsageTotals & { router_authority_id: string | null }>()
  const calls: AgentUsageCall[] = [], ids = new Set<string>(), tokens = new Set<string>()
  const logs = new Map<string, { call: string; entry: AgentUsageCall['entries'][number] }>()
  for (const raw of rows) {
    if (raw.orgId !== orgId || ids.has(raw.id) || !integer(raw.createdAt) || !integer(raw.updatedAt)
      || !integer(raw.grantExpiresAt) || raw.grantExpiresAt < raw.createdAt || !Array.isArray(raw.consumption)) invalid()
    ids.add(raw.id)
    if (raw.mode !== window.mode) continue
    const authority = raw.routerAuthorityId ?? null
    if (authority !== null && !hash(authority)) invalid()
    if (raw.attribution && (!hash(raw.attribution.metadataDigest)
      || !['dify', 'langgraph', 'openai', 'mcp', 'a2a', 'http', 'native', 'saas', 'other'].includes(raw.attribution.sourcePlatform)
      || typeof raw.attribution.assetName !== 'string')) invalid()
    if (authority && raw.routerToken) {
      const key = JSON.stringify([authority, raw.routerToken.accountId, raw.routerToken.id])
      if (tokens.has(key)) invalid()
      tokens.add(key)
    }
    const entries: AgentUsageCall['entries'] = []
    // Historical rows without an authority pin remain pending; same numeric IDs could belong to another Router.
    if (raw.ledgerStatus === 'router_verified' && authority) for (const item of raw.consumption) {
      if (!raw.routerToken || item.tokenId !== raw.routerToken.id || item.accountId !== raw.routerToken.accountId || item.model !== raw.model
        || ![item.id, item.tokenId, item.accountId, item.createdAt, item.quota, item.promptTokens, item.completionTokens].every(integer)
        || item.id < 1 || item.tokenId < 1 || item.accountId < 1
        || item.createdAt * 1000 < Math.floor(raw.createdAt / 1000) * 1000 - 2000
        || item.createdAt * 1000 > raw.grantExpiresAt + 120000) invalid()
      const entry = { id: item.id, account_id: item.accountId, created_at: item.createdAt * 1000,
        quota: item.quota, input_tokens: item.promptTokens, output_tokens: item.completionTokens }
      const key = JSON.stringify([authority, item.accountId, item.id]), previous = logs.get(key)
      if (previous && (previous.call !== raw.id || !isDeepStrictEqual(previous.entry, entry))) invalid()
      if (!previous && entry.created_at >= window.from && entry.created_at < window.to) entries.push(entry)
      logs.set(key, { call: raw.id, entry })
    }
    const notInvoked = raw.status === 'rejected' && !raw.routerToken && !raw.tokenCleanupPending
    const verified = !!authority && raw.ledgerStatus === 'router_verified' && raw.consumption.length > 0
    const startedInWindow = raw.createdAt >= window.from && raw.createdAt < window.to
    const pendingOverlap = !notInvoked && !verified && raw.createdAt < window.to && raw.grantExpiresAt + 120000 >= window.from
    if (!entries.length && !startedInWindow && !pendingOverlap) continue
    const call: AgentUsageCall = { id: raw.id, task_id: raw.taskId, asset_id: raw.assetId, owner_user_id: raw.ownerUserId,
      department_id: raw.departmentId, platform: raw.attribution?.sourcePlatform ?? null, asset_name: raw.attribution?.assetName ?? null,
      router_authority_id: authority, model: raw.model, status: raw.status, created_at: raw.createdAt, updated_at: raw.updatedAt,
      ledger_status: notInvoked ? 'not_invoked' : verified ? 'verified' : 'pending', token_cleanup: raw.tokenCleanupPending ? 'pending' : 'confirmed', entries }
    calls.push(call)
    const key = JSON.stringify([authority, call.department_id, call.platform, call.asset_id]), group = groups.get(key) ?? {
      ...empty(), department_id: call.department_id, department_name: null, platform: call.platform, asset_id: call.asset_id,
      asset_name: call.asset_name, router_authority_id: authority }
    // A rename within the interval must not label all historical calls as the newest name.
    if (group.asset_name !== call.asset_name) group.asset_name = null
    add(group, call); groups.set(key, group)
    const total = authorities.get(authority) ?? { ...empty(), router_authority_id: authority }
    add(total, call); authorities.set(authority, total)
  }
  return { kind: 'AgentUsageReport', authority: 'sudorouter', unit: 'router_quota', window, captured_at: capturedAt,
    coverage: 'execution_model_gateway_only', historical_attribution: 'captured_at_call',
    status: !calls.length ? 'no_records' : calls.some(c => c.ledger_status === 'pending' || !c.platform || c.token_cleanup === 'pending') ? 'partial' : 'verified',
    authorities: [...authorities.values()], groups: [...groups.values()], calls }
}

export class AgentUsageReports {
  constructor(private readonly db: DbDriver, private readonly ready: Promise<void>) {}
  async read(orgId: string, window: AgentUsageWindow): Promise<AgentUsageReport> {
    await this.ready
    // One statement gives a consistent set of immutable ledger facts even with concurrent completions.
    const field = (name: string) => this.db.kind === 'postgres' ? `CAST(document::jsonb ->> '${name}' AS BIGINT)` : `CAST(json_extract(document, '$.${name}') AS INTEGER)`
    const mode = this.db.kind === 'postgres' ? "document::jsonb ->> 'mode'" : "json_extract(document, '$.mode')"
    const rows = await this.db.all(`SELECT document FROM agent_model_calls WHERE org_id = ? AND (${mode}) = ?
      AND (${field('createdAt')}) < ? AND (${field('grantExpiresAt')}) + 120000 >= ? ORDER BY id LIMIT ${MAX_CALLS + 1}`,
      [orgId, window.mode, window.to + 2000, window.from])
    if (rows.length > MAX_CALLS) throw new ExternalProviderError(413, 'AGENT_USAGE_REPORT_LIMIT')
    return projectAgentUsage(orgId, window, rows.map(row => JSON.parse(String(row.document)) as ExecutionModelCall))
  }
}
