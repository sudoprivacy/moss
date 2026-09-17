export type BillingOwnerType = 'organization' | 'user'
export type BillingContextSource = 'online' | 'migration' | 'replay'
export type BillingOrderStatus =
  | 'PENDING'
  | 'PAYING'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'PARTIAL_REFUNDED'
export type BillingOperationStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'SUPPRESSED'
export type CreditApplicationStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'APPROVED'
  | 'REJECTED'
  | 'SYNC_FAILED'
  | 'SYNC_UNKNOWN'

export class BillingDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'BillingDomainError'
  }
}
