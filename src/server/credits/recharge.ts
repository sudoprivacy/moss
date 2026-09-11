import { randomUUID } from 'crypto'
import type { FuiouCallbackPayload, FuiouClient } from './fuiou.js'
import { pointsToQuota, SudorouterError, type SudorouterClient } from './sudorouter.js'

export const ORDER_STATUS = {
  PENDING: 0,
  PAYING: 1,
  SUCCESS: 2,
  FAILED: 3,
  REFUNDED: 4,
  CANCELLED: 5,
} as const

export type OrderStatus = typeof ORDER_STATUS[keyof typeof ORDER_STATUS]

export const ORDER_STATUS_TEXT: Record<OrderStatus, string> = {
  [ORDER_STATUS.PENDING]: '待支付',
  [ORDER_STATUS.PAYING]: '支付中',
  [ORDER_STATUS.SUCCESS]: '支付成功',
  [ORDER_STATUS.FAILED]: '支付失败',
  [ORDER_STATUS.REFUNDED]: '已退款',
  [ORDER_STATUS.CANCELLED]: '已取消',
}

export type RechargeSyncStatus =
  | 'NONE'
  | 'PROCESSING'
  | 'SYNCED'
  | 'SYNC_FAILED'
  | 'SYNC_UNKNOWN'

export type PaymentMethod = 'ALIPAY' | 'WECHAT'

export type RechargePackage = {
  amount: number
  points: number
  bonus: number
  description: string
}

export const RECHARGE_PACKAGES: RechargePackage[] = [
  { amount: 1, points: 1000, bonus: 0, description: '基础充值' },
  { amount: 5, points: 5000, bonus: 500, description: '充5送500积分' },
  { amount: 10, points: 10000, bonus: 1000, description: '充10送1000积分' },
  { amount: 20, points: 20000, bonus: 3000, description: '充20送3000积分' },
  { amount: 50, points: 50000, bonus: 10000, description: '充50送10000积分' },
]

export type RechargePolicy = {
  minAmountUsd: number
  maxAmountUsd: number
  usdToCnyRate: number
  orderExpireMinutes: number
}

export type RechargeOrder = {
  id: number
  orderNo: string
  userId: string
  userPhone: string | null
  orgId: string
  amountUsd: number
  amountYuan: number
  amountCents: number
  exchangeRate: number
  quotaAmount: number
  pointsAmount: number
  bonusPoints: number
  paymentMethod: PaymentMethod
  orderDate: string
  fuiouOrderInfo: string | null
  status: OrderStatus
  syncStatus: RechargeSyncStatus
  syncError: string | null
  callbackData: string | null
  callbackTime: number | null
  callbackAmountCents: number | null
  createdAt: number
  updatedAt: number
  expiredAt: number
  remark: string | null
}

export type RefundRecord = {
  id: number
  refundNo: string
  orderId: number
  orderNo: string
  userId: string
  orgId: string
  refundAmountYuan: number
  refundQuota: number
  refundPoints: number
  refundReason: string | null
  refundType: string
  status: number
  syncStatus: RechargeSyncStatus
  syncError: string | null
  fuiouRefundNo: string | null
  fuiouResponse: string | null
  createdAt: number
  processedAt: number | null
}

export type RechargeOrderStore = {
  create(input: Omit<RechargeOrder, 'id' | 'createdAt' | 'updatedAt' | 'fuiouOrderInfo'
    | 'status' | 'syncStatus' | 'syncError' | 'callbackData' | 'callbackTime'
    | 'callbackAmountCents' | 'remark'>): RechargeOrder
  getByOrderNo(orderNo: string): RechargeOrder | null
  getById(id: number): RechargeOrder | null
  listForUser(userId: string, page: number, pageSize: number): { list: RechargeOrder[]; total: number }
  listForAdmin(input: {
    orgId?: string
    status?: number
    orderNo?: string
    userPhone?: string
    startDate?: string
    endDate?: string
    page: number
    pageSize: number
  }): { list: RechargeOrder[]; total: number }
  update(id: number, patch: Partial<Pick<RechargeOrder,
    'status' | 'syncStatus' | 'syncError' | 'fuiouOrderInfo' | 'callbackData'
    | 'callbackTime' | 'callbackAmountCents' | 'remark'>>): void
  createRefund(input: Omit<RefundRecord, 'id' | 'createdAt'>): RefundRecord
}

