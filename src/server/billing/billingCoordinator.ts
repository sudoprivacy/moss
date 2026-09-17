import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { assertTrustedCommandContext, migrationCommandContext, onlineCommandContext, replayCommandContext, type CommandContext } from '../application/commandContext.js'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'
import { BillingRepository, type QuotaOperationRecord } from './billingRepository.js'
import { BillingDomainError, type BillingOperationStatus, type BillingOwnerType } from './types.js'
import { pointsToQuota, type QuotaSnapshot, type SudorouterPort } from './sudorouterAdapter.js'
import { WalletService } from './walletService.js'

export interface AdjustPointsInput {
  ownerType: BillingOwnerType
  ownerId: string
  orgId: string
  externalUserId: string
  pointsDelta: number
  reason: string
  sourceType: string
  sourceId: string
  actorUserId?: string | null
}

export interface AdjustmentResult {
  operationId: string
  status: BillingOperationStatus
  newBalanceUnits?: number
  newQuotaUnits?: number
  error?: string
}

interface CoordinatorOptions {
  clock?: () => number
  idGenerator?: () => string
}

export class BillingCoordinator {
  private readonly clock: () => number
  private readonly idGenerator: () => string

  constructor(
    private readonly db: DatabaseSync,
    private readonly repository: BillingRepository,
    private readonly walletService: WalletService,
    private readonly sudorouter: SudorouterPort,
    options: CoordinatorOptions = {},
  ) {
    this.clock = options.clock ?? Date.now
    this.idGenerator = options.idGenerator ?? randomUUID
  }

