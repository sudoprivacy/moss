// Runs under Node (AuthCenterDb uses node:sqlite, which Bun lacks): `tsx --test`.
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { AuthCenterDb } from '../authCenter/db.js'
import { normalizePhone, PhoneAuthError, PhoneAuthService, type PhoneAuthConfig } from '../auth/phoneAuth.js'

const SECRET = 'test-secret'
const PHONE = '13800138000'

function makeConfig(overrides: Partial<PhoneAuthConfig> = {}): PhoneAuthConfig {
  return {
    enabled: true,
    delivery: 'log',
    codeTtlSec: 300,
    resendCooldownSec: 60,
    maxSendsPerHour: 5,
    maxVerifyAttempts: 3,
    autoCreateOrg: true,
    ...overrides,
  }
}

let db: AuthCenterDb
let raw: DatabaseSync

beforeEach(() => {
  raw = new DatabaseSync(':memory:')
  db = new AuthCenterDb(raw, ':memory:')
})

afterEach(() => {
  raw.close()
})

/**
 * `sendCode` logs the code (the only shipped transport), so tests recover it by
 * capturing console.warn rather than by reaching into the service — the same
 * path an operator would use.
 */
async function sendAndCaptureCode(service: PhoneAuthService, phone: string, now?: number): Promise<string> {
  const original = console.warn
  let captured = ''
  console.warn = (...args: unknown[]) => { captured = args.map(String).join(' ') }
  try {
    await service.sendCode(phone, now)
  } finally {
    console.warn = original
  }
  const match = captured.match(/is (\d{6})\./)
  if (!match) throw new Error(`no code in delivery output: ${captured}`)
  return match[1]!
}

describe('normalizePhone', () => {
  it('accepts the forms the client accepts and returns the bare 11 digits', async () => {
    assert.equal(normalizePhone('13800138000'), '13800138000')
    assert.equal(normalizePhone('+8613800138000'), '13800138000')
    assert.equal(normalizePhone('8613800138000'), '13800138000')
    assert.equal(normalizePhone(' 138 0013-8000 '), '13800138000')
  })

  it('rejects anything that is not a mainland mobile number', async () => {
    assert.equal(normalizePhone('23800138000'), null)   // wrong leading digit
    assert.equal(normalizePhone('1380013800'), null)    // too short
    assert.equal(normalizePhone('138001380000'), null)  // too long
    assert.equal(normalizePhone('+8513800138000'), null) // wrong country
    assert.equal(normalizePhone(12345), null)
    assert.equal(normalizePhone(undefined), null)
  })
})

