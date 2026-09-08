import { QMS_LEGACY_ROUTES } from './qmsRoutes.js'

type SharedRoute = Readonly<{ method: string; path: string }>

const ADMIN_OPERATION_ROUTES: readonly SharedRoute[] = [
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
]

const QMS_OPERATION_ROUTES: readonly SharedRoute[] = QMS_LEGACY_ROUTES
  .filter(([, path]) => path.startsWith('/api/v1/qms/'))
  .map(([method, path]) => ({ method, path }))

/**
 * 无冲突、可由 Moss 管理端直接调用的统一运营接口。
 * 旧认证、用户和组织管理等与 Moss 原生 API 冲突的路径不得加入此清单。
 */
export const MOSS_SHARED_SUDOWORK_ROUTES: readonly SharedRoute[] = [
  ...ADMIN_OPERATION_ROUTES,
  ...QMS_OPERATION_ROUTES,
]