  async adjustPoints(
    input: AdjustPointsInput,
    context: CommandContext,
    finalizeLocal?: () => void,
  ): Promise<AdjustmentResult> {
    assertTrustedCommandContext(context)
    if (!Number.isSafeInteger(input.pointsDelta) || input.pointsDelta === 0) {
      throw new BillingDomainError('INVALID_AMOUNT', '积分数量必须为非零整数')
    }
    const quotaDelta = pointsToQuota(input.pointsDelta)
    const requestFingerprint = createHash('sha256').update(JSON.stringify([
      input.ownerType, input.ownerId, input.orgId, input.externalUserId,
      input.pointsDelta, input.reason, input.sourceType, input.sourceId, input.actorUserId ?? null,
    ])).digest('hex')

    const prepared = runInTransaction(this.db, () => {
      const existing = this.repository.getQuotaOperationByKey(context.idempotencyKey)
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new BillingDomainError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同的额度命令')
        }
        return { operation: existing, created: false, newBalanceUnits: undefined }
      }
      const status = context.externalEffects === 'suppress_external' ? 'SUPPRESSED' : 'PENDING'
      const id = this.idGenerator()
      this.repository.insertQuotaOperation({
        id, ownerType: input.ownerType, ownerId: input.ownerId,
        externalUserId: input.externalUserId, deltaUnits: quotaDelta, status,
        idempotencyKey: context.idempotencyKey, sourceType: input.sourceType,
        sourceId: input.sourceId, orgId: input.orgId, actorUserId: input.actorUserId,
        reason: input.reason, requestFingerprint, contextSource: context.source,
        createdAt: this.clock(),
      })
      const operation = this.repository.getQuotaOperationById(id)!
      const posting = status === 'SUPPRESSED'
        ? this.walletService.post(this.walletInput(operation), this.walletContext(context))
        : undefined
      if (status === 'SUPPRESSED') finalizeLocal?.()
      return { operation, created: true, newBalanceUnits: posting?.balanceAfterUnits }
    })

    if (!prepared.created) {
      if ((prepared.operation.status === 'SUCCEEDED' || prepared.operation.status === 'SUPPRESSED') && finalizeLocal) {
        runInTransaction(this.db, finalizeLocal)
      }
      return this.resultFor(prepared.operation)
    }
    if (prepared.operation.status === 'SUPPRESSED') {
      return {
        operationId: prepared.operation.id, status: 'SUPPRESSED',
        newBalanceUnits: prepared.newBalanceUnits,
      }
    }

    const baseline = await this.sudorouter.getUser(input.externalUserId)
    if (!baseline) return this.failOperation(prepared.operation.id, '获取 sudorouter 用户信息失败')
    runInTransaction(this.db, () => this.repository.updateQuotaOperation({
      id: prepared.operation.id, status: 'PROCESSING', observedQuotaUnits: baseline.quotaUnits,
      observedUsedUnits: baseline.usedQuotaUnits, updatedAt: this.clock(),
    }))
    const changed = await this.sudorouter.changeQuota({
      externalUserId: input.externalUserId, deltaUnits: quotaDelta,
      comment: input.reason, idempotencyKey: context.idempotencyKey,
    })
    if (!changed.success) return this.failOperation(prepared.operation.id, changed.error || '更新额度失败')
    try {
      return this.finalize(prepared.operation.id, baseline.quotaUnits + quotaDelta, baseline.usedQuotaUnits, finalizeLocal)
    } catch (error) {
      runInTransaction(this.db, () => this.repository.updateQuotaOperation({
        id: prepared.operation.id, status: 'UNKNOWN',
        errorText: `外部额度已返回成功，本地入账失败: ${error instanceof Error ? error.message : String(error)}`,
        updatedAt: this.clock(),
      }))
      return { operationId: prepared.operation.id, status: 'UNKNOWN', error: '额度发放状态不确定，请对账' }
    }
  }

  async retry(operationId: string, finalizeLocal?: () => void): Promise<AdjustmentResult> {
    const operation = this.repository.getQuotaOperationById(operationId)
    if (!operation) throw new BillingDomainError('QUOTA_OPERATION_NOT_FOUND', '额度操作不存在')
    if (operation.status === 'SUCCEEDED' || operation.status === 'SUPPRESSED') {
      if (finalizeLocal) runInTransaction(this.db, finalizeLocal)
      return this.resultFor(operation)
    }
    if (operation.status !== 'PENDING' && operation.status !== 'UNKNOWN'
      && operation.status !== 'PROCESSING' && operation.status !== 'FAILED') {
      throw new BillingDomainError('QUOTA_OPERATION_NOT_RETRYABLE', '额度操作当前不可重试')
    }
    const current = await this.sudorouter.getUser(operation.externalUserId)
    if (!current) {
      return { operationId, status: 'UNKNOWN', error: '无法确认 sudorouter 当前额度' }
    }
    if (operation.observedQuotaUnits == null) {
      runInTransaction(this.db, () => this.repository.updateQuotaOperation({
        id: operation.id, status: 'PROCESSING', observedQuotaUnits: current.quotaUnits,
        observedUsedUnits: current.usedQuotaUnits, updatedAt: this.clock(),
      }))
      const changed = await this.sudorouter.changeQuota({
        externalUserId: operation.externalUserId, deltaUnits: operation.deltaUnits,
        comment: operation.reason ?? '额度恢复', idempotencyKey: operation.idempotencyKey,
      })
      if (!changed.success) return this.failOperation(operation.id, changed.error || '更新额度失败')
      return this.finalize(operation.id, current.quotaUnits + operation.deltaUnits, current.usedQuotaUnits, finalizeLocal)
    }
    const expected = operation.observedQuotaUnits + operation.deltaUnits
    if (current.quotaUnits === expected) return this.finalize(operation.id, current.quotaUnits, current.usedQuotaUnits, finalizeLocal)
    if (current.quotaUnits !== operation.observedQuotaUnits) {
      return { operationId, status: 'UNKNOWN', error: 'sudorouter 额度与基线及预期均不一致' }
    }
    const changed = await this.sudorouter.changeQuota({
      externalUserId: operation.externalUserId, deltaUnits: operation.deltaUnits,
      comment: operation.reason ?? '额度重试', idempotencyKey: operation.idempotencyKey,
    })
    if (!changed.success) return this.failOperation(operation.id, changed.error || '更新额度失败')
    return this.finalize(operation.id, expected, current.usedQuotaUnits, finalizeLocal)
  }

  async syncQuota(ownerType: BillingOwnerType, ownerId: string, externalUserId: string): Promise<QuotaSnapshot> {
    const snapshot = await this.sudorouter.getUser(externalUserId)
    if (!snapshot) throw new BillingDomainError('SUDOROUTER_QUERY_FAILED', '获取 sudorouter 用户信息失败')
    runInTransaction(this.db, () => this.repository.upsertExternalAccount({
      provider: 'sudorouter', ownerType, ownerId, externalAccountId: externalUserId,
      quotaUnits: snapshot.quotaUnits, usedQuotaUnits: snapshot.usedQuotaUnits, updatedAt: this.clock(),
    }))
    return snapshot
  }

  private finalize(
    operationId: string,
    quotaUnits: number,
    usedQuotaUnits: number,
    finalizeLocal?: () => void,
  ): AdjustmentResult {
    return runInTransaction(this.db, () => {
      const operation = this.repository.getQuotaOperationById(operationId)
      if (!operation) throw new BillingDomainError('QUOTA_OPERATION_NOT_FOUND', '额度操作不存在')
      if (operation.status === 'SUCCEEDED') return this.resultFor(operation)
      const posting = this.walletService.post(this.walletInput(operation), this.childContext(operation))
      this.repository.upsertExternalAccount({
        provider: 'sudorouter', ownerType: operation.ownerType, ownerId: operation.ownerId,
        externalAccountId: operation.externalUserId, quotaUnits, usedQuotaUnits, updatedAt: this.clock(),
      })
      this.repository.updateQuotaOperation({
        id: operation.id, status: 'SUCCEEDED', providerResponse: { quotaUnits, usedQuotaUnits },
        updatedAt: this.clock(),
      })
      finalizeLocal?.()
      return {
        operationId: operation.id, status: 'SUCCEEDED',
        newBalanceUnits: posting.balanceAfterUnits, newQuotaUnits: quotaUnits,
      }
    })
  }

  private failOperation(operationId: string, error: string): AdjustmentResult {
    runInTransaction(this.db, () => this.repository.updateQuotaOperation({
      id: operationId, status: 'FAILED', errorText: error, updatedAt: this.clock(),
    }))
    return { operationId, status: 'FAILED', error }
  }

  private resultFor(operation: QuotaOperationRecord): AdjustmentResult {
    const wallet = this.repository.getWallet(operation.ownerType, operation.ownerId)
    const account = this.repository.getExternalAccount('sudorouter', operation.ownerType, operation.ownerId)
    return {
      operationId: operation.id, status: operation.status,
      ...(wallet ? { newBalanceUnits: wallet.balanceUnits } : {}),
      ...(account ? { newQuotaUnits: account.quotaUnits } : {}),
    }
  }

  private walletInput(operation: QuotaOperationRecord) {
    return {
      ownerType: operation.ownerType, ownerId: operation.ownerId,
      deltaUnits: operation.deltaUnits / 500,
      entryType: operation.deltaUnits < 0 ? 'CONSUME' : 'BONUS',
      memo: operation.reason,
      sourceType: 'quota_operation', sourceId: operation.id,
      actorUserId: operation.actorUserId, orgId: operation.orgId,
    }
  }

  private childContext(operation: QuotaOperationRecord): CommandContext {
    const key = `quota:${operation.idempotencyKey}`
    if (operation.contextSource === 'migration') return migrationCommandContext(operation.idempotencyKey, key)
    if (operation.contextSource === 'replay') return replayCommandContext(operation.idempotencyKey, key)
    return onlineCommandContext(key)
  }

  private walletContext(context: CommandContext): CommandContext {
    const key = `quota:${context.idempotencyKey}`
    if (context.source === 'migration') return migrationCommandContext(context.migrationRunId!, key)
    if (context.source === 'replay') return replayCommandContext(context.originalEventId!, key)
    return onlineCommandContext(key)
  }
}
