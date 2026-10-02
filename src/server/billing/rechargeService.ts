import { createHash, randomUUID } from 'node:crypto'
import { assertTrustedCommandContext, type CommandContext } from '../application/commandContext.js'
import type { DbDriver } from '../db/driver.js'
import { BillingRepository, type BillingOrderRecord } from './billingRepository.js'
import { BillingDomainError } from './types.js'
import type { VerifiedPaymentEvent } from './fuiouAdapter.js'
import { WalletService } from './walletService.js'
import { onlineCommandContext } from '../application/commandContext.js'
import type { BillingCoordinator } from './billingCoordinator.js'

const CREATE_ORDER_COMMAND = 'billing.recharge.create-order'
const PREPARE_PAYMENT_COMMAND = 'billing.recharge.prepare-payment'

const PACKAGES = [
  { amount: 1, points: 1000, bonus: 0, description: '基础充值' },
  { amount: 5, points: 5000, bonus: 500, description: '充5送500积分' },
  { amount: 10, points: 10000, bonus: 1000, description: '充10送1000积分' },
  { amount: 20, points: 20000, bonus: 3000, description: '充20送3000积分' },
  { amount: 50, points: 50000, bonus: 10000, description: '充50送10000积分' },
] as const

export interface CreateRechargeOrderInput {
  userId: string
  legacyUserId: number
  orgId: string
  userPhone: string | null
  amountUsd: number
  paymentMethod: 'ALIPAY' | 'WECHAT'
  exchangeRate?: number
  expireMinutes?: number
}

export interface RechargeOrderResult {
  id: string
  orderNo: string
  amountUsd: number
  amountCny: number
  amountCents: number
  pointsUnits: number
  quotaUnits: number
  bonusUnits: number
  expiredAt: number
  status: BillingOrderRecord['status']
}

export interface PaymentIntent {
  attemptId: string
  orderId: string
  orderNo: string
  orderDate: string
  amountCents: number
  amountUsd: number
  paymentMethod: 'ALIPAY' | 'WECHAT'
}

export interface PaymentCallbackResult {
  success: true
  orderNo: string
  alreadyProcessed: boolean
}

interface RechargeServiceOptions {
  clock?: () => number
  idGenerator?: () => string
  suffixGenerator?: () => string
  numericAliasAllocator?: (orderId: string, orgId: string) => Promise<number>
  testPaymentAmountCents?: number
}

function fingerprint(values: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}

export class RechargeService {
  private readonly clock: () => number
  private readonly idGenerator: () => string
  private readonly suffixGenerator: () => string
  private readonly numericAliasAllocator?: (orderId: string, orgId: string) => Promise<number>
  private readonly testPaymentAmountCents?: number

  constructor(
    private readonly driver: DbDriver,
    private readonly repository = new BillingRepository(driver),
    options: RechargeServiceOptions = {},
  ) {
    this.clock = options.clock ?? Date.now
    this.idGenerator = options.idGenerator ?? randomUUID
    this.suffixGenerator = options.suffixGenerator ?? (() => Math.random().toString(36).slice(2, 8).toUpperCase())
    this.numericAliasAllocator = options.numericAliasAllocator
    this.testPaymentAmountCents = options.testPaymentAmountCents
  }

  listPackages(exchangeRate = 7.3): Array<Record<string, number | string>> {
    return PACKAGES.map(item => ({
      ...item,
      amount_cny: Math.round(item.amount * exchangeRate * 100) / 100,
      exchange_rate: exchangeRate,
    }))
  }

