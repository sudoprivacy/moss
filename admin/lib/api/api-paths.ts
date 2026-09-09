export const MOSS_ADMIN_API_PREFIX = '/api/moss/v1'
export const MOSS_OPERATIONS_API_PREFIX = `${MOSS_ADMIN_API_PREFIX}/operations`

export function toMossAdminApiPath(path: string): string {
  if (path === MOSS_ADMIN_API_PREFIX || path.startsWith(`${MOSS_ADMIN_API_PREFIX}/`)) return path
  if (path === '/api/v1') return MOSS_ADMIN_API_PREFIX
  if (path.startsWith('/api/v1/')) return `${MOSS_ADMIN_API_PREFIX}${path.slice('/api/v1'.length)}`
  return path
}

export function toMossOperationsApiPath(path: string): string {
  if (path === '/api/v1/admin') return MOSS_OPERATIONS_API_PREFIX
  if (path.startsWith('/api/v1/admin/')) {
    return `${MOSS_OPERATIONS_API_PREFIX}${path.slice('/api/v1/admin'.length)}`
  }
  if (path === '/api/v1/qms') return `${MOSS_OPERATIONS_API_PREFIX}/qms`
  if (path.startsWith('/api/v1/qms/')) {
    return `${MOSS_OPERATIONS_API_PREFIX}${path.slice('/api/v1'.length)}`
  }
  throw new Error(`Unsupported operations path: ${path}`)
}

export function apiErrorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback
  const body = value as Record<string, unknown>
  if (typeof body.error === 'string') return body.error
  if (body.error && typeof body.error === 'object') {
    const nested = (body.error as Record<string, unknown>).message
    if (typeof nested === 'string' && nested) return nested
  }
  if (typeof body.message === 'string' && body.message) return body.message
  if (typeof body.msg === 'string' && body.msg) return body.msg
  return fallback
}
