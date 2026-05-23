export function shouldProcessRateLimits(): boolean {
  return false
}

export function withRetry(): unknown {
  return null
}

export const rateLimitHeaders = {}
export type RateLimitInfo = Record<string, unknown>