export class RechargeError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
    this.name = 'RechargeError'
  }
}

function now(): number {
  return Date.now()
}

function iso(ts: number | null): string | null {
  return ts == null ? null : new Date(ts).toISOString()
}

export function rechargePackagesWithCny(exchangeRate: number): Array<RechargePackage & {
  amount_cny: number
  exchange_rate: number
}> {
  return RECHARGE_PACKAGES.map(pkg => ({
    ...pkg,
    amount_cny: Math.round(pkg.amount * exchangeRate * 100) / 100,
    exchange_rate: exchangeRate,
  }))
}

function normalizeAmount(value: unknown): number {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return NaN
  return Math.round(amount * 100) / 100
}

function newOrderNo(userId: string): string {
  const userPart = userId.replace(/[^A-Za-z0-9]/g, '').slice(-8) || 'U'
  return `USR${userPart}NO${Date.now()}${randomUUID().slice(0, 6).toUpperCase()}`
}

function todayCompact(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '')
}

export function createRechargeOrder(
  store: RechargeOrderStore,
  policy: RechargePolicy,
  input: {
    userId: string
    userPhone?: string | null
    orgId: string
    amount: unknown
    paymentMethod: unknown
  },
): RechargeOrder {
  const amountUsd = normalizeAmount(input.amount)
  if (!amountUsd || amountUsd < policy.minAmountUsd || amountUsd > policy.maxAmountUsd) {
    throw new RechargeError(400, `充值金额无效（${policy.minAmountUsd}-${policy.maxAmountUsd}美元）`)
  }
  if (input.paymentMethod !== 'ALIPAY' && input.paymentMethod !== 'WECHAT') {
    throw new RechargeError(400, '支付方式无效')
  }
  const pkg = RECHARGE_PACKAGES.find(item => item.amount === amountUsd)
  const bonusPoints = pkg?.bonus ?? 0
  const pointsAmount = Math.round(amountUsd * 1000) + bonusPoints
  const amountYuan = Math.round(amountUsd * policy.usdToCnyRate * 100) / 100
  const amountCents = Math.round(amountYuan * 100)
  const createdAt = now()
  return store.create({
    orderNo: newOrderNo(input.userId),
    userId: input.userId,
    userPhone: input.userPhone ?? null,
    orgId: input.orgId,
    amountUsd,
    amountYuan,
    amountCents,
    exchangeRate: policy.usdToCnyRate,
    quotaAmount: pointsToQuota(pointsAmount),
    pointsAmount,
    bonusPoints,
    paymentMethod: input.paymentMethod,
    orderDate: todayCompact(),
    expiredAt: createdAt + policy.orderExpireMinutes * 60_000,
  })
}

export async function payRechargeOrder(
  store: RechargeOrderStore,
  fuiou: FuiouClient | null,
  userId: string,
  orderNo: string,
): Promise<{ qr_code_url: string; order_info: string }> {
  if (!fuiou?.isConfigured()) throw new RechargeError(503, '支付服务未配置')
  const order = store.getByOrderNo(orderNo)
  if (!order || order.userId !== userId) throw new RechargeError(404, '订单不存在')
  if (order.status !== ORDER_STATUS.PENDING && order.status !== ORDER_STATUS.PAYING) {
    throw new RechargeError(400, '订单状态无效')
  }
  if (order.expiredAt < now()) {
    store.update(order.id, { status: ORDER_STATUS.CANCELLED, remark: '订单已过期' })
    throw new RechargeError(400, '订单已过期')
  }

  const payCents = fuiou.isTestMode() ? 1 : order.amountCents
  const result = await fuiou.createOrder({
    orderId: order.orderNo,
    orderDate: order.orderDate,
    orderAmt: String(payCents),
    orderPayType: order.paymentMethod,
    goodsName: `TUC${order.amountUsd}USD`,
    goodsDetail: `充值${order.amountUsd}美元 (¥${order.amountYuan.toFixed(2)})`,
  })
  if (!result.success || !result.data?.order_info) {
    throw new RechargeError(400, result.error || '支付二维码获取失败')
  }
  store.update(order.id, {
    status: ORDER_STATUS.PAYING,
    fuiouOrderInfo: result.data.order_info,
  })
  return { qr_code_url: result.data.order_info, order_info: result.data.order_info }
}

