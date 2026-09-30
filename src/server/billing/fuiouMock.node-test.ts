import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { SqliteDriver } from '../db/driver.js'
import { FuiouAdapter } from './fuiouAdapter.js'
import { OrganizationBillingService } from './organizationBillingService.js'
import { OrganizationRechargeService } from './organizationRechargeService.js'
import { OrganizationRouterAdapter } from './organizationRouterAdapter.js'
import { parseOrganizationPaymentCallback } from './organizationRechargeRoutes.js'
import { FuiouMock } from './testing/fuiouMock.js'
import { RouterMock } from './testing/routerMock.js'

void test('real RSA/GBK payment protocol credits once via callback or query, including a late payment', async () => {
  const db = new SqliteDriver(new DatabaseSync(':memory:'))
  try {
    await db.exec(`CREATE TABLE organizations(id TEXT PRIMARY KEY); CREATE TABLE users(id TEXT PRIMARY KEY, org_id TEXT, role TEXT, status TEXT);
      INSERT INTO organizations VALUES ('org'); INSERT INTO users VALUES ('admin', 'org', 'admin', 'active'), ('member', 'org', 'user', 'active');`)
    const routerMock = new RouterMock({ adminToken: 'test' })
    const router = new OrganizationRouterAdapter({ baseUrl: 'http://mock', apiToken: 'test', adminUserId: '1', fetch: routerMock.fetch })
    const secrets = new Map<string, string>()
    const billing = new OrganizationBillingService(db, router, {
      putSecret: async (_ns, key, value) => { secrets.set(key, value) },
      getSecret: async (_ns, key) => { const value = secrets.get(key); return value ? { value, status: 'enabled', version: 1 } : null },
    })
    await billing.initialize()
    const account = await billing.configureOrganization('org', 'Test', { initialAmountUsd: '0', defaultMemberLimitUsd: '5' })
    const pair = () => generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
    const merchant = pair(); const provider = pair(); const controlToken = 'only-for-local-test-control-token'
    let recharge: OrganizationRechargeService
    const mock = new FuiouMock({
      merchantCode: 'TEST', merchantPublicKey: merchant.publicKey, providerPrivateKey: provider.privateKey, controlToken,
      baseUrl: 'http://127.0.0.1:3303', callbackUrl: 'http://127.0.0.1:43127/api/v1/model-billing/callback',
      fetch: async (_url, init) => {
        await recharge.handleCallback(parseOrganizationPaymentCallback(String(init?.body), 'application/x-www-form-urlencoded'))
        return new Response('success')
      },
    })
    const adapter = new FuiouAdapter({
      merchantCode: 'TEST', merchantPrivateKey: merchant.privateKey, fuiouPublicKey: provider.publicKey,
      baseUrl: 'http://127.0.0.1:3303', callbackUrl: 'http://127.0.0.1:43127/api/v1/model-billing/callback',
      fetch: async (url, init) => mock.handle(new Request(url instanceof Request ? url.url : String(url), { method: init?.method, headers: init?.headers, body: String(init?.body) })),
    })
    recharge = new OrganizationRechargeService(billing, adapter)
    const actor = { userId: 'admin', orgId: 'org' }
    const command = (orderNo: string, action: string) => mock.handle(new Request(`http://127.0.0.1:3303/__mock/orders/${orderNo}/${action}`, {
      method: 'POST', headers: { Authorization: `Bearer ${controlToken}`, 'Content-Type': 'application/json' }, body: '{}',
    }))
    const balance = async () => (await router.getAccount(account.router_user_id!)).quota
    const first = await recharge.createOrder(actor, '10.00', 'ALIPAY', 'rsa-callback')
    const firstNo = String(first.order_no)
    const payment = await recharge.pay(actor, firstNo)
    assert.equal(payment.qr_code_url, `http://127.0.0.1:3303/pay/${firstNo}`)
    assert.equal(mock.snapshot()[0]!.amountCents, 7300)
    assert.equal((await command(firstNo, 'pay')).status, 200)
    assert.equal((await recharge.get(actor, firstNo)).credit_status, 'credited')
    assert.equal(await balance(), 5_500_000)
    await Promise.all([command(firstNo, 'replay'), command(firstNo, 'replay'), recharge.sync(actor, firstNo)])
    assert.equal(await balance(), 5_500_000, 'duplicate callbacks never repeat the old quota mutation')
    await assert.rejects(recharge.createOrder({ userId: 'member', orgId: 'org' }, '1.00', 'ALIPAY', 'forbidden'))
    const second = await recharge.createOrder(actor, '5.00', 'WECHAT', 'rsa-query')
    const secondNo = String(second.order_no)
    await recharge.pay(actor, secondNo)
    await command(secondNo, 'pay-without-callback')
    assert.equal((await recharge.get(actor, secondNo)).credit_status, 'pending')
    assert.equal((await recharge.sync(actor, secondNo)).credit_status, 'credited')
    await command(secondNo, 'replay')
    assert.equal(await balance(), 8_250_000)
    const third = await recharge.createOrder(actor, '1.00', 'WECHAT', 'rsa-late')
    const thirdNo = String(third.order_no)
    await recharge.pay(actor, thirdNo); await recharge.cancel(actor, thirdNo)
    await command(thirdNo, 'pay')
    assert.equal((await recharge.get(actor, thirdNo)).credit_status, 'credited')
    assert.equal(await balance(), 8_750_000)
    await assert.rejects(recharge.handleCallback({ mchnt_cd: 'TEST', resp_code: '0000', message: Buffer.alloc(256).toString('base64') }))
    assert.equal(await balance(), 8_750_000)
    const denied = await mock.handle(new Request(`http://127.0.0.1:3303/__mock/orders/${firstNo}/replay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))
    assert.equal(denied.status, 403)
    assert.equal(mock.snapshot()[0]!.lastCallbackStatus, 200)
  } finally { await db.close() }
})
