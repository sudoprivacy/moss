import { createHash } from 'node:crypto'
import { sudorouterInitialPassword } from './sudorouterAdapter.js'
import { requireInteger } from './modelMoney.js'

export type RouterAdminStatus = 'enabled' | 'disabled'
export type RouterEffectiveStatus = 'active' | 'disabled' | 'exhausted' | 'expired' | 'parent_disabled'
export interface RouterAccount {
  id: number
  username: string
  quota: number
  used_quota: number
  status: number
}
export interface RouterToken {
  id: number
  user_id: number
  name: string
  key_masked?: string
  admin_status: RouterAdminStatus
  effective_status: RouterEffectiveStatus
  unlimited_quota: boolean
  remain_quota: number
  used_quota: number
  expired_time: number
}
export interface RouterTokenCreated extends RouterToken { key: string }
export interface RouterLog {
  id: string
  user_id: number
  token_id: number
  created_at: number
  type: number
  model_name: string
  quota: number
  prompt_tokens: number
  completion_tokens: number
  request_id: string
  duration?: number
}
export interface OrganizationRouterPort {
  readonly modelBaseUrl: string
  createAccount(username: string, name: string): Promise<{ id: number; username: string }>
  findAccount(username: string): Promise<RouterAccount | null>
  getAccount(id: number): Promise<RouterAccount>
  changeAccountQuota(id: number, delta: number, comment: string): Promise<void>
  setAccountStatus(id: number, status: RouterAdminStatus): Promise<void>
  createToken(userId: number, name: string, limit: number | null): Promise<RouterTokenCreated>
  listTokens(userId: number, tokenId?: number): Promise<RouterToken[]>
  setTokenStatus(userId: number, tokenId: number, status: RouterAdminStatus, reference: string): Promise<RouterToken>
  adjustTokenQuota(userId: number, tokenId: number, delta: number, reference: string): Promise<RouterToken>
  setTokenLimitMode(userId: number, tokenId: number, limit: number | null, reference: string): Promise<RouterToken>
  listLogs(userId: number, page: number, pageSize: number, tokenId?: number): Promise<{ items: RouterLog[]; total: number }>
}

/** Unknown means a write might already have happened; never blindly retry an old API. */
export class RouterRequestError extends Error {
  constructor(message: string, readonly outcome: 'rejected' | 'unknown', readonly code = 'ROUTER_ERROR') {
    super(message)
  }
}

export type RouterFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export interface OrganizationRouterAdapterOptions {
  baseUrl: string
  apiToken: string
  adminUserId: string
  modelBaseUrl?: string
  timeoutMs?: number
  fetch?: RouterFetch
}

export class OrganizationRouterAdapter implements OrganizationRouterPort {
  readonly modelBaseUrl: string
  constructor(private readonly options: OrganizationRouterAdapterOptions) {
    this.modelBaseUrl = options.modelBaseUrl?.replace(/\/+$/, '') ?? `${options.baseUrl.replace(/\/+$/, '')}/v1`
  }