export async function handleRechargeCallback(
  store: RechargeOrderStore,
  fuiou: FuiouClient | null,
  sudorouter: SudorouterClient | null,
  payload: FuiouCallbackPayload,
  getGatewayUserId: (userId: string) => string | null,
): Promise<{ order_no: string }> {
  if (!fuiou?.isConfigured()) throw new RechargeError(503, '支付服务未配置')
  const message = await fuiou.handleCallback(payload)
  const order = store.getByOrderNo(message.order_id)
  if (!order) throw new RechargeError(404, '订单不存在')
  if (order.status === ORDER_STATUS.SUCCESS) return { order_no: order.orderNo }
  if (order.syncStatus === 'SYNCED' || order.syncStatus === 'PROCESSING' || order.syncStatus === 'SYNC_UNKNOWN') {
    return { order_no: order.orderNo }
  }

  const callbackAmount = Number.parseInt(message.order_amt, 10)
  const expectedAmount = fuiou.isTestMode() ? 1 : order.amountCents
  if (!fuiou.isTestMode() && callbackAmount !== expectedAmount) {
    store.update(order.id, {
      status: ORDER_STATUS.FAILED,
      syncStatus: 'SYNC_FAILED',
      callbackData: JSON.stringify(payload),
      callbackTime: now(),
      callbackAmountCents: callbackAmount,
      remark: '金额不一致',
    })
    throw new RechargeError(400, '金额不一致')
  }

  if (message.order_st === '2') {
    store.update(order.id, {
      status: ORDER_STATUS.FAILED,
      callbackData: JSON.stringify(payload),
      callbackTime: now(),
      callbackAmountCents: callbackAmount,
      remark: '支付失败',
    })
    return { order_no: order.orderNo }
  }
  if (message.order_st !== '1') {
    return { order_no: order.orderNo }
  }

  const gatewayUserId = getGatewayUserId(order.userId)
  if (!gatewayUserId) {
    store.update(order.id, {
      status: ORDER_STATUS.FAILED,
      syncStatus: 'SYNC_FAILED',
      syncError: 'User has no model gateway account',
      callbackData: JSON.stringify(payload),
      callbackTime: now(),
      callbackAmountCents: callbackAmount,
      remark: '用户信息异常',
    })
    throw new RechargeError(409, '用户信息异常')
  }
  if (!sudorouter) {
    store.update(order.id, {
      status: ORDER_STATUS.FAILED,
      syncStatus: 'SYNC_FAILED',
      syncError: 'Model gateway is not configured',
      callbackData: JSON.stringify(payload),
      callbackTime: now(),
      callbackAmountCents: callbackAmount,
      remark: '模型网关未配置',
    })
    throw new RechargeError(503, '模型网关未配置')
  }

  store.update(order.id, {
    status: ORDER_STATUS.PAYING,
    syncStatus: 'PROCESSING',
    syncError: null,
    callbackData: JSON.stringify(payload),
    callbackTime: now(),
    callbackAmountCents: callbackAmount,
  })

  try {
    await sudorouter.addPoints(gatewayUserId, order.pointsAmount, `充值订单: ${order.orderNo}`)
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error)
    const refused = error instanceof SudorouterError && error.status !== undefined
    store.update(order.id, {
      status: ORDER_STATUS.FAILED,
      syncStatus: refused ? 'SYNC_FAILED' : 'SYNC_UNKNOWN',
      syncError: messageText.slice(0, 500),
      remark: refused ? 'Sudorouter更新失败' : 'Sudorouter更新结果未知',
    })
    throw new RechargeError(502, refused ? `Sudorouter 更新失败: ${messageText}` : `Sudorouter 更新结果未知: ${messageText}`)
  }

  store.update(order.id, {
    status: ORDER_STATUS.SUCCESS,
    syncStatus: 'SYNCED',
    syncError: null,
    remark: null,
  })
  return { order_no: order.orderNo }
}

