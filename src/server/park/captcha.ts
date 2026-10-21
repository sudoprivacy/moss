import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { HttpError } from '../httpRespond.js'
import type { ParkStore } from './store.js'
import sharp from 'sharp'

const SYMBOLS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function answerHash(key: string, sessionId: string, answer: string): string {
  return createHmac('sha256', key).update(`${sessionId}:${answer}`).digest('hex')
}

function svgImage(answer: string): string {
  const lines = Array.from({ length: 8 }, () => `<path d="M${randomInt(0, 220)} ${randomInt(0, 70)} L${randomInt(0, 220)} ${randomInt(0, 70)}" stroke="#c8b28a" stroke-width="1" opacity=".65"/>`).join('')
  const letters = [...answer].map((char, index) => `<text x="${22 + index * 39}" y="${47 + randomInt(-4, 5)}" transform="rotate(${randomInt(-12, 13)} ${22 + index * 39} 42)" font-family="Georgia,serif" font-size="32" font-weight="700" fill="#173d66">${char}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="70" viewBox="0 0 220 70" role="img" aria-label="安全验证码"><rect width="220" height="70" fill="#f8f4e9"/>${lines}${letters}</svg>`
}

export class ParkCaptcha {
  constructor(private readonly store: ParkStore, private readonly key?: string, private readonly codeFactory?: () => string) {}

  async issue(sessionId: string, now = Date.now(), isContactRetry = false): Promise<string> {
    if (!this.key || this.key.length < 32) throw new HttpError(503, 'CAPTCHA is not configured')
    const previous = await this.store.db.get<{ issued_at: number }>('SELECT issued_at FROM park_captcha_challenges WHERE session_id = ?', [sessionId])
    if (!isContactRetry && previous && now - Number(previous.issued_at) < 10_000) throw new HttpError(429, 'Wait before requesting another challenge')
    const answer = this.codeFactory?.() ?? Array.from({ length: 5 }, () => SYMBOLS[randomInt(SYMBOLS.length)]).join('')
    if (!/^[A-Z2-9]{5}$/.test(answer)) throw new Error('Invalid CAPTCHA generator output')
    await this.store.db.run(`INSERT INTO park_captcha_challenges (session_id, answer_hash, issued_at, expires_at, attempts, passed_until)
      VALUES (?, ?, ?, ?, 0, NULL)
      ON CONFLICT (session_id) DO UPDATE SET answer_hash = excluded.answer_hash, issued_at = excluded.issued_at,
      expires_at = excluded.expires_at, attempts = 0, passed_until = NULL`,
    [sessionId, answerHash(this.key, sessionId, answer), now, now + 5 * 60_000])
    const png = await sharp(Buffer.from(svgImage(answer))).png().toBuffer()
    return `data:image/png;base64,${png.toString('base64')}`
  }

  async verify(sessionId: string, answer: string, now = Date.now()): Promise<boolean> {
    if (!this.key || !/^[A-Z2-9]{5}$/.test(answer)) return false
    const row = await this.store.db.get<{ answer_hash: string; expires_at: number; attempts: number }>('SELECT answer_hash, expires_at, attempts FROM park_captcha_challenges WHERE session_id = ?', [sessionId])
    if (!row || Number(row.expires_at) <= now || Number(row.attempts) >= 5) return false
    const actual = Buffer.from(answerHash(this.key, sessionId, answer), 'hex')
    const expected = Buffer.from(row.answer_hash, 'hex')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      await this.store.db.run('UPDATE park_captcha_challenges SET attempts = attempts + 1 WHERE session_id = ?', [sessionId])
      return false
    }
    await this.store.db.run('UPDATE park_captcha_challenges SET passed_until = ?, answer_hash = ? WHERE session_id = ?', [now + 10 * 60_000, '', sessionId])
    return true
  }

  async isPassed(sessionId: string, now = Date.now()): Promise<boolean> {
    const row = await this.store.db.get<{ passed_until: number | null }>('SELECT passed_until FROM park_captcha_challenges WHERE session_id = ?', [sessionId])
    return row?.passed_until != null && Number(row.passed_until) > now
  }
}
