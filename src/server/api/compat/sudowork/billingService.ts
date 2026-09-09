import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { onlineCommandContext } from '../../../application/commandContext.js'
import type { AuthCenterDb, AuthCenterUser } from '../../../authCenter/db.js'
import type { BillingCoordinator } from '../../../billing/billingCoordinator.js'
import { BillingRepository, type BillingOrderRecord, type CreditApplicationRecord } from '../../../billing/billingRepository.js'
import type { CreditApplicationService } from '../../../billing/creditApplicationService.js'
import type { PaymentIntent, RechargeService } from '../../../billing/rechargeService.js'
import type { RefundService } from '../../../billing/refundService.js'
import { pointsToQuota, quotaToPoints } from '../../../billing/sudorouterAdapter.js'
import { BillingDomainError, type BillingOrderStatus, type CreditApplicationStatus } from '../../../billing/types.js'
import type { WalletService } from '../../../billing/walletService.js'
import type { IdentityRepository } from '../../../identity/identityRepository.js'
import {
  hasGlobalOrganizationAccess,
  type IdentityActor,
} from '../../../identity/organizationIdentityService.js'

export class SudoworkBillingError extends Error {
  constructor(readonly statusCode: 400 | 403 | 404 | 409 | 500, message: string) {
    super(message)
    this.name = 'SudoworkBillingError'
  }
}

export interface SudoworkBillingPort {
  listPackages(): unknown[]
  createOrder(input: { actor: IdentityActor; amount: number; paymentMethod: unknown; idempotencyKey?: string }): unknown
  payOrder(input: { actor: IdentityActor; orderNo: string; idempotencyKey?: string }): Promise<unknown>
  handlePaymentCallback(payload: Record<string, unknown>): Promise<void>
  queryOrder(actor: IdentityActor, orderNo: string): unknown
  listUserOrders(input: { actor: IdentityActor; page: number; pageSize: number }): unknown
  cancelOrder(input: { actor: IdentityActor; orderNo: string; idempotencyKey?: string }): void

  listAdminOrders(input: { actor: IdentityActor; query: Record<string, string | undefined> }): unknown
  getAdminOrder(actor: IdentityActor, orderNo: string): unknown
  getRechargeStats(actor: IdentityActor): unknown
  calculateRefund(actor: IdentityActor, orderNo: string): unknown
  requestRefund(input: { actor: IdentityActor; orderNo: string; reason: string; idempotencyKey?: string }): Promise<unknown>
  simulatePayment(input: { actor: IdentityActor; orderNo: string; idempotencyKey?: string }): Promise<unknown>
  listRechargeRecords(input: { actor: IdentityActor; query: Record<string, string | undefined> }): unknown
  retryOrder(input: { actor: IdentityActor; legacyOrderId: number; idempotencyKey?: string }): Promise<void>
  syncPendingOrders(input: { actor: IdentityActor; idempotencyKey?: string }): Promise<unknown>
  syncOrder(input: { actor: IdentityActor; orderNo: string; idempotencyKey?: string }): Promise<unknown>
  adjustUserPoints(input: {
    actor: IdentityActor; legacyUserId: number; amount: number; operation: unknown
    reason?: string; syncSudorouter?: boolean; idempotencyKey?: string
  }): Promise<unknown>
  rechargeUser(input: {
    actor: IdentityActor; legacyUserId: number; points: number; reason?: string
    paymentReference?: string; idempotencyKey?: string
  }): Promise<unknown>
  syncUserQuota(input: { actor: IdentityActor; legacyUserId: number; idempotencyKey?: string }): Promise<unknown>

  createCreditApplication(input: {
    actor: IdentityActor; requestedPoints: number; reason: unknown; idempotencyKey?: string
  }): unknown
  listUserCreditApplications(input: { actor: IdentityActor; page: number; pageSize: number }): unknown
  getUserCreditApplication(actor: IdentityActor, legacyApplicationId: number): unknown
  listAdminCreditApplications(input: { actor: IdentityActor; query: Record<string, string | undefined> }): unknown
  getAdminCreditApplication(actor: IdentityActor, legacyApplicationId: number): unknown
  approveCreditApplication(input: {
    actor: IdentityActor; legacyApplicationId: number; approvedPoints?: number
    adminComment?: string; idempotencyKey?: string
  }): Promise<unknown>
  rejectCreditApplication(input: {
    actor: IdentityActor; legacyApplicationId: number; adminComment: unknown; idempotencyKey?: string
  }): unknown
  retryCreditApplication(input: {
    actor: IdentityActor; legacyApplicationId: number; idempotencyKey?: string
  }): Promise<unknown>
}

