import type { AuthService } from './service.js'

const CACHE_TTL = 30_000

const cache = new Map<string, { status: string; updatedAt: number }>()

export function isUserActive(userId: string, authService: AuthService): boolean {
  try {
    const now = Date.now()
    const cached = cache.get(userId)
    if (cached && now - cached.updatedAt < CACHE_TTL) {
      return cached.status === 'active'
    }
    const user = authService.getUserById(userId)
    const status = user?.status === 'active' ? 'active' : 'disabled'
    cache.set(userId, { status, updatedAt: now })
    return status === 'active'
  } catch {
    return true
  }
}

export function invalidateUserStatusCache(userId: string): void {
  cache.delete(userId)
}
