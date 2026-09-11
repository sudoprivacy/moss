/**
 * Phone + verification-code authentication (`login_method: 0`).
 *
 * This is the self-service signup path for a public deployment: a person enters
 * a phone number, receives a code, and is logged in — creating their account and
 * their own single-person organisation on first use. It is the counterpart to
 * `login_method: 1` (username/password, admin-provisioned) and `2` (an external
 * IdP owns identity), and which of the three a deployment offers is declared in
 * `GET /api/v1/system-config`.
 *
 * ## Why the state lives in SQLite rather than in memory
 *
 * moss can run as several instances behind a load balancer. A code minted on
 * one instance must verify on another, so an in-process Map would fail exactly
 * when a deployment scales out — and fail intermittently, which is worse than
 * failing always. The shared store makes send/verify instance-agnostic.
 *
 * The register token is the opposite: it is stateless and HMAC-signed with the
 * server's existing secret, so it needs no storage and cannot be replayed after
 * expiry.
 *
 * ## What is deliberately NOT here
 *
 * No SMS provider. moss has no delivery contract yet, so the only shipped
 * transport writes the code to the server log, which is a development and
 * single-operator affordance, not a production one — anyone who can read the
 * log can then log in as anyone. `deliverCode` returns the transport used so
 * the caller can refuse to enable it silently.
 */
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AuthCenterDb } from '../authCenter/db.js'

/** How a code reaches the person. `log` is development-only. */
export type PhoneCodeDelivery = 'log' | 'tencent'

/**
 * Sends one code. Returns nothing on success and throws on refusal.
 *
 * Injected rather than imported so the provider's credentials are fetched by
 * whoever composes the server (which has the vault client), and this module
 * never touches a secret.
 */
export type SmsSender = (phone: string, code: string) => Promise<void>

export type PhoneAuthConfig = {
  enabled: boolean
  delivery: PhoneCodeDelivery
  codeTtlSec: number
  resendCooldownSec: number
  maxSendsPerHour: number
  maxVerifyAttempts: number
  /** When set, `register` requires this exact invitation code. */
  invitationCode?: string
  /** Give each new person their own organisation (the one-person-company model). */
  autoCreateOrg: boolean
}

export class PhoneAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds until another send is allowed, surfaced to the client as `next_send_in`. */
    readonly retryAfterSec?: number,
  ) {
    super(message)
    this.name = 'PhoneAuthError'
  }
}

