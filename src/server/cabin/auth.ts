import { createHmac, timingSafeEqual } from 'crypto'
import type { CabinPassengerContext, CabinTokenPayload } from './types.js'

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64')
}

function sign(value: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(value).digest())
}

export function issueCabinToken(
  input: { tabletToken: string; tabletId: string },
  options: { secret: string; ttlSeconds: number; nowMs?: number },
): string {
  const now = options.nowMs ?? Date.now()
  const payload: CabinTokenPayload = {
    tabletToken: input.tabletToken,
    tabletId: input.tabletId,
    issuedAt: now,
    expiresAt: now + options.ttlSeconds * 1000,
  }
  const body = base64UrlEncode(JSON.stringify(payload))
  return `ai_${body}.${sign(body, options.secret)}`
}

export function verifyCabinToken(
  token: string,
  options: { secret: string; nowMs?: number },
): CabinTokenPayload | null {
  const normalized = token.startsWith('ai_') ? token.slice('ai_'.length) : token
  const [body, signature] = normalized.split('.')
  if (!body || !signature) return null
  const expected = sign(body, options.secret)
  const actualBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(base64UrlDecode(body).toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const payload = parsed as Partial<CabinTokenPayload>
  if (
    typeof payload.tabletToken !== 'string' ||
    typeof payload.tabletId !== 'string' ||
    typeof payload.issuedAt !== 'number' ||
    typeof payload.expiresAt !== 'number'
  ) {
    return null
  }
  if ((options.nowMs ?? Date.now()) >= payload.expiresAt) return null
  return payload as CabinTokenPayload
}

export function buildConversationKey(context: CabinPassengerContext): string {
  const passenger = context.passengerId || context.passengerRef || `tablet:${context.tabletId}`
  return [
    passenger.trim().toLowerCase(),
    context.flightId.trim().toLowerCase(),
  ].join('|')
}
