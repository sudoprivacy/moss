export interface QuotaSnapshot {
  externalUserId: string
  quotaUnits: number
  usedQuotaUnits: number
}

export interface ChangeQuotaInput {
  externalUserId: string
  deltaUnits: number
  comment: string
  idempotencyKey: string
}

export interface SudorouterPort {
  getUser(externalUserId: string): Promise<QuotaSnapshot | null>
  changeQuota(input: ChangeQuotaInput): Promise<{ success: boolean; error?: string }>
}

export interface SudorouterUserAccount extends QuotaSnapshot {
  username: string
}

export interface SudorouterUsageLog {
  id: string
  createdAtSeconds: number
  type: string
  model: string | null
  costQuotaUnits: number
  inputTokens: number
  outputTokens: number
}

export interface SudorouterUsagePort {
  listUsageLogs(input: {
    externalUserId: string
    fromSeconds: number
    toSeconds: number
    page: number
    pageSize: number
  }): Promise<{ list: SudorouterUsageLog[]; total: number }>
}

export interface SudorouterAccountPort extends SudorouterPort {
  findUserByUsername(username: string): Promise<SudorouterUserAccount | null>
  createUser(input: {
    username: string
    displayName: string
    idempotencyKey: string
  }): Promise<SudorouterUserAccount>
  createToken(input: {
    externalUserId: string
    name: string
    idempotencyKey: string
  }): Promise<string>
}

interface SudorouterAdapterOptions {
  baseUrl: string
  apiToken: string
  adminUserId?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

export function pointsToQuota(points: number): number {
  if (!Number.isSafeInteger(points)) throw new Error('Points must be a safe integer')
  return points * 500
}

export function quotaToPoints(quota: number): number {
  if (!Number.isSafeInteger(quota)) throw new Error('Quota must be a safe integer')
  return Math.round(quota * 0.002)
}

export class SudorouterAdapter implements SudorouterAccountPort {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: SudorouterAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? fetch
  }

  async getUser(externalUserId: string): Promise<QuotaSnapshot | null> {
    const response = await this.request(`${this.baseUrl}/api/user/${encodeURIComponent(externalUserId)}`, { method: 'GET' })
    const payload = await response.json() as { success?: boolean; data?: Record<string, unknown> }
    if (!response.ok || !payload.success || !payload.data) return null
    const quotaUnits = Number(payload.data.quota ?? 0)
    const usedQuotaUnits = Number(payload.data.used_quota ?? 0)
    if (!Number.isSafeInteger(quotaUnits) || !Number.isSafeInteger(usedQuotaUnits)) return null
    return { externalUserId, quotaUnits, usedQuotaUnits }
  }

  async listUsageLogs(input: {
    externalUserId: string
    fromSeconds: number
    toSeconds: number
    page: number
    pageSize: number
  }): Promise<{ list: SudorouterUsageLog[]; total: number }> {
    const numericId = Number(input.externalUserId)
    if (!Number.isSafeInteger(numericId) || numericId <= 0) throw new Error('Sudorouter user id is invalid')
    const query = new URLSearchParams({
      user_id: String(numericId),
      time_from: String(input.fromSeconds),
      time_to: String(input.toSeconds),
      page_num: String(input.page),
      page_size: String(input.pageSize),
      order_by: 'created_at',
      desc: 'true',
    })
    const response = await this.request(`${this.baseUrl}/api/log/query?${query.toString()}`, { method: 'GET' })
    const payload = await response.json() as {
      success?: boolean
      message?: string
      data?: { count?: unknown; data?: Array<Record<string, unknown>> }
    }
    if (!response.ok || !payload.success || !Array.isArray(payload.data?.data)) {
      throw new Error(payload.message || `Sudorouter usage query failed: HTTP ${response.status}`)
    }
    const list = payload.data.data.map((row): SudorouterUsageLog => ({
      id: String(row.id),
      createdAtSeconds: safeInteger(row.created_at, 'created_at'),
      type: String(row.type ?? ''),
      model: typeof row.model_name === 'string' && row.model_name ? row.model_name : null,
      costQuotaUnits: safeInteger(row.cost ?? 0, 'cost'),
      inputTokens: safeInteger(row.prompt_tokens ?? 0, 'prompt_tokens'),
      outputTokens: safeInteger(row.completion_tokens ?? 0, 'completion_tokens'),
    }))
    const total = safeInteger(payload.data.count ?? list.length, 'count')
    return { list, total }
  }