  async createOrder(input: CreateRechargeOrderInput, context: CommandContext): Promise<RechargeOrderResult> {
    assertTrustedCommandContext(context)
    this.validateCreateInput(input)
    const exchangeRate = input.exchangeRate ?? 7.3
    const amountUsdMicros = Math.round(input.amountUsd * 1_000_000)
    const exchangeRateMicros = Math.round(exchangeRate * 1_000_000)
    const amountCents = Number(
      (BigInt(amountUsdMicros) * BigInt(exchangeRateMicros) + 5_000_000_000n) / 10_000_000_000n,
    )
    const basePoints = Math.round(amountUsdMicros / 1_000)
    const packageInfo = PACKAGES.find(item => item.amount === input.amountUsd)
    const bonusUnits = packageInfo?.bonus ?? 0
    const pointsUnits = basePoints + bonusUnits
    const quotaUnits = pointsUnits * 500
    const requestFingerprint = fingerprint([
      input.userId, input.legacyUserId, input.orgId, input.userPhone,
      amountUsdMicros, input.paymentMethod, exchangeRateMicros, input.expireMinutes ?? 30,
    ])

    return this.driver.transaction(async () => {
      const previous = await this.repository.getCommandResult<RechargeOrderResult>(CREATE_ORDER_COMMAND, context.idempotencyKey)
      if (previous) {
        if (previous.requestFingerprint !== requestFingerprint) {
          throw new BillingDomainError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同的充值订单')
        }
        return previous.result
      }

      const now = this.clock()
      const orderDate = new Date(now).toISOString().slice(0, 10).replaceAll('-', '')
      const orderNo = `USR${input.legacyUserId}NO${now}${this.suffixGenerator()}`
      const orderId = this.idGenerator()
      const order: BillingOrderRecord = {
        id: orderId, legacyId: await this.numericAliasAllocator?.(orderId, input.orgId) ?? null,
        orderNo, userId: input.userId, orgId: input.orgId,
        userPhone: input.userPhone, amountUsdMicros, amountCents, exchangeRateMicros,
        quotaUnits, pointsUnits, bonusUnits, paymentMethod: input.paymentMethod, orderDate,
        providerOrderInfo: null, status: 'PENDING', idempotencyKey: context.idempotencyKey,
        createdAt: now, updatedAt: now, expiredAt: now + (input.expireMinutes ?? 30) * 60_000,
        remark: null,
      }
      await this.repository.insertOrder(order)
      const result = this.toResult(order)
      await this.repository.saveCommandResult(
        CREATE_ORDER_COMMAND, context.idempotencyKey, requestFingerprint,
        context.source, result, now,
      )
      return result
    })
  }

  async preparePayment(orderNo: string, userId: string, context: CommandContext): Promise<PaymentIntent> {
    assertTrustedCommandContext(context)
    const requestFingerprint = fingerprint([orderNo, userId])
    const outcome = await this.driver.transaction(async (): Promise<{ result?: PaymentIntent; error?: BillingDomainError }> => {
      const previous = await this.repository.getCommandResult<PaymentIntent>(PREPARE_PAYMENT_COMMAND, context.idempotencyKey)
      if (previous) {
        if (previous.requestFingerprint !== requestFingerprint) {
          throw new BillingDomainError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同的支付请求')
        }
        return { result: previous.result }
      }
      const order = await this.repository.getOrderByOrderNo(orderNo, userId)
      if (!order) return { error: new BillingDomainError('ORDER_NOT_FOUND', '订单不存在') }
      const now = this.clock()
      if (order.expiredAt < now || (order.status === 'CANCELLED' && order.remark === '订单已过期')) {
        if (order.status !== 'CANCELLED') {
          await this.repository.updateOrderStatus({ orderId: order.id, status: 'CANCELLED', updatedAt: now, remark: '订单已过期' })
        }
        return { error: new BillingDomainError('ORDER_EXPIRED', '订单已过期') }
      }
      if (order.status !== 'PENDING' && order.status !== 'PAYING') {
        return { error: new BillingDomainError('ORDER_STATUS_INVALID', '订单状态无效') }
      }
      const result: PaymentIntent = {
        attemptId: this.idGenerator(), orderId: order.id, orderNo: order.orderNo,
        orderDate: order.orderDate, amountCents: order.amountCents,
        amountUsd: order.amountUsdMicros / 1_000_000, paymentMethod: order.paymentMethod,
      }
      await this.repository.insertPaymentAttempt({
        id: result.attemptId, orderId: order.id, provider: 'fuiou', status: 'PENDING',
        idempotencyKey: context.idempotencyKey,
        request: { orderNo: order.orderNo, amountCents: order.amountCents, paymentMethod: order.paymentMethod },
        createdAt: now,
      })
      await this.repository.saveCommandResult(
        PREPARE_PAYMENT_COMMAND, context.idempotencyKey, requestFingerprint,
        context.source, result, now,
      )
      return { result }
    })
    if (outcome.error) throw outcome.error
    return outcome.result!
  }