describe('verification codes', () => {
  it('accepts the delivered code exactly once', async () => {
    const service = new PhoneAuthService(db, makeConfig(), SECRET)
    const code = await sendAndCaptureCode(service, PHONE)

    assert.equal(await service.verifyCode(PHONE, code), true)
    // Consumed: replaying the same code must not log anyone in again.
    assert.equal(await service.verifyCode(PHONE, code), false)
  })

  it('two concurrent verifies of the same code succeed exactly once (atomic consume)', async () => {
    const service = new PhoneAuthService(db, makeConfig(), SECRET)
    const code = await sendAndCaptureCode(service, PHONE)

    // Both reads see the same live code and pass the compare; only one DELETE
    // reports a removed row, so exactly one call issues a token. (SQLite
    // serialises writers; the PG two-pool race is covered in pgBackend.test.ts.)
    const results = await Promise.all([
      service.verifyCode(PHONE, code),
      service.verifyCode(PHONE, code),
    ])
    assert.equal(results.filter(Boolean).length, 1)
  })

  it('rejects a wrong code without consuming the real one', async () => {
    const service = new PhoneAuthService(db, makeConfig(), SECRET)
    const code = await sendAndCaptureCode(service, PHONE)

    assert.equal(await service.verifyCode(PHONE, '000000' === code ? '111111' : '000000'), false)
    assert.equal(await service.verifyCode(PHONE, code), true)
  })

  it('rejects an expired code and clears it', async () => {
    const service = new PhoneAuthService(db, makeConfig({ codeTtlSec: 60 }), SECRET)
    const t0 = Date.now()
    const code = await sendAndCaptureCode(service, PHONE, t0)

    assert.equal(await service.verifyCode(PHONE, code, t0 + 61_000), false)
    assert.equal(await db.getPhoneLoginCode(PHONE), null)
  })

  it('burns the code after too many wrong attempts, so brute force costs a resend', async () => {
    const service = new PhoneAuthService(db, makeConfig({ maxVerifyAttempts: 3 }), SECRET)
    const code = await sendAndCaptureCode(service, PHONE)
    const wrong = code === '000000' ? '111111' : '000000'

    assert.equal(await service.verifyCode(PHONE, wrong), false)
    assert.equal(await service.verifyCode(PHONE, wrong), false)
    assert.equal(await service.verifyCode(PHONE, wrong), false)
    // Budget exhausted: even the correct code is now refused, and the record is gone.
    await assert.rejects(() => service.verifyCode(PHONE, code), PhoneAuthError)
    assert.equal(await db.getPhoneLoginCode(PHONE), null)
  })

  it('rejects malformed input without touching the stored code', async () => {
    const service = new PhoneAuthService(db, makeConfig(), SECRET)
    const code = await sendAndCaptureCode(service, PHONE)

    assert.equal(await service.verifyCode(PHONE, ''), false)
    assert.equal(await service.verifyCode(PHONE, 'abcdef'), false)
    assert.equal(await service.verifyCode(PHONE, 123456), false)
    // None of those counted as an attempt against the real code.
    assert.equal(await service.verifyCode(PHONE, code), true)
  })

  it('stores only a hash, so reading the table does not yield a usable code', async () => {
    const service = new PhoneAuthService(db, makeConfig(), SECRET)
    const code = await sendAndCaptureCode(service, PHONE)

    const stored = await db.getPhoneLoginCode(PHONE)
    assert.notEqual(stored, null)
    assert.ok(!(stored!.codeHash).includes(code))
    assert.equal((stored!.codeHash).length, 64)
  })
})

describe('rate limiting', () => {
  it('refuses a resend inside the cooldown and says how long to wait', async () => {
    const service = new PhoneAuthService(db, makeConfig({ resendCooldownSec: 60 }), SECRET)
    const t0 = Date.now()
    await sendAndCaptureCode(service, PHONE, t0)

    try {
      await service.sendCode(PHONE, t0 + 10_000)
      throw new Error('expected a cooldown rejection')
    } catch (error) {
      assert.ok(error instanceof PhoneAuthError)
      assert.equal((error as PhoneAuthError).status, 429)
      assert.equal((error as PhoneAuthError).retryAfterSec, 50)
    }
  })

  it('allows a resend once the cooldown has passed', async () => {
    const service = new PhoneAuthService(db, makeConfig({ resendCooldownSec: 60 }), SECRET)
    const t0 = Date.now()
    await sendAndCaptureCode(service, PHONE, t0)
    await assert.doesNotReject(async () => await sendAndCaptureCode(service, PHONE, t0 + 61_000))
  })

  it('caps sends per number per hour independently of the cooldown', async () => {
    const service = new PhoneAuthService(db, makeConfig({ resendCooldownSec: 0, maxSendsPerHour: 3 }), SECRET)
    const t0 = Date.now()
    await sendAndCaptureCode(service, PHONE, t0)
    await sendAndCaptureCode(service, PHONE, t0 + 1_000)
    await sendAndCaptureCode(service, PHONE, t0 + 2_000)

    // The cap must hold even though the cooldown is satisfied — the two limits
    // defend different things (button-mashing vs cost/abuse).
    await assert.rejects(() => service.sendCode(PHONE, t0 + 3_000), PhoneAuthError)
  })

  it('counts sends per number, so one number cannot lock out another', async () => {
    const service = new PhoneAuthService(db, makeConfig({ resendCooldownSec: 0, maxSendsPerHour: 2 }), SECRET)
    const t0 = Date.now()
    await sendAndCaptureCode(service, PHONE, t0)
    await sendAndCaptureCode(service, PHONE, t0 + 1_000)
    await assert.rejects(() => service.sendCode(PHONE, t0 + 2_000), PhoneAuthError)

    await assert.doesNotReject(async () => await sendAndCaptureCode(service, '13900139000', t0 + 2_000))
  })

  it('does not let a successful verification reset the hourly budget', async () => {
    const service = new PhoneAuthService(db, makeConfig({ resendCooldownSec: 0, maxSendsPerHour: 2 }), SECRET)
    const t0 = Date.now()
    const code = await sendAndCaptureCode(service, PHONE, t0)
    assert.equal(await service.verifyCode(PHONE, code, t0 + 500), true)

    await sendAndCaptureCode(service, PHONE, t0 + 1_000)
    // The send log survives code deletion; without that, verifying would be a
    // free way to reset the limit.
    await assert.rejects(() => service.sendCode(PHONE, t0 + 2_000), PhoneAuthError)
  })
})

