import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AuthCenterDb } from '../authCenter/db.js'
import type { IdentityRepository } from './identityRepository.js'

export interface LegacyJwtClaims {
  id: number
  phone: string
  role: string
  enterprise_id: number | null
  iat: number
  exp: number
}

export interface LegacyPrincipal {
  userId: string
  orgId: string
  role: string
  legacyUserId: number
  legacyEnterpriseId: number | null
}

export interface LegacyKeyValueStore {
  setex(key: string, seconds: number, value: string): Promise<void>
  keys(pattern: string): Promise<string[]>
  get(key: string): Promise<string | null>
  del(...keys: string[]): Promise<void>
  rotate?(oldKey: string, newKey: string, seconds: number, value: string): Promise<boolean>
}

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

function signature(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url')
}

function requireSecret(secret: string): void {
  if (!secret.trim()) throw new Error('Legacy JWT secret must be configured explicitly')
}

export function issueLegacyJwt(input: {
  secret: string
  userId: number
  phone: string
  role: string
  enterpriseId: number | null
  expiresInSec: number
  nowSeconds?: number
}): string {
  requireSecret(input.secret)
  const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64UrlEncode(JSON.stringify({
    id: input.userId,
    phone: input.phone,
    role: input.role,
    enterprise_id: input.enterpriseId,
    iat: issuedAt,
    exp: issuedAt + input.expiresInSec,
  }))
  const signingInput = `${header}.${payload}`
  return `${signingInput}.${signature(signingInput, input.secret)}`
}

export function verifyLegacyJwt(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): LegacyJwtClaims | null {
  requireSecret(secret)
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerPart, payloadPart, receivedSignature] = parts
  if (!headerPart || !payloadPart || !receivedSignature) return null

  let header: Record<string, unknown>
  let payload: Record<string, unknown>
  try {
    header = JSON.parse(base64UrlDecode(headerPart).toString('utf8')) as Record<string, unknown>
    payload = JSON.parse(base64UrlDecode(payloadPart).toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
  if (header.alg !== 'HS256' || header.typ !== 'JWT') return null
  const expected = Buffer.from(signature(`${headerPart}.${payloadPart}`, secret))
  const received = Buffer.from(receivedSignature)
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null
  if (
    typeof payload.id !== 'number'
    || !Number.isSafeInteger(payload.id)
    || typeof payload.phone !== 'string'
    || typeof payload.role !== 'string'
    || (payload.enterprise_id !== null && (typeof payload.enterprise_id !== 'number' || !Number.isSafeInteger(payload.enterprise_id)))
    || typeof payload.iat !== 'number'
    || typeof payload.exp !== 'number'
    || payload.exp <= nowSeconds
  ) return null
  return payload as unknown as LegacyJwtClaims
}

export function resolveLegacyPrincipal(
  token: string,
  secret: string,
  repository: IdentityRepository,
  authDb: AuthCenterDb,
  nowSeconds?: number,
): LegacyPrincipal | null {
  const claims = verifyLegacyJwt(token, secret, nowSeconds)
  if (!claims) return null
  const userAlias = repository.resolveNumericAliasGlobal('user', claims.id)
  if (!userAlias) return null
  if (claims.enterprise_id !== null) {
    const orgAlias = repository.resolveNumericAliasGlobal('enterprise', claims.enterprise_id)
    if (!orgAlias || orgAlias.resourceId !== userAlias.orgId) return null
  }
  const user = authDb.getUserByIdAndOrg(userAlias.resourceId, userAlias.orgId)
  if (!user || user.status !== 'active') return null
  return {
    userId: user.id,
    orgId: user.orgId,
    role: user.role,
    legacyUserId: claims.id,
    legacyEnterpriseId: claims.enterprise_id,
  }
}

export class LegacyRefreshTokenService {
  constructor(
    private readonly store: LegacyKeyValueStore,
    private readonly tokenFactory: () => string = randomUUID,
    private readonly ttlSeconds = 30 * 24 * 60 * 60,
  ) {}

  async rotate(token: string, deviceId = 'default'): Promise<{
    token: string
    userId: number
    deviceId: string
    claims: { phone: string; role: string; enterprise_id: number | null }
  } | null> {
    const keys = await this.store.keys(`refresh_token:*:${deviceId}:${token}`)
    if (keys.length !== 1) return null
    const oldKey = keys[0]!
    const match = oldKey.match(/^refresh_token:(\d+):([^:]+):(.+)$/)
    if (!match || match[2] !== deviceId || match[3] !== token) return null
    const value = await this.store.get(oldKey)
    if (!value) return null
    let claims: { phone: string; role: string; enterprise_id: number | null }
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>
      if (
        typeof parsed.phone !== 'string'
        || typeof parsed.role !== 'string'
        || (parsed.enterprise_id !== null && typeof parsed.enterprise_id !== 'number')
      ) return null
      claims = parsed as typeof claims
    } catch {
      return null
    }

    const nextToken = this.tokenFactory()
    const newKey = `refresh_token:${match[1]}:${deviceId}:${nextToken}`
    if (this.store.rotate) {
      if (!await this.store.rotate(oldKey, newKey, this.ttlSeconds, value)) return null
    } else {
      await this.store.setex(newKey, this.ttlSeconds, value)
      try {
        await this.store.del(oldKey)
      } catch (error) {
        await this.store.del(newKey).catch(() => undefined)
        throw error
      }
    }
    return { token: nextToken, userId: Number(match[1]), deviceId, claims }
  }
}
