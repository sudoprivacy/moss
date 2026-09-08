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

export class SudorouterAdapter implements SudorouterPort {
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