  async findUserByUsername(username: string): Promise<SudorouterUserAccount | null> {
    const normalized = username.trim()
    if (!normalized) throw new Error('Sudorouter username is required')
    const query = new URLSearchParams({ keyword: normalized, page: '1', page_size: '100' })
    const response = await this.request(`${this.baseUrl}/api/user/search?${query.toString()}`, { method: 'GET' })
    const payload = await response.json() as {
      success?: boolean
      message?: string
      data?: { items?: Array<Record<string, unknown>> }
    }
    if (!response.ok || !payload.success) {
      throw new Error(payload.message || `Sudorouter user search failed: HTTP ${response.status}`)
    }
    const matched = payload.data?.items?.find(item => (
      item.username === normalized
      && item.deleted_at == null
      && item.status !== 0
    ))
    return matched ? account(matched, normalized) : null
  }

  async createUser(input: {
    username: string
    displayName: string
    idempotencyKey: string
  }): Promise<SudorouterUserAccount> {
    const username = input.username.trim()
    if (!username) throw new Error('Sudorouter username is required')
    const response = await this.request(`${this.baseUrl}/api/user/`, {
      method: 'POST',
      headers: { 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({
        username,
        password: username.length >= 8 ? username : username.padEnd(8, '1'),
        display_name: input.displayName.trim() || username,
        role: 1,
        utm_source: 'sudowork',
      }),
    })
    const payload = await response.json() as { success?: boolean; message?: string; data?: Record<string, unknown> }
    if (!response.ok || !payload.success || !payload.data) {
      throw new Error(payload.message || `Sudorouter user creation failed: HTTP ${response.status}`)
    }
    return account(payload.data, username)
  }

  async createToken(input: {
    externalUserId: string
    name: string
    idempotencyKey: string
  }): Promise<string> {
    const numericId = Number(input.externalUserId)
    if (!Number.isSafeInteger(numericId) || numericId <= 0) throw new Error('Sudorouter user id is invalid')
    const response = await this.request(`${this.baseUrl}/api/token/`, {
      method: 'POST',
      headers: { 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({
        name: input.name.trim() || `${input.externalUserId}-token`,
        expired_time: -1,
        unlimited_quota: true,
        user_id: numericId,
      }),
    })
    const payload = await response.json() as { success?: boolean; message?: string; data?: { key?: unknown } }
    const token = typeof payload.data?.key === 'string' ? payload.data.key.trim() : ''
    if (!response.ok || !payload.success || !token) {
      throw new Error(payload.message || `Sudorouter token creation failed: HTTP ${response.status}`)
    }
    return token
  }

  async changeQuota(input: ChangeQuotaInput): Promise<{ success: boolean; error?: string }> {
    const numericId = Number(input.externalUserId)
    if (!Number.isSafeInteger(numericId) || numericId <= 0 || !Number.isSafeInteger(input.deltaUnits)) {
      return { success: false, error: 'Sudorouter 用户或额度无效' }
    }
    try {
      const response = await this.request(`${this.baseUrl}/api/user/quota`, {
        method: 'PUT',
        headers: { 'Idempotency-Key': input.idempotencyKey },
        body: JSON.stringify({ id: numericId, quota: input.deltaUnits, comment: input.comment }),
      })
      const payload = await response.json() as { success?: boolean; message?: string }
      return response.ok && payload.success
        ? { success: true }
        : { success: false, error: payload.message || `HTTP ${response.status}` }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000)
    const headers = new Headers(init.headers)
    headers.set('Content-Type', 'application/json')
    headers.set('Authorization', `Bearer ${this.options.apiToken}`)
    headers.set('New-Api-User', this.options.adminUserId ?? '13')
    try {
      return await this.fetchImpl(url, { ...init, headers, signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
  }
}

function safeInteger(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Sudorouter ${field} is invalid`)
  return parsed
}

function account(value: Record<string, unknown>, expectedUsername: string): SudorouterUserAccount {
  const externalUserId = String(value.id ?? '')
  const username = typeof value.username === 'string' ? value.username : expectedUsername
  const quotaUnits = Number(value.quota ?? 0)
  const usedQuotaUnits = Number(value.used_quota ?? 0)
  if (!/^\d+$/.test(externalUserId) || Number(externalUserId) <= 0
    || username !== expectedUsername
    || !Number.isSafeInteger(quotaUnits) || !Number.isSafeInteger(usedQuotaUnits)) {
    throw new Error('Sudorouter returned an invalid user account')
  }
  return { externalUserId, username, quotaUnits, usedQuotaUnits }
}
