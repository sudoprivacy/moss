import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SqliteDriver } from '../db/driver.js'
import { OrganizationBillingService } from './organizationBillingService.js'
import { OrganizationRechargeService, type OrganizationPaymentPort } from './organizationRechargeService.js'
import { OrganizationRouterAdapter } from './organizationRouterAdapter.js'
import { RouterMock } from './testing/routerMock.js'
import { dispatchOrganizationRecharge, parseOrganizationPaymentCallback } from './organizationRechargeRoutes.js'
import type { VerifiedPaymentEvent } from './fuiouAdapter.js'

async function setup() {
  const db = new SqliteDriver(new DatabaseSync(':memory:'))
  await db.exec(`CREATE TABLE organizations (id TEXT PRIMARY KEY); CREATE TABLE users (id TEXT PRIMARY KEY, org_id TEXT, role TEXT, status TEXT, name TEXT, display_name TEXT);
    INSERT INTO organizations VALUES ('a'), ('b'); INSERT INTO users(id, org_id, role, status) VALUES ('admin', 'a', 'admin', 'active'), ('admin2', 'a', 'admin', 'active'), ('member', 'a', 'user', 'active'), ('outsider', 'b', 'admin', 'active');`)
  const mock = new RouterMock({ adminToken: 'test' })
  let loseResponse = false; let writes = 0
  const router = new OrganizationRouterAdapter({ baseUrl: 'http://mock', apiToken: 'test', adminUserId: '1', fetch: async (input, init) => {
    const result = await mock.fetch(input, init)
    if (String(input).endsWith('/api/user/quota')) { writes++; if (loseResponse) throw new Error('lost response') }
    return result
  } })
  const values = new Map<string, string>()
  const billing = new OrganizationBillingService(db, router, {
    putSecret: async (_ns, key, value) => { values.set(key, value) },
    getSecret: async (_ns, key) => { const value = values.get(key); return value ? { value, status: 'enabled', version: 1 } : null },
  })
  await billing.initialize()
  await billing.configureOrganization('a', 'A', { initialAmountUsd: '0', defaultMemberLimitUsd: null })
  const payment: OrganizationPaymentPort = {
    simulationEnabled: false,
    createPayment: async () => ({ qrCodeUrl: 'https://example.test/pay', orderInfo: 'https://example.test/pay' }),
    verifyCallback: async () => { throw new Error('invalid signature') },
    queryPayment: async () => ({ status: 'PENDING' }),
  }
  const recharge = new OrganizationRechargeService(billing, payment)
  return { db, router, billing, recharge, payment, writes: () => writes, lose: () => { loseResponse = true } }
}
const actor = { userId: 'admin', orgId: 'a' }

