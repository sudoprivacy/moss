import { randomBytes } from 'node:crypto'
import type { RouterAccount, RouterLog, RouterTokenCreated, RouterFetch } from '../organizationRouterAdapter.js'

interface MockState {
  accounts: RouterAccount[]
  tokens: RouterTokenCreated[]
  logs: RouterLog[]
  commands: Array<[string, { fingerprint: string; response: unknown }]>
  nextUserId: number
  nextTokenId: number
}
export interface RouterMockOptions {
  adminToken: string
  adminUserId?: string
  registrationQuota?: number
  state?: MockState
  save?: (state: MockState) => void
  upstream?: { baseUrl: string; apiToken: string; adminUserId: string }
  fetch?: RouterFetch
}

/** Loopback-only development double. Existing quota writes deliberately have no idempotency. */
export class RouterMock {
  private readonly state: MockState
  constructor(private readonly options: RouterMockOptions) {
    this.state = options.state ?? { accounts: [], tokens: [], logs: [], commands: [], nextUserId: 1000, nextTokenId: 2000 }
  }
  snapshot(): MockState { return structuredClone(this.state) }
  private save(): void { this.options.save?.(this.snapshot()) }
  readonly fetch: RouterFetch = async (input, init) => this.handle(input instanceof Request ? new Request(input, init) : new Request(String(input), init))
  async handle(request: Request): Promise<Response> {
    try { return await this.route(request) } catch {
      return failure('MOCK_REQUEST_FAILED', 'Invalid mock request or upstream unavailable', 503)
    }
  }
  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/$/, '')
    const key = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''
    if (path === '/health') return json({ mode: this.options.upstream ? 'hybrid' : 'standalone', simulated_new_interfaces: true })
    if (path.startsWith('/v1/') || path === '/api/usage/token' || path === '/api/v1/logs') {
      // Model discovery is read-only and must use the requesting member's Key.
      // Other model routes remain blocked in hybrid mode: local limits cannot enforce upstream inference.
      if (this.options.upstream && path === '/v1/models' && request.method === 'GET') {
        const token = this.state.tokens.find(t => t.key === key)
        if (!token) return failure('UNAUTHORIZED', 'Unknown model Key', 401)
        const response = await (this.options.fetch ?? fetch)(`${this.options.upstream.baseUrl.replace(/\/$/, '')}/v1/models`, {
          headers: { Authorization: `Bearer ${token.key}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
        })
        return json(await response.json(), response.status)
      }
      if (this.options.upstream) return failure('HYBRID_NOT_ENFORCED', 'Hybrid mode does not simulate actual upstream inference enforcement', 409)
      const token = this.state.tokens.find(t => t.key === key)
      if (!token) return failure('UNAUTHORIZED', 'Unknown model Key', 401)
      const account = this.state.accounts.find(a => a.id === token.user_id)!
      if (path === '/api/usage/token') return json({ code: true, data: { total_available: token.remain_quota, total_used: token.used_quota, unlimited_quota: token.unlimited_quota } })
      // Preserve the old upstream limitation; a mock must not claim it fixed the real endpoint.
      if (path === '/api/v1/logs') return json({ success: true, data: { data: this.state.logs.filter(l => l.user_id === token.user_id) } })
      if (path === '/v1/models') return json({ data: [{ id: 'mock-model', object: 'model' }] })
      if (path === '/v1/chat/completions' && request.method === 'POST') {
        const consumed = this.consume(token, account, 100, 'mock-model')
        if (consumed) return consumed
        return json({ id: 'mock-completion', object: 'chat.completion', model: 'mock-model', choices: [{ index: 0, message: { role: 'assistant', content: 'Local Router simulation.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
      }
      return failure('NOT_FOUND', 'Unknown model route', 404)
    }
    if (key !== this.options.adminToken || request.headers.get('New-Api-User') !== (this.options.adminUserId ?? '1')) return failure('UNAUTHORIZED', 'Invalid mock administrator', 401)
    const body = request.method === 'GET' ? {} : await request.json() as Record<string, any>
    const isTokenManagement = ['/api/user/tokens', '/api/user/token/status', '/api/user/token/quota'].includes(path)
    if (this.options.upstream && !isTokenManagement && !path.startsWith('/__mock/')) {
      return this.forward(request, body)
    }
    if (path === '/api/user/search') return ok({ items: this.state.accounts.filter(a => a.username.includes(url.searchParams.get('keyword') ?? '')) })
    if (path === '/api/user' && request.method === 'POST') {
      if (this.state.accounts.some(a => a.username === body.username)) return failure('DUPLICATE', 'Username exists', 409)
      const account: RouterAccount = { id: this.state.nextUserId++, username: body.username, quota: this.options.registrationQuota ?? 0, used_quota: 0, status: 1 }
      this.state.accounts.push(account); this.save()
      return ok({ id: account.id, username: account.username })
    }
    if (path === '/api/user/quota' && request.method === 'PUT') {
      const account = this.state.accounts.find(a => a.id === body.id)
      if (!account || !Number.isSafeInteger(body.quota)) return failure('INVALID', 'Invalid account or amount', 400)
      if (!Number.isSafeInteger(account.quota + body.quota)) return failure('INVALID', 'Amount out of range', 400)
      account.quota += body.quota; this.save(); return ok()
    }
    if (path === '/api/user/manage' && request.method === 'POST') {
      const account = this.state.accounts.find(a => a.id === body.id)
      if (!account || !['enable', 'disable'].includes(body.action)) return failure('INVALID', 'Invalid account action', 400)
      account.status = body.action === 'enable' ? 1 : 2; this.save(); return ok()
    }
    const userMatch = path.match(/^\/api\/user\/(\d+)$/)
    if (userMatch) {
      const account = this.state.accounts.find(a => a.id === Number(userMatch[1]))
      return account ? ok(account) : failure('NOT_FOUND', 'Account missing', 404)
    }
    if (path === '/api/token' && request.method === 'POST') {
      if (!this.state.accounts.some(a => a.id === body.user_id) || !Number.isSafeInteger(body.remain_quota) || body.remain_quota < 0) return failure('INVALID', 'Invalid token', 400)
      const token: RouterTokenCreated = { id: this.state.nextTokenId++, user_id: body.user_id, name: body.name, key: `sk-mock-${randomBytes(20).toString('hex')}`,
        admin_status: 'enabled', effective_status: 'active', unlimited_quota: body.unlimited_quota, remain_quota: body.remain_quota, used_quota: 0, expired_time: body.expired_time }
      this.state.tokens.push(token); this.save(); return ok(token)
    }
    if (path === '/api/log') {
      const account = this.state.accounts.find(a => a.username === url.searchParams.get('username'))
      const list = this.state.logs.filter(l => l.user_id === account?.id)
      const page = Math.max(1, Number(url.searchParams.get('p') ?? 1)); const size = Math.min(100, Math.max(1, Number(url.searchParams.get('page_size') ?? 100)))
      return ok({ items: list.slice((page - 1) * size, page * size), total: list.length })
    }
    if (path === '/api/log/query') {
      const name = url.searchParams.get('api_key_name')
      const list = this.state.logs.filter(log => log.user_id === Number(url.searchParams.get('user_id')) && log.type === 2)
        .map(log => ({ created_at: log.created_at, type: 'consumption',
          api_key_name: this.state.tokens.find(token => token.id === log.token_id)?.name ?? '', model_name: log.model_name,
          cost: log.quota, prompt_tokens: log.prompt_tokens, completion_tokens: log.completion_tokens, other: { request_id: log.request_id } }))
        .filter(log => !name || log.api_key_name === name).sort((a, b) => b.created_at - a.created_at)
      const page = Math.max(1, Number(url.searchParams.get('page_num') ?? 1))
      const size = Math.min(100, Math.max(1, Number(url.searchParams.get('page_size') ?? 20)))
      return ok({ data: list.slice((page - 1) * size, page * size), count: list.length })
    }
    if (path === '/__mock/consume') {
      if (this.options.upstream) return failure('HYBRID_NOT_ENFORCED', 'Consumption simulation requires standalone mode', 409)
      const token = this.state.tokens.find(t => t.id === body.token_id)
      const account = this.state.accounts.find(a => a.id === token?.user_id)
      if (!token || !account || !Number.isSafeInteger(body.quota) || body.quota <= 0) return failure('INVALID', 'Invalid simulated consumption', 400)
      return this.consume(token, account, body.quota, 'mock-model') ?? ok()
    }
    if (path === '/api/user/tokens' && request.method === 'GET') {
      const userId = Number(url.searchParams.get('user_id'))
      const account = this.state.accounts.find(a => a.id === userId)
      if (!account) return failure('NOT_FOUND', 'Account missing', 404)
      const target = url.searchParams.get('id')
      const tokens = this.state.tokens.filter(t => t.user_id === userId && (!target || t.id === Number(target)))
      return ok({ data: tokens.map(t => this.project(t, account)), count: tokens.length })
    }
    if (request.method === 'PUT' && ['/api/user/token/status', '/api/user/token/quota'].includes(path)) {
      const token = this.state.tokens.find(t => t.id === body.id)
      const account = this.state.accounts.find(a => a.id === token?.user_id)
      if (!token || !account) return failure('NOT_FOUND', 'Token missing', 404)
      if (path.endsWith('/status')) {
        if (!['enable', 'disabled'].includes(body.status)) return failure('INVALID_STATUS', 'Invalid status', 400)
        token.admin_status = body.status === 'enable' ? 'enabled' : 'disabled'
      } else {
        if (typeof body.unlimited_quota !== 'boolean' || !Number.isSafeInteger(body.delta_quota)) return failure('INVALID_AMOUNT', 'Invalid quota mode or amount', 400)
        if (!body.unlimited_quota) {
          const remaining = body.delta_quota === 0 ? 0 : token.remain_quota + body.delta_quota
          if (!Number.isSafeInteger(remaining) || remaining < 0) return failure('INSUFFICIENT_QUOTA', 'Insufficient member limit', 422)
          token.remain_quota = remaining
        }
        token.unlimited_quota = body.unlimited_quota
      }
      // Match the supplied API: repeated deltas apply again. Moss owns local deduplication.
      this.save(); return ok(this.project(token, account))
    }
    return failure('NOT_FOUND', 'Mock route not implemented', 404)
  }
  private project(token: RouterTokenCreated, account: RouterAccount): Record<string, unknown> {
    const { key, ...data } = token
    const effective = token.admin_status === 'disabled' ? 'disabled' : account.status !== 1 ? 'parent_disabled'
      : token.expired_time !== -1 && token.expired_time <= Date.now() / 1000 ? 'expired'
        : !token.unlimited_quota && token.remain_quota <= 0 ? 'exhausted' : 'active'
    return { ...data, status: effective === 'active' ? 'enabled' : effective, effective_status: effective, key_masked: `${key.slice(0, 6)}…${key.slice(-4)}` }
  }
  private consume(token: RouterTokenCreated, account: RouterAccount, quota: number, model: string): Response | null {
    if (this.project(token, account).effective_status !== 'active') return failure('KEY_UNAVAILABLE', 'Key unavailable', 403)
    if (account.quota < quota || !token.unlimited_quota && token.remain_quota < quota) return failure('INSUFFICIENT_QUOTA', '额度不足', 403)
    account.quota -= quota; account.used_quota += quota
    token.remain_quota -= quota
    token.used_quota += quota
    this.state.logs.push({ id: String(this.state.logs.length + 1), user_id: account.id, token_id: token.id, type: 2, created_at: Math.floor(Date.now() / 1000), quota, model_name: model, prompt_tokens: 10, completion_tokens: 10, request_id: `mock-${this.state.logs.length + 1}` })
    this.save(); return null
  }
  private async forward(request: Request, body: Record<string, any>): Promise<Response> {
    const upstream = this.options.upstream!
    const url = new URL(request.url)
    const response = await (this.options.fetch ?? fetch)(`${upstream.baseUrl.replace(/\/$/, '')}${url.pathname}${url.search}`, {
      method: request.method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstream.apiToken}`, 'New-Api-User': upstream.adminUserId },
      ...(request.method === 'GET' ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(10_000),
    })
    const payload = await response.json() as Record<string, any>
    if (payload.success === true) {
      const path = url.pathname.replace(/\/$/, '')
      if (path === '/api/user' && request.method === 'POST' && payload.data?.id) {
        this.state.accounts.push({ id: payload.data.id, username: body.username, quota: 0, used_quota: 0, status: 1 })
      } else if (/^\/api\/user\/\d+$/.test(path) && payload.data?.id) {
        const index = this.state.accounts.findIndex(a => a.id === payload.data.id)
        const account: RouterAccount = { id: payload.data.id, username: payload.data.username, quota: payload.data.quota, used_quota: payload.data.used_quota, status: payload.data.status }
        if (index >= 0) this.state.accounts[index] = account
        else this.state.accounts.push(account)
      } else if (path === '/api/token' && request.method === 'POST' && payload.data?.id && payload.data?.key) {
        this.state.tokens.push({ ...payload.data, key: payload.data.key.startsWith('sk-') ? payload.data.key : `sk-${payload.data.key}`, admin_status: 'enabled', effective_status: 'active' })
      }
      this.save()
    }
    return json(payload, response.status)
  }
}
function json(body: unknown, status = 200): Response { return Response.json(body, { status }) }
function ok(data?: unknown): Response { return json({ success: true, message: '', ...(data === undefined ? {} : { data }) }) }
function failure(code: string, message: string, status: number): Response { return json({ success: false, error: { code, message } }, status) }
