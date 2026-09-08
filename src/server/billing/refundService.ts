import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { assertTrustedCommandContext, migrationCommandContext, onlineCommandContext, replayCommandContext, type CommandContext } from '../application/commandContext.js'
import type { IdentityRepository } from '../identity/identityRepository.js'
import type { IdentityActor } from '../identity/organizationIdentityService.js'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'
import { BillingCoordinator } from './billingCoordinator.js'
import { BillingRepository, type RefundRecord } from './billingRepository.js'
import { pointsToQuota } from './sudorouterAdapter.js'
import { BillingDomainError } from './types.js'
import type { WalletService } from './walletService.js'

export interface FuiouRefundPort {
  refund(input: {
    refundNo: string
    refundDate: string
    payOrderDate: string
    payOrderNo: string
    amountCents: number
  }): Promise<{
    success: boolean
    providerRefundNo?: string
    raw?: Record<string, unknown>
    error?: string
  }>
}

export interface RefundQuote {
  orderPoints: number
  userBalance: number
  usedPoints: number
  refundAmountCents: number
  deductPoints: number
  originalAmountCents: number
}

interface RefundServiceOptions {
  clock?: () => number
  idGenerator?: () => string
  suffixGenerator?: () => string
}

export class RefundService {
  private readonly clock: () => number
  private readonly idGenerator: () => string
  private readonly suffixGenerator: () => string

  constructor(
    private readonly db: DatabaseSync,
    private readonly repository: BillingRepository,
    private readonly identities: IdentityRepository,
    private readonly wallet: WalletService,
    private readonly coordinator: BillingCoordinator,
    private readonly fuiou: FuiouRefundPort,
    options: RefundServiceOptions = {},
  ) {
    this.clock = options.clock ?? Date.now
    this.idGenerator = options.idGenerator ?? randomUUID
    this.suffixGenerator = options.suffixGenerator ?? (() => Math.random().toString(36).slice(2, 8).toUpperCase())
  }

  calculate(orderNo: string): RefundQuote {
    const order = this.repository.getOrderByOrderNo(orderNo)
    if (!order) throw new BillingDomainError('ORDER_NOT_FOUND', '订单不存在')
    if (order.status !== 'SUCCESS') throw new BillingDomainError('ORDER_NOT_REFUNDABLE', '订单状态不支持退款')
    const wallet = this.repository.getWallet('user', order.userId)
    if (!wallet) throw new BillingDomainError('WALLET_NOT_FOUND', '用户不存在')

    // pointsUnits 已经是实际到账总积分，bonusUnits 仅用于展示，不能再次相加。
    const orderPoints = order.pointsUnits
    const userBalance = wallet.balanceUnits
    const usedPoints = Math.max(0, orderPoints - userBalance)
    const deductPoints = Math.min(userBalance, orderPoints)
    const usedAmountCents = divideAndRound(
      BigInt(usedPoints) * BigInt(order.exchangeRateMicros) * 100n,
      1_000_000_000n,
    )
    const refundAmountCents = Math.max(0, order.amountCents - usedAmountCents)
    return {
      orderPoints, userBalance, usedPoints, refundAmountCents,
      deductPoints, originalAmountCents: order.amountCents,
    }
  }