void test('Moss organization order view is scoped, paginated, read-only and available to selected-org super admins', async () => {
  const c = await setup()
  try {
    await c.db.exec(`
      UPDATE users SET name = 'org-admin', display_name = '组织管理员' WHERE id = 'admin';
      INSERT INTO users(id, org_id, role, status) VALUES ('root', 'b', 'super_admin', 'active');`)
    const first = await c.recharge.createOrder(actor, '10.00', 'ALIPAY', 'admin-view-1')
    const second = await c.recharge.createOrder(actor, '5.00', 'WECHAT', 'admin-view-2')
    await c.recharge.acceptVerifiedEvent(await eventFor(c, String(first.order_no)))
    const selectedRoot = { userId: 'root', orgId: 'a' }
    const listed = await c.recharge.listForAdministration(selectedRoot, 1, 1)
    const next = await c.recharge.listForAdministration(selectedRoot, 2, 1)
    assert.equal(listed.total, 2)
    assert.equal(listed.items.length, 1)
    assert.notEqual(listed.items[0]!.order_no, next.items[0]!.order_no)
    assert.equal((await c.recharge.listForAdministration(selectedRoot, 3, 1)).items.length, 0)
    const orders = [...listed.items, ...next.items]
    const paid = orders.find(order => order.order_no === first.order_no)!
    assert.equal(paid.payer_username, 'org-admin')
    assert.equal(paid.payer_nickname, '组织管理员')
    assert.equal(paid.payment_status, 'paid')
    assert.equal(paid.credit_status, 'credited')
    assert.equal(paid.purchase_amount_usd, '10.00')
    assert.equal(paid.bonus_amount_usd, '1.00')
    assert.equal(paid.amount_cny_fen, 7300)
    assert.equal(typeof paid.paid_at, 'number')
    assert.equal(typeof paid.credited_at, 'number')
    assert.equal(paid.provider_order_info, undefined)
    assert.equal(orders.find(order => order.order_no === second.order_no)!.paid_at, null)
    assert.equal((await c.recharge.listForAdministration({ userId: 'outsider', orgId: 'b' })).total, 0)
    await assert.rejects(c.recharge.listForAdministration({ userId: 'admin', orgId: 'b' }), { statusCode: 403 })
    await assert.rejects(c.recharge.listForAdministration({ userId: 'member', orgId: 'a' }), { statusCode: 403 })
    await assert.rejects(c.recharge.listForAdministration(actor, 1, 101), { code: 'INVALID_PAGE' })
    await assert.rejects(c.recharge.createOrder(selectedRoot, '1.00', 'ALIPAY', 'root-cannot-pay'), { statusCode: 403 })
    await assert.rejects(c.recharge.list(selectedRoot), { statusCode: 403 })
    const route = await dispatchOrganizationRecharge(c.recharge, selectedRoot, 'GET', new URL('http://moss/api/v1/model-billing/admin/orders?org_id=b'), {})
    assert.equal(route.status, 200)
    assert.equal((route.body as { data: { total: number } }).data.total, 2)
    assert.equal((await dispatchOrganizationRecharge(c.recharge, selectedRoot, 'POST', new URL('http://moss/api/v1/model-billing/admin/orders'), {})).status, 404)
    assert.equal(c.writes(), 1, 'reading orders must not query payments or credit the account')
    await c.db.run("UPDATE users SET org_id = 'b', name = 'moved-admin', display_name = '其他组织' WHERE id = 'admin'")
    const moved = (await c.recharge.listForAdministration(selectedRoot)).items[0]!
    assert.equal(moved.payer_username, null)
    assert.equal(moved.payer_nickname, null)
  } finally { await c.db.close() }
})

async function eventFor(c: Awaited<ReturnType<typeof setup>>, orderNo: string): Promise<VerifiedPaymentEvent> {
  const order = await c.recharge.requireOrder(orderNo)
  return { providerEventId: 'fuiou-1', orderNo, orderDate: new Date(order.created_at).toISOString().slice(0, 10).replaceAll('-', ''), amountCents: order.amount_cny_fen, status: 'SUCCESS', raw: {} }
}