describe('register token', () => {
  it('round-trips the phone it attests to', async () => {
    const service = new PhoneAuthService(db, makeConfig(), SECRET)
    const token = service.issueRegisterToken(PHONE)
    assert.equal(service.verifyRegisterToken(token), PHONE)
  })

  it('rejects a tampered payload', async () => {
    const service = new PhoneAuthService(db, makeConfig(), SECRET)
    const token = service.issueRegisterToken(PHONE)
    const [payload, signature] = token.split('.')
    const forged = Buffer.from(
      JSON.stringify({ typ: 'phone-register', phone: '13900139000', exp: 9_999_999_999 }),
    ).toString('base64url')

    assert.notEqual(payload, forged)
    assert.equal(service.verifyRegisterToken(`${forged}.${signature}`), null)
  })

  it('rejects a token signed with a different secret', async () => {
    const minted = new PhoneAuthService(db, makeConfig(), 'other-secret').issueRegisterToken(PHONE)
    const service = new PhoneAuthService(db, makeConfig(), SECRET)
    assert.equal(service.verifyRegisterToken(minted), null)
  })

  it('rejects an expired token', async () => {
    const service = new PhoneAuthService(db, makeConfig(), SECRET)
    const t0 = Date.now()
    const token = service.issueRegisterToken(PHONE, t0)
    assert.equal(service.verifyRegisterToken(token, t0 + 11 * 60 * 1000), null)
  })

  it('rejects junk', async () => {
    const service = new PhoneAuthService(db, makeConfig(), SECRET)
    assert.equal(service.verifyRegisterToken(''), null)
    assert.equal(service.verifyRegisterToken('not-a-token'), null)
    assert.equal(service.verifyRegisterToken(undefined), null)
  })
})

describe('invitation code', () => {
  it('accepts anything when none is configured', async () => {
    const service = new PhoneAuthService(db, makeConfig(), SECRET)
    assert.equal(service.checkInvitationCode(undefined), true)
    assert.equal(service.checkInvitationCode('whatever'), true)
  })

  it('requires an exact match when configured', async () => {
    const service = new PhoneAuthService(db, makeConfig({ invitationCode: 'LETMEIN' }), SECRET)
    assert.equal(service.checkInvitationCode('LETMEIN'), true)
    assert.equal(service.checkInvitationCode('  LETMEIN  '), true)
    assert.equal(service.checkInvitationCode('letmein'), false)
    assert.equal(service.checkInvitationCode(''), false)
    assert.equal(service.checkInvitationCode(undefined), false)
  })
})
