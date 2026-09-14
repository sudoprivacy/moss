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
 *
 * Why an admin token rather than each user's own key, which moss already
 * stores and which would be least privilege: the stored key is a `Token.Key`,
 * and SudoRouter accepts those only on `/v1/*`, its model API. The `/api/*`
 * console routes authenticate against a dashboard session or a personal access
 * token, which is a different column and a different format — 48 alphanumeric
 * characters for the former against base64 for the latter, which is how the
 * two are told apart. So reading a balance with the user's own credential is
 * not available, however much it ought to be.
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
  /** Points, for display. */
  cost: number | null
  /** The same figure in the gateway's own unit, summed before converting. */
  costQuota: number
}

export type GatewayAccount = {
  gatewayUserId: string
  /** The per-user key sessions spend. Returned once, at creation. */
  gatewayKey: string
  /** False when an account for this username already existed and was reused. */
  created: boolean
}

export type SudorouterClient = {
  getCredits(gatewayUserId: string): Promise<UserCredits>
  /**
   * Find or create this person's gateway account and issue their key.
   *
   * Find-or-create, not create: a username already known to the gateway keeps
   * its balance and history. Creating a second account for the same person
   * would strand whatever they already hold.
   */
  provisionAccount(input: {
    username: string
    displayName?: string
    initialPoints: number
  }): Promise<GatewayAccount>
  /** Positive credits, negative debits. `comment` lands in the gateway's audit trail. */
  addPoints(gatewayUserId: string, points: number, comment: string): Promise<void>
  /** Usage rows between two unix-second bounds, consumption only. */
  getModelUsage(gatewayUserId: string, fromSec: number, toSec: number): Promise<ModelUsageRow[]>
}

export type SudorouterErrorOutcome = 'refused' | 'unknown'

export class SudorouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly outcome: SudorouterErrorOutcome = status === undefined ? 'unknown' : 'refused',
  ) {
    super(message)
    this.name = 'SudorouterError'
  }
}

