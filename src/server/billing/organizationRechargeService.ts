import { OrganizationManualCreditService } from './organizationManualCreditService.js'
import { createHash, randomUUID } from 'node:crypto'
import type { SqlRow } from '../db/driver.js'
import type { VerifiedPaymentEvent } from './fuiouAdapter.js'
import type { PaymentIntent } from './rechargeService.js'
import { formatUsdMicros, parseUsd, payableCnyFen, usdMicrosToQuota } from './modelMoney.js'
import { OrganizationBillingError, type OrganizationBillingActor, type OrganizationBillingService } from './organizationBillingService.js'

export interface OrganizationPaymentPort {
  readonly simulationEnabled: boolean
  createPayment(intent: PaymentIntent): Promise<{ qrCodeUrl: string; orderInfo: string }>
  verifyCallback(payload: Record<string, unknown>): Promise<VerifiedPaymentEvent>
  queryPayment(order: { orderNo: string; orderDate: string; amountCents: number }): Promise<{ status: string; event?: VerifiedPaymentEvent }>
}
export type OrganizationOrder = SqlRow & {
  id: string; order_no: string; org_id: string; router_user_id: number; payer_user_id: string
  purchase_usd_micros: number; bonus_usd_micros: number; amount_cny_fen: number; exchange_rate_micros: number
  credited_quota: number; quota_per_usd: number; payment_method: 'ALIPAY' | 'WECHAT'
  payment_status: 'pending' | 'paying' | 'paid' | 'cancelled'; credit_status: 'pending' | 'sending' | 'credited' | 'needs_review'
  payment_test_mode: number; provider_order_info: string | null; reference: string; fingerprint: string; created_at: number; expires_at: number
  paid_at: number | null; credited_at: number | null
}
const PACKAGES = [
  ['1.00', '0.00'], ['5.00', '0.50'], ['10.00', '1.00'], ['20.00', '3.00'], ['50.00', '10.00'],
] as const