  recordPaymentRequestResult(input: {
    attemptId: string
    orderId: string
    success: boolean
    providerOrderInfo?: string | null
    errorText?: string | null
  }): Promise<void> {
    return this.driver.transaction(async () => {
      const now = this.clock()
      await this.repository.updatePaymentAttempt({
        id: input.attemptId,
        status: input.success ? 'SUCCEEDED' : 'FAILED',
        response: input.providerOrderInfo ? { orderInfo: input.providerOrderInfo } : null,
        errorText: input.errorText,
        updatedAt: now,
      })
      if (input.success) {
        await this.repository.updateOrderStatus({
          orderId: input.orderId, status: 'PAYING', updatedAt: now,
          providerOrderInfo: input.providerOrderInfo,
        })
      }
    })
  }

  async cancelOrder(orderNo: string, userId: string): Promise<void> {
    await this.driver.transaction(async () => {
      const order = await this.repository.getOrderByOrderNo(orderNo, userId)
      if (!order) throw new BillingDomainError('ORDER_NOT_FOUND', '订单不存在')
      if (order.status !== 'PENDING' && order.status !== 'PAYING') {
        throw new BillingDomainError('ORDER_STATUS_INVALID', '订单状态无效，无法取消')
      }
      await this.repository.updateOrderStatus({ orderId: order.id, status: 'CANCELLED', updatedAt: this.clock() })
    })
  }

