import type { MiddlewareHandler } from 'hono'

export interface LegacyRateLimitStore {
  incrementWithExpiry(key: string, seconds: number): Promise<number>
  ttl(key: string): Promise<number>
}

const LOGIN_WINDOW_SECONDS = 15 * 60
const LOGIN_MAX_REQUESTS = 10

export function createLegacyLoginRateLimit(store: LegacyRateLimitStore): MiddlewareHandler {
  return async (context, next) => {
    const forwarded = context.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    const ip = forwarded || context.req.header('x-real-ip') || 'unknown'
    const key = `rate_limit:${ip}:${context.req.path}`
    try {
      const count = await store.incrementWithExpiry(key, LOGIN_WINDOW_SECONDS)
      if (count > LOGIN_MAX_REQUESTS) {
        const ttl = await store.ttl(key)
        return context.json({
          success: false,
          msg: '登录尝试过于频繁，请 15 分钟后再试',
          retry_after: ttl > 0 ? ttl : LOGIN_WINDOW_SECONDS,
        }, 429)
      }
    } catch (error) {
      process.stderr.write(`[SudoworkRateLimit] Redis unavailable, allowing request: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    await next()
  }
}