  private async request(path: string, method = 'GET', body?: unknown): Promise<Record<string, any>> {
    const base = this.options.baseUrl
    try {
      const response = await (this.options.fetch ?? fetch)(`${base.replace(/\/+$/, '')}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiToken}`, 'New-Api-User': this.options.adminUserId },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
        redirect: 'error',
      })
      const payload = await response.json() as Record<string, any>
      if (!response.ok || payload.success !== true) {
        const uncertain = response.status >= 500 || response.status === 202 || method !== 'GET' && response.ok
        throw new RouterRequestError('Router request did not complete', uncertain ? 'unknown' : 'rejected', String(payload.error?.code ?? 'ROUTER_ERROR'))
      }
      return payload
    } catch (error) {
      if (error instanceof RouterRequestError) throw error
      // Transport errors must not include credentials or raw upstream response bodies.
      throw new RouterRequestError('Router connection failed or response was invalid', 'unknown')
    }
  }

  async createAccount(username: string, name: string): Promise<{ id: number; username: string }> {
    const payload = await this.request('/api/user/', 'POST', {
      username, display_name: [...name].slice(0, 20).join(''), password: sudorouterInitialPassword(username), role: 1,
    })
    return { id: integer(payload.data?.id, 'account id', 1), username }
  }
  async findAccount(username: string): Promise<RouterAccount | null> {
    const payload = await this.request(`/api/user/search?${new URLSearchParams({ keyword: username, p: '1', page_size: '100' })}`)
    const item = payload.data?.items?.find((row: Record<string, unknown>) => row.username === username && row.deleted_at == null)
    return item ? parseAccount(item) : null
  }
  async getAccount(id: number): Promise<RouterAccount> {
    const payload = await this.request(`/api/user/${integer(id, 'account id', 1)}`)
    const account = parseAccount(payload.data)
    if (account.id !== id) throw new RouterRequestError('Router returned a different account', 'unknown')
    return account
  }
  async changeAccountQuota(id: number, delta: number, comment: string): Promise<void> {
    await this.request('/api/user/quota', 'PUT', { id: integer(id, 'account id', 1), quota: integer(delta, 'quota delta'), comment })
  }
  async setAccountStatus(id: number, status: RouterAdminStatus): Promise<void> {
    await this.request('/api/user/manage', 'POST', { id: integer(id, 'account id', 1), action: status === 'enabled' ? 'enable' : 'disable' })
  }
  async createToken(userId: number, name: string, limit: number | null): Promise<RouterTokenCreated> {
    const payload = await this.request('/api/token/', 'POST', {
      user_id: integer(userId, 'account id', 1), name, expired_time: -1,
      unlimited_quota: limit === null, remain_quota: limit === null ? 0 : integer(limit, 'member limit', 0),
    })
    const token = parseToken(payload.data)
    if (token.user_id !== userId || typeof payload.data?.key !== 'string' || !payload.data.key.trim()) {
      throw new RouterRequestError('Router returned an invalid created Key', 'unknown')
    }
    return { ...token, key: payload.data.key.startsWith('sk-') ? payload.data.key : `sk-${payload.data.key}` }
  }
  async listTokens(userId: number, tokenId?: number): Promise<RouterToken[]> {
    const query = new URLSearchParams({ user_id: String(integer(userId, 'account id', 1)) })
    if (tokenId !== undefined) query.set('id', String(integer(tokenId, 'token id', 1)))
    const payload = await this.request(`/api/user/tokens?${query}`)
    if (!Array.isArray(payload.data?.data)) throw new RouterRequestError('Router Key list is invalid', 'unknown')
    const items = payload.data.data.map(parseToken) as RouterToken[]
    if (items.some(token => token.user_id !== userId || tokenId !== undefined && token.id !== tokenId)
      || new Set(items.map(token => token.id)).size !== items.length) {
      throw new RouterRequestError('Router returned Keys outside the requested scope', 'unknown')
    }
    // The supplied API has no pagination contract. Never silently display a partial list.
    if (items.length !== integer(payload.data.count, 'total', 0)) throw new RouterRequestError('Router Key list is incomplete', 'unknown')
    const account = await this.getAccount(userId)
    return items.map(token => account.status !== 1 && token.admin_status !== 'disabled' ? { ...token, effective_status: 'parent_disabled' } : token)
  }
  async setTokenStatus(userId: number, tokenId: number, status: RouterAdminStatus, reference: string): Promise<RouterToken> {
    await this.getToken(userId, tokenId)
    const payload = await this.request('/api/user/token/status', 'PUT', {
      id: tokenId, status: status === 'enabled' ? 'enable' : 'disabled', comment: `Moss member status ${reference}`,
    })
    return this.validateToken(payload.data, userId, tokenId)
  }
  async adjustTokenQuota(userId: number, tokenId: number, delta: number, reference: string): Promise<RouterToken> {
    const token = await this.getToken(userId, tokenId)
    if (token.unlimited_quota) throw new RouterRequestError('Unlimited Key has no member limit to adjust', 'rejected', 'QUOTA_MODE_CONFLICT')
    const change = integer(delta, 'quota delta')
    if (!change || !Number.isSafeInteger(token.remain_quota + change) || token.remain_quota + change < 0) {
      throw new RouterRequestError('Invalid remaining member limit', 'rejected', 'INVALID_LIMIT')
    }
    // comment is audit context only; this delta endpoint has no documented deduplication.
    const payload = await this.request('/api/user/token/quota', 'PUT', {
      id: tokenId, delta_quota: change, unlimited_quota: false, comment: `Moss member limit ${reference}`,
    })
    return this.validateToken(payload.data, userId, tokenId)
  }
  private validateToken(row: Record<string, any>, userId: number, tokenId: number): RouterToken {
    const token = parseToken(row)
    if (token.user_id !== userId || token.id !== tokenId) throw new RouterRequestError('Router Key scope mismatch', 'unknown')
    return token
  }
  async setTokenLimitMode(userId: number, tokenId: number, limit: number | null, reference: string): Promise<RouterToken> {
    const before = await this.getToken(userId, tokenId)
    if (before.unlimited_quota === (limit === null)) return before
    // The real API treats a zero finite delta as RESET, and nonzero values as
    // increments even when changing modes. Reset first, then add the new budget.
    // This preserves concurrent consumption after the reset (no snapshot overwrite).
    // The caller durably fences the whole command; a partial/unknown result cannot replay.
    const amount = limit === null ? 0 : integer(limit, 'remaining limit', 0)
    let resetCompleted = false
    try {
      let payload = await this.request('/api/user/token/quota', 'PUT', {
        id: tokenId, unlimited_quota: limit === null, delta_quota: 0, comment: `Moss limit mode reset ${reference}`,
      })
      resetCompleted = true
      let after = this.validateToken(payload.data, userId, tokenId)
      if (after.unlimited_quota !== (limit === null) || after.admin_status !== before.admin_status) throw new RouterRequestError('Router limit mode result requires review', 'unknown')
      if (limit !== null && amount > 0) {
        payload = await this.request('/api/user/token/quota', 'PUT', {
          id: tokenId, unlimited_quota: false, delta_quota: amount, comment: `Moss limit mode budget ${reference}`,
        })
        after = this.validateToken(payload.data, userId, tokenId)
        if (after.unlimited_quota || after.admin_status !== before.admin_status) throw new RouterRequestError('Router limit budget result requires review', 'unknown')
      }
      return after
    } catch (error) {
      if (resetCompleted) throw new RouterRequestError('Limit mode partly applied; reconcile before any further adjustment', 'unknown', 'LIMIT_MODE_NEEDS_REVIEW')
      throw error
    }
  }
  private async getToken(userId: number, tokenId: number): Promise<RouterToken> {
    const token = (await this.listTokens(userId, tokenId))[0]
    if (!token) throw new RouterRequestError('Router Key not found after operation', 'unknown')
    return token
  }
  async listLogs(userId: number, page: number, pageSize: number, tokenId?: number): Promise<{ items: RouterLog[]; total: number }> {
    const tokens = await this.listTokens(userId)
    const target = tokenId === undefined ? undefined : tokens.find(token => token.id === tokenId)
    // Names are the upstream filter. Missing or duplicate names cannot safely identify a member.
    if (tokenId !== undefined && (!target?.name || tokens.filter(token => token.name === target.name).length !== 1)) {
      throw new RouterRequestError('Router log Key name is missing or ambiguous', 'unknown')
    }
    const query = new URLSearchParams({ user_id: String(integer(userId, 'account id', 1)), type: 'consumption',
      page_num: String(integer(page, 'page', 1)), page_size: String(integer(pageSize, 'page size', 1)), order_by: 'created_at', desc: 'true' })
    if (target) query.set('api_key_name', target.name)
    const payload = await this.request(`/api/log/query?${query}`)
    if (!Array.isArray(payload.data?.data)) throw new RouterRequestError('Router log list is invalid', 'unknown')
    const total = integer(payload.data.count, 'log total', 0)
    if (payload.data.data.length > pageSize || payload.data.data.length > total) throw new RouterRequestError('Router log pagination is invalid', 'unknown')
    const items: RouterLog[] = payload.data.data.map((row: Record<string, any>, index: number) => {
      if (row?.type !== 'consumption' || typeof row.api_key_name !== 'string' || target && row.api_key_name !== target.name) {
        throw new RouterRequestError('Router log scope mismatch', 'unknown')
      }
      const matches = tokens.filter(token => token.name === row.api_key_name)
      const log = { user_id: userId, token_id: target?.id ?? (matches.length === 1 ? matches[0]!.id : 0),
        created_at: integer(row.created_at, 'created at', 0), type: 2,
        model_name: String(row.model_name ?? ''), quota: integer(row.cost, 'log quota', 0),
        prompt_tokens: integer(row.prompt_tokens ?? 0, 'input tokens', 0), completion_tokens: integer(row.completion_tokens ?? 0, 'output tokens', 0),
        request_id: String(row.other?.request_id ?? row.other?.x_request_id ?? ''),
        ...(typeof row.duration === 'number' && Number.isFinite(row.duration) && row.duration >= 0 ? { duration: row.duration } : {}),
      }
      // This API has no record ID. Supply a display key, not a purported upstream ID.
      return { ...log, id: `query-${createHash('sha256').update(JSON.stringify([log, row.api_key_name, page, index])).digest('hex').slice(0, 24)}` }
    })
    return { items, total }
  }
}

