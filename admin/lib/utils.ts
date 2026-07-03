import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Resolve a user id to a display name for admin tables.
 *
 * Resolution order:
 *   1. `serverName` — a name resolved server-side (org-agnostic). Needed for
 *      owners outside the current org's roster, e.g. a super_admin who created
 *      the resource while switched into this org; the client's `users` list
 *      (this org only) can't name them.
 *   2. the org roster (`users`).
 *   3. a truncated id fallback so something always renders.
 */
export function resolveOwnerName(
  users: Array<{ id: string; name: string }>,
  userId: string,
  serverName?: string | null,
): string {
  if (serverName) return serverName
  const user = users.find((u) => u.id === userId)
  return user?.name || userId.slice(0, 8)
}