/**
 * Accepts an 11-digit mainland China mobile number, with or without a `+86`
 * prefix, and returns it in the bare 11-digit form used as the stored identity.
 * Mirrors the client-side check so a number the UI accepts is not then rejected
 * by the server (and vice versa).
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().replace(/[\s-]/g, '')
  const bare = trimmed.startsWith('+86')
    ? trimmed.slice(3)
    : trimmed.startsWith('86') && trimmed.length === 13
      ? trimmed.slice(2)
      : trimmed
  return /^1\d{10}$/.test(bare) ? bare : null
}

function hashCode(code: string, secret: string): string {
  return createHmac('sha256', secret).update(`phone-code:${code}`).digest('hex')
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Six digits, uniformly drawn from the full range including leading zeros.
 * `randomInt` is CSPRNG-backed; `Math.random` would make codes guessable.
 */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export class PhoneAuthService {
  constructor(
    private readonly db: AuthCenterDb,
    private readonly config: PhoneAuthConfig,
    private readonly secret: string,
    /** Required when `delivery` is anything other than `log`. */
    private readonly smsSender?: SmsSender,
  ) {}

  get enabled(): boolean {
    return this.config.enabled
  }

  get invitationRequired(): boolean {
    return Boolean(this.config.invitationCode)
  }

  get autoCreateOrg(): boolean {
    return this.config.autoCreateOrg
  }

  /**
   * Mint and deliver a code. Returns the cooldown the client should count down
   * before offering "resend".
   *
   * Two independent limits apply, because they defend different things: the
   * cooldown stops a user hammering the button, while the hourly cap bounds the
   * cost and abuse potential of an unauthenticated endpoint that (once a real
   * provider is wired) spends money per call.
   */
  async sendCode(phone: string, now = Date.now()): Promise<{ nextSendIn: number; delivery: PhoneCodeDelivery }> {
    await this.db.prunePhoneLoginCodes(now)

    const existing = await this.db.getPhoneLoginCode(phone)
    if (existing) {
      const elapsedSec = Math.floor((now - existing.createdAt) / 1000)
      const remaining = this.config.resendCooldownSec - elapsedSec
      if (remaining > 0) {
        throw new PhoneAuthError(429, 'Please wait before requesting another code', remaining)
      }
    }

    const sentLastHour = await this.db.countPhoneLoginSends(phone, now - 60 * 60 * 1000)
    if (sentLastHour >= this.config.maxSendsPerHour) {
      throw new PhoneAuthError(429, 'Too many codes requested for this number, try again later')
    }

    const code = generateCode()
    await this.db.upsertPhoneLoginCode({
      phone,
      codeHash: hashCode(code, this.secret),
      createdAt: now,
      expiresAt: now + this.config.codeTtlSec * 1000,
      attempts: 0,
    })
    await this.db.recordPhoneLoginSend(phone, now)

    // Deliver BEFORE returning success: a provider refusal (bad credentials,
    // template not approved, quota exhausted) must surface as a failed send
    // rather than a countdown for a code that never arrives. The stored code is
    // dropped so the number is not left in cooldown for nothing.
    try {
      await this.deliverCode(phone, code)
    } catch (error) {
      await this.db.deletePhoneLoginCode(phone)
      throw new PhoneAuthError(
        502,
        error instanceof Error ? error.message : 'Failed to deliver verification code',
      )
    }
    return { nextSendIn: this.config.resendCooldownSec, delivery: this.config.delivery }
  }

  private async deliverCode(phone: string, code: string): Promise<void> {
    if (this.config.delivery !== 'log') {
      if (!this.smsSender) {
        throw new Error(`phoneAuth.delivery is '${this.config.delivery}' but no SMS sender is configured`)
      }
      await this.smsSender(phone, code)
      return
    }
    this.logCode(phone, code)
  }

  private logCode(phone: string, code: string): void {
    // The only transport that exists. Loud on purpose: a deployment that ends up
    // here without meaning to should see it in the log rather than discover it
    // when someone reads a code out of journald.
    const masked = `${phone.slice(0, 3)}****${phone.slice(-4)}`
    console.warn(
      `[PhoneAuth] DEV DELIVERY — verification code for ${masked} is ${code}. ` +
      'Codes are written to the server log because no SMS provider is configured; ' +
      'anyone who can read this log can sign in as this number.',
    )
  }

  /**
   * Consume a code. Returns true only when it matches, has not expired, and the
   * attempt budget is not exhausted; the record is deleted on success so a code
   * cannot be reused.
   */
  async verifyCode(phone: string, code: unknown, now = Date.now()): Promise<boolean> {
    if (typeof code !== 'string' || !/^\d{4,8}$/.test(code.trim())) return false
    const record = await this.db.getPhoneLoginCode(phone)
    if (!record) return false

    if (record.expiresAt <= now) {
      await this.db.deletePhoneLoginCode(phone)
      return false
    }
    if (record.attempts >= this.config.maxVerifyAttempts) {
      // Burn the code rather than leaving an exhausted record around: a fresh
      // send is the only way forward, which is also the rate-limited path.
      await this.db.deletePhoneLoginCode(phone)
      throw new PhoneAuthError(429, 'Too many incorrect attempts, request a new code')
    }

    const matches = constantTimeEquals(hashCode(code.trim(), this.secret), record.codeHash)
    if (!matches) {
      await this.db.bumpPhoneLoginCodeAttempts(phone)
      return false
    }
    await this.db.deletePhoneLoginCode(phone)
    return true
  }

  /**
   * Stateless proof that this phone number passed a code check moments ago, so
   * `register` does not have to re-verify (and cannot be reached without having
   * verified). Signed, not stored, so it works across instances.
   */
  issueRegisterToken(phone: string, now = Date.now()): string {
    const payload = {
      typ: 'phone-register',
      phone,
      jti: randomUUID(),
      exp: Math.floor(now / 1000) + 10 * 60,
    }
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signature = createHmac('sha256', this.secret).update(encoded).digest('base64url')
    return `${encoded}.${signature}`
  }

  /** Returns the phone the token attests to, or null if absent/tampered/expired. */
  verifyRegisterToken(token: unknown, now = Date.now()): string | null {
    if (typeof token !== 'string') return null
    const [encoded, signature] = token.split('.')
    if (!encoded || !signature) return null

    const expected = createHmac('sha256', this.secret).update(encoded).digest('base64url')
    if (!constantTimeEquals(signature, expected)) return null

    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
        typ?: string
        phone?: string
        exp?: number
      }
      if (payload.typ !== 'phone-register') return null
      if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null
      return normalizePhone(payload.phone)
    } catch {
      return null
    }
  }

  /** Constant-time invitation-code check; always true when none is configured. */
  checkInvitationCode(supplied: unknown): boolean {
    const required = this.config.invitationCode
    if (!required) return true
    if (typeof supplied !== 'string') return false
    return constantTimeEquals(supplied.trim(), required)
  }
}
