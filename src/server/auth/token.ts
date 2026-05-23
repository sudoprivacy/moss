import { createHmac, timingSafeEqual } from 'crypto'

export type AccessTokenClaims = {
  iss: string
  sub: string
  org_id: string
  role: string
  scopes: string[]
  key_id: string
  type: 'access'
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
  claims: Omit<AccessTokenClaims, 'iat' | 'exp' | 'type'>,
  secret: string,
  expiresInSec = 60 * 60,
): {
  token: string
  expiresAt: number
} {
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = issuedAt + expiresInSec
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload: AccessTokenClaims = {
    ...claims,
    type: 'access',
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

export function verifyAccessToken(
  token: string,
  secret: string,
  expectedIssuer?: string,
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
    payload.type !== 'access' ||
    typeof payload.sub !== 'string' ||
    typeof payload.org_id !== 'string' ||
    typeof payload.key_id !== 'string' ||
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
