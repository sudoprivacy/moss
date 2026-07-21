/**
 * Body-level "unauthorized" detection for the auth proxy's re-mint-and-retry
 * path.
 *
 * Some upstreams never return an HTTP 401 for an invalidated session: they
 * reply HTTP 200 with an envelope like `{"code":401,"message":"登录失效"}`.
 * PR #139's re-mint only fires on an HTTP 401 status, so those replies slip
 * through and surface to the caller as a spurious auth error.
 *
 * A config item can opt in to body-level detection by storing a JSON recipe in
 * its `body_auth_check` column:
 *
 *   {
 *     "field": "code",                  // dotted path into the JSON body
 *     "unauthorizedValues": [401, "401"] // values that mean "re-mint & retry"
 *   }
 *
 * `field` defaults to "code" and `unauthorizedValues` defaults to [401, "401"]
 * when omitted, so `{}` (or even `{"field":"errCode"}`) is a valid minimal
 * recipe. A null/absent column keeps today's HTTP-status-only behavior.
 */

export interface BodyAuthCheckRecipe {
  /** Dotted path to the status field in the JSON body, e.g. "code", "data.code". */
  field?: string
  /** Values (loosely compared) that indicate an unauthorized/expired session. */
  unauthorizedValues?: Array<string | number>
}

const DEFAULT_FIELD = 'code'
const DEFAULT_UNAUTHORIZED: Array<string | number> = [401, '401']

/** Resolve a dotted path (e.g. "data.code") in a parsed JSON object. */
function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return cur
}

/**
 * Parse a config item's `body_auth_check` column into a recipe. Returns null
 * (detection disabled) for a null/empty/invalid value — a bad recipe must never
 * throw in the request path or change the default HTTP-only behavior.
 */
export function parseBodyAuthCheck(raw: string | null | undefined): BodyAuthCheckRecipe | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const r = parsed as Record<string, unknown>
    const recipe: BodyAuthCheckRecipe = {}
    if (typeof r.field === 'string' && r.field.trim()) recipe.field = r.field.trim()
    if (Array.isArray(r.unauthorizedValues)) {
      const vals = r.unauthorizedValues.filter(
        (v): v is string | number => typeof v === 'string' || typeof v === 'number',
      )
      if (vals.length > 0) recipe.unauthorizedValues = vals
    }
    return recipe
  } catch {
    return null
  }
}

/**
 * Given a recipe and a raw upstream response body, report whether the body
 * signals an unauthorized/expired session (so the proxy should re-mint & retry).
 *
 * Non-JSON bodies, a missing field, or a non-matching value all return false —
 * detection is strictly additive and only fires on a positive match.
 */
export function bodyIndicatesUnauthorized(
  recipe: BodyAuthCheckRecipe | null,
  body: Buffer | string,
): boolean {
  if (!recipe) return false
  const text = typeof body === 'string' ? body : body.toString('utf8')
  if (!text.trim()) return false
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return false // body isn't JSON — can't have a code:401 envelope
  }
  const field = recipe.field ?? DEFAULT_FIELD
  const actual = getByPath(json, field)
  if (actual === undefined || actual === null) return false
  const wanted = recipe.unauthorizedValues ?? DEFAULT_UNAUTHORIZED
  // Loose comparison: the envelope may carry 401 as a number or a string, and
  // admins may configure either — compare by string form so both match.
  const actualStr = String(actual)
  return wanted.some(v => String(v) === actualStr)
}
