import { createHash } from 'node:crypto'
import type { SqlRow } from '../db/driver.js'
import { formatUsdMicros, parseUsd, usdMicrosToQuota } from './modelMoney.js'
import { OrganizationBillingError, type OrganizationBillingActor, type OrganizationBillingService } from './organizationBillingService.js'
import type { OrganizationOrder, OrganizationRechargeService } from './organizationRechargeService.js'

type Credit = SqlRow & {
  credit_no: string; org_id: string; router_user_id: number; amount_usd_micros: number; quota: number
  actor_user_id: string; reason: string; related_order_no: string | null; reference: string; fingerprint: string
  status: 'pending' | 'sending' | 'credited' | 'failed' | 'needs_review'; created_at: number; credited_at: number | null
}
type Resolution = SqlRow & { order_no: string; original_outcome: 'unknown' | 'credited' | 'not_executed'; is_closed: number }

/** Non-idempotent Router writes have one durable attempt; uncertain writes require human evidence. */
export class OrganizationManualCreditService {
  constructor(private readonly recharge: OrganizationRechargeService, private readonly billing: OrganizationBillingService) {}

  private async assertOperator(actor: OrganizationBillingActor) {
    await this.billing.assertAdmin(actor, actor.orgId)
    const user = await this.billing.db.get('SELECT role FROM users WHERE id = ?', [actor.userId])
    if (user?.role !== 'super_admin') throw new OrganizationBillingError('FORBIDDEN', '仅超级管理员可以后台充值或登记核对结果', 403)
  }
  private reason(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 1000) throw new OrganizationBillingError('INVALID_REASON', '请填写原因或核对依据（1–1000 字）')
    return value.trim()
  }
  private reference(value: string): string {
    if (!value || value.length > 120) throw new OrganizationBillingError('INVALID_REFERENCE', '操作标识无效')
    return value
  }
  private lock(credit: Credit): string { return `order:${credit.related_order_no ?? `manual:${credit.credit_no}`}` }
  async requireCredit(no: string, orgId: string): Promise<Credit> {
    const credit = await this.billing.db.get<Credit>('SELECT * FROM organization_model_credits WHERE credit_no = ? AND org_id = ?', [no, orgId])
    if (!credit) throw new OrganizationBillingError('CREDIT_NOT_FOUND', '后台充值记录不存在', 404)
    return credit
  }
  async create(actor: OrganizationBillingActor, input: Record<string, unknown>, reference: string) {
    await this.assertOperator(actor)
    this.reference(reference)
    const reason = this.reason(input.reason)
    let amount: number
    try { amount = parseUsd(input.amount_usd, false) } catch { throw new OrganizationBillingError('INVALID_AMOUNT', '请输入最多两位小数的美元金额') }
    if (amount < 10000 || amount > 10000000000) throw new OrganizationBillingError('INVALID_AMOUNT', '后台充值金额须为 $0.01 至 $10000.00')
    const related = input.related_order_no == null ? null : typeof input.related_order_no === 'string' && input.related_order_no.trim() || null
    if (input.related_order_no != null && !related) throw new OrganizationBillingError('INVALID_ORDER', '关联订单号无效')
    const account = await this.billing.requireAccount(actor.orgId)
    if (account.status !== 'ready' || !account.router_user_id) throw new OrganizationBillingError('ACCOUNT_UNAVAILABLE', '组织模型账户尚未就绪', 409)
    const no = `MADM${createHash('sha256').update(reference).digest('hex').slice(0, 24)}`
    const fingerprint = createHash('sha256').update(JSON.stringify([actor.orgId, actor.userId, account.router_user_id, amount, reason, related])).digest('hex')
    return this.billing.exclusive(`manual-create:${reference}`, () => this.billing.exclusive(`order:${related ?? `manual:${no}`}`, async () => {
      const existing = await this.billing.db.get<Credit>('SELECT * FROM organization_model_credits WHERE reference = ?', [reference])
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new OrganizationBillingError('IDEMPOTENCY_CONFLICT', '操作标识已用于不同充值', 409)
        // Even pending records are never implicitly sent by replays. Recovery is explicit.
        return this.project(existing)
      }
      if (related) await this.assertCanSupplement(related, actor.orgId)
      await this.billing.db.run(`INSERT INTO organization_model_credits
        (credit_no, org_id, router_user_id, amount_usd_micros, quota, actor_user_id, reason, related_order_no, reference, fingerprint, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [no, actor.orgId, account.router_user_id!, amount, usdMicrosToQuota(amount, account.quota_per_usd), actor.userId, reason, related, reference, fingerprint, Date.now()])
      await this.attempt(await this.requireCredit(no, actor.orgId), `initial:${reference}`, actor)
      return this.project(await this.requireCredit(no, actor.orgId))
    }))
  }
  private async attempt(credit: Credit, reference: string, actor: OrganizationBillingActor) {
    const attemptRef = `manual-credit:${reference}`
    await this.billing.db.transaction(async () => {
      await this.billing.db.run(`INSERT INTO organization_model_credit_attempts (reference, credit_no, status, actor_user_id, created_at)
        VALUES (?, ?, 'sending', ?, ?)`, [attemptRef, credit.credit_no, actor.userId, Date.now()])
      await this.billing.db.run("UPDATE organization_model_credits SET status = 'sending' WHERE credit_no = ?", [credit.credit_no])
    })
    let status: Credit['status'] = 'credited'
    try {
      await this.billing.operation(credit.org_id, 'manual-credit', attemptRef, { creditNo: credit.credit_no, accountId: credit.router_user_id, quota: credit.quota }, false, async () => {
        await this.billing.router.changeAccountQuota(credit.router_user_id, credit.quota, `Moss manual credit ${credit.credit_no} ${reference}`)
        return { creditedQuota: credit.quota }
      }, undefined, actor.userId)
    } catch {
      const op = await this.billing.db.get('SELECT status FROM organization_model_operations WHERE reference = ?', [attemptRef])
      status = op?.status === 'rejected' ? 'failed' : 'needs_review'
    }
    await this.billing.db.transaction(async () => {
      await this.billing.db.run('UPDATE organization_model_credit_attempts SET status = ? WHERE reference = ?', [status, attemptRef])
      await this.billing.db.run('UPDATE organization_model_credits SET status = ?, credited_at = ? WHERE credit_no = ?', [status, status === 'credited' ? Date.now() : null, credit.credit_no])
    })
  }
  async retry(actor: OrganizationBillingActor, no: string, reference: string) {
    await this.assertOperator(actor); this.reference(reference)
    const credit = await this.requireCredit(no, actor.orgId)
    return this.billing.exclusive(this.lock(credit), async () => {
      const previous = await this.billing.db.get('SELECT credit_no FROM organization_model_credit_attempts WHERE reference = ?', [`manual-credit:retry:${reference}`])
      if (previous) {
        if (previous.credit_no !== no) throw new OrganizationBillingError('IDEMPOTENCY_CONFLICT', '重试标识已被使用', 409)
        return this.project(await this.requireCredit(no, actor.orgId))
      }
      const current = await this.requireCredit(no, actor.orgId)
      if (!['failed', 'pending'].includes(current.status)) throw new OrganizationBillingError('NEEDS_REVIEW', '只有明确未执行的充值允许再次尝试', 409)
      if (current.related_order_no) await this.assertCanSupplement(current.related_order_no, actor.orgId, no)
      await this.attempt(current, `retry:${reference}`, actor)
      return this.project(await this.requireCredit(no, actor.orgId))
    })
  }
  async resolve(actor: OrganizationBillingActor, no: string, input: Record<string, unknown>, reference: string) {
    await this.assertOperator(actor); this.reference(reference)
    const evidence = this.reason(input.evidence)
    if (!['credited', 'not_executed', 'unknown'].includes(String(input.outcome))) throw new OrganizationBillingError('INVALID_OUTCOME', '核对结论无效')
    const credit = await this.requireCredit(no, actor.orgId)
    return this.billing.exclusive(this.lock(credit), async () => this.localCommand(actor, `credit-resolve:${reference}`, { no, ...input }, async () => {
      const current = await this.requireCredit(no, actor.orgId)
      if (!['sending', 'needs_review'].includes(current.status)) throw new OrganizationBillingError('INVALID_STATE', '仅待核对充值可登记结果', 409)
      if (input.outcome !== 'unknown' && input.confirm_request_finished !== true) throw new OrganizationBillingError('IN_FLIGHT', '必须核实原请求已结束且不会继续执行', 409)
      const status = input.outcome === 'credited' ? 'credited' : input.outcome === 'not_executed' ? 'failed' : 'needs_review'
      const attempt = await this.billing.db.get("SELECT reference FROM organization_model_credit_attempts WHERE credit_no = ? AND status IN ('sending', 'needs_review') ORDER BY created_at DESC, reference DESC LIMIT 1", [no])
      if (!attempt) throw new OrganizationBillingError('INVALID_STATE', '缺少到账尝试记录', 409)
      await this.billing.db.run('UPDATE organization_model_credit_attempts SET status = ? WHERE reference = ?', [status, String(attempt.reference)])
      await this.billing.db.run('UPDATE organization_model_credits SET status = ?, credited_at = ? WHERE credit_no = ?', [status, status === 'credited' ? Date.now() : null, no])
      await this.audit(actor, no, reference, String(input.outcome), evidence)
      return this.project(await this.requireCredit(no, actor.orgId))
    }))
  }
  async resolution(actor: OrganizationBillingActor, no: string, input: Record<string, unknown>, reference: string) {
    await this.assertOperator(actor); this.reference(reference)
    const evidence = this.reason(input.evidence)
    return this.billing.exclusive(`order:${no}`, async () => this.localCommand(actor, `order-resolve:${reference}`, { no, ...input }, async () => {
      const order = await this.recharge.requireOrder(no, actor.orgId)
      const resolution = await this.billing.db.get<Resolution>('SELECT * FROM organization_model_order_resolutions WHERE order_no = ?', [no])
      const op = await this.billing.db.get('SELECT status FROM organization_model_operations WHERE reference = ?', [`recharge:${order.id}`])
      if (input.action === 'takeover') {
        if (resolution) return this.orderSummary(order)
        if (order.payment_status !== 'paid' || order.credit_status === 'credited') throw new OrganizationBillingError('INVALID_STATE', '仅已付款的异常订单可转人工处理', 409)
        if (op?.status === 'sending') throw new OrganizationBillingError('IN_FLIGHT', '原请求仍处于发送状态，请先核实并登记原入账结果', 409)
        await this.billing.db.run(`INSERT INTO organization_model_order_resolutions (order_no, original_outcome, is_closed) VALUES (?, ?, 0)`,
          [no, !op || op.status === 'rejected' ? 'not_executed' : 'unknown'])
      } else if (input.action === 'original_result') {
        if (order.payment_status !== 'paid' || resolution?.is_closed) throw new OrganizationBillingError('INVALID_STATE', '订单当前不允许核对', 409)
        if (!['credited', 'not_executed', 'unknown'].includes(String(input.outcome))) throw new OrganizationBillingError('INVALID_OUTCOME', '核对结论无效')
        if (input.outcome !== 'unknown' && input.confirm_request_finished !== true) throw new OrganizationBillingError('IN_FLIGHT', '必须核实原请求已结束且不会继续执行', 409)
        if (order.credit_status === 'credited' || resolution && resolution.original_outcome !== 'unknown') throw new OrganizationBillingError('INVALID_STATE', '原入账已有确定结论', 409)
        if (input.outcome === 'not_executed' && op?.status === 'succeeded') throw new OrganizationBillingError('INVALID_STATE', '原入账操作已确认成功', 409)
        await this.billing.db.run(`INSERT INTO organization_model_order_resolutions (order_no, original_outcome, is_closed) VALUES (?, ?, 0)
          ON CONFLICT(order_no) DO UPDATE SET original_outcome = excluded.original_outcome`, [no, String(input.outcome)])
        if (input.outcome === 'credited') await this.billing.db.run("UPDATE organization_model_orders SET credit_status = 'credited', credited_at = COALESCE(credited_at, ?) WHERE id = ?", [Date.now(), order.id])
      } else if (input.action === 'close') {
        const summary = await this.orderSummary(order)
        if (!resolution || resolution.original_outcome === 'unknown' || summary.unsettled_count || Number(summary.difference_usd) > 0) throw new OrganizationBillingError('UNRESOLVED', '仍有未知结果、未完成充值或补充金额不足，不能结案', 409)
        await this.billing.db.run('UPDATE organization_model_order_resolutions SET is_closed = 1 WHERE order_no = ?', [no])
      } else throw new OrganizationBillingError('INVALID_ACTION', '人工处理操作无效')
      await this.audit(actor, no, reference, String(input.action), evidence)
      return this.orderSummary(await this.recharge.requireOrder(no, actor.orgId))
    }))
  }
  private async localCommand<T>(actor: OrganizationBillingActor, reference: string, input: unknown, run: () => Promise<T>) {
    // Local resolution and its replay result commit together, with no network call inside the transaction.
    return this.billing.db.transaction(() => this.billing.operation(actor.orgId, 'manual-resolution', reference, input, true, run, undefined, actor.userId))
  }
  private audit(actor: OrganizationBillingActor, target: string, reference: string, action: string, evidence: string) {
    return this.billing.db.run(`INSERT INTO organization_model_credit_audit (reference, org_id, target_no, actor_user_id, action, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [reference, actor.orgId, target, actor.userId, action, evidence, Date.now()])
  }
  private async assertCanSupplement(no: string, orgId: string, exceptCredit?: string) {
    const order = await this.recharge.requireOrder(no, orgId)
    const resolution = await this.billing.db.get<Resolution>('SELECT * FROM organization_model_order_resolutions WHERE order_no = ?', [no])
    if (order.payment_status !== 'paid' || !resolution || resolution.is_closed || resolution.original_outcome !== 'not_executed') throw new OrganizationBillingError('NEEDS_REVIEW', '关联订单须转人工并确认原入账未执行，且尚未结案', 409)
    const unknown = await this.billing.db.get(`SELECT credit_no FROM organization_model_credits WHERE related_order_no = ? AND status IN ('pending', 'sending', 'needs_review') AND credit_no <> ? LIMIT 1`, [no, exceptCredit ?? ''])
    if (unknown) throw new OrganizationBillingError('NEEDS_REVIEW', '关联订单已有未完成或待核对的后台充值', 409)
  }
  async orderSummary(order: OrganizationOrder) {
    const resolution = await this.billing.db.get<Resolution>('SELECT * FROM organization_model_order_resolutions WHERE order_no = ?', [order.order_no])
    const credits = await this.billing.db.all<Credit>('SELECT * FROM organization_model_credits WHERE related_order_no = ? ORDER BY created_at, credit_no', [order.order_no])
    const paid = credits.filter(c => c.status === 'credited').reduce((sum, c) => sum + c.amount_usd_micros, 0)
    const unsettled = credits.filter(c => ['pending', 'sending', 'needs_review'].includes(c.status))
    const expected = order.purchase_usd_micros + order.bonus_usd_micros
    const original = order.credit_status === 'credited' || resolution?.original_outcome === 'credited' ? expected : 0
    return { is_manual: !!resolution, original_outcome: resolution?.original_outcome ?? (original ? 'credited' : 'unknown'),
      status: !resolution ? 'automatic' : resolution.is_closed ? 'closed' : resolution.original_outcome === 'unknown' || unsettled.length ? 'needs_review' : paid > 0 && paid + original < expected ? 'partial' : 'ready',
      expected_amount_usd: formatUsdMicros(expected), original_credited_usd: formatUsdMicros(original), manual_credited_usd: formatUsdMicros(paid),
      difference_usd: formatUsdMicros(expected - original - paid), unsettled_count: unsettled.length,
      related_credits: credits.map(c => ({ credit_no: c.credit_no, amount_usd: formatUsdMicros(c.amount_usd_micros), status: c.status })),
      audit: await this.billing.db.all('SELECT actor_user_id, action, evidence, created_at FROM organization_model_credit_audit WHERE target_no = ? AND org_id = ? ORDER BY created_at', [order.order_no, order.org_id]) }
  }
  async project(credit: Credit): Promise<Record<string, unknown>> {
    const operator = await this.billing.db.get('SELECT name, display_name FROM users WHERE id = ?', [credit.actor_user_id])
    return { source: 'manual', order_no: credit.credit_no, org_id: credit.org_id, router_user_id: credit.router_user_id,
      payer_user_id: credit.actor_user_id, payer_username: operator?.name ?? null, payer_nickname: operator?.display_name ?? null,
      purchase_amount_usd: formatUsdMicros(credit.amount_usd_micros), bonus_amount_usd: '0.00', amount_cny_fen: null,
      payment_method: null, payment_status: 'not_required', payment_test_mode: false, credit_status: credit.status,
      created_at: credit.created_at, expires_at: null, paid_at: null, credited_at: credit.credited_at, reason: credit.reason, related_order_no: credit.related_order_no,
      attempts: await this.billing.db.all('SELECT reference, status, actor_user_id, created_at FROM organization_model_credit_attempts WHERE credit_no = ? ORDER BY created_at, reference', [credit.credit_no]),
      audit: await this.billing.db.all('SELECT actor_user_id, action, evidence, created_at FROM organization_model_credit_audit WHERE target_no = ? AND org_id = ? ORDER BY created_at', [credit.credit_no, credit.org_id]) }
  }
}
