import { randomInt } from 'node:crypto'

export interface SmsCodeStore {
  get(key: string): Promise<string | null>
  setex(key: string, seconds: number, value: string): Promise<void>
  del(...keys: string[]): Promise<void>
  ttl(key: string): Promise<number>
  incrementWithExpiry(key: string, seconds: number): Promise<number>
}

export interface SmsSender {
  send(input: { phone: string; code: string; expireMinutes: number }): Promise<void>
}

export interface SmsResult {
  success: boolean
  message?: string
  expire?: number
  nextSendIn?: number
  dailyRemaining?: number
}

interface SmsCodeRecord {
  phone: string
  code: string
  expiresAt: number
  attempts: number
}

export class SmsVerificationService {
  constructor(private readonly options: {
    store: SmsCodeStore
    sender: SmsSender
    codeFactory?: () => string
    codeLength?: number
    today?: () => string
    expireMinutes?: number
    sendIntervalSeconds?: number
    maxPerDay?: number
  }) {}

  async sendCode(phone: string): Promise<SmsResult> {
    const expireMinutes = this.options.expireMinutes ?? 5
    const sendIntervalSeconds = this.options.sendIntervalSeconds ?? 60
    const maxPerDay = this.options.maxPerDay ?? 10
    const today = this.options.today?.() ?? new Date().toISOString().split('T')[0]!
    const dailyKey = `sms_daily_count:${phone}:${today}`
    const dailyCount = Number(await this.options.store.get(dailyKey) ?? 0)
    if (dailyCount >= maxPerDay) {
      return { success: false, message: `今日发送次数已达上限（${maxPerDay}次），请明天再试` }
    }

    const codeKey = `sms_code:${phone}`
    if (await this.options.store.get(codeKey)) {
      const ttl = await this.options.store.ttl(codeKey)
      const elapsed = expireMinutes * 60 - ttl
      const nextSendIn = sendIntervalSeconds - elapsed
      if (nextSendIn > 0) {
        return { success: false, message: `发送过于频繁，请 ${nextSendIn} 秒后再试`, nextSendIn }
      }
    }

    const code = this.options.codeFactory?.()
      ?? Array.from({ length: this.options.codeLength ?? 6 }, () => randomInt(0, 10)).join('')
    const expireSeconds = expireMinutes * 60
    await this.options.store.setex(codeKey, expireSeconds, JSON.stringify({
      phone, code, expiresAt: Date.now() + expireSeconds * 1_000, attempts: 0,
    } satisfies SmsCodeRecord))
    const updatedDailyCount = await this.options.store.incrementWithExpiry(dailyKey, 86_400)
    try {
      await this.options.sender.send({ phone, code, expireMinutes })
    } catch (error) {
      await this.options.store.del(codeKey)
      throw error
    }
    return {
      success: true,
      expire: expireSeconds,
      nextSendIn: sendIntervalSeconds,
      dailyRemaining: maxPerDay - updatedDailyCount,
    }
  }

  async verifyCode(phone: string, code: string): Promise<SmsResult> {
    const codeKey = `sms_code:${phone}`
    const stored = await this.options.store.get(codeKey)
    if (!stored) return { success: false, message: '验证码已过期或不存在' }
    let record: SmsCodeRecord
    try {
      record = JSON.parse(stored) as SmsCodeRecord
    } catch {
      await this.options.store.del(codeKey)
      return { success: false, message: '验证码已过期或不存在' }
    }
    if (record.code === code) {
      await this.options.store.del(codeKey)
      return { success: true }
    }
    const attempts = record.attempts + 1
    if (attempts >= 5) {
      await this.options.store.del(codeKey)
      return { success: false, message: '验证次数过多，请重新获取验证码' }
    }
    await this.options.store.setex(codeKey, 300, JSON.stringify({ ...record, attempts }))
    return { success: false, message: '验证码错误' }
  }
}