export function queryRechargeOrder(store: RechargeOrderStore, userId: string, orderNo: string): unknown | null {
  const order = store.getByOrderNo(orderNo)
  if (!order || order.userId !== userId) return null
  return toUserOrderPayload(order)
}

export function listRechargeOrders(
  store: RechargeOrderStore,
  userId: string,
  page: number,
  pageSize: number,
): { list: unknown[]; total: number; page: number; pageSize: number } {
  const result = store.listForUser(userId, page, pageSize)
  return { list: result.list.map(toUserOrderListPayload), total: result.total, page, pageSize }
}

export function cancelRechargeOrder(
  store: RechargeOrderStore,
  userId: string,
  orderNo: string,
): void {
  const order = store.getByOrderNo(orderNo)
  if (!order || order.userId !== userId) throw new RechargeError(404, '订单不存在')
  if (order.status !== ORDER_STATUS.PENDING && order.status !== ORDER_STATUS.PAYING) {
    throw new RechargeError(400, '订单状态不可取消')
  }
  store.update(order.id, { status: ORDER_STATUS.CANCELLED })
}

export function toCreatedOrderPayload(order: RechargeOrder): unknown {
  return {
    order_no: order.orderNo,
    amount_usd: order.amountUsd,
    amount_cny: order.amountYuan,
    points: order.pointsAmount,
    quota: order.quotaAmount,
    expired_at: new Date(order.expiredAt).toISOString(),
  }
}

export function toUserOrderPayload(order: RechargeOrder): unknown {
  return {
    order_no: order.orderNo,
    amount_usd: order.amountUsd,
    amount_cny: order.amountYuan,
    exchange_rate: order.exchangeRate,
    points: order.pointsAmount,
    status: order.status,
    status_text: ORDER_STATUS_TEXT[order.status],
    payment_method: order.paymentMethod,
    created_at: iso(order.createdAt),
    expired_at: iso(order.expiredAt),
    sync_status: order.syncStatus,
    sync_error: order.syncError,
  }
}

function toUserOrderListPayload(order: RechargeOrder): unknown {
  return {
    order_no: order.orderNo,
    amount_usd: order.amountUsd,
    amount_cny: order.amountYuan,
    exchange_rate: order.exchangeRate,
    points: order.pointsAmount,
    status: order.status,
    status_text: ORDER_STATUS_TEXT[order.status],
    payment_method: order.paymentMethod,
    created_at: iso(order.createdAt),
  }
}

export function toAdminOrderPayload(
  order: RechargeOrder,
  userName?: string,
): unknown {
  return {
    id: order.id,
    order_no: order.orderNo,
    user_id: order.userId,
    user_phone: order.userPhone,
    user_nickname: userName ?? null,
    amount_usd: order.amountUsd,
    amount_cny: order.amountYuan,
    exchange_rate: order.exchangeRate,
    points: order.pointsAmount,
    bonus_points: order.bonusPoints,
    quota: order.quotaAmount,
    payment_method: order.paymentMethod,
    status: order.status,
    status_text: ORDER_STATUS_TEXT[order.status],
    sync_status: order.syncStatus,
    sync_error: order.syncError,
    created_at: iso(order.createdAt),
    callback_time: iso(order.callbackTime),
    expired_at: iso(order.expiredAt),
    remark: order.remark,
    fuiou_order_info: order.fuiouOrderInfo,
  }
}

export function calculateRefund(input: {
  order: RechargeOrder
  userRemainingPoints: number
}): {
  orderPoints: number
  userBalance: number
  usedPoints: number
  refundAmount: number
  deductPoints: number
  originalAmount: number
} {
  const orderPoints = input.order.pointsAmount
  const userBalance = Math.max(0, Math.floor(input.userRemainingPoints))
  const originalAmount = input.order.amountCents
  if (userBalance >= orderPoints) {
    return {
      orderPoints,
      userBalance,
      usedPoints: 0,
      refundAmount: originalAmount,
      deductPoints: orderPoints,
      originalAmount,
    }
  }
  const usedPoints = orderPoints - userBalance
  const usedAmountCents = Math.round((usedPoints / 1000) * input.order.exchangeRate * 100)
  return {
    orderPoints,
    userBalance,
    usedPoints,
    refundAmount: Math.max(0, originalAmount - usedAmountCents),
    deductPoints: userBalance,
    originalAmount,
  }
}

