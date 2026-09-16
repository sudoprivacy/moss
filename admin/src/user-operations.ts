import type { AuthUser } from '@/lib/api/types'

export type UserOperation =
  | 'approve'
  | 'reject'
  | 'delete_pending'
  | 'recharge'
  | 'adjust'
  | 'sync_quota'
  | 'ledger'

export function accountStatusLabel(status: AuthUser['status']): string {
  if (status === 'pending') return '待审批'
  if (status === 'active') return '启用'
  if (status === 'locked') return '锁定'
  return '禁用'
}

export function availableUserOperations(
  status: AuthUser['status'],
  isSuperAdmin: boolean,
): UserOperation[] {
  if (status === 'pending') return ['approve', 'reject', 'delete_pending']
  if (status === 'locked') return ['ledger']
  if (status !== 'active') return ['ledger']
  return [
    ...(isSuperAdmin ? ['recharge' as const] : []),
    'adjust',
    'sync_quota',
    'ledger',
  ]
}

export function parsePositiveIntegerPoints(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('积分必须是正整数')
  return parsed
}