export interface BillingPaymentPort {
  readonly simulationEnabled: boolean
  createPayment(intent: PaymentIntent): Promise<{ qrCodeUrl: string; orderInfo: string }>
  verifyCallback(payload: Record<string, unknown>): Promise<{
    providerEventId: string
    orderNo: string
    status: 'SUCCESS' | 'FAILED'
    amountCents: number
    orderDate: string
    raw: Record<string, unknown>
  }>
  queryPayment(order: BillingOrderRecord): Promise<{
    status: 'SUCCESS' | 'FAILED' | 'PENDING'
    event?: {
      providerEventId: string
      orderNo: string
      status: 'SUCCESS' | 'FAILED'
      amountCents: number
      orderDate: string
      raw: Record<string, unknown>
    }
  }>
}

interface SudoworkBillingServiceOptions {
  db: DatabaseSync
  auth: AuthCenterDb
  identities: IdentityRepository
  repository: BillingRepository
  wallet: WalletService
  recharge: RechargeService
  coordinator: BillingCoordinator
  credit: CreditApplicationService
  refund: RefundService
  payment: BillingPaymentPort
  clock?: () => number
}

const STATUS_TO_LEGACY: Record<BillingOrderStatus, number> = {
  PENDING: 0, PAYING: 1, SUCCESS: 2, FAILED: 3,
  REFUNDED: 4, PARTIAL_REFUNDED: 4, CANCELLED: 5,
}
const STATUS_TEXT = ['待支付', '支付中', '支付成功', '支付失败', '已退款', '已取消'] as const
const LEGACY_TO_STATUS: Record<string, BillingOrderStatus> = {
  '0': 'PENDING', '1': 'PAYING', '2': 'SUCCESS', '3': 'FAILED', '4': 'REFUNDED', '5': 'CANCELLED',
}

export class SudoworkBillingService implements SudoworkBillingPort {
  private readonly clock: () => number

  constructor(private readonly options: SudoworkBillingServiceOptions) {
    this.clock = options.clock ?? Date.now
  }

  listPackages(): unknown[] {
    return this.options.recharge.listPackages()
  }

  createOrder(input: { actor: IdentityActor; amount: number; paymentMethod: unknown; idempotencyKey?: string }): unknown {
    const user = this.requireUser(input.actor.userId)
    const legacyUserId = this.ensureAlias('user', user.id, user.orgId)
    const phone = this.options.identities.findAuthIdentityByUser(user.id, 'phone', 'sudowork')?.normalizedSubject ?? null
    const order = this.options.recharge.createOrder({
      userId: user.id, legacyUserId, orgId: user.orgId, userPhone: phone,
      amountUsd: input.amount, paymentMethod: input.paymentMethod as 'ALIPAY' | 'WECHAT',
    }, this.context(input.idempotencyKey, 'create-order'))
    return {
      order_no: order.orderNo, amount_usd: order.amountUsd, amount_cny: order.amountCny,
      points: order.pointsUnits, quota: order.quotaUnits, expired_at: toIso(order.expiredAt),
    }
  }

  async payOrder(input: { actor: IdentityActor; orderNo: string; idempotencyKey?: string }): Promise<unknown> {
    const context = this.context(input.idempotencyKey, 'pay-order')
    const intent = this.options.recharge.preparePayment(input.orderNo, input.actor.userId, context)
    try {
      const payment = await this.options.payment.createPayment(intent)
      this.options.recharge.recordPaymentRequestResult({
        attemptId: intent.attemptId, orderId: intent.orderId, success: true,
        providerOrderInfo: payment.orderInfo,
      })
      return { order_no: input.orderNo, qr_code_url: payment.qrCodeUrl, order_info: payment.orderInfo }
    } catch (error) {
      this.options.recharge.recordPaymentRequestResult({
        attemptId: intent.attemptId, orderId: intent.orderId, success: false,
        errorText: error instanceof Error ? error.message : String(error),
      })
      throw new SudoworkBillingError(400, error instanceof Error ? error.message : '支付请求失败')
    }
  }

  async handlePaymentCallback(payload: Record<string, unknown>): Promise<void> {
    const event = await this.options.payment.verifyCallback(payload)
    await this.options.recharge.acceptVerifiedCallbackWithCoordinator(event, this.options.coordinator)
  }