  async request(
    input: { orderNo: string; reason: string },
    actor: IdentityActor,
    context: CommandContext,
  ): Promise<RefundRecord> {
    assertTrustedCommandContext(context)
    const reason = input.reason?.trim() || '用户申请退款'
    if (reason.length > 500) throw new BillingDomainError('REFUND_REASON_TOO_LONG', '退款原因不能超过 500 个字符')
    const order = this.repository.getOrderByOrderNo(input.orderNo)
    if (!order) throw new BillingDomainError('ORDER_NOT_FOUND', '订单不存在')
    this.requireReviewer(order.orgId, actor)
    const quote = this.calculate(input.orderNo)
    if (quote.refundAmountCents <= 0) throw new BillingDomainError('REFUND_AMOUNT_ZERO', '无可退款金额')
    const external = this.repository.getExternalAccount('sudorouter', 'user', order.userId)
    if (!external) throw new BillingDomainError('SUDOROUTER_NOT_BOUND', '用户未绑定 sudorouter 账号')
    const fingerprint = createHash('sha256').update(JSON.stringify([
      order.id, reason, actor.userId, actor.orgId,
    ])).digest('hex')

    const prepared = runInTransaction(this.db, () => {
      const previous = this.repository.getRefundByIdempotencyKey(context.idempotencyKey)
      if (previous) {
        if (previous.requestFingerprint !== fingerprint) {
          throw new BillingDomainError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同的退款请求')
        }
        return { refund: previous, created: false }
      }
      if (this.repository.getActiveRefundForOrder(order.id)) {
        throw new BillingDomainError('REFUND_IN_PROGRESS', '该订单已有退款记录')
      }
      const current = this.repository.getWallet('user', order.userId)
      if (!current || current.balanceUnits < quote.deductPoints) {
        throw new BillingDomainError('INSUFFICIENT_BALANCE', '用户积分不足，无法退款')
      }
      const now = this.clock()
      const id = this.idGenerator()
      const status = context.externalEffects === 'suppress_external' ? 'SUPPRESSED' : 'PROCESSING'
      const refund: RefundRecord = {
        id, legacyId: this.identities.allocateNumericAlias('billing_refund', id, order.orgId),
        refundNo: `RF${now}${this.suffixGenerator()}`,
        orderId: order.id, userId: order.userId,
        refundAmountCents: quote.refundAmountCents,
        refundQuotaUnits: pointsToQuota(quote.deductPoints),
        refundPointsUnits: quote.deductPoints, reason, refundType: 'ORIGINAL', status,
        providerRefundNo: null, quotaOperationId: null,
        idempotencyKey: context.idempotencyKey, requestFingerprint: fingerprint,
        createdAt: now, updatedAt: now,
      }
      this.repository.insertRefund(refund)
      return { refund, created: true }
    })

    if (!prepared.created) return prepared.refund
    let providerResult: Awaited<ReturnType<FuiouRefundPort['refund']>> = {
      success: true, raw: { suppressed: true },
    }
    if (context.externalEffects !== 'suppress_external') {
      providerResult = await this.fuiou.refund({
        refundNo: prepared.refund.refundNo,
        refundDate: formatOrderDate(this.clock()),
        payOrderDate: order.orderDate,
        payOrderNo: order.orderNo,
        amountCents: quote.refundAmountCents,
      })
      if (!providerResult.success) {
        runInTransaction(this.db, () => this.repository.updateRefund({
          id: prepared.refund.id, status: 'FAILED', providerResponse: providerResult.raw,
          updatedAt: this.clock(),
        }))
        throw new BillingDomainError('REFUND_PROVIDER_FAILED', providerResult.error || '退款请求失败')
      }
    }

    const childContext = this.childContext(context, `refund:${prepared.refund.id}`)
    const adjustment = await this.coordinator.adjustPoints({
      ownerType: 'user', ownerId: order.userId, orgId: order.orgId,
      externalUserId: external.externalAccountId, pointsDelta: -quote.deductPoints,
      reason: `退款扣除: ${order.orderNo}`, sourceType: 'billing_refund',
      sourceId: prepared.refund.id, actorUserId: actor.userId,
    }, childContext, () => {
      this.repository.updateRefund({
        id: prepared.refund.id,
        status: context.externalEffects === 'suppress_external' ? 'SUPPRESSED' : 'SUCCEEDED',
        providerRefundNo: providerResult.providerRefundNo,
        providerResponse: providerResult.raw,
        quotaOperationId: this.repository.getQuotaOperationByKey(childContext.idempotencyKey)?.id,
        updatedAt: this.clock(),
      })
      this.repository.updateOrderStatus({
        orderId: order.id, status: 'REFUNDED', updatedAt: this.clock(),
        remark: `退款原因: ${reason}`,
      })
    })
    if (adjustment.status !== 'SUCCEEDED' && adjustment.status !== 'SUPPRESSED') {
      this.markUnknown(prepared.refund.id, providerResult, adjustment.operationId)
      throw new BillingDomainError('REFUND_SYNC_UNKNOWN', '退款已受理，积分与额度同步状态待对账')
    }
    return this.repository.getRefundById(prepared.refund.id)!
  }

  private requireReviewer(orderOrgId: string, actor: IdentityActor): void {
    if (actor.role !== 'super_admin' && actor.role !== 'admin') {
      throw new BillingDomainError('REFUND_FORBIDDEN', '无权执行退款')
    }
    if (actor.role !== 'super_admin' && actor.orgId !== orderOrgId) {
      throw new BillingDomainError('REFUND_FORBIDDEN', '无权退款其他企业的订单')
    }
  }

  private markUnknown(
    refundId: string,
    providerResult: Awaited<ReturnType<FuiouRefundPort['refund']>>,
    quotaOperationId?: string,
  ): void {
    runInTransaction(this.db, () => this.repository.updateRefund({
      id: refundId, status: 'UNKNOWN', providerRefundNo: providerResult.providerRefundNo,
      providerResponse: providerResult.raw, quotaOperationId, updatedAt: this.clock(),
    }))
  }

  private childContext(context: CommandContext, key: string): CommandContext {
    if (context.source === 'migration') return migrationCommandContext(context.migrationRunId!, key)
    if (context.source === 'replay') return replayCommandContext(context.originalEventId!, key)
    return onlineCommandContext(key)
  }
}

function divideAndRound(numerator: bigint, denominator: bigint): number {
  return Number((numerator + denominator / 2n) / denominator)
}

function formatOrderDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10).replaceAll('-', '')
}
