import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { HttpError } from '../httpRespond.js'
import type { ParkStore } from './store.js'

export type ParkSmsSender = (phone: string, code: string) => Promise<void>

function codeHash(key: string, sessionId: string, phone: string, code: string): string {
  return createHmac('sha256', key).update(`${sessionId}:${phone}:${code}`).digest('hex')
}

export class ParkPhoneVerification {
  constructor(private readonly store: ParkStore, private readonly sender?: ParkSmsSender, private readonly hmacKey?: string) {}

  async send(sessionId: string, phone: string, now = Date.now()): Promise<void> {
    if (!this.sender || !this.hmacKey || this.hmacKey.length < 32) throw new HttpError(503, 'SMS verification is not configured')
    if (!/^1[3-9]\d{9}$/.test(phone)) throw new HttpError(400, 'Invalid phone')
    const prior = await this.store.db.get<{ sent_at: number }>('SELECT sent_at FROM park_phone_codes WHERE session_id = ?', [sessionId])
    if (prior && now - Number(prior.sent_at) < 60_000) throw new HttpError(429, 'Please wait before requesting another code')
    const sends = await this.store.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM park_phone_sends WHERE phone = ? AND sent_at >= ?', [phone, now - 60 * 60_000])
    if (Number(sends?.count ?? 0) >= 5) throw new HttpError(429, 'SMS hourly limit reached')
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const hash = codeHash(this.hmacKey, sessionId, phone, code)
    await this.store.db.run(`INSERT INTO park_phone_codes (session_id, phone, code_hash, expires_at, attempts, sent_at, verified_at)
      VALUES (?, ?, ?, ?, 0, ?, NULL)
      ON CONFLICT (session_id) DO UPDATE SET phone = excluded.phone, code_hash = excluded.code_hash,
      expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at, verified_at = NULL`,
    [sessionId, phone, hash, now + 5 * 60_000, now])
    try {
      await this.sender(phone, code)
    } catch {
      await this.store.db.run('DELETE FROM park_phone_codes WHERE session_id = ?', [sessionId])
      throw new HttpError(502, 'SMS delivery failed')
    }
    await this.store.db.run('INSERT INTO park_phone_sends (id, phone, session_id, sent_at) VALUES (?, ?, ?, ?)', [randomUUID(), phone, sessionId, now])
  }

  async verify(sessionId: string, phone: string, code: string, now = Date.now()): Promise<boolean> {
    if (!/^\d{6}$/.test(code)) return false
    const row = await this.store.db.get<{ phone: string; code_hash: string; expires_at: number; attempts: number }>('SELECT phone, code_hash, expires_at, attempts FROM park_phone_codes WHERE session_id = ?', [sessionId])
    if (!row || row.phone !== phone || Number(row.expires_at) <= now || Number(row.attempts) >= 5 || !this.hmacKey) return false
    const actual = Buffer.from(codeHash(this.hmacKey, sessionId, phone, code), 'hex')
    const expected = Buffer.from(row.code_hash, 'hex')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      await this.store.db.run('UPDATE park_phone_codes SET attempts = attempts + 1 WHERE session_id = ?', [sessionId])
      return false
    }
    await this.store.db.run('UPDATE park_phone_codes SET verified_at = ?, code_hash = ? WHERE session_id = ?', [now, '', sessionId])
    return true
  }

  async verifiedAt(sessionId: string, phone: string, now = Date.now()): Promise<number | null> {
    const row = await this.store.db.get<{ verified_at: number | null; phone: string }>('SELECT verified_at, phone FROM park_phone_codes WHERE session_id = ?', [sessionId])
    if (!row || row.phone !== phone || row.verified_at === null || now - Number(row.verified_at) > 10 * 60_000) return null
    return Number(row.verified_at)
  }
}