void test('USD organization purchase freezes recipient and credits once after payer leaves', async () => {
  const c = await setup()
  try {
    await assert.rejects(c.recharge.createOrder(actor, '1e3', 'ALIPAY', 'invalid-amount'), { statusCode: 400 })
    const order = await c.recharge.createOrder(actor, '10', 'ALIPAY', 'order-1')
    assert.equal(order.purchase_amount_usd, '10.00'); assert.equal(order.bonus_amount_usd, '1.00'); assert.equal(order.amount_cny_fen, 7300)
    assert.deepEqual(await c.recharge.createOrder(actor, '10.00', 'ALIPAY', 'order-1'), order)
    await assert.rejects(c.recharge.createOrder(actor, '5', 'ALIPAY', 'order-1'), /不同订单/)
    await assert.rejects(c.recharge.list({ userId: 'member', orgId: 'a' }))
    await assert.rejects(c.recharge.get({ userId: 'outsider', orgId: 'b' }, String(order.order_no)))
    assert.equal((await c.recharge.list({ userId: 'admin2', orgId: 'a' })).items.length, 1)
    await c.db.run("UPDATE users SET org_id = 'b', role = 'user' WHERE id = 'admin'")
    const event = await eventFor(c, String(order.order_no))
    await c.recharge.acceptVerifiedEvent(event); await c.recharge.acceptVerifiedEvent(event)
    assert.equal(c.writes(), 1)
    const account = await c.billing.requireAccount('a')
    assert.equal((await c.router.getAccount(account.router_user_id!)).quota, 5_500_000)
    assert.equal((await c.recharge.get({ userId: 'admin2', orgId: 'a' }, String(order.order_no))).credit_status, 'credited')
  } finally { await c.db.close() }
})
void test('payment mismatches and invalid callbacks cannot credit; lost quota response needs reconciliation', async () => {
  const c = await setup()
  try {
    const order = await c.recharge.createOrder(actor, '5', 'WECHAT', 'order-2')
    const event = await eventFor(c, String(order.order_no))
    await assert.rejects(c.recharge.handleCallback({ status: 'SUCCESS' }))
    await assert.rejects(c.recharge.acceptVerifiedEvent({ ...event, amountCents: 1 }))
    assert.equal(c.writes(), 0)
    c.lose()
    await c.recharge.acceptVerifiedEvent(event); await c.recharge.acceptVerifiedEvent(event)
    assert.equal(c.writes(), 1)
    const result = await c.recharge.get(actor, String(order.order_no))
    assert.equal(result.payment_status, 'paid'); assert.equal(result.credit_status, 'needs_review')
  } finally { await c.db.close() }
})
void test('cancelled orders still account for a verified late payment, and test mode is frozen per order', async () => {
  const c = await setup()
  try {
    const order = await c.recharge.createOrder(actor, '1', 'ALIPAY', 'order-3')
    Object.assign(c.payment, { simulationEnabled: true })
    assert.equal((await c.recharge.get(actor, String(order.order_no))).payment_test_mode, false)
    await assert.rejects(c.recharge.pay(actor, String(order.order_no)), /支付环境已变更/)
    await c.recharge.cancel(actor, String(order.order_no))
    await c.recharge.acceptVerifiedEvent(await eventFor(c, String(order.order_no)))
    assert.equal((await c.recharge.get(actor, String(order.order_no))).credit_status, 'credited')
  } finally { await c.db.close() }
})

void test('Fuiou callback envelopes preserve encoded signatures and reject invalid JSON shapes', () => {
  const body = { mchnt_cd: 'test', message: 'a+b/c=', resp_code: '0000' }
  assert.deepEqual(parseOrganizationPaymentCallback(new URLSearchParams(body).toString(), 'application/x-www-form-urlencoded; charset=UTF-8'), body)
  assert.deepEqual(parseOrganizationPaymentCallback(JSON.stringify(body), 'application/json'), body)
  assert.throws(() => parseOrganizationPaymentCallback('[]', 'application/json'))
})

void test('configured exchange rate freezes integer CNY and later changes do not reprice orders', async () => {
  const c = await setup()
  try {
    const options = { exchangeRateMicros: 7_100_000 }
    const recharge = new OrganizationRechargeService(c.billing, c.payment, options)
    assert.equal((await recharge.packages(actor)).find(p => p.purchase_amount_usd === '10.00')?.amount_cny_fen, 7100)
    const order = await recharge.createOrder(actor, '10.00', 'ALIPAY', 'configured-rate')
    options.exchangeRateMicros = 7_900_000
    assert.equal((await recharge.get(actor, String(order.order_no))).amount_cny_fen, 7100)
    assert.equal((await recharge.createOrder(actor, '10.00', 'ALIPAY', 'configured-rate')).amount_cny_fen, 7100)
  } finally { await c.db.close() }
})

