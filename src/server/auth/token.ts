import { createHmac, timingSafeEqual, randomUUID } from 'crypto'

export type AccessTokenClaims = {
  iss: string
  sub: string
  org_id: string
  role: string
  scopes: string[]
  key_id: string
  jti: string
  type: 'access' | 'refresh'
  iat: number
  exp: number
}

export type AuthContext = {
  rawToken: string
  userId: string
  orgId: string
  role: string
  scopes: string[]
  keyId: string
  jti: string
  exp: number
  /** Document Center: set when the token was issued for an in-container scode session. */
  assistantId?: string | null
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
  const remainder = padded.length % 4
  const normalized =
    remainder === 0 ? padded : `${padded}${'='.repeat(4 - remainder)}`
  return Buffer.from(normalized, 'base64')
}

function signHs256(payload: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(payload).digest())
}

export function issueAccessToken(
  claims: Omit<AccessTokenClaims, 'iat' | 'exp' | 'type' | 'jti'>,
  secret: string,
  expiresInSec = 60 * 60,
  type: 'access' | 'refresh' = 'access',
): {
  token: string
  expiresAt: number
} {
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = issuedAt + expiresInSec
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload: AccessTokenClaims = {
    ...claims,
    type,
    jti: randomUUID(),
    iat: issuedAt,
    exp: expiresAt,
  }

  const encodedHeader = base64UrlEncode(JSON.stringify(header))
  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = signHs256(signingInput, secret)

  return {
    token: `${signingInput}.${signature}`,
    expiresAt,
  }
}

/**
 * Document Center: sign a short-lived bearer token that moss-server injects
 * into the scode container via SESSION_TOKEN env var. The wikiCli reads it
 * and forwards as `Authorization: Bearer ...` on every /api/v1/agent/wikis
 * call.
 *
 * The token claims include an extra `assistant_id` field on top of the
 * standard AccessTokenClaims; the server-side handler will use it to
 * restrict which wikis are visible (see admin scope check + agent
 * `enabledWikis` filter in `/api/v1/agent/wikis*` handlers).
 *
 * Default TTL: 24h — aligned with typical session length. Caller may
 * override.
 */
export function issueWikiSessionToken(params: {
  secret: string
  issuer: string
  userId: string
  orgId: string
  role: string
  scopes: string[]
  keyId: string
  assistantName: string | null
  expiresInSec?: number
}): { token: string; expiresAt: number } {
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = issuedAt + (params.expiresInSec ?? 24 * 60 * 60)
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload: AccessTokenClaims & { assistant_id: string | null } = {
    iss: params.issuer,
    sub: params.userId,
    org_id: params.orgId,
    role: params.role,
    scopes: params.scopes,
    key_id: params.keyId,
    jti: randomUUID(),
    type: 'access',
    iat: issuedAt,
    exp: expiresAt,
    assistant_id: params.assistantName,
  }

  const encodedHeader = base64UrlEncode(JSON.stringify(header))
  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = signHs256(signingInput, params.secret)

  return {
    token: `${signingInput}.${signature}`,
    expiresAt,
  }
}

export function verifyAccessToken(
  token: string,
  secret: string,
  expectedIssuer?: string,
  expectedType: 'access' | 'refresh' = 'access',
): AuthContext | null {
  const parts = token.split('.')
  if (parts.length !== 3) {
    return null
  }

  const [encodedHeader, encodedPayload, signature] = parts
  if (!encodedHeader || !encodedPayload || !signature) {
    return null
  }

  let header: { alg?: string; typ?: string }
  let payload: AccessTokenClaims
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8')) as {
      alg?: string
      typ?: string
    }
    payload = JSON.parse(
      base64UrlDecode(encodedPayload).toString('utf8'),
    ) as AccessTokenClaims
  } catch {
    return null
  }

  if (header.alg !== 'HS256' || header.typ !== 'JWT') {
    return null
  }

  const expectedSignature = signHs256(
    `${encodedHeader}.${encodedPayload}`,
    secret,
  )
  const receivedBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expectedSignature)
  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    return null
  }

  const now = Math.floor(Date.now() / 1000)
  if (
    payload.type !== expectedType ||
    typeof payload.sub !== 'string' ||
    typeof payload.org_id !== 'string' ||
    typeof payload.key_id !== 'string' ||
    typeof payload.jti !== 'string' ||
    typeof payload.role !== 'string' ||
    !Array.isArray(payload.scopes) ||
    typeof payload.exp !== 'number' ||
    payload.exp <= now
  ) {
    return null
  }

  if (expectedIssuer && payload.iss !== expectedIssuer) {
    return null
  }

  return {
    rawToken: token,
    userId: payload.sub,
    orgId: payload.org_id,
    role: payload.role,
    scopes: payload.scopes,
    keyId: payload.key_id,
    jti: payload.jti,
    exp: payload.exp,
    assistantId:
      typeof (payload as AccessTokenClaims & { assistant_id?: unknown }).assistant_id === 'string'
        ? (payload as AccessTokenClaims & { assistant_id: string }).assistant_id
        : (payload as AccessTokenClaims & { assistant_id?: unknown }).assistant_id === null
          ? null
          : undefined,
  }
}

