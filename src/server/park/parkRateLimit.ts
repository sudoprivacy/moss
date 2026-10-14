/**
 * Fixed-window rate limiter for the park anonymous registration endpoint
 * (plan 2.6 #1: park 模块内部鉴权+限流). Pattern copied from
 * api/eventTriggers.ts RateLimiter with the window parameterized (the
 * precedent hard-codes 60s). In-memory and per-process; the webui BFF adds
 * an express-rate-limit layer with the same defaults, so a BFF-routed
 * request passes both layers at a 1:1 ratio without double counting.
 *
 * Limit key: client IP as seen by moss — X-Forwarded-For first entry when
 * present (set by the BFF / a reverse proxy), else the socket remote
 * address (direct callers). Same resolution as the server.ts auth wall.
 * MOSS_PARK_REGISTER_RATE_LIMIT <= 0 disables the limiter.
 */
export class ParkRateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly windowMs: number,
    private readonly limit: number,
  ) {}

  /** Returns true when the request is allowed and counts it. */
  check(key: string): boolean {
    if (this.limit <= 0) return true
    const now = Date.now()
    const entry = this.windows.get(key)
    if (!entry || now >= entry.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    if (entry.count >= this.limit) return false
    entry.count += 1
    return true
  }

  /** Drop expired windows so the map cannot grow without bound. */
  sweep(): void {
    const now = Date.now()
    for (const [key, entry] of this.windows) {
      if (now >= entry.resetAt) this.windows.delete(key)
    }
  }
}

export const PARK_REGISTER_RATE_WINDOW_MS = 15 * 60_000
export const PARK_REGISTER_RATE_LIMIT = Number(process.env.MOSS_PARK_REGISTER_RATE_LIMIT ?? 10)

export const defaultParkRegisterLimiter = new ParkRateLimiter(PARK_REGISTER_RATE_WINDOW_MS, PARK_REGISTER_RATE_LIMIT)

const sweeper = setInterval(() => defaultParkRegisterLimiter.sweep(), 60_000)
sweeper.unref?.()