async function operator(c: Awaited<ReturnType<typeof setup>>) {
  await c.db.run("INSERT INTO users(id, org_id, role, status, name) VALUES ('root', 'b', 'super_admin', 'active', 'operator')")
  return { userId: 'root', orgId: 'a' }
}
void test('manual credits use USD without bonuses/payment/member limit mutations and deduplicate business requests', async () => {
  const c = await setup()
  try {
    const root = await operator(c)
    await c.billing.ensureMember('a', 'member', '2')
    const token = (await c.billing.token('a', 'member'))!
    const before = (await c.router.listTokens(token.router_user_id, token.router_token_id!))[0]!
    await assert.rejects(c.recharge.manual.create(actor, { amount_usd: '11', reason: 'test' }, 'forbidden'), { statusCode: 403 })
    for (const amount of ['0', '0.001', '-1', '10000.01', '1e2']) await assert.rejects(c.recharge.manual.create(root, { amount_usd: amount, reason: 'test' }, 'invalid'))
    const input = { amount_usd: '11', reason: 'Manual organization credit' }
    const [a, b] = await Promise.all([c.recharge.manual.create(root, input, 'manual-1'), c.recharge.manual.create(root, input, 'manual-1')])
    assert.equal(a.order_no, b.order_no)
    assert.equal(a.credit_status, 'credited'); assert.equal(a.source, 'manual'); assert.equal(a.amount_cny_fen, null)
    assert.equal(a.payment_status, 'not_required'); assert.equal(a.bonus_amount_usd, '0.00'); assert.equal(c.writes(), 1)
    assert.equal((await c.router.getAccount(token.router_user_id)).quota, 5500000)
    assert.deepEqual((await c.router.listTokens(token.router_user_id, token.router_token_id!))[0], before)
    await assert.rejects(c.recharge.manual.create(root, { ...input, amount_usd: '12' }, 'manual-1'), { code: 'IDEMPOTENCY_CONFLICT' })
    const listed = await c.recharge.list(actor)
    assert.equal(listed.total, 1); assert.equal(listed.items[0]!.payer_username, 'operator')
    assert.equal((await c.recharge.listForAdministration(root, 1, 20, 'online')).total, 0)
    assert.equal((await c.recharge.listForAdministration(root, 1, 20, 'manual')).total, 1)
    await assert.rejects(c.recharge.pay(actor, String(a.order_no)), { statusCode: 404 })
    const foreign = { userId: root.userId, orgId: 'b' }
    await assert.rejects(c.recharge.manual.retry(foreign, String(a.order_no), 'cross-org'), { statusCode: 404 })
    const route = await dispatchOrganizationRecharge(c.recharge, root, 'POST', new URL('http://moss/api/v1/model-billing/admin/credits'), { amount_usd: '0.01', reason: 'route test' }, 'manual-route')
    assert.equal(route.status, 200)
  } finally { await c.db.close() }
})
void test('uncertain manual credit survives service recreation; reconciliation repairs records without another quota write', async () => {
  const c = await setup()
  try {
    const root = await operator(c); c.lose()
    const input = { amount_usd: '1', reason: 'lost response' }
    const credit = await c.recharge.manual.create(root, input, 'lost-manual')
    assert.equal(credit.credit_status, 'needs_review')
    const resumed = new OrganizationRechargeService(c.billing, c.payment)
    assert.equal((await resumed.manual.create(root, input, 'lost-manual')).credit_status, 'needs_review')
    await assert.rejects(resumed.manual.retry(root, String(credit.order_no), 'blind-retry'), { code: 'NEEDS_REVIEW' })
    await assert.rejects(resumed.manual.resolve(root, String(credit.order_no), { outcome: 'credited', evidence: 'checked' }, 'no-confirm'), { code: 'IN_FLIGHT' })
    const body = { outcome: 'credited', evidence: 'Verified upstream transaction; request has finished', confirm_request_finished: true }
    const path = new URL(`http://moss/api/v1/model-billing/admin/credits/${credit.order_no}/resolve`)
    assert.equal((await dispatchOrganizationRecharge(resumed, root, 'POST', path, body, 'resolve-lost')).status, 200)
    assert.equal((await dispatchOrganizationRecharge(resumed, root, 'POST', path, body, 'resolve-lost')).status, 200)
    assert.equal(c.writes(), 1)
    assert.equal((await resumed.list(actor)).items[0]!.credit_status, 'credited')
  } finally { await c.db.close() }
})
void test('rejected attempts can retry on the same business record, while replays never send twice', async () => {
  const c = await setup()
  try {
    const root = await operator(c)
    const original = c.router.changeAccountQuota.bind(c.router)
    const { RouterRequestError } = await import('./organizationRouterAdapter.js')
    c.router.changeAccountQuota = async () => { throw new RouterRequestError('upstream rejected', 'rejected') }
    const credit = await c.recharge.manual.create(root, { amount_usd: '2', reason: 'test rejection' }, 'rejected-manual')
    assert.equal(credit.credit_status, 'failed')
    c.router.changeAccountQuota = original
    const no = String(credit.order_no)
    const path = new URL(`http://moss/api/v1/model-billing/admin/credits/${no}/retry`)
    assert.equal((await dispatchOrganizationRecharge(c.recharge, root, 'POST', path, {}, 'retry-once')).status, 200)
    assert.equal((await dispatchOrganizationRecharge(c.recharge, root, 'POST', path, {}, 'retry-once')).status, 200)
    const result = (await c.recharge.list(actor)).items[0]!
    assert.equal(result.credit_status, 'credited'); assert.equal((result.attempts as unknown[]).length, 2)
    assert.equal((await c.recharge.list(actor)).total, 1); assert.equal(c.writes(), 1)
  } finally { await c.db.close() }
})
void test('manual takeover blocks late callbacks; partial supplements cannot close and originals remain distinct', async () => {
  const c = await setup()
  try {
    const root = await operator(c)
    const original = c.router.changeAccountQuota.bind(c.router)
    const { RouterRequestError } = await import('./organizationRouterAdapter.js')
    c.router.changeAccountQuota = async () => { throw new RouterRequestError('rejected', 'rejected', 'rejected') }
    const order = await c.recharge.createOrder(actor, '10', 'ALIPAY', 'abnormal-order')
    const no = String(order.order_no)
    const event = await eventFor(c, no)
    await c.recharge.acceptVerifiedEvent(event)
    c.router.changeAccountQuota = original
    await assert.rejects(c.recharge.manual.create(root, { amount_usd: '5', reason: 'supplement', related_order_no: no }, 'before-takeover'))
    const path = new URL(`http://moss/api/v1/model-billing/admin/orders/${no}/resolution`)
    assert.equal((await dispatchOrganizationRecharge(c.recharge, root, 'POST', path, { action: 'takeover', evidence: 'Original explicitly rejected' }, 'takeover')).status, 200)
    await c.recharge.manual.create(root, { amount_usd: '5', reason: 'partial', related_order_no: no }, 'partial')
    let summary = await c.recharge.manual.orderSummary(await c.recharge.requireOrder(no))
    assert.equal(summary.status, 'partial'); assert.equal(summary.difference_usd, '6.00')
    await assert.rejects(c.recharge.manual.resolution(root, no, { action: 'close', evidence: 'not enough' }, 'early-close'), { code: 'UNRESOLVED' })
    await c.recharge.acceptVerifiedEvent(event)
    assert.equal(c.writes(), 1)
    await c.recharge.manual.create(root, { amount_usd: '6', reason: 'remaining', related_order_no: no }, 'remaining')
    await c.recharge.manual.resolution(root, no, { action: 'close', evidence: 'Verified full eleven dollars' }, 'close')
    await c.recharge.acceptVerifiedEvent(event)
    summary = await c.recharge.manual.orderSummary(await c.recharge.requireOrder(no))
    assert.equal(summary.status, 'closed'); assert.equal(summary.manual_credited_usd, '11.00'); assert.equal(summary.original_credited_usd, '0.00')
    assert.equal(c.writes(), 2); assert.equal((await c.recharge.list(actor)).total, 3)
    await assert.rejects(c.recharge.manual.create(root, { amount_usd: '1', reason: 'closed', related_order_no: no }, 'closed-credit'))
  } finally { await c.db.close() }
})
void test('unknown original attempts must be reconciled before linked credit and in-flight locks prevent takeover races', async () => {
  const c = await setup()
  try {
    const root = await operator(c)
    const order = await c.recharge.createOrder(actor, '1', 'ALIPAY', 'unknown-original')
    const no = String(order.order_no)
    c.lose(); await c.recharge.acceptVerifiedEvent(await eventFor(c, no))
    await c.recharge.manual.resolution(root, no, { action: 'takeover', evidence: 'Investigating' }, 'take-unknown')
    await assert.rejects(c.recharge.manual.create(root, { amount_usd: '1', reason: 'unsafe', related_order_no: no }, 'unsafe'))
    await c.recharge.manual.resolution(root, no, { action: 'original_result', outcome: 'credited', evidence: 'Router recorded original credit', confirm_request_finished: true }, 'original-credited')
    await c.recharge.acceptVerifiedEvent(await eventFor(c, no))
    assert.equal(c.writes(), 1)
    await c.recharge.manual.resolution(root, no, { action: 'close', evidence: 'Original confirmed' }, 'close-original')
    assert.equal((await c.recharge.manual.orderSummary(await c.recharge.requireOrder(no))).status, 'closed')
  } finally { await c.db.close() }
})

