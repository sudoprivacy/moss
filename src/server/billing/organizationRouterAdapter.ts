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
  listLogs(userId: number, username: string, page: number, pageSize: number): Promise<{ items: RouterLog[]; total: number }>
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
  integrationBaseUrl?: string
  timeoutMs?: number
  fetch?: RouterFetch
}

export class OrganizationRouterAdapter implements OrganizationRouterPort {
  readonly modelBaseUrl: string
  constructor(private readonly options: OrganizationRouterAdapterOptions) {
    this.modelBaseUrl = options.modelBaseUrl?.replace(/\/+$/, '') ?? `${options.baseUrl.replace(/\/+$/, '')}/v1`
  }

  private async request(path: string, method = 'GET', body?: unknown): Promise<Record<string, any>> {
    const base = path.startsWith('/api/integration/') ? this.options.integrationBaseUrl ?? this.options.baseUrl : this.options.baseUrl
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
    const items: RouterToken[] = []
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ page: String(page), page_size: '100' })
      if (tokenId !== undefined) query.set('token_id', String(integer(tokenId, 'token id', 1)))
      const payload = await this.request(`/api/integration/v1/users/${integer(userId, 'account id', 1)}/tokens?${query}`)
      if (!Array.isArray(payload.data?.items)) throw new RouterRequestError('Router Key list is invalid', 'unknown')
      const batch = payload.data.items.map(parseToken) as RouterToken[]
      if (batch.some(token => token.user_id !== userId || tokenId !== undefined && token.id !== tokenId)) {
        throw new RouterRequestError('Router returned Keys outside the requested scope', 'unknown')
      }
      items.push(...batch)
      if (!batch.length || items.length >= integer(payload.data.total, 'total', 0)) return items
      if (page >= 100) throw new RouterRequestError('Router Key pagination exceeded the supported range', 'unknown')
    }
  }
  async setTokenStatus(userId: number, tokenId: number, status: RouterAdminStatus, reference: string): Promise<RouterToken> {
    await this.request(`/api/integration/v1/users/${userId}/tokens/${tokenId}/status`, 'PATCH', { status, reference, reason: 'Moss member status' })
    return this.getToken(userId, tokenId)
  }
  async adjustTokenQuota(userId: number, tokenId: number, delta: number, reference: string): Promise<RouterToken> {
    await this.request(`/api/integration/v1/users/${userId}/tokens/${tokenId}/quota-adjustments`, 'POST', {
      delta_quota: integer(delta, 'quota delta'), reference, reason: 'Moss member limit adjustment',
    })
    return this.getToken(userId, tokenId)
  }
  private async getToken(userId: number, tokenId: number): Promise<RouterToken> {
    const token = (await this.listTokens(userId, tokenId))[0]
    if (!token) throw new RouterRequestError('Router Key not found after operation', 'unknown')
    return token
  }
  async listLogs(userId: number, username: string, page: number, pageSize: number): Promise<{ items: RouterLog[]; total: number }> {
    const query = new URLSearchParams({ username, p: String(integer(page, 'page', 1)), page_size: String(integer(pageSize, 'page size', 1)) })
    const payload = await this.request(`/api/log/?${query}`)
    if (!Array.isArray(payload.data?.items)) throw new RouterRequestError('Router log list is invalid', 'unknown')
    const items: RouterLog[] = payload.data.items.map((row: Record<string, any>) => ({
      id: String(row.id), user_id: integer(row.user_id, 'log user', 1), token_id: integer(row.token_id, 'log token', 0),
      created_at: integer(row.created_at, 'created at', 0), type: integer(row.type, 'log type', 0),
      model_name: String(row.model_name ?? ''), quota: integer(row.quota ?? 0, 'log quota'),
      prompt_tokens: integer(row.prompt_tokens ?? 0, 'input tokens', 0), completion_tokens: integer(row.completion_tokens ?? 0, 'output tokens', 0),
      request_id: String(row.request_id ?? ''),
    }))
    if (items.some(row => row.user_id !== userId)) throw new RouterRequestError('Router log scope mismatch', 'unknown')
    return { items, total: integer(payload.data.total, 'log total', 0) }
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
      : expired !== -1 && expired <= Date.now() / 1000 ? 'expired'
        : !row?.unlimited_quota && remaining <= 0 ? 'exhausted' : 'active'
  if (typeof row?.unlimited_quota !== 'boolean') throw new RouterRequestError('Invalid Router quota mode', 'unknown')
  return { id: integer(row.id, 'token id', 1), user_id: integer(row.user_id, 'token user', 1), name: String(row.name ?? ''),
    key_masked: typeof row.key_masked === 'string' ? row.key_masked : undefined,
    admin_status: admin, effective_status: effective, unlimited_quota: row.unlimited_quota,
    remain_quota: remaining, used_quota: integer(row.used_quota ?? 0, 'used quota', 0), expired_time: expired }
}