export class OrganizationRechargeService {
  readonly manual: OrganizationManualCreditService
  constructor(readonly billing: OrganizationBillingService, private readonly payment?: OrganizationPaymentPort,
    private readonly options: { exchangeRateMicros?: number; enabled?: boolean } = {}) { this.manual = new OrganizationManualCreditService(this, billing) }
  isEnabled(): boolean { return !!this.payment && this.options.enabled !== false }
  private requirePayment(): OrganizationPaymentPort {
    if (!this.payment || this.options.enabled === false) throw new OrganizationBillingError('PAYMENT_UNAVAILABLE', '充值服务未配置', 503)
    return this.payment
  }
  async packages(actor: OrganizationBillingActor) {
    await this.billing.assertAdmin(actor, actor.orgId, true)
    const rate = this.options.exchangeRateMicros ?? 7_300_000
    return PACKAGES.map(([purchase, bonus]) => ({ purchase_amount_usd: purchase, bonus_amount_usd: bonus,
      amount_cny_fen: payableCnyFen(parseUsd(purchase), rate), currency: 'USD', payment_currency: 'CNY' }))
  }
  async createOrder(actor: OrganizationBillingActor, amountUsd: string, method: 'ALIPAY' | 'WECHAT', reference: string): Promise<Record<string, unknown>> {
    await this.billing.assertAdmin(actor, actor.orgId, true)
    const payment = this.requirePayment()
    const account = await this.billing.requireAccount(actor.orgId)
    if (account.status !== 'ready' || !account.router_user_id) throw new OrganizationBillingError('ACCOUNT_UNAVAILABLE', '组织账户尚未就绪', 409)
    let purchase: number
    try { purchase = parseUsd(amountUsd, false) } catch { throw new OrganizationBillingError('INVALID_AMOUNT', '充值金额必须是最多两位小数的美元金额') }
    if (purchase < 1_000_000 || purchase > 10_000_000_000) throw new OrganizationBillingError('INVALID_AMOUNT', '充值金额须为 $1.00 至 $10000.00')
    if (!['ALIPAY', 'WECHAT'].includes(method) || !reference || reference.length > 200) throw new OrganizationBillingError('INVALID_ORDER', '支付方式或操作标识无效')
    const bonus = parseUsd(PACKAGES.find(([amount]) => parseUsd(amount) === purchase)?.[1] ?? '0.00')
    const rate = this.options.exchangeRateMicros ?? 7_300_000
    const fen = payment.simulationEnabled ? 1 : payableCnyFen(purchase, rate)
    const quota = usdMicrosToQuota(purchase + bonus, account.quota_per_usd)
    const fingerprint = createHash('sha256').update(JSON.stringify([actor.orgId, actor.userId, account.router_user_id, purchase, method])).digest('hex')
    return this.billing.exclusive(`order-create:${reference}`, async () => {
      const id = randomUUID(); const now = Date.now()
      await this.billing.db.run(`INSERT INTO organization_model_orders
        (id, order_no, org_id, router_user_id, payer_user_id, purchase_usd_micros, bonus_usd_micros, amount_cny_fen, exchange_rate_micros,
         credited_quota, quota_per_usd, payment_method, payment_status, credit_status, reference, fingerprint, created_at, expires_at, payment_test_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?, ?) ON CONFLICT(reference) DO NOTHING`,
      [id, `MORG${id.replaceAll('-', '').slice(0, 24)}`, actor.orgId, account.router_user_id!, actor.userId, purchase, bonus, fen, rate,
        quota, account.quota_per_usd, method, reference, fingerprint, now, now + 30 * 60_000, payment.simulationEnabled ? 1 : 0])
      const order = (await this.billing.db.get<OrganizationOrder>('SELECT * FROM organization_model_orders WHERE reference = ?', [reference]))!
      if (order.fingerprint !== fingerprint) throw new OrganizationBillingError('IDEMPOTENCY_CONFLICT', '操作标识已用于不同订单', 409)
      return this.project(order)
    })
  }
  async pay(actor: OrganizationBillingActor, orderNo: string): Promise<Record<string, unknown>> {
    await this.billing.assertAdmin(actor, actor.orgId, true)
    const payment = this.requirePayment()
    return this.billing.exclusive(`order:${orderNo}`, async () => {
      const order = await this.requireOrder(orderNo, actor.orgId)
      if (!['pending', 'paying'].includes(order.payment_status) || order.expires_at <= Date.now()) throw new OrganizationBillingError('ORDER_UNAVAILABLE', '订单已支付、取消或过期', 409)
      if (payment.simulationEnabled !== (order.payment_test_mode === 1)) throw new OrganizationBillingError('PAYMENT_ENVIRONMENT_CHANGED', '支付环境已变更，请取消后重新创建订单', 409)
      if (order.provider_order_info) return { qr_code_url: order.provider_order_info, order: this.project(order) }
      const result = await this.billing.operation(order.org_id, 'payment-create', `payment:${order.id}`, { orderId: order.id }, false, () => payment.createPayment({
        attemptId: `payment:${order.id}`, orderId: order.id, orderNo: order.order_no, orderDate: date(order.created_at),
        amountCents: order.amount_cny_fen, amountUsd: order.purchase_usd_micros / 1_000_000, paymentMethod: order.payment_method,
      }), undefined, actor.userId)
      await this.billing.db.run("UPDATE organization_model_orders SET payment_status = 'paying', provider_order_info = ? WHERE id = ?", [result.orderInfo, order.id])
      return { qr_code_url: result.qrCodeUrl, order: this.project((await this.requireOrder(orderNo, actor.orgId))) }
    })
  }
  async list(actor: OrganizationBillingActor, page = 1, pageSize = 20): Promise<{ items: Record<string, unknown>[]; total: number; page: number; page_size: number }> {
    await this.billing.assertAdmin(actor, actor.orgId, true)
    return this.listRecords(actor, page, pageSize)
  }
  async get(actor: OrganizationBillingActor, orderNo: string): Promise<Record<string, unknown>> {
    await this.billing.assertAdmin(actor, actor.orgId, true)
    return this.project(await this.requireOrder(orderNo, actor.orgId))
  }
  async listForAdministration(actor: OrganizationBillingActor, page = 1, pageSize = 20, source = 'all') {
    await this.billing.assertAdmin(actor, actor.orgId)
    return this.listRecords(actor, page, pageSize, source)
  }
  private async listRecords(actor: OrganizationBillingActor, page: number, pageSize: number, source = 'all') {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new OrganizationBillingError('INVALID_PAGE', '分页参数无效')
    if (!['all', 'online', 'manual'].includes(source)) throw new OrganizationBillingError('INVALID_SOURCE', '充值来源无效')
    const union = `SELECT order_no AS no, created_at, 'online' AS source FROM organization_model_orders WHERE org_id = ?
      UNION ALL SELECT credit_no AS no, created_at, 'manual' AS source FROM organization_model_credits WHERE org_id = ?`
    const filter = source === 'all' ? '' : ' WHERE source = ?'
    const params = source === 'all' ? [actor.orgId, actor.orgId] : [actor.orgId, actor.orgId, source]
    const [rows, count] = await Promise.all([
      this.billing.db.all(`SELECT * FROM (${union}) records${filter} ORDER BY created_at DESC, no DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]),
      this.billing.db.get(`SELECT COUNT(*) AS total FROM (${union}) records${filter}`, params),
    ])
    const items = await Promise.all(rows.map(async row => {
      if (row.source === 'manual') return this.manual.project(await this.manual.requireCredit(String(row.no), actor.orgId))
      const order = await this.requireOrder(String(row.no), actor.orgId)
      const payer = await this.billing.db.get('SELECT name, display_name FROM users WHERE id = ? AND org_id = ?', [order.payer_user_id, order.org_id])
      return { ...this.project(order), router_user_id: order.router_user_id, payer_username: payer?.name ?? null,
        payer_nickname: payer?.display_name ?? null, paid_at: order.paid_at, credited_at: order.credited_at, resolution: await this.manual.orderSummary(order) }
    }))
    return { items, total: Number(count?.total ?? 0), page, page_size: pageSize }
  }

  async sync(actor: OrganizationBillingActor, orderNo: string): Promise<Record<string, unknown>> {
    await this.billing.assertAdmin(actor, actor.orgId, true)
    const order = await this.requireOrder(orderNo, actor.orgId)
    if (order.payment_status === 'paid') return this.project(order)
    const result = await this.requirePayment().queryPayment({ orderNo: order.order_no, orderDate: date(order.created_at), amountCents: order.amount_cny_fen })
    if (result.event) await this.acceptVerifiedEvent(result.event)
    return this.project(await this.requireOrder(orderNo, actor.orgId))
  }
  async cancel(actor: OrganizationBillingActor, orderNo: string): Promise<void> {
    await this.billing.assertAdmin(actor, actor.orgId, true)
    await this.billing.exclusive(`order:${orderNo}`, async () => {
      const order = await this.requireOrder(orderNo, actor.orgId)
      if (order.payment_status === 'paid') throw new OrganizationBillingError('ALREADY_PAID', '已付款订单不能取消', 409)
      await this.billing.db.run("UPDATE organization_model_orders SET payment_status = 'cancelled' WHERE id = ?", [order.id])
      return true
    })
  }
  async handleCallback(payload: Record<string, unknown>): Promise<void> {
    await this.acceptVerifiedEvent(await this.requirePayment().verifyCallback(payload))
  }
  /** Only called with a provider-protocol-validated payment/query result, never with client-provided paid flags. */
  async acceptVerifiedEvent(event: VerifiedPaymentEvent): Promise<void> {
    await this.billing.exclusive(`order:${event.orderNo}`, async () => {
      const order = await this.requireOrder(event.orderNo)
      if (event.orderDate !== date(order.created_at) || event.amountCents !== order.amount_cny_fen) throw new OrganizationBillingError('PAYMENT_MISMATCH', '支付金额或订单日期不匹配', 400)
      if (event.status !== 'SUCCESS' || order.credit_status === 'credited') return true
      await this.billing.db.run("UPDATE organization_model_orders SET payment_status = 'paid', paid_at = COALESCE(paid_at, ?), credit_status = 'sending' WHERE id = ?", [Date.now(), order.id])
      const manual = await this.billing.db.get('SELECT order_no FROM organization_model_order_resolutions WHERE order_no = ?', [order.order_no])
      if (manual) {
        await this.billing.db.run("UPDATE organization_model_orders SET credit_status = 'needs_review' WHERE id = ?", [order.id])
        return true
      }
      try {
        await this.billing.operation(order.org_id, 'organization-recharge', `recharge:${order.id}`, { accountId: order.router_user_id, quota: order.credited_quota, orderNo: order.order_no }, false, async () => {
          await this.billing.router.changeAccountQuota(order.router_user_id, order.credited_quota, `Moss organization recharge ${order.order_no}`)
          return { creditedQuota: order.credited_quota }
        }, undefined, order.payer_user_id)
        await this.billing.db.run("UPDATE organization_model_orders SET credit_status = 'credited', credited_at = ? WHERE id = ?", [Date.now(), order.id])
      } catch {
        // The verified payment is durably recorded. A repeated callback must not send another old quota write.
        await this.billing.db.run("UPDATE organization_model_orders SET credit_status = 'needs_review' WHERE id = ?", [order.id])
      }
      return true
    })
  }
  async requireOrder(orderNo: string, orgId?: string): Promise<OrganizationOrder> {
    const order = await this.billing.db.get<OrganizationOrder>(`SELECT * FROM organization_model_orders WHERE order_no = ?${orgId ? ' AND org_id = ?' : ''}`, orgId ? [orderNo, orgId] : [orderNo])
    if (!order) throw new OrganizationBillingError('ORDER_NOT_FOUND', '订单不存在', 404)
    return order
  }
  project(order: OrganizationOrder): Record<string, unknown> {
    return { source: 'online', order_no: order.order_no, org_id: order.org_id, payer_user_id: order.payer_user_id,
      purchase_amount_usd: formatUsdMicros(order.purchase_usd_micros), bonus_amount_usd: formatUsdMicros(order.bonus_usd_micros),
      amount_cny_fen: order.amount_cny_fen, payment_method: order.payment_method,
      payment_status: order.payment_status, credit_status: order.credit_status, created_at: order.created_at, expires_at: order.expires_at,
      payment_test_mode: order.payment_test_mode === 1 }
  }
}
function date(timestamp: number): string { return new Date(timestamp).toISOString().slice(0, 10).replaceAll('-', '') }
