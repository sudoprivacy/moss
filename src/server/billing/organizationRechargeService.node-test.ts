import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SqliteDriver } from '../db/driver.js'
import { OrganizationBillingService } from './organizationBillingService.js'
import { OrganizationRechargeService, type OrganizationPaymentPort } from './organizationRechargeService.js'
import { OrganizationRouterAdapter } from './organizationRouterAdapter.js'
import { RouterMock } from './testing/routerMock.js'
import { parseOrganizationPaymentCallback } from './organizationRechargeRoutes.js'
import type { VerifiedPaymentEvent } from './fuiouAdapter.js'

async function setup() {
  const db = new SqliteDriver(new DatabaseSync(':memory:'))
  await db.exec(`CREATE TABLE organizations (id TEXT PRIMARY KEY); CREATE TABLE users (id TEXT PRIMARY KEY, org_id TEXT, role TEXT, status TEXT);
    INSERT INTO organizations VALUES ('a'), ('b'); INSERT INTO users VALUES ('admin', 'a', 'admin', 'active'), ('admin2', 'a', 'admin', 'active'), ('member', 'a', 'user', 'active'), ('outsider', 'b', 'admin', 'active');`)
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