  queryOrder(actor: IdentityActor, orderNo: string): unknown {
    const order = this.options.repository.getOrderByOrderNo(orderNo, actor.userId)
    if (!order) throw new SudoworkBillingError(404, '订单不存在')
    return this.userOrderDto(order, true)
  }

  listUserOrders(input: { actor: IdentityActor; page: number; pageSize: number }): unknown {
    const { page, pageSize, offset } = normalizePage(input.page, input.pageSize)
    const result = this.options.repository.listOrders({ userId: input.actor.userId, limit: pageSize, offset })
    return { list: result.list.map(order => this.userOrderDto(order, false)), total: result.total, page, pageSize }
  }

  cancelOrder(input: { actor: IdentityActor; orderNo: string }): void {
    this.options.recharge.cancelOrder(input.orderNo, input.actor.userId)
  }

  listAdminOrders(input: { actor: IdentityActor; query: Record<string, string | undefined> }): unknown {
    const { page, pageSize, offset } = normalizePage(
      Number(input.query.page), Number(input.query.pageSize ?? input.query.page_size),
    )
    const result = this.options.repository.listOrders({
      orgId: hasGlobalOrganizationAccess(input.actor) ? undefined : input.actor.orgId,
      status: input.query.status ? LEGACY_TO_STATUS[input.query.status] : undefined,
      orderNo: input.query.order_no, userPhone: input.query.user_phone,
      startAt: parseStartDate(input.query.start_date), endAt: parseEndDate(input.query.end_date),
      limit: pageSize, offset,
    })
    return { list: result.list.map(order => this.adminOrderDto(order, false)), total: result.total, page, pageSize }
  }

  getAdminOrder(actor: IdentityActor, orderNo: string): unknown {
    const order = this.requireScopedOrder(actor, orderNo)
    return this.adminOrderDto(order, true)
  }

  getRechargeStats(actor: IdentityActor): unknown {
    const allOrders = this.options.repository.listOrders({
      orgId: hasGlobalOrganizationAccess(actor) ? undefined : actor.orgId,
      limit: 1_000_000, offset: 0,
    }).list
    const startToday = startOfUtcDay(this.clock())
    const summarize = (orders: BillingOrderRecord[]) => ({
      orders: orders.length,
      amount_usd: sum(orders.filter(success), item => item.amountUsdMicros) / 1_000_000,
      amount_cny: sum(orders.filter(success), item => item.amountCents) / 100,
      points: sum(orders.filter(success), item => item.pointsUnits),
    })
    const totalSummary = summarize(allOrders)
    const byPayment = (method: BillingOrderRecord['paymentMethod']) => {
      const orders = allOrders.filter(item => success(item) && item.paymentMethod === method)
      return { count: orders.length, amount_usd: sum(orders, item => item.amountUsdMicros) / 1_000_000, amount_cny: sum(orders, item => item.amountCents) / 100 }
    }
    return {
      total: {
        ...totalSummary,
        bonus: sum(allOrders.filter(success), item => item.bonusUnits),
        success_count: allOrders.filter(success).length,
        failed_count: allOrders.filter(item => item.status === 'FAILED').length,
        pending_count: allOrders.filter(item => item.status === 'PENDING' || item.status === 'PAYING').length,
      },
      today: summarize(allOrders.filter(item => item.createdAt >= startToday)),
      by_payment: { ALIPAY: byPayment('ALIPAY'), WECHAT: byPayment('WECHAT') },
      daily: buildDailyStats(allOrders, this.clock()),
    }
  }

  calculateRefund(actor: IdentityActor, orderNo: string): unknown {
    this.requireScopedOrder(actor, orderNo)
    const quote = this.options.refund.calculate(orderNo)
    return {
      order_points: quote.orderPoints, user_balance: quote.userBalance, used_points: quote.usedPoints,
      refund_amount: quote.refundAmountCents, refund_amount_yuan: (quote.refundAmountCents / 100).toFixed(2),
      deduct_points: quote.deductPoints, original_amount: quote.originalAmountCents,
      original_amount_yuan: (quote.originalAmountCents / 100).toFixed(2),
    }
  }

