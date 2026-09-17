import type { AdjustmentResult } from './billingCoordinator.js'

interface RecoverableQuotaRepository {
  listRecoverableQuotaOperationIds(limit?: number): string[]
}

interface QuotaRetryCoordinator {
  retry(operationId: string): Promise<AdjustmentResult>
}

export interface BillingWorkerRunResult {
  attempted: number
  succeeded: number
  failed: number
}

export class BillingOutboxWorker {
  constructor(
    private readonly repository: RecoverableQuotaRepository,
    private readonly coordinator: QuotaRetryCoordinator,
  ) {}

  async runOnce(limit = 100): Promise<BillingWorkerRunResult> {
    const ids = this.repository.listRecoverableQuotaOperationIds(limit)
    let succeeded = 0
    let failed = 0
    for (const id of ids) {
      try {
        const result = await this.coordinator.retry(id)
        if (result.status === 'SUCCEEDED') succeeded += 1
        else failed += 1
      } catch {
        failed += 1
      }
    }
    return { attempted: ids.length, succeeded, failed }
  }
}
