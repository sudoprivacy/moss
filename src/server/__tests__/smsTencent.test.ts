import { describe, expect, it } from 'bun:test'
import { buildAuthorization, sendTencentSms, SmsDeliveryError } from '../auth/smsTencent.js'

/**
 * The signature is the part that fails silently in production — a wrong one
 * comes back as AuthFailure rather than a crash — so it is pinned against fixed
 * inputs instead of only being exercised through a live call.
 */

const CREDS = { secretId: 'AKIDTEST', secretKey: 'SECRETTEST' }
const SETTINGS = { sdkAppId: '1400000000', signName: 'Test', templateId: '1234567', region: 'ap-beijing' }
const TS = 1_700_000_000

describe('buildAuthorization', () => {
  it('is deterministic for the same inputs', () => {
    const a = buildAuthorization({ ...CREDS, payload: '{"a":1}', timestamp: TS })
    const b = buildAuthorization({ ...CREDS, payload: '{"a":1}', timestamp: TS })
    expect(a).toBe(b)
  })

  it('has the TC3 shape the API expects', () => {
    const auth = buildAuthorization({ ...CREDS, payload: '{"a":1}', timestamp: TS })
    expect(auth.startsWith('TC3-HMAC-SHA256 ')).toBe(true)
    expect(auth).toContain(`Credential=${CREDS.secretId}/2023-11-14/sms/tc3_request`)
    expect(auth).toContain('SignedHeaders=content-type;host')
    expect(/Signature=[0-9a-f]{64}$/.test(auth)).toBe(true)
  })

  it('changes when the payload, the key, or the day changes', () => {
    const base = buildAuthorization({ ...CREDS, payload: '{"a":1}', timestamp: TS })
    expect(buildAuthorization({ ...CREDS, payload: '{"a":2}', timestamp: TS })).not.toBe(base)
    expect(buildAuthorization({ ...CREDS, secretKey: 'OTHER', payload: '{"a":1}', timestamp: TS })).not.toBe(base)
    // Crossing a UTC day boundary changes the credential scope, so a cached
    // signature would start failing at midnight if the date were not derived
    // from the timestamp actually sent.
    expect(buildAuthorization({ ...CREDS, payload: '{"a":1}', timestamp: TS + 86_400 })).not.toBe(base)
  })
})

describe('sendTencentSms', () => {
  it('sends E.164, the template and the code, with matching signed headers', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    await sendTencentSms({
      phone: '13800138000',
      code: '123456',
      settings: SETTINGS,
      credentials: CREDS,
      now: TS * 1000,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, init }
        return { ok: true, json: async () => ({ Response: { SendStatusSet: [{ Code: 'Ok' }] } }) } as unknown as Response
      }) as unknown as typeof fetch,
    })

    expect(seen).not.toBeNull()
    const body = JSON.parse(String(seen!.init.body))
    // The stored identity is bare digits; the provider wants E.164.
    expect(body.PhoneNumberSet).toEqual(['+8613800138000'])
    expect(body.TemplateParamSet).toEqual(['123456'])
    expect(body.SmsSdkAppId).toBe(SETTINGS.sdkAppId)

    const headers = seen!.init.headers as Record<string, string>
    // The timestamp header must be the one the signature was built with, or the
    // API rejects the request.
    expect(headers['X-TC-Timestamp']).toBe(String(TS))
    expect(headers.Authorization).toBe(
      buildAuthorization({ ...CREDS, payload: String(seen!.init.body), timestamp: TS }),
    )
  })

  it('treats an API-level error as a failure even though HTTP said 200', async () => {
    // Tencent answers 200 for AuthFailure/quota errors, so a naive res.ok check
    // would report a code as delivered when nothing was sent.
    const promise = sendTencentSms({
      phone: '13800138000',
      code: '123456',
      settings: SETTINGS,
      credentials: CREDS,
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: 'bad signature' } } }),
      })) as unknown as typeof fetch,
    })
    await expect(promise).rejects.toThrow(SmsDeliveryError)
  })

  it('treats a per-number rejection as a failure', async () => {
    const promise = sendTencentSms({
      phone: '13800138000',
      code: '123456',
      settings: SETTINGS,
      credentials: CREDS,
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ Response: { SendStatusSet: [{ Code: 'LimitExceeded.PhoneNumberDailyLimit', Message: 'daily limit' }] } }),
      })) as unknown as typeof fetch,
    })
    await expect(promise).rejects.toThrow(SmsDeliveryError)
  })

  it('fails on a transport-level error', async () => {
    const promise = sendTencentSms({
      phone: '13800138000',
      code: '123456',
      settings: SETTINGS,
      credentials: CREDS,
      fetchImpl: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch,
    })
    await expect(promise).rejects.toThrow(SmsDeliveryError)
  })
})
