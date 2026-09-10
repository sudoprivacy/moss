/**
 * The credit ledger, which lives in SudoRouter rather than in moss.
 *
 * moss deliberately keeps no balance of its own. A user's credits are spent by
 * the model gateway as requests flow through it, so the gateway is the only
 * component that can know the real number; a copy held here would be wrong
 * between every request and every reconciliation. moss stores the user's
 * gateway id and asks.
 *
 * Two admin endpoints are all this needs, both already present in SudoRouter:
 * `GET /api/user/:id` to read, `PUT /api/user/quota` to credit.
 */

/**
 * Points are what users see; quota is what the gateway counts in.
 *
 * The factor is 500, measured against the previous server's own export (its
 * `balance` and `quota` columns hold this ratio for every account) — not
 * derived from SudoRouter's `QuotaPerUnit`, which is 500000 and denominates
 * dollars. Getting this wrong is silent and severe: at 500000 every user would
 * be shown a thousandth of the balance they actually hold.
 */
const QUOTA_PER_POINT = 500

export function quotaToPoints(quota: number): number {
  return Math.round(quota / QUOTA_PER_POINT)
}

export function pointsToQuota(points: number): number {
  return Math.round(points * QUOTA_PER_POINT)
}

export type UserCredits = {
  remainingPoints: number
  usedPoints: number
}

export type ModelUsageRow = {
  date: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cost: number | null
}

export type SudorouterClient = {
  getCredits(gatewayUserId: string): Promise<UserCredits>
  /** Positive credits, negative debits. `comment` lands in the gateway's audit trail. */
  addPoints(gatewayUserId: string, points: number, comment: string): Promise<void>
  getModelUsage(gatewayUserId: string, startDate: string, endDate: string): Promise<ModelUsageRow[]>
}

export class SudorouterError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'SudorouterError'
  }
}

export type SudorouterConfig = {
  /** Root URL, no `/v1` and no trailing slash. */
  baseUrl: string
  /** Admin token. Held by the caller, which reads it from the vault per call. */
  getAdminToken: () => Promise<string>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

export function createSudorouterClient(config: SudorouterConfig): SudorouterClient {
  const doFetch = config.fetchImpl ?? fetch
  const root = config.baseUrl.replace(/\/+$/, '')

  async function call(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await config.getAdminToken()
    if (!token) {
      throw new SudorouterError('SudoRouter admin token is not configured')
    }
    let res: Response
    try {
      res = await doFetch(`${root}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
    } catch (error) {
      // A network failure and a refusal are different outcomes for a credit
      // operation: one may have applied, the other did not. The caller
      // distinguishes them, so do not flatten this into a generic message.
      throw new SudorouterError(
        `SudoRouter unreachable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const text = await res.text()
    if (!res.ok) {
      throw new SudorouterError(`SudoRouter returned ${res.status}: ${text.slice(0, 200)}`, res.status)
    }
    let body: { success?: boolean; message?: string; data?: unknown }
    try {
      body = JSON.parse(text)
    } catch {
      throw new SudorouterError(`SudoRouter returned unparseable body: ${text.slice(0, 200)}`)
    }
    // SudoRouter answers 200 with `success: false` for application-level
    // refusals, so status alone does not tell you whether the call worked.
    if (body.success === false) {
      throw new SudorouterError(body.message || 'SudoRouter rejected the request')
    }
    return body.data
  }

  return {
    async getCredits(gatewayUserId: string): Promise<UserCredits> {
      const data = await call(`/api/user/${encodeURIComponent(gatewayUserId)}`) as
        { quota?: number; used_quota?: number } | undefined
      return {
        remainingPoints: quotaToPoints(Number(data?.quota ?? 0)),
        usedPoints: quotaToPoints(Number(data?.used_quota ?? 0)),
      }
    },

    async addPoints(gatewayUserId: string, points: number, comment: string): Promise<void> {
      const id = Number(gatewayUserId)
      if (!Number.isInteger(id)) {
        throw new SudorouterError(`Gateway user id is not numeric: ${gatewayUserId}`)
      }
      await call('/api/user/quota', {
        method: 'PUT',
        body: JSON.stringify({ id, quota: pointsToQuota(points), comment }),
      })
    },

    async getModelUsage(
      gatewayUserId: string,
      startDate: string,
      endDate: string,
    ): Promise<ModelUsageRow[]> {
      const params = new URLSearchParams({
        user_id: gatewayUserId,
        start_date: startDate,
        end_date: endDate,
      })
      const data = await call(`/api/log/query?${params.toString()}`)
      const rows = Array.isArray(data) ? data : (data as { items?: unknown[] })?.items
      if (!Array.isArray(rows)) return []
      return rows.map(raw => {
        const row = raw as Record<string, unknown>
        const prompt = Number(row.prompt_tokens ?? 0)
        const completion = Number(row.completion_tokens ?? row.completion ?? 0)
        return {
          date: String(row.date ?? row.created_at ?? ''),
          model: String(row.model_name ?? row.model ?? ''),
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: Number(row.total_tokens ?? prompt + completion),
          // Cost is reported in quota; the client labels this column in points
          // like every other number it shows.
          cost: row.quota == null ? null : quotaToPoints(Number(row.quota)),
        }
      })
    },
  }
}