  async requestRefund(input: { actor: IdentityActor; orderNo: string; reason: string; idempotencyKey?: string }): Promise<unknown> {
    this.requireScopedOrder(input.actor, input.orderNo)
    const result = await this.options.refund.request(
      { orderNo: input.orderNo, reason: input.reason }, input.actor,
      this.context(input.idempotencyKey, 'refund'),
    )
    return { refund_no: result.refundNo, refund_amount: result.refundAmountCents }
  }

  async simulatePayment(input: { actor: IdentityActor; orderNo: string; idempotencyKey?: string }): Promise<unknown> {
    if (!this.options.payment.simulationEnabled) throw new SudoworkBillingError(400, '仅在测试模式下可用')
    const order = this.requireScopedOrder(input.actor, input.orderNo)
    await this.options.recharge.acceptVerifiedCallbackWithCoordinator({
      providerEventId: `simulation:${order.orderNo}`, orderNo: order.orderNo,
      status: 'SUCCESS', amountCents: order.amountCents, orderDate: order.orderDate,
      raw: { simulated: true },
    }, this.options.coordinator)
    return { order_no: order.orderNo }
  }

  listRechargeRecords(input: { actor: IdentityActor; query: Record<string, string | undefined> }): unknown {
    const { page, pageSize, offset } = normalizePage(Number(input.query.page), Number(input.query.pageSize))
    const activityType = input.query.type === 'CLIENT' || input.query.type === 'ADMIN'
      ? input.query.type : undefined
    const result = this.options.repository.listRechargeActivities({
      orgId: hasGlobalOrganizationAccess(input.actor) ? undefined : input.actor.orgId,
      activityType, keyword: input.query.keyword?.trim().slice(0, 50),
      paymentMethod: input.query.payment_method === 'ALIPAY' || input.query.payment_method === 'WECHAT'
        ? input.query.payment_method : undefined,
      limit: pageSize, offset,
    })
    return {
      list: result.list.map(item => ({
        id: item.legacyId, type: item.activityType,
        order_no: item.orderId
          ? this.options.repository.getOrderByLegacyId(this.options.identities.getNumericAlias('billing_order', item.orderId) ?? -1)?.orderNo
            ?? (typeof item.details.orderNo === 'string' ? item.details.orderNo : null)
          : (typeof item.details.orderNo === 'string' ? item.details.orderNo : null),
        user_phone: this.phoneFor(item.userId),
        user_nickname: this.options.auth.getUserById(item.userId)?.displayName
          ?? this.options.auth.getUserById(item.userId)?.name ?? null,
        points: item.pointsUnits, quota: item.quotaUnits,
        amount_cny: item.amountCents === null ? null : item.amountCents / 100,
        payment_method: item.paymentMethod,
        admin_nickname: item.actorUserId
          ? this.options.auth.getUserById(item.actorUserId)?.displayName
            ?? this.options.auth.getUserById(item.actorUserId)?.name ?? null
          : null,
        reason: item.reason, created_at: toSqlDate(item.createdAt),
        source: item.activityType === 'ADMIN' ? item.sourceType : null,
        source_text: item.activityType === 'ADMIN'
          ? item.sourceType === 'CREDIT_APPLICATION' ? '积分申请审批发放' : '后台手工充值'
          : null,
        application_id: item.applicationId
          ? this.options.identities.getNumericAlias('credit_application', item.applicationId) : null,
        application_no: item.applicationId
          ? this.options.repository.getCreditApplication(item.applicationId)?.applicationNo ?? null : null,
        requested_points: item.applicationId
          ? this.options.repository.getCreditApplication(item.applicationId)?.requestedUnits ?? null : null,
        approved_points: item.applicationId
          ? this.options.repository.getCreditApplication(item.applicationId)?.approvedUnits ?? null : null,
        application_reason: item.applicationId
          ? this.options.repository.getCreditApplication(item.applicationId)?.reason ?? null : null,
        admin_comment: item.applicationId
          ? this.options.repository.getCreditApplication(item.applicationId)?.adminComment ?? null : null,
      })),
      total: result.total, page, pageSize,
    }
  }

  async retryOrder(input: { actor: IdentityActor; legacyOrderId: number; idempotencyKey?: string }): Promise<void> {
    const order = this.options.repository.getOrderByLegacyId(input.legacyOrderId)
    if (!order) throw new SudoworkBillingError(404, '订单不存在')
    this.assertOrgScope(input.actor, order.orgId)
    await this.syncOrder({ actor: input.actor, orderNo: order.orderNo, idempotencyKey: input.idempotencyKey })
  }