export async function refundRechargeOrder(
  store: RechargeOrderStore,
  fuiou: FuiouClient | null,
  sudorouter: SudorouterClient | null,
  input: {
    orderNo: string
    reason: string
    adminId: string
    getGatewayUserId: (userId: string) => string | null
  },
): Promise<{ refund_no: string; refund_amount: number }> {
  const order = store.getByOrderNo(input.orderNo)
  if (!order) throw new RechargeError(404, '订单不存在')
  if (order.status !== ORDER_STATUS.SUCCESS) throw new RechargeError(400, '订单状态不支持退款')
  if (!fuiou?.isConfigured()) throw new RechargeError(503, '支付服务未配置')
  if (!sudorouter) throw new RechargeError(503, '模型网关未配置')
  const gatewayUserId = input.getGatewayUserId(order.userId)
  if (!gatewayUserId) throw new RechargeError(409, '用户信息异常')

  const credits = await sudorouter.getCredits(gatewayUserId)
  const calc = calculateRefund({ order, userRemainingPoints: credits.remainingPoints })
  const refundNo = `RF${Date.now()}${randomUUID().slice(0, 6).toUpperCase()}`
  const refundDate = todayCompact()

  let fuiouResponse: unknown = null
  if (!fuiou.isTestMode()) {
    const result = await fuiou.refundOrder({
      refund_order_date: refundDate,
      refund_order_id: refundNo,
      pay_order_date: order.orderDate,
      pay_order_id: order.orderNo,
      refund_amt: String(calc.refundAmount),
    })
    fuiouResponse = result.response.data
    if (!result.success) throw new RechargeError(400, result.error || '退款请求失败')
    if (result.data?.refund_st !== '5') throw new RechargeError(400, '退款状态异常')
  }

  store.update(order.id, { status: ORDER_STATUS.REFUNDED, remark: `退款原因: ${input.reason}` })
  if (calc.deductPoints > 0) {
    try {
      await sudorouter.addPoints(gatewayUserId, -calc.deductPoints, `退款扣除: ${order.orderNo}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const refused = error instanceof SudorouterError && error.status !== undefined
      store.createRefund({
        refundNo,
        orderId: order.id,
        orderNo: order.orderNo,
        userId: order.userId,
        orgId: order.orgId,
        refundAmountYuan: calc.refundAmount / 100,
        refundQuota: pointsToQuota(calc.deductPoints),
        refundPoints: calc.deductPoints,
        refundReason: input.reason,
        refundType: fuiou.isTestMode() ? 'SIMULATED' : 'FUIOU',
        status: 0,
        syncStatus: refused ? 'SYNC_FAILED' : 'SYNC_UNKNOWN',
        syncError: message.slice(0, 500),
        fuiouRefundNo: refundNo,
        fuiouResponse: JSON.stringify(fuiouResponse),
        processedAt: now(),
      })
      throw new RechargeError(502, refused ? `Sudorouter 扣减失败: ${message}` : `Sudorouter 扣减结果未知: ${message}`)
    }
  }
  store.createRefund({
    refundNo,
    orderId: order.id,
    orderNo: order.orderNo,
    userId: order.userId,
    orgId: order.orgId,
    refundAmountYuan: calc.refundAmount / 100,
    refundQuota: pointsToQuota(calc.deductPoints),
    refundPoints: calc.deductPoints,
    refundReason: input.reason,
    refundType: fuiou.isTestMode() ? 'SIMULATED' : 'FUIOU',
    status: 1,
    syncStatus: 'SYNCED',
    syncError: null,
    fuiouRefundNo: refundNo,
    fuiouResponse: JSON.stringify(fuiouResponse),
    processedAt: now(),
  })
  return { refund_no: refundNo, refund_amount: calc.refundAmount }
}