export function hasScope(scopes: string[], requiredScope: string): boolean {
  if (
    scopes.includes('*') ||
    scopes.includes(requiredScope) ||
    scopes.includes(`${requiredScope.split(':')[0]}:*`)
  ) {
    return true
  }
  return false
}

/**
 * Admin capability for cron gating: admin/super_admin roles or the admin:cron
 * scope. clientCronEnabled gates client-issued cron actions only — actors with
 * this capability bypass the gate on both the API routes and the scheduler's
 * owner check (#83).
 */
export function isCronAdminCapable(auth: { role: string; scopes?: string[] }): boolean {
  return auth.role === 'admin' || auth.role === 'super_admin' || hasScope(auth.scopes ?? [], 'admin:cron')
}

/**
 * Full-admin capability: the admin/super_admin roles, or a token carrying the
 * wildcard `*` scope. Used as the shared "is this an unrestricted actor" test
 * for the split credential/store/cron scopes below, so a dept_admin or user
 * with a narrow scope is never mistaken for an admin.
 */
function isFullAdmin(auth: { role: string; scopes?: string[] }): boolean {
  return auth.role === 'admin' || auth.role === 'super_admin' || hasScope(auth.scopes ?? [], '*')
}

/**
 * May view department-scope credentials (and, per Phase F, set a per-department
 * value). Full admins qualify via `admin:secrets`; a dept_admin qualifies via
 * the narrower `secrets:department:read`.
 */
export function canReadDepartmentSecrets(auth: { role: string; scopes?: string[] }): boolean {
  const scopes = auth.scopes ?? []
  return isFullAdmin(auth) || hasScope(scopes, 'admin:secrets') || hasScope(scopes, 'secrets:department:read')
}

/**
 * May set own user-credential values. Full admins qualify via `admin:secrets`;
 * dept_admin and user qualify via `secrets:user:write`. The per-namespace
 * ownership check (`user:{userId}:`) still applies on top of this.
 */
export function canWriteUserSecrets(auth: { role: string; scopes?: string[] }): boolean {
  const scopes = auth.scopes ?? []
  return isFullAdmin(auth) || hasScope(scopes, 'admin:secrets') || hasScope(scopes, 'secrets:user:write')
}

/**
 * May view any credential audit / rotation surface (subject to server-side
 * actor/scope narrowing): a full admin, a dept_admin (department secrets), or a
 * user (own user secrets).
 */
export function canReadSecretAudit(auth: { role: string; scopes?: string[] }): boolean {
  return canReadDepartmentSecrets(auth) || canWriteUserSecrets(auth)
}

/**
 * Full store admin: may install hub items, approve tenant items, sync, and set
 * arbitrary visibility. A dept_admin/user with `store:read`/`store:tenant:write`
 * is NOT a store admin — those grant view + scoped tenant/custom management only.
 */
export function isStoreAdmin(auth: { role: string; scopes?: string[] }): boolean {
  return isFullAdmin(auth) || hasScope(auth.scopes ?? [], 'admin:settings')
}

/**
 * Org-pinned user lookup, except a super_admin resolves regardless of org.
 * A super_admin may have switched their effective org (see AuthService.switchOrg),
 * so lookups keyed by the switched org won't find their home-org record — that
 * broke cron execution and author stamping for resources created while
 * switched. Every other role stays pinned to its home org to preserve
 * isolation. Mirrors the requireAuthUser pattern. Lives here (not service.ts)
 * so it is unit-testable under bun:test, which cannot load node:sqlite.
 */
export function resolveUserPinnedOrSuperAdmin<U extends { role: string }>(
  userId: string,
  orgId: string,
  db: {
    getUserByIdAndOrg(id: string, orgId: string): U | null
    getUserById(id: string): U | null
  },
): U | null {
  const user = db.getUserByIdAndOrg(userId, orgId)
  if (user) {
    return user
  }
  const byId = db.getUserById(userId)
  return byId && byId.role === 'super_admin' ? byId : null
}