  async syncPendingOrders(input: { actor: IdentityActor; idempotencyKey?: string }): Promise<unknown> {
    const orders = this.options.repository.listOrders({
      orgId: hasGlobalOrganizationAccess(input.actor) ? undefined : input.actor.orgId,
      limit: 1_000, offset: 0,
    }).list.filter(order => order.status === 'PENDING' || order.status === 'PAYING' || order.status === 'FAILED')
    let successCount = 0
    let failedCount = 0
    for (const order of orders) {
      try {
        await this.syncOrder({ actor: input.actor, orderNo: order.orderNo, idempotencyKey: `${input.idempotencyKey ?? 'sync'}:${order.id}` })
        successCount += 1
      } catch { failedCount += 1 }
    }
    return { total: orders.length, success: successCount, failed: failedCount }
  }

  async syncOrder(input: { actor: IdentityActor; orderNo: string; idempotencyKey?: string }): Promise<unknown> {
    const order = this.requireScopedOrder(input.actor, input.orderNo)
    const queried = await this.options.payment.queryPayment(order)
    if (queried.event) await this.options.recharge.acceptVerifiedCallbackWithCoordinator(queried.event, this.options.coordinator)
    return { order_no: order.orderNo, status: STATUS_TO_LEGACY[queried.status === 'PENDING' ? order.status : queried.status] }
  }

  async adjustUserPoints(input: {
    actor: IdentityActor; legacyUserId: number; amount: number; operation: unknown
    reason?: string; syncSudorouter?: boolean; idempotencyKey?: string
  }): Promise<unknown> {
    const user = this.requireLegacyUser(input.legacyUserId)
    this.assertOrgScope(input.actor, user.orgId)
    const delta = input.operation === 'subtract' ? -input.amount : input.amount
    if (!Number.isSafeInteger(delta) || delta === 0) throw new SudoworkBillingError(400, '积分数量必须大于 0')
    if (!input.syncSudorouter) {
      const result = this.options.wallet.post({
        ownerType: 'user', ownerId: user.id, deltaUnits: delta,
        entryType: delta < 0 ? 'DEDUCT' : 'ADJUST', sourceType: 'admin_adjustment',
        sourceId: input.idempotencyKey ?? randomUUID(),
        memo: input.reason ?? '管理员调整', actorUserId: input.actor.userId, orgId: user.orgId,
      }, this.context(input.idempotencyKey, 'adjust-points'))
      return { amount: delta, new_balance: result.balanceAfterUnits, quota_delta: 0, new_quota: this.externalQuota(user.id), sudorouter_success: true, sudorouter_error: null }
    }
    const external = this.requireExternal(user.id)
    const result = await this.options.coordinator.adjustPoints({
      ownerType: 'user', ownerId: user.id, orgId: user.orgId,
      externalUserId: external.externalAccountId, pointsDelta: delta,
      reason: input.reason ?? '管理员调整', sourceType: 'admin_adjustment',
      sourceId: input.idempotencyKey ?? randomUUID(), actorUserId: input.actor.userId,
    }, this.context(input.idempotencyKey, 'adjust-points'))
    if (result.status !== 'SUCCEEDED') throw new SudoworkBillingError(500, result.error ?? 'sudorouter 额度更新失败')
    return { amount: delta, new_balance: result.newBalanceUnits, quota_delta: pointsToQuota(delta), new_quota: result.newQuotaUnits, sudorouter_success: true, sudorouter_error: null }
  }