void test('live original credit blocks takeover until its outcome is known', async () => {
  const c = await setup()
  try {
    const root = await operator(c)
    const order = await c.recharge.createOrder(actor, '1', 'ALIPAY', 'inflight-original')
    const no = String(order.order_no)
    let release!: () => void; let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const paused = new Promise<void>(resolve => { release = resolve })
    const original = c.router.changeAccountQuota.bind(c.router)
    c.router.changeAccountQuota = async (...args) => { started(); await paused; return original(...args) }
    const callback = c.recharge.acceptVerifiedEvent(await eventFor(c, no))
    await ready
    let takeoverFinished = false
    const takeover = c.recharge.manual.resolution(root, no, { action: 'takeover', evidence: 'concurrent request' }, 'concurrent-takeover').then(() => { takeoverFinished = true }, () => { takeoverFinished = true })
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(takeoverFinished, false)
    release(); await callback; await takeover
    assert.equal(c.writes(), 1)
    assert.equal((await c.recharge.manual.orderSummary(await c.recharge.requireOrder(no))).is_manual, false)
  } finally { await c.db.close() }
})
void test('confirmed nonexecution can retry; unknown linked attempts block a second supplement and stale sending records never resend', async () => {
  const c = await setup()
  try {
    const root = await operator(c)
    const original = c.router.changeAccountQuota.bind(c.router)
    c.router.changeAccountQuota = async () => { throw new Error('request outcome unknown to client') }
    const order = await c.recharge.createOrder(actor, '1', 'ALIPAY', 'unknown-before-send')
    const no = String(order.order_no)
    await c.recharge.acceptVerifiedEvent(await eventFor(c, no))
    await c.recharge.manual.resolution(root, no, { action: 'original_result', outcome: 'not_executed', confirm_request_finished: true, evidence: 'Upstream confirmed original request absent and finished' }, 'confirm-original-not-executed')
    const credit = await c.recharge.manual.create(root, { amount_usd: '1', reason: 'supplement', related_order_no: no }, 'unknown-linked')
    const creditNo = String(credit.order_no)
    await assert.rejects(c.recharge.manual.create(root, { amount_usd: '1', reason: 'duplicate gap', related_order_no: no }, 'second-gap'), { code: 'NEEDS_REVIEW' })
    await c.db.run("UPDATE organization_model_credits SET status = 'sending' WHERE credit_no = ?", [creditNo])
    const resumed = new OrganizationRechargeService(c.billing, c.payment)
    await assert.rejects(resumed.manual.retry(root, creditNo, 'crash-retry'), { code: 'NEEDS_REVIEW' })
    await resumed.manual.resolve(root, creditNo, { outcome: 'not_executed', confirm_request_finished: true, evidence: 'Upstream confirmed attempt absent and finished' }, 'confirm-credit-not-executed')
    c.router.changeAccountQuota = original
    await resumed.manual.retry(root, creditNo, 'confirmed-retry')
    assert.equal(c.writes(), 1)
    const summary = await resumed.manual.orderSummary(await resumed.requireOrder(no))
    assert.equal(summary.manual_credited_usd, '1.00'); assert.equal(summary.unsettled_count, 0)
    const record = (await resumed.listForAdministration(root, 1, 20, 'manual')).items[0]!
    assert.equal((record.attempts as unknown[]).length, 2)
  } finally { await c.db.close() }
})