function integer(value: unknown, field: string, minimum = -Number.MAX_SAFE_INTEGER): number {
  try { return requireInteger(value, field, minimum) } catch { throw new RouterRequestError(`Invalid Router ${field}`, 'unknown') }
}
function parseAccount(row: Record<string, any>): RouterAccount {
  return { id: integer(row?.id, 'account id', 1), username: String(row.username), quota: integer(row.quota, 'quota'), used_quota: integer(row.used_quota, 'used quota', 0), status: integer(row.status, 'status', 0) }
}
function parseToken(row: Record<string, any>): RouterToken {
  const admin: RouterAdminStatus = row?.admin_status === 'disabled' || row?.status === 'disabled' || row?.status === 2 ? 'disabled' : 'enabled'
  const remaining = integer(row?.remain_quota, 'remaining quota')
  const expired = integer(row?.expired_time, 'expiry', -1)
  const effective: RouterEffectiveStatus = admin === 'disabled' ? 'disabled'
    : row?.effective_status === 'parent_disabled' ? 'parent_disabled'
      : row?.status === 3 || expired !== -1 && expired <= Date.now() / 1000 ? 'expired'
        : row?.status === 4 || !row?.unlimited_quota && remaining <= 0 ? 'exhausted' : 'active'
  if (typeof row?.unlimited_quota !== 'boolean') throw new RouterRequestError('Invalid Router quota mode', 'unknown')
  return { id: integer(row.id, 'token id', 1), user_id: integer(row.user_id, 'token user', 1), name: String(row.name ?? ''),
    key_masked: typeof (row.key_masked ?? row.key) === 'string' ? `${String(row.key_masked ?? row.key).slice(0, 4)}****${String(row.key_masked ?? row.key).slice(-4)}` : undefined,
    admin_status: admin, effective_status: effective, unlimited_quota: row.unlimited_quota,
    remain_quota: remaining, used_quota: integer(row.used_quota ?? 0, 'used quota', 0), expired_time: expired }
}