  async rechargeUser(input: {
    actor: IdentityActor; legacyUserId: number; points: number; reason?: string
    paymentReference?: string; idempotencyKey?: string
  }): Promise<unknown> {
    if (input.actor.role !== 'super_admin') throw new SudoworkBillingError(403, '只有超级管理员可以为用户充值')
    const user = this.requireLegacyUser(input.legacyUserId)
    this.assertOrgScope(input.actor, user.orgId)
    const external = this.requireExternal(user.id)
    const context = this.context(input.idempotencyKey, 'admin-recharge')
    const activityKey = `billing:activity:${context.idempotencyKey}`
    const finalizeLocal = () => {
      if (this.options.repository.getActivityByIdempotencyKey(activityKey)) return
      const timestamp = this.clock()
      this.options.repository.insertActivityRecord({
        id: randomUUID(), legacyId: this.options.repository.allocateActivityLegacyId('ADMIN'),
        activityType: 'ADMIN', userId: user.id, orgId: user.orgId, orderId: null,
        actorUserId: input.actor.userId, applicationId: null, pointsUnits: input.points,
        quotaUnits: pointsToQuota(input.points), amountCents: null, paymentMethod: null,
        reason: input.reason ?? null, paymentReference: input.paymentReference ?? null,
        sourceType: 'ADMIN_MANUAL', sourceId: null, details: { externalUserId: external.externalAccountId },
        idempotencyKey: activityKey, createdAt: timestamp, processedAt: timestamp,
      })
    }
    const result = await this.options.coordinator.adjustPoints({
      ownerType: 'user', ownerId: user.id, orgId: user.orgId,
      externalUserId: external.externalAccountId, pointsDelta: input.points,
      reason: input.reason ?? '后台充值', sourceType: 'admin_recharge',
      sourceId: input.paymentReference ?? input.idempotencyKey ?? randomUUID(), actorUserId: input.actor.userId,
    }, context, finalizeLocal)
    if (result.status !== 'SUCCEEDED') throw new SudoworkBillingError(500, `sudorouter 额度更新失败: ${result.error ?? '未知错误'}`)
    return { points: input.points, quota: pointsToQuota(input.points), newBalance: result.newBalanceUnits, newQuota: result.newQuotaUnits }
  }

  async syncUserQuota(input: { actor: IdentityActor; legacyUserId: number }): Promise<unknown> {
    const user = this.requireLegacyUser(input.legacyUserId)
    this.assertOrgScope(input.actor, user.orgId)
    const external = this.requireExternal(user.id)
    const snapshot = await this.options.coordinator.syncQuota('user', user.id, external.externalAccountId)
    const balance = this.options.repository.getWallet('user', user.id)?.balanceUnits ?? 0
    return { quota: snapshot.quotaUnits, used_quota: snapshot.usedQuotaUnits, balance, total_points: quotaToPoints(snapshot.quotaUnits + snapshot.usedQuotaUnits) }
  }

  createCreditApplication(input: { actor: IdentityActor; requestedPoints: number; reason: unknown; idempotencyKey?: string }): unknown {
    const record = this.options.credit.createApplication({
      requestedPoints: input.requestedPoints, reason: typeof input.reason === 'string' ? input.reason : '',
    }, input.actor, this.context(input.idempotencyKey, 'credit-create'))
    return this.creditDto(record)
  }

  listUserCreditApplications(input: { actor: IdentityActor; page: number; pageSize: number }): unknown {
    const { page, pageSize, offset } = normalizePage(input.page, input.pageSize)
    const result = this.options.repository.listCreditApplications({ userId: input.actor.userId, limit: pageSize, offset })
    return { list: result.list.map(item => this.creditDto(item)), total: result.total, page, pageSize }
  }

  getUserCreditApplication(actor: IdentityActor, legacyApplicationId: number): unknown {
    const record = this.requireCredit(legacyApplicationId)
    if (record.userId !== actor.userId) throw new SudoworkBillingError(404, '申请记录不存在')
    return this.creditDto(record)
  }

  listAdminCreditApplications(input: { actor: IdentityActor; query: Record<string, string | undefined> }): unknown {
    const { page, pageSize, offset } = normalizePage(Number(input.query.page), Number(input.query.pageSize ?? input.query.page_size))
    const requestedOrg = input.query.enterprise_id
      ? this.options.identities.resolveNumericAliasGlobal('enterprise', Number(input.query.enterprise_id))?.resourceId
      : undefined
    if (requestedOrg && !hasGlobalOrganizationAccess(input.actor) && requestedOrg !== input.actor.orgId) {
      throw new SudoworkBillingError(403, '权限不足')
    }
    const orgId = hasGlobalOrganizationAccess(input.actor) ? requestedOrg : input.actor.orgId
    const result = this.options.repository.listCreditApplications({
      orgId, status: input.query.status as CreditApplicationStatus | undefined,
      keyword: input.query.keyword?.trim().slice(0, 50), limit: pageSize, offset,
    })
    return { list: result.list.map(item => this.creditDto(item, true)), total: result.total, page, pageSize }
  }

  getAdminCreditApplication(actor: IdentityActor, legacyApplicationId: number): unknown {
    const record = this.requireCredit(legacyApplicationId)
    this.assertOrgScope(actor, record.orgId)
    return this.creditDto(record, true)
  }

