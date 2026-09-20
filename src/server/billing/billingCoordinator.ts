import { createHash, randomUUID } from 'node:crypto'
import { assertTrustedCommandContext, migrationCommandContext, onlineCommandContext, replayCommandContext, type CommandContext } from '../application/commandContext.js'
import type { DbDriver } from '../db/driver.js'
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
    private readonly driver: DbDriver,
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
    finalizeLocal?: () => Promise<void>,
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

    const prepared = await this.driver.transaction(async () => {
      const existing = await this.repository.getQuotaOperationByKey(context.idempotencyKey)
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new BillingDomainError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同的额度命令')
        }
        return { operation: existing, created: false, newBalanceUnits: undefined }
      }
      const status = context.externalEffects === 'suppress_external' ? 'SUPPRESSED' : 'PENDING'
      const id = this.idGenerator()
      const inserted = await this.repository.insertQuotaOperation({
        id, ownerType: input.ownerType, ownerId: input.ownerId,
        externalUserId: input.externalUserId, deltaUnits: quotaDelta, status,
        idempotencyKey: context.idempotencyKey, sourceType: input.sourceType,
        sourceId: input.sourceId, orgId: input.orgId, actorUserId: input.actorUserId,
        reason: input.reason, requestFingerprint, contextSource: context.source,
        createdAt: this.clock(),
      })
      const operation = await this.repository.getQuotaOperationByKey(context.idempotencyKey)
      if (!operation) throw new Error('Quota operation was not persisted')
      if (operation.requestFingerprint !== requestFingerprint) {
        throw new BillingDomainError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同的额度命令')
      }
      const posting = status === 'SUPPRESSED'
        ? inserted ? await this.walletService.post(this.walletInput(operation), this.walletContext(context)) : undefined
        : undefined
      if (status === 'SUPPRESSED' && inserted) await finalizeLocal?.()
      if (status === 'SUPPRESSED') return { operation, created: inserted, newBalanceUnits: posting?.balanceAfterUnits }
      const claimed = await this.repository.claimQuotaOperation(operation.id)
      return { operation: claimed ?? operation, created: claimed !== null, newBalanceUnits: undefined }
    })

    if (!prepared.created) {
      if ((prepared.operation.status === 'SUCCEEDED' || prepared.operation.status === 'SUPPRESSED') && finalizeLocal) {
        await this.driver.transaction(finalizeLocal)
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
    await this.driver.transaction(async () => this.repository.updateQuotaOperation({
      id: prepared.operation.id, status: 'PROCESSING', observedQuotaUnits: baseline.quotaUnits,
      observedUsedUnits: baseline.usedQuotaUnits, updatedAt: this.clock(),
    }))
    const changed = await this.sudorouter.changeQuota({
      externalUserId: input.externalUserId, deltaUnits: quotaDelta,
      comment: input.reason, idempotencyKey: context.idempotencyKey,
    })
    if (!changed.success) return this.failOperation(prepared.operation.id, changed.error || '更新额度失败')
    try {
      return await this.finalize(prepared.operation.id, baseline.quotaUnits + quotaDelta, baseline.usedQuotaUnits, finalizeLocal)
    } catch (error) {
      await this.driver.transaction(async () => this.repository.updateQuotaOperation({
        id: prepared.operation.id, status: 'UNKNOWN',
        errorText: `外部额度已返回成功，本地入账失败: ${error instanceof Error ? error.message : String(error)}`,
        updatedAt: this.clock(),
      }))
      return { operationId: prepared.operation.id, status: 'UNKNOWN', error: '额度发放状态不确定，请对账' }
    }
  }

  async retry(operationId: string, finalizeLocal?: () => Promise<void>): Promise<AdjustmentResult> {
    const operation = await this.repository.getQuotaOperationById(operationId)
    if (!operation) throw new BillingDomainError('QUOTA_OPERATION_NOT_FOUND', '额度操作不存在')
    if (operation.status === 'SUCCEEDED' || operation.status === 'SUPPRESSED') {
      if (finalizeLocal) await this.driver.transaction(finalizeLocal)
      return this.resultFor(operation)
    }
    if (operation.status === 'PROCESSING') return this.resultFor(operation)
    if (operation.status !== 'PENDING' && operation.status !== 'UNKNOWN' && operation.status !== 'FAILED') {
      throw new BillingDomainError('QUOTA_OPERATION_NOT_RETRYABLE', '额度操作当前不可重试')
    }
    const claimed = await this.driver.transaction(async () => this.repository.claimQuotaOperation(operation.id))
    if (!claimed) return this.resultFor((await this.repository.getQuotaOperationById(operation.id)) ?? operation)
    const current = await this.sudorouter.getUser(claimed.externalUserId)
    if (!current) {
      return { operationId, status: 'UNKNOWN', error: '无法确认 sudorouter 当前额度' }
    }
    if (claimed.observedQuotaUnits == null) {
      await this.driver.transaction(async () => this.repository.updateQuotaOperation({
        id: claimed.id, status: 'PROCESSING', observedQuotaUnits: current.quotaUnits,
        observedUsedUnits: current.usedQuotaUnits, updatedAt: this.clock(),
      }))
      const changed = await this.sudorouter.changeQuota({
        externalUserId: claimed.externalUserId, deltaUnits: claimed.deltaUnits,
        comment: claimed.reason ?? '额度恢复', idempotencyKey: claimed.idempotencyKey,
      })
      if (!changed.success) return this.failOperation(claimed.id, changed.error || '更新额度失败')
      return this.finalize(claimed.id, current.quotaUnits + claimed.deltaUnits, current.usedQuotaUnits, finalizeLocal)
    }
    const expected = claimed.observedQuotaUnits + claimed.deltaUnits
    if (current.quotaUnits === expected) return this.finalize(claimed.id, current.quotaUnits, current.usedQuotaUnits, finalizeLocal)
    if (current.quotaUnits !== claimed.observedQuotaUnits) {
      return { operationId, status: 'UNKNOWN', error: 'sudorouter 额度与基线及预期均不一致' }
    }
    const changed = await this.sudorouter.changeQuota({
      externalUserId: claimed.externalUserId, deltaUnits: claimed.deltaUnits,
      comment: claimed.reason ?? '额度重试', idempotencyKey: claimed.idempotencyKey,
    })
    if (!changed.success) return this.failOperation(claimed.id, changed.error || '更新额度失败')
    return this.finalize(claimed.id, expected, current.usedQuotaUnits, finalizeLocal)
  }

  async syncQuota(ownerType: BillingOwnerType, ownerId: string, externalUserId: string): Promise<QuotaSnapshot> {
    const snapshot = await this.sudorouter.getUser(externalUserId)
    if (!snapshot) throw new BillingDomainError('SUDOROUTER_QUERY_FAILED', '获取 sudorouter 用户信息失败')
    await this.driver.transaction(async () => this.repository.upsertExternalAccount({
      provider: 'sudorouter', ownerType, ownerId, externalAccountId: externalUserId,
      quotaUnits: snapshot.quotaUnits, usedQuotaUnits: snapshot.usedQuotaUnits, updatedAt: this.clock(),
    }))
    return snapshot
  }

  private finalize(
    operationId: string,
    quotaUnits: number,
    usedQuotaUnits: number,
    finalizeLocal?: () => Promise<void>,
  ): Promise<AdjustmentResult> {
    return this.driver.transaction(async () => {
      const operation = await this.repository.getQuotaOperationById(operationId)
      if (!operation) throw new BillingDomainError('QUOTA_OPERATION_NOT_FOUND', '额度操作不存在')
      if (operation.status === 'SUCCEEDED') return this.resultFor(operation)
      const posting = await this.walletService.post(this.walletInput(operation), this.childContext(operation))
      await this.repository.upsertExternalAccount({
        provider: 'sudorouter', ownerType: operation.ownerType, ownerId: operation.ownerId,
        externalAccountId: operation.externalUserId, quotaUnits, usedQuotaUnits, updatedAt: this.clock(),
      })
      await this.repository.updateQuotaOperation({
        id: operation.id, status: 'SUCCEEDED', providerResponse: { quotaUnits, usedQuotaUnits },
        updatedAt: this.clock(),
      })
      await finalizeLocal?.()
      return {
        operationId: operation.id, status: 'SUCCEEDED',
        newBalanceUnits: posting.balanceAfterUnits, newQuotaUnits: quotaUnits,
      }
    })
  }

  private async failOperation(operationId: string, error: string): Promise<AdjustmentResult> {
    await this.driver.transaction(async () => this.repository.updateQuotaOperation({
      id: operationId, status: 'FAILED', errorText: error, updatedAt: this.clock(),
    }))
    return { operationId, status: 'FAILED', error }
  }

  private async resultFor(operation: QuotaOperationRecord): Promise<AdjustmentResult> {
    const wallet = await this.repository.getWallet(operation.ownerType, operation.ownerId)
    const account = await this.repository.getExternalAccount('sudorouter', operation.ownerType, operation.ownerId)
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