  async acceptVerifiedCallback(event: VerifiedPaymentEvent, walletService: WalletService): Promise<PaymentCallbackResult> {
    const order = await this.repository.getOrderByOrderNo(event.orderNo)
    if (!order) throw new BillingDomainError('ORDER_NOT_FOUND', '订单不存在')
    if (event.amountCents !== (this.testPaymentAmountCents ?? order.amountCents)) {
      throw new BillingDomainError('PAYMENT_AMOUNT_MISMATCH', '金额不一致')
    }
    const payloadHash = fingerprint([
      event.orderNo, event.status, event.amountCents, event.orderDate,
    ])

    return this.driver.transaction(async () => {
      const existing = await this.repository.getProviderEvent('fuiou', event.providerEventId)
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new BillingDomainError('PROVIDER_EVENT_CONFLICT', '支付回调事件内容冲突')
        }
        if (existing.status === 'SUCCEEDED') {
          await this.ensureClientActivity(order, this.clock())
          return { success: true, orderNo: order.orderNo, alreadyProcessed: true }
        }
        throw new BillingDomainError('PROVIDER_EVENT_INCOMPLETE', '支付回调正在处理或状态不确定')
      }

      const now = this.clock()
      const eventId = this.idGenerator()
      await this.repository.insertProviderEvent({
        id: eventId,
        provider: 'fuiou',
        providerEventId: event.providerEventId,
        eventType: 'PAYMENT_CALLBACK',
        payloadHash,
        payload: event.raw,
        status: 'PROCESSING',
        receivedAt: now,
      })

      if (event.status === 'FAILED') {
        await this.repository.updateOrderStatus({
          orderId: order.id, status: 'FAILED', updatedAt: now, remark: '支付失败',
          callbackData: JSON.stringify(event.raw), callbackTime: now, callbackAmountCents: event.amountCents,
        })
        await this.repository.updateProviderEvent({ id: eventId, status: 'SUCCEEDED', processedAt: now })
        return { success: true, orderNo: order.orderNo, alreadyProcessed: false }
      }

      if (order.status !== 'SUCCESS') {
        if (order.status === 'CANCELLED' || order.status === 'REFUNDED' || order.status === 'PARTIAL_REFUNDED') {
          throw new BillingDomainError('ORDER_STATUS_INVALID', '订单状态无效')
        }
        await walletService.post({
          ownerType: 'user',
          ownerId: order.userId,
          deltaUnits: order.pointsUnits,
          entryType: 'RECHARGE',
          memo: `用户充值: ${order.orderNo}`,
          sourceType: 'payment_order',
          sourceId: order.id,
          orgId: order.orgId,
        }, onlineCommandContext(`payment:${order.orderNo}`))
        await this.repository.updateOrderStatus({
          orderId: order.id, status: 'SUCCESS', updatedAt: now,
          callbackData: JSON.stringify(event.raw), callbackTime: now, callbackAmountCents: event.amountCents,
        })
        await this.ensureClientActivity(order, now)
      }
      await this.repository.updateProviderEvent({ id: eventId, status: 'SUCCEEDED', processedAt: now })
      return { success: true, orderNo: order.orderNo, alreadyProcessed: order.status === 'SUCCESS' }
    })
  }

  async acceptVerifiedCallbackWithCoordinator(
    event: VerifiedPaymentEvent,
    coordinator: BillingCoordinator,
  ): Promise<PaymentCallbackResult> {
    const order = await this.repository.getOrderByOrderNo(event.orderNo)
    if (!order) throw new BillingDomainError('ORDER_NOT_FOUND', '订单不存在')
    if (event.amountCents !== (this.testPaymentAmountCents ?? order.amountCents)) {
      throw new BillingDomainError('PAYMENT_AMOUNT_MISMATCH', '金额不一致')
    }
    const payloadHash = fingerprint([event.orderNo, event.status, event.amountCents, event.orderDate])
    const prepared = await this.driver.transaction(async () => {
      const existing = await this.repository.getProviderEvent('fuiou', event.providerEventId)
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new BillingDomainError('PROVIDER_EVENT_CONFLICT', '支付回调事件内容冲突')
        }
        return { id: existing.id, alreadyProcessed: existing.status === 'SUCCEEDED' }
      }
      const id = this.idGenerator()
      await this.repository.insertProviderEvent({
        id, provider: 'fuiou', providerEventId: event.providerEventId,
        eventType: 'PAYMENT_CALLBACK', payloadHash, payload: event.raw,
        status: 'PROCESSING', receivedAt: this.clock(),
      })
      return { id, alreadyProcessed: false }
    })
    if (prepared.alreadyProcessed) {
      await this.driver.transaction(async () => this.ensureClientActivity(order, this.clock()))
      return { success: true, orderNo: order.orderNo, alreadyProcessed: true }
    }

    if (event.status === 'FAILED') {
      await this.driver.transaction(async () => {
        await this.repository.updateOrderStatus({
          orderId: order.id, status: 'FAILED', updatedAt: this.clock(), remark: '支付失败',
          callbackData: JSON.stringify(event.raw), callbackTime: this.clock(), callbackAmountCents: event.amountCents,
        })
        await this.repository.updateProviderEvent({ id: prepared.id, status: 'SUCCEEDED', processedAt: this.clock() })
      })
      return { success: true, orderNo: order.orderNo, alreadyProcessed: false }
    }

    const external = await this.repository.getExternalAccount('sudorouter', 'user', order.userId)
    if (!external) {
      await this.driver.transaction(async () => this.repository.updateProviderEvent({
        id: prepared.id, status: 'UNKNOWN', errorText: '用户未绑定 sudorouter 账号', processedAt: this.clock(),
      }))
      throw new BillingDomainError('SUDOROUTER_NOT_BOUND', '用户未绑定 sudorouter 账号')
    }
    const operationKey = `payment:${order.orderNo}`
    const finalizeLocal = async () => {
      await this.repository.updateOrderStatus({
        orderId: order.id, status: 'SUCCESS', updatedAt: this.clock(),
        callbackData: JSON.stringify(event.raw), callbackTime: this.clock(), callbackAmountCents: event.amountCents,
      })
      await this.repository.updateProviderEvent({ id: prepared.id, status: 'SUCCEEDED', processedAt: this.clock() })
      await this.ensureClientActivity(order, this.clock())
    }
    const existingOperation = await this.repository.getQuotaOperationByKey(operationKey)
    const adjustment = existingOperation
      ? await coordinator.retry(existingOperation.id, finalizeLocal)
      : await coordinator.adjustPoints({
          ownerType: 'user', ownerId: order.userId, orgId: order.orgId,
          externalUserId: external.externalAccountId, pointsDelta: order.pointsUnits,
          reason: `用户充值: ${order.orderNo}`, sourceType: 'payment_order',
          sourceId: order.id,
        }, onlineCommandContext(operationKey), finalizeLocal)
    if (adjustment.status !== 'SUCCEEDED') {
      await this.driver.transaction(async () => this.repository.updateProviderEvent({
        id: prepared.id, status: 'UNKNOWN', errorText: adjustment.error ?? '额度发放状态待确认',
        processedAt: this.clock(),
      }))
      throw new BillingDomainError('PAYMENT_SYNC_UNKNOWN', '支付成功，积分与额度发放状态待对账')
    }
    return { success: true, orderNo: order.orderNo, alreadyProcessed: false }
  }

  private validateCreateInput(input: CreateRechargeOrderInput): void {
    if (!Number.isInteger(input.legacyUserId) || input.legacyUserId <= 0) {
      throw new BillingDomainError('INVALID_USER_ALIAS', '用户数字 ID 无效')
    }
    const micros = Math.round(input.amountUsd * 1_000_000)
    if (!Number.isFinite(input.amountUsd) || input.amountUsd < 1 || input.amountUsd > 10_000
      || !Number.isSafeInteger(micros) || Math.abs(micros / 1_000_000 - input.amountUsd) > 1e-9) {
      throw new BillingDomainError('INVALID_RECHARGE_AMOUNT', '充值金额无效（1-10000美元）')
    }
    if (input.paymentMethod !== 'ALIPAY' && input.paymentMethod !== 'WECHAT') {
      throw new BillingDomainError('INVALID_PAYMENT_METHOD', '支付方式无效')
    }
  }

  private async ensureClientActivity(order: BillingOrderRecord, processedAt: number): Promise<void> {
    const idempotencyKey = `billing:activity:payment:${order.orderNo}`
    if (await this.repository.getActivityByIdempotencyKey(idempotencyKey)) return
    await this.repository.insertActivityRecord({
      id: this.idGenerator(), legacyId: await this.repository.allocateActivityLegacyId('CLIENT'),
      activityType: 'CLIENT', userId: order.userId, orgId: order.orgId,
      orderId: order.id, actorUserId: null, applicationId: null,
      pointsUnits: order.pointsUnits, quotaUnits: order.quotaUnits,
      amountCents: order.amountCents, paymentMethod: order.paymentMethod,
      reason: null, paymentReference: null, sourceType: 'CLIENT_RECHARGE', sourceId: order.id,
      details: { orderNo: order.orderNo }, idempotencyKey,
      createdAt: order.createdAt, processedAt,
    })
  }

  private toResult(order: BillingOrderRecord): RechargeOrderResult {
    return {
      id: order.id,
      orderNo: order.orderNo,
      amountUsd: order.amountUsdMicros / 1_000_000,
      amountCny: order.amountCents / 100,
      amountCents: order.amountCents,
      pointsUnits: order.pointsUnits,
      quotaUnits: order.quotaUnits,
      bonusUnits: order.bonusUnits,
      expiredAt: order.expiredAt,
      status: order.status,
    }
  }
}