  async approveCreditApplication(input: {
    actor: IdentityActor; legacyApplicationId: number; approvedPoints?: number
    adminComment?: string; idempotencyKey?: string
  }): Promise<unknown> {
    const record = this.requireCredit(input.legacyApplicationId)
    this.assertOrgScope(input.actor, record.orgId)
    const result = await this.options.credit.approveApplication({
      applicationId: record.id, approvedPoints: input.approvedPoints, adminComment: input.adminComment,
    }, input.actor, this.context(input.idempotencyKey, 'credit-approve'))
    return this.creditDto(result, true)
  }

  rejectCreditApplication(input: { actor: IdentityActor; legacyApplicationId: number; adminComment: unknown }): unknown {
    const record = this.requireCredit(input.legacyApplicationId)
    this.assertOrgScope(input.actor, record.orgId)
    this.options.credit.rejectApplication(record.id, typeof input.adminComment === 'string' ? input.adminComment : '', input.actor)
    return undefined
  }

  async retryCreditApplication(input: { actor: IdentityActor; legacyApplicationId: number }): Promise<unknown> {
    const record = this.requireCredit(input.legacyApplicationId)
    this.assertOrgScope(input.actor, record.orgId)
    return this.creditDto(await this.options.credit.retryApplication(record.id, input.actor), true)
  }

  private requireUser(id: string): AuthCenterUser {
    const user = this.options.auth.getUserById(id)
    if (!user) throw new SudoworkBillingError(404, '用户不存在')
    return user
  }

  private requireLegacyUser(legacyId: number): AuthCenterUser {
    const resolved = this.options.identities.resolveNumericAliasGlobal('user', legacyId)
    if (!resolved) throw new SudoworkBillingError(404, '用户不存在')
    return this.requireUser(resolved.resourceId)
  }

  private requireCredit(legacyId: number): CreditApplicationRecord {
    const record = this.options.repository.getCreditApplicationByLegacyId(legacyId)
    if (!record) throw new SudoworkBillingError(404, '申请记录不存在')
    return record
  }

  private requireScopedOrder(actor: IdentityActor, orderNo: string): BillingOrderRecord {
    const order = this.options.repository.getOrderByOrderNo(orderNo)
    if (!order) throw new SudoworkBillingError(404, '订单不存在')
    this.assertOrgScope(actor, order.orgId)
    return order
  }

  private assertOrgScope(actor: IdentityActor, orgId: string): void {
    if (!hasGlobalOrganizationAccess(actor) && actor.orgId !== orgId) {
      throw new SudoworkBillingError(403, '权限不足')
    }
  }

  private requireExternal(userId: string) {
    const external = this.options.repository.getExternalAccount('sudorouter', 'user', userId)
    if (!external) throw new SudoworkBillingError(400, '用户未绑定 sudorouter 账号')
    return external
  }

  private externalQuota(userId: string): number {
    return this.options.repository.getExternalAccount('sudorouter', 'user', userId)?.quotaUnits ?? 0
  }

  private ensureAlias(namespace: string, resourceId: string, orgId: string): number {
    return this.options.identities.getNumericAlias(namespace, resourceId)
      ?? this.options.identities.allocateNumericAlias(namespace, resourceId, orgId)
  }

  private context(key: string | undefined, operation: string) {
    return onlineCommandContext(key?.trim() || `sudowork:${operation}:${randomUUID()}`)
  }

  private userOrderDto(order: BillingOrderRecord, includeExpiry: boolean): Record<string, unknown> {
    const status = STATUS_TO_LEGACY[order.status]
    return {
      order_no: order.orderNo, amount_usd: order.amountUsdMicros / 1_000_000,
      amount_cny: order.amountCents / 100, exchange_rate: order.exchangeRateMicros / 1_000_000,
      points: order.pointsUnits, status, status_text: STATUS_TEXT[status] ?? '未知',
      payment_method: order.paymentMethod, created_at: toSqlDate(order.createdAt),
      ...(includeExpiry ? { expired_at: toIso(order.expiredAt) } : {}),
    }
  }

