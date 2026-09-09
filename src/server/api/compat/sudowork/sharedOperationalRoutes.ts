import { QMS_LEGACY_ROUTES } from './qmsRoutes.js'

type SharedRoute = Readonly<{ method: string; path: string }>

export const MOSS_OPERATIONS_API_PREFIX = '/api/moss/v1/operations'

export function mapMossOperationsPath(pathname: string): string | null {
  if (!pathname.startsWith(`${MOSS_OPERATIONS_API_PREFIX}/`)) return null
  const suffix = pathname.slice(MOSS_OPERATIONS_API_PREFIX.length)
  if (suffix === '/qms' || suffix.startsWith('/qms/')) {
    return `/api/v1${suffix}`
  }
  return `/api/v1/admin${suffix}`
}

const ADMIN_OPERATION_ROUTES: readonly SharedRoute[] = [
  { method: 'POST', path: '/api/v1/admin/approve' },
  { method: 'POST', path: '/api/v1/admin/reject' },
  { method: 'POST', path: '/api/v1/admin/delete' },
  { method: 'GET', path: '/api/v1/admin/users' },
  { method: 'GET', path: '/api/v1/admin/users/:id/ledger' },
  { method: 'POST', path: '/api/v1/admin/users/:id/points' },
  { method: 'POST', path: '/api/v1/admin/users/:id/recharge' },
  { method: 'POST', path: '/api/v1/admin/users/:id/sync-quota' },
  { method: 'GET', path: '/api/v1/admin/system-config' },
  { method: 'PUT', path: '/api/v1/admin/system-config' },
  { method: 'GET', path: '/api/v1/admin/invitation-codes/available' },
  { method: 'GET', path: '/api/v1/admin/invitation-codes' },
  { method: 'POST', path: '/api/v1/admin/invitation-codes' },
  { method: 'DELETE', path: '/api/v1/admin/invitation-codes/:id' },
  { method: 'GET', path: '/api/v1/admin/logs' },
  { method: 'GET', path: '/api/v1/admin/stats' },
  { method: 'GET', path: '/api/v1/admin/recharge/orders' },
  { method: 'GET', path: '/api/v1/admin/recharge/orders/:orderNo' },
  { method: 'GET', path: '/api/v1/admin/recharge/stats' },
  { method: 'GET', path: '/api/v1/admin/recharge/refund-calc/:orderNo' },
  { method: 'POST', path: '/api/v1/admin/recharge/orders/:orderNo/refund' },
  { method: 'POST', path: '/api/v1/admin/recharge/simulate-payment/:orderNo' },
  { method: 'GET', path: '/api/v1/admin/recharge-records' },
  { method: 'POST', path: '/api/v1/admin/recharge/orders/:id/retry' },
  { method: 'POST', path: '/api/v1/admin/recharge/sync' },
  { method: 'POST', path: '/api/v1/admin/recharge/orders/:orderNo/sync' },
  { method: 'GET', path: '/api/v1/admin/credit-applications' },
  { method: 'GET', path: '/api/v1/admin/credit-applications/:id' },
  { method: 'POST', path: '/api/v1/admin/credit-applications/:id/approve' },
  { method: 'POST', path: '/api/v1/admin/credit-applications/:id/reject' },
  { method: 'POST', path: '/api/v1/admin/credit-applications/:id/retry-sync' },
  { method: 'GET', path: '/api/v1/admin/datasets' },
  { method: 'POST', path: '/api/v1/admin/datasets' },
  { method: 'GET', path: '/api/v1/admin/datasets/:datasetId' },
  { method: 'PATCH', path: '/api/v1/admin/datasets/:datasetId' },
  { method: 'DELETE', path: '/api/v1/admin/datasets/:datasetId' },
  { method: 'GET', path: '/api/v1/admin/datasets/:datasetId/documents' },
  { method: 'POST', path: '/api/v1/admin/datasets/:datasetId/documents' },
  { method: 'DELETE', path: '/api/v1/admin/datasets/:datasetId/documents/:documentId' },
  { method: 'POST', path: '/api/v1/admin/datasets/:datasetId/retrieve' },
  { method: 'GET', path: '/api/v1/admin/dify/sso' },
]

const QMS_OPERATION_ROUTES: readonly SharedRoute[] = QMS_LEGACY_ROUTES
  .filter(([, path]) => path.startsWith('/api/v1/qms/'))
  .map(([method, path]) => ({ method, path }))

/** Moss 运营命名空间在内部复用的旧协议投影清单，不直接对 Moss Host 公开。 */
export const MOSS_OPERATIONS_LEGACY_ROUTES: readonly SharedRoute[] = [
  ...ADMIN_OPERATION_ROUTES,
  ...QMS_OPERATION_ROUTES,
]
