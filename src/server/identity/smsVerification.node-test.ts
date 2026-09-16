import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  SmsVerificationService,
  type SmsCodeStore,
  type SmsSender,
} from './smsVerification.js'

class MemorySmsStore implements SmsCodeStore {
  readonly values = new Map<string, string>()
  readonly ttls = new Map<string, number>()

  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null }
  async setex(key: string, seconds: number, value: string): Promise<void> {
    this.values.set(key, value)
    this.ttls.set(key, seconds)
  }
  async del(...keys: string[]): Promise<void> {
    for (const key of keys) this.values.delete(key)
  }
  async ttl(key: string): Promise<number> { return this.ttls.get(key) ?? -2 }
  async incrementWithExpiry(key: string, seconds: number): Promise<number> {
    const next = Number(this.values.get(key) ?? '0') + 1
    this.values.set(key, String(next))
    this.ttls.set(key, seconds)
    return next
  }
}

describe('SMS verification service', () => {
  test('stores and sends a code with the legacy expiry and daily response fields', async () => {
    const store = new MemorySmsStore()
    const sent: Array<{ phone: string; code: string; expireMinutes: number }> = []
    const sender: SmsSender = {
      async send(input) { sent.push(input) },
    }
    const service = new SmsVerificationService({
      store, sender, codeFactory: () => '123456', today: () => '2026-09-07',
      expireMinutes: 5, sendIntervalSeconds: 60, maxPerDay: 10,
    })

    assert.deepEqual(await service.sendCode('13800000000'), {
      success: true, expire: 300, nextSendIn: 60, dailyRemaining: 9,
    })
    assert.deepEqual(sent, [{ phone: '13800000000', code: '123456', expireMinutes: 5 }])
    assert.equal((await service.verifyCode('13800000000', '123456')).success, true)
    assert.equal(await store.get('sms_code:13800000000'), null)
  })

  test('preserves resend throttling and invalid-attempt lockout messages', async () => {
    const store = new MemorySmsStore()
    const service = new SmsVerificationService({
      store, sender: { async send() {} }, codeFactory: () => '123456',
      today: () => '2026-09-07', expireMinutes: 5, sendIntervalSeconds: 60, maxPerDay: 10,
    })
    await service.sendCode('13800000000')
    const throttled = await service.sendCode('13800000000')
    assert.equal(throttled.success, false)
    assert.match(throttled.message ?? '', /发送过于频繁/)

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      assert.deepEqual(await service.verifyCode('13800000000', '000000'), {
        success: false, message: '验证码错误',
      })
    }
    assert.deepEqual(await service.verifyCode('13800000000', '000000'), {
      success: false, message: '验证次数过多，请重新获取验证码',
    })
    assert.equal(await store.get('sms_code:13800000000'), null)
  })
})