export function isSudorouterRefusal(error: unknown): boolean {
  return error instanceof SudorouterError && error.outcome === 'refused'
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
      throw new SudorouterError('SudoRouter admin token is not configured', undefined, 'refused')
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
        undefined,
        'unknown',
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
      throw new SudorouterError(`SudoRouter returned unparseable body: ${text.slice(0, 200)}`, undefined, 'unknown')
    }
    // SudoRouter answers 200 with `success: false` for application-level
    // refusals, so status alone does not tell you whether the call worked.
    if (body.success === false) {
      throw new SudorouterError(body.message || 'SudoRouter rejected the request', undefined, 'refused')
    }
    return body.data
  }


  /**
   * Issue the per-user key. `unlimited_quota` is set on the key on purpose:
   * the spending limit belongs to the account, and a second cap on the key
   * would silently stop a user who still has balance.
   */
  async function issueKey(gatewayUserId: string, username: string): Promise<string> {
    const token = await call('/api/token/', {
      method: 'POST',
      body: JSON.stringify({
        name: `${username}-token`,
        expired_time: -1,
        unlimited_quota: true,
        user_id: Number(gatewayUserId),
      }),
    }) as { key?: string } | undefined
    if (!token?.key) throw new SudorouterError('Gateway issued no key')
    return token.key
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

    async provisionAccount(input): Promise<GatewayAccount> {
      const username = input.username.trim()
      if (!username) throw new SudorouterError('Cannot provision an account without a username')

      // Reuse an existing account before creating one. The gateway holds the
      // balance, so a duplicate would strand whatever this person already has.
      const found = await call(
        `/api/user/search?${new URLSearchParams({ keyword: username, page: '1', page_size: '100' }).toString()}`,
      ) as { items?: unknown[] } | unknown[] | undefined
      const rows = Array.isArray(found) ? found : (found?.items ?? [])
      const existing = (rows as Array<Record<string, unknown>>).find(
        row => String(row.username ?? '') === username,
      )
      if (existing?.id != null) {
        return {
          gatewayUserId: String(existing.id),
          gatewayKey: await issueKey(String(existing.id), username),
          created: false,
        }
      }

      // The gateway validates these three at 20 characters and answers with a
      // field-validation blob, which surfaces as a failed sign-up for a reason
      // no one can act on. A phone number fits; a display name the user typed
      // may not, so it is trimmed here rather than rejected — the name is
      // cosmetic at the gateway, and moss keeps the full one.
      const GATEWAY_FIELD_MAX = 20
      if (username.length > GATEWAY_FIELD_MAX) {
        throw new SudorouterError(
          `Username is too long for the gateway (${username.length} > ${GATEWAY_FIELD_MAX})`,
        )
      }
      const created = await call('/api/user/', {
        method: 'POST',
        body: JSON.stringify({
          username,
          // The gateway requires a password it will never be asked for: moss
          // authenticates these people, and nothing signs in to the gateway
          // console as them. Derived rather than random so a re-provision after
          // a lost record produces the same account. Its own minimum is 8.
          password: username.length >= 8 ? username : username.padEnd(8, '1'),
          display_name: (input.displayName?.trim() || username).slice(0, GATEWAY_FIELD_MAX),
          role: 1,
          utm_source: 'sudowork',
        }),
      }) as { id?: number | string } | undefined
      if (created?.id == null) {
        throw new SudorouterError('Gateway accepted the account but returned no id')
      }
      const gatewayUserId = String(created.id)

      // Only a newly created account is granted the starting balance; a reused
      // one already has its own, and topping it up again on every provision
      // would hand out free credit per sign-in.
      if (input.initialPoints > 0) {
        await call('/api/user/quota', {
          method: 'PUT',
          body: JSON.stringify({
            id: Number(gatewayUserId),
            quota: pointsToQuota(input.initialPoints),
            comment: 'initial balance on sign-up',
          }),
        })
      }

      return { gatewayUserId, gatewayKey: await issueKey(gatewayUserId, username), created: true }
    },

    async addPoints(gatewayUserId: string, points: number, comment: string): Promise<void> {
      const id = Number(gatewayUserId)
      if (!Number.isInteger(id)) {
        throw new SudorouterError(`Gateway user id is not numeric: ${gatewayUserId}`, undefined, 'refused')
      }
      await call('/api/user/quota', {
        method: 'PUT',
        body: JSON.stringify({ id, quota: pointsToQuota(points), comment }),
      })
    },

    async getModelUsage(
      gatewayUserId: string,
      fromSec: number,
      toSec: number,
    ): Promise<ModelUsageRow[]> {
      // `time_from` / `time_to` in unix seconds, with paging — verified against
      // the live gateway. A `start_date` / `end_date` pair is accepted and then
      // silently ignored, which returns an unfiltered page and looks like it
      // worked.
      const params = new URLSearchParams({
        user_id: gatewayUserId,
        time_from: String(Math.floor(fromSec)),
        time_to: String(Math.ceil(toSec)),
        page_num: '1',
        page_size: '1000',
        order_by: 'created_at',
        desc: 'true',
      })
      const data = await call(`/api/log/query?${params.toString()}`)
      const rows = Array.isArray(data)
        ? data
        : ((data as { items?: unknown[]; data?: unknown[] })?.items
          ?? (data as { data?: unknown[] })?.data
          ?? [])
      if (!Array.isArray(rows)) return []
      return (rows as Array<Record<string, unknown>>)
        // `manage` rows are administrative quota adjustments, not consumption.
        // Counting them would report a top-up as spending.
        .filter(row => String(row.type ?? '') !== 'manage' && String(row.model_name ?? '') !== '')
        .map(row => {
          const prompt = Number(row.prompt_tokens ?? 0)
          const completion = Number(row.completion_tokens ?? 0)
          const seconds = Number(row.created_at ?? 0)
          return {
            date: seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : '',
            model: String(row.model_name ?? ''),
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: Number(row.total_tokens ?? prompt + completion),
            // The gateway names this `cost`, in quota. The client shows points
            // like every other figure it renders.
            cost: row.cost == null ? null : quotaToPoints(Number(row.cost)),
            /** Raw quota, kept for callers that sum before converting. */
            costQuota: Number(row.cost ?? 0),
          }
        })
    },
  }
}
