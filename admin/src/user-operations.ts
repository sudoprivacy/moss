import type { AuthUser } from '@/lib/api/types'

export type UserOperation = 'model_account' | 'model_usage' | 'approve' | 'reject' | 'delete_pending'

export function accountStatusLabel(status: AuthUser['status']): string {
  if (status === 'pending') return '待审批'
  if (status === 'active') return '启用'
  if (status === 'locked') return '锁定'
  return '禁用'
}

export function availableUserOperations(status: AuthUser['status'], _isSuperAdmin: boolean): UserOperation[] {
  if (status === 'pending') return ['approve', 'reject', 'delete_pending', 'model_account', 'model_usage']
  return ['model_account', 'model_usage']
}
