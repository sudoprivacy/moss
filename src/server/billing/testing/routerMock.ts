import { createHash, randomBytes } from 'node:crypto'
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
    if (this.options.upstream && !path.startsWith('/api/integration/') && !path.startsWith('/__mock/')) {
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
    if (path === '/__mock/consume') {
      if (this.options.upstream) return failure('HYBRID_NOT_ENFORCED', 'Consumption simulation requires standalone mode', 409)
      const token = this.state.tokens.find(t => t.id === body.token_id)
      const account = this.state.accounts.find(a => a.id === token?.user_id)
      if (!token || !account || !Number.isSafeInteger(body.quota) || body.quota <= 0) return failure('INVALID', 'Invalid simulated consumption', 400)
      return this.consume(token, account, body.quota, 'mock-model') ?? ok()
    }
    const match = path.match(/^\/api\/integration\/v1\/users\/(\d+)\/tokens(?:\/(\d+)\/(status|quota-adjustments))?$/)
    if (match) {
      const userId = Number(match[1]); const account = this.state.accounts.find(a => a.id === userId)
      if (!account) return failure('NOT_FOUND', 'Account not mirrored in this mock; create it through the hybrid facade first', 404)
      if (!match[2] && request.method === 'GET') {
        const target = url.searchParams.get('token_id')
        const tokens = this.state.tokens.filter(t => t.user_id === userId && (!target || t.id === Number(target)))
        const page = Math.max(1, Number(url.searchParams.get('page') ?? 1)); const size = Math.min(100, Math.max(1, Number(url.searchParams.get('page_size') ?? 100)))
        return ok({ items: tokens.slice((page - 1) * size, page * size).map(t => this.project(t, account)), total: tokens.length, page, page_size: size })
      }
      const token = this.state.tokens.find(t => t.id === Number(match[2]) && t.user_id === userId)
      if (!token) return failure('NOT_FOUND', 'Token missing', 404)
      if (typeof body.reference !== 'string' || !body.reference) return failure('INVALID_REFERENCE', 'Reference required', 400)
      const scope = `${match[3]}:${body.reference}`
      const fingerprint = createHash('sha256').update(JSON.stringify([userId, token.id, body.status, body.delta_quota])).digest('hex')
      const previous = this.state.commands.find(([key]) => key === scope)?.[1]
      if (previous) return previous.fingerprint === fingerprint ? json({ ...(previous.response as Record<string, unknown>), idempotent_replay: true }) : failure('IDEMPOTENCY_CONFLICT', 'Reference reused', 409)
      if (match[3] === 'status' && request.method === 'PATCH') {
        if (!['enabled', 'disabled'].includes(body.status)) return failure('INVALID_STATUS', 'Invalid status', 400)
        if (body.status === 'enabled' && (token.expired_time !== -1 && token.expired_time <= Date.now() / 1000 || !token.unlimited_quota && token.remain_quota <= 0)) return failure('TOKEN_UNAVAILABLE', 'Key expired or exhausted', 422)
        token.admin_status = body.status
      } else if (match[3] === 'quota-adjustments' && request.method === 'POST') {
        if (token.unlimited_quota) return failure('QUOTA_MODE_CONFLICT', 'Key has no member limit', 409)
        if (!Number.isSafeInteger(body.delta_quota) || !body.delta_quota || !Number.isSafeInteger(token.remain_quota + body.delta_quota)) return failure('INVALID_AMOUNT', 'Invalid quota delta', 400)
        if (body.delta_quota < 0 && token.remain_quota + body.delta_quota < 0) return failure('INSUFFICIENT_QUOTA', 'Insufficient member limit', 422)
        token.remain_quota += body.delta_quota
      } else return failure('METHOD_NOT_ALLOWED', 'Invalid method', 405)
      const response = { success: true, reference: body.reference, idempotent_replay: false, data: this.project(token, account) }
      this.state.commands.push([scope, { fingerprint, response }]); this.save(); return json(response)
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
    if (!token.unlimited_quota) token.remain_quota -= quota
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
