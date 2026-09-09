export const MOSS_ADMIN_API_PREFIX = '/api/moss/v1'

export function normalizeMossAdminApiPath(pathname: string): string {
  if (pathname === MOSS_ADMIN_API_PREFIX) return '/api/v1'
  if (pathname.startsWith(`${MOSS_ADMIN_API_PREFIX}/`)) {
    return `/api/v1${pathname.slice(MOSS_ADMIN_API_PREFIX.length)}`
  }
  return pathname
}
