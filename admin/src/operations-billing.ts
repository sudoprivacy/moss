export type BillingOrderAction = 'detail' | 'sync' | 'retry' | 'refund'
export type CreditApplicationAction = 'detail' | 'approve' | 'reject' | 'retry_sync'

export function billingOrderActions(status: number): BillingOrderAction[] {
  if (status === 1) return ['detail', 'sync']
  if (status === 2) return ['detail', 'refund']
  if (status === 3) return ['detail', 'retry']
  return ['detail']
}

export function creditApplicationActions(status: string | number): CreditApplicationAction[] {
  if (status === 'PENDING') return ['detail', 'approve', 'reject']
  if (status === 'SYNC_FAILED') return ['detail', 'retry_sync']
  return ['detail']
}

export function parseOptionalIntegerPoints(value: string): number | undefined {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('批准积分必须是正整数')
  return parsed
}
