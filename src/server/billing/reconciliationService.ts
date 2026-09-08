import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { assertTrustedCommandContext, type CommandContext } from '../application/commandContext.js'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'
import { BillingRepository } from './billingRepository.js'
import type { BillingOwnerType } from './types.js'
import type { WalletService } from './walletService.js'

export interface ReconciliationReport {
  id: string
  status: 'MATCHED' | 'MISMATCH'
  expectedUnits: number
  actualUnits: number
  differenceUnits: number
}

interface ReconciliationOptions {
  clock?: () => number
  idGenerator?: () => string
}

export class ReconciliationService {
  private readonly clock: () => number
  private readonly idGenerator: () => string

  constructor(
    private readonly db: DatabaseSync,
    private readonly repository: BillingRepository,
    private readonly wallet: WalletService,
    options: ReconciliationOptions = {},
  ) {
    this.clock = options.clock ?? Date.now
    this.idGenerator = options.idGenerator ?? randomUUID
  }

  run(
    scope: { ownerType: BillingOwnerType; ownerId: string },
    context: CommandContext,
  ): ReconciliationReport {
    assertTrustedCommandContext(context)
    const rebuilt = this.wallet.rebuild(scope.ownerType, scope.ownerId)
    const report: ReconciliationReport = {
      id: this.idGenerator(),
      status: rebuilt.difference === 0 ? 'MATCHED' : 'MISMATCH',
      expectedUnits: rebuilt.rebuilt,
      actualUnits: rebuilt.stored,
      differenceUnits: rebuilt.difference,
    }
    runInTransaction(this.db, () => this.repository.insertReconciliation({
      id: report.id, scopeType: scope.ownerType, scopeId: scope.ownerId,
      reconciliationType: 'WALLET_LEDGER', expectedUnits: report.expectedUnits,
      actualUnits: report.actualUnits, differenceUnits: report.differenceUnits,
      status: report.status, details: { commandIdempotencyKey: context.idempotencyKey },
      createdAt: this.clock(),
    }))
    return report
  }
}