  private adminOrderDto(order: BillingOrderRecord, detail: boolean): Record<string, unknown> {
    const user = this.options.auth.getUserById(order.userId)
    const status = STATUS_TO_LEGACY[order.status]
    const base = {
      id: order.legacyId, order_no: order.orderNo,
      user_id: this.ensureAlias('user', order.userId, order.orgId), user_phone: order.userPhone,
      user_nickname: user?.displayName ?? user?.name ?? null,
      amount_usd: order.amountUsdMicros / 1_000_000, amount_cny: order.amountCents / 100,
      exchange_rate: order.exchangeRateMicros / 1_000_000, points: order.pointsUnits,
      bonus_points: order.bonusUnits, payment_method: order.paymentMethod,
      status, status_text: STATUS_TEXT[status] ?? '未知', created_at: toSqlDate(order.createdAt),
      callback_time: order.callbackTime ? toSqlDate(order.callbackTime) : null, remark: order.remark,
    }
    return detail ? {
      ...base, quota: order.quotaUnits, expired_at: toIso(order.expiredAt),
      fuiou_order_info: order.providerOrderInfo,
    } : base
  }

  private creditDto(record: CreditApplicationRecord, admin = false): Record<string, unknown> {
    const user = this.options.auth.getUserById(record.userId)
    const base: Record<string, unknown> = {
      id: record.legacyId, application_no: record.applicationNo,
      user_id: this.ensureAlias('user', record.userId, record.orgId),
      enterprise_id: this.ensureAlias('enterprise', record.orgId, record.orgId),
      requested_points: record.requestedUnits, approved_points: record.approvedUnits,
      quota_amount: record.quotaUnits, reason: record.reason, status: record.status,
      admin_id: record.adminUserId ? this.ensureAlias('user', record.adminUserId, record.orgId) : null,
      admin_comment: record.adminComment,
      sudorouter_user_id: this.options.repository.getExternalAccount('sudorouter', 'user', record.userId)?.externalAccountId ?? null,
      sudorouter_success: record.status === 'APPROVED',
      sudorouter_error: record.status === 'SYNC_FAILED' || record.status === 'SYNC_UNKNOWN' ? '额度同步失败' : null,
      created_at: toSqlDate(record.createdAt), reviewed_at: record.reviewedAt ? toSqlDate(record.reviewedAt) : null,
      updated_at: toSqlDate(record.updatedAt),
    }
    if (admin) {
      base.user_phone = this.phoneFor(record.userId)
      base.user_nickname = user?.displayName ?? user?.name ?? null
      base.enterprise_name = this.options.auth.getOrganization(record.orgId)?.name ?? null
      base.admin_phone = record.adminUserId ? this.phoneFor(record.adminUserId) : null
      base.admin_nickname = record.adminUserId ? this.options.auth.getUserById(record.adminUserId)?.displayName ?? null : null
    }
    return base
  }

  private phoneFor(userId: string): string | null {
    return this.options.identities.findAuthIdentityByUser(userId, 'phone', 'sudowork')?.normalizedSubject ?? null
  }
}

function normalizePage(rawPage: number, rawPageSize: number): { page: number; pageSize: number; offset: number } {
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1
  const pageSize = Number.isInteger(rawPageSize) && rawPageSize > 0 ? Math.min(rawPageSize, 100) : 20
  return { page, pageSize, offset: (page - 1) * pageSize }
}

function toIso(timestamp: number): string { return new Date(timestamp).toISOString() }
function toSqlDate(timestamp: number): string { return new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19) }
function parseStartDate(value?: string): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed) ? parsed : undefined
}
function parseEndDate(value?: string): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(`${value}T23:59:59.999Z`)
  return Number.isFinite(parsed) ? parsed : undefined
}
function startOfUtcDay(timestamp: number): number {
  const date = new Date(timestamp)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}
function sum<T>(items: T[], select: (item: T) => number): number { return items.reduce((total, item) => total + select(item), 0) }
function success(order: BillingOrderRecord): boolean { return order.status === 'SUCCESS' }
function buildDailyStats(orders: BillingOrderRecord[], now: number): Array<Record<string, unknown>> {
  const cutoff = startOfUtcDay(now) - 6 * 86_400_000
  const grouped = new Map<string, BillingOrderRecord[]>()
  for (const order of orders) {
    if (order.createdAt < cutoff) continue
    const date = new Date(order.createdAt).toISOString().slice(0, 10)
    grouped.set(date, [...(grouped.get(date) ?? []), order])
  }
  return [...grouped.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([date, values]) => ({
    date, orders: values.length,
    amount_usd: sum(values.filter(success), item => item.amountUsdMicros) / 1_000_000,
    amount_cny: sum(values.filter(success), item => item.amountCents) / 100,
  }))
}
