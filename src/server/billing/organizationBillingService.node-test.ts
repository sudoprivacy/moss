import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { SqliteDriver } from '../db/driver.js'
import { parseUsd, usdMicrosToQuota, quotaToUsd, payableCnyFen } from './modelMoney.js'
import { OrganizationRouterAdapter, type RouterFetch } from './organizationRouterAdapter.js'
import { OrganizationBillingService } from './organizationBillingService.js'
import { RouterMock } from './testing/routerMock.js'

async function setup(registrationQuota = 0, transform?: (fetcher: RouterFetch) => RouterFetch) {
  const sqlite = new DatabaseSync(':memory:')
  const db = new SqliteDriver(sqlite)
  await db.exec(`CREATE TABLE organizations (id TEXT PRIMARY KEY); CREATE TABLE users (id TEXT PRIMARY KEY, org_id TEXT, role TEXT, status TEXT);
    INSERT INTO organizations VALUES ('org-a'), ('org-b');
    INSERT INTO users VALUES ('admin-a', 'org-a', 'admin', 'active'), ('member-a', 'org-a', 'user', 'active'), ('member-b', 'org-a', 'user', 'active'), ('other', 'org-b', 'admin', 'active');`)
  const mock = new RouterMock({ adminToken: 'local-router-test', registrationQuota })
  const router = new OrganizationRouterAdapter({ baseUrl: 'http://mock', apiToken: 'local-router-test', adminUserId: '1', fetch: transform ? transform(mock.fetch) : mock.fetch })
  const values = new Map<string, string>()
  const secrets = {
    putSecret: async (namespace: string, key: string, value: string) => { values.set(`${namespace}/${key}`, value) },
    getSecret: async (namespace: string, key: string) => { const value = values.get(`${namespace}/${key}`); return value ? { value, status: 'enabled', version: 1 } : null },
  }
  const service = new OrganizationBillingService(db, router, secrets)
  await service.initialize()
  return { sqlite, db, service, router, mock, values }
}
const actor = { userId: 'admin-a', orgId: 'org-a' }

void test('USD/quota remains exact below a cent and CNY rounds once at order creation', () => {
  assert.equal(usdMicrosToQuota(parseUsd('10.02')), 5_010_000)
  assert.equal(payableCnyFen(parseUsd('10.02'), 7_300_000), 7315)
  assert.equal(quotaToUsd(1), '0.000002')
  assert.equal(quotaToUsd(-1), '-0.000002')
  assert.equal(quotaToUsd(6_700_000), '13.40')
  for (const bad of ['-1', '1e2', '01', '1.001', '', 10, '9007199254740991']) assert.throws(() => parseUsd(bad))
})

void test('organization initial gift is counted once, members share funds with independent finite/unlimited Keys', async () => {
  const c = await setup(5_000_000)
  try {
    const account = await c.service.configureOrganization('org-a', 'Example', { initialAmountUsd: '100.00', defaultMemberLimitUsd: '80.00' })
    assert.equal((await c.router.getAccount(account.router_user_id!)).quota, 50_000_000)
    const [a, b] = await Promise.all([c.service.ensureMember('org-a', 'member-a'), c.service.ensureMember('org-a', 'member-b', null)])
    assert.equal(a.router_user_id, b.router_user_id)
    assert.notEqual(a.router_token_id, b.router_token_id)
    assert.equal(c.mock.snapshot().accounts.length, 1)
    assert.equal(c.mock.snapshot().tokens.length, 3)
    const consume = await c.mock.handle(new Request('http://mock/__mock/consume', { method: 'POST', headers: { Authorization: 'Bearer local-router-test', 'New-Api-User': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token_id: a.router_token_id, quota: 25_000_000 }) }))
    assert.equal(consume.status, 200)
    assert.equal((await c.router.getAccount(account.router_user_id!)).quota, 25_000_000)
    assert.equal((await c.router.listTokens(account.router_user_id!, a.router_token_id!))[0]!.remain_quota, 15_000_000)
    await c.service.retryOrganization('org-a', 'Example')
    await c.service.ensureMember('org-a', 'member-a')
    assert.equal((await c.router.getAccount(account.router_user_id!)).quota, 25_000_000, 'retry/login must not top up spent organization funds')
    assert.equal(c.mock.snapshot().tokens.length, 3)
    const dash = await c.service.dashboard({ userId: 'member-a', orgId: 'org-a' })
    assert.equal(dash.can_recharge, false)
    assert.equal(dash.model_balance_usd, undefined)
    assert.equal((dash.member as Record<string, unknown>).remaining_limit_usd, '30.00')
    await assert.rejects(c.service.assertAdmin({ userId: 'member-a', orgId: 'org-a' }, 'org-a', true))
    await assert.rejects(c.service.listMembers({ userId: 'other', orgId: 'org-a' }))
  } finally { await c.db.close() }
})

void test('changing member limit is idempotent, leaves shared funds/usage unchanged, never unfreezes a member', async () => {
  const c = await setup()
  try {
    const account = await c.service.configureOrganization('org-a', 'Example', { initialAmountUsd: '100', defaultMemberLimitUsd: '10' })
    const member = await c.service.ensureMember('org-a', 'member-a')
    await c.service.setMemberStatus(actor, 'member-a', 'disabled', 'freeze-a')
    const first = await c.service.adjustMemberLimit(actor, 'member-a', '5', 'increase', 'limit-a')
    assert.equal(first.admin_status, 'disabled')
    await c.service.adjustMemberLimit(actor, 'member-a', '5', 'increase', 'limit-a')
    const current = (await c.router.listTokens(account.router_user_id!, member.router_token_id!))[0]!
    assert.equal(current.remain_quota, 7_500_000)
    assert.equal(current.used_quota, 0)
    assert.equal((await c.router.getAccount(account.router_user_id!)).quota, 50_000_000)
    assert.equal(await c.service.credential('org-a', 'member-a'), null)
    await assert.rejects(c.service.adjustMemberLimit(actor, 'member-a', '6', 'increase', 'limit-a'), /操作标识/)
    await assert.rejects(c.service.adjustMemberLimit(actor, 'member-a', '16', 'decrease', 'lower-too-far'))
    await c.service.ensureMember('org-a', 'member-b', null)
    await assert.rejects(c.service.adjustMemberLimit(actor, 'member-b', '1', 'increase', 'unlimited-a'))
  } finally { await c.db.close() }
})

void test('lost old quota response never triggers blind replenishment, even if shared balance returns to baseline', async () => {
  let quotaWrites = 0
  const c = await setup(0, fetcher => async (input, init) => {
    const response = await fetcher(input, init)
    if (String(input).endsWith('/api/user/quota')) { quotaWrites++; throw new Error('response lost after remote commit') }
    return response
  })
  try {
    await assert.rejects(c.service.configureOrganization('org-a', 'Example', { initialAmountUsd: '100', defaultMemberLimitUsd: '10' }))
    assert.equal(c.mock.snapshot().accounts[0]!.quota, 50_000_000)
    await c.mock.handle(new Request('http://mock/api/user/quota', { method: 'PUT', headers: { Authorization: 'Bearer local-router-test', 'New-Api-User': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: c.mock.snapshot().accounts[0]!.id, quota: -50_000_000 }) }))
    assert.equal(c.mock.snapshot().accounts[0]!.quota, 0)
    await assert.rejects(c.service.retryOrganization('org-a', 'Example'), /待核对/)
    assert.equal(quotaWrites, 1)
    assert.equal(c.mock.snapshot().tokens.length, 0)
  } finally { await c.db.close() }
})

void test('lost old Key response does not create duplicate Keys; credentials never fall back to service Key', async () => {
  let keyWrites = 0
  const c = await setup(0, fetcher => async (input, init) => {
    const response = await fetcher(input, init)
    if (String(input).endsWith('/api/token/')) { keyWrites++; throw new Error('lost Key response') }
    return response
  })
  try {
    await assert.rejects(c.service.configureOrganization('org-a', 'Example', { initialAmountUsd: '100', defaultMemberLimitUsd: '10' }))
    await assert.rejects(c.service.retryOrganization('org-a', 'Example'), /待核对/)
    assert.equal(keyWrites, 1)
    assert.equal(c.mock.snapshot().tokens.length, 1)
    assert.equal(await c.service.credential('org-a', 'member-a'), null)
  } finally { await c.db.close() }
})

void test('default changes only affect future members and upstream gifts above initial target are preserved', async () => {
  const c = await setup(60_000_000)
  try {
    const account = await c.service.configureOrganization('org-a', 'Example', { initialAmountUsd: '100', defaultMemberLimitUsd: '10' })
    const first = await c.service.ensureMember('org-a', 'member-a')
    await c.service.setDefaults(actor, null)
    const second = await c.service.ensureMember('org-a', 'member-b')
    assert.equal(first.initial_quota, 5_000_000)
    assert.equal(second.initial_quota, null)
    assert.equal((await c.router.getAccount(account.router_user_id!)).quota, 60_000_000)
    assert.equal((await c.db.all("SELECT * FROM organization_model_operations WHERE operation_type = 'initial-quota'" )).length, 1)
  } finally { await c.db.close() }
})

void test('service Key and organization status do not alter member limits; old status replays cannot undo later commands', async () => {
  const c = await setup()
  try {
    const account = await c.service.configureOrganization('org-a', 'Example', { initialAmountUsd: '100', defaultMemberLimitUsd: '10' })
    await c.service.ensureMember('org-a', 'member-a')
    await c.service.manageService(actor, 'service-limit', { amountUsd: '2', direction: 'increase' })
    assert.equal((await c.service.token('org-a', 'member-a'))!.initial_quota, 5_000_000)
    await c.service.setMemberStatus(actor, 'member-a', 'disabled', 'disable-1')
    await c.service.setMemberStatus(actor, 'member-a', 'enabled', 'enable-2')
    await c.service.setMemberStatus(actor, 'member-a', 'disabled', 'disable-1')
    assert.ok(await c.service.credential('org-a', 'member-a'))
    await c.service.setAccountStatus(actor, 'disabled', 'account-off')
    assert.equal(await c.service.credential('org-a', 'member-a'), null)
    await c.service.setAccountStatus(actor, 'enabled', 'account-on')
    await c.service.setAccountStatus(actor, 'disabled', 'account-off')
    assert.ok(await c.service.credential('org-a', 'member-a'))
    assert.equal((await c.router.getAccount(account.router_user_id!)).quota, 50_000_000)
  } finally { await c.db.close() }
})

void test('member logs expose only their token records and filtered totals', async () => {
  const c = await setup()
  try {
    await c.service.configureOrganization('org-a', 'Example', { initialAmountUsd: '100', defaultMemberLimitUsd: null })
    for (const memberId of ['member-a', 'member-b']) {
      const token = await c.service.ensureMember('org-a', memberId)
      await c.mock.handle(new Request('http://mock/__mock/consume', { method: 'POST', headers: { Authorization: 'Bearer local-router-test', 'New-Api-User': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token_id: token.router_token_id, quota: 1_000 }) }))
    }
    const own = await c.service.logs({ userId: 'member-a', orgId: 'org-a' })
    assert.equal(own.total, 1)
    assert.equal((own.items as Array<Record<string, unknown>>)[0]!.token_id, (await c.service.token('org-a', 'member-a'))!.router_token_id)
    assert.equal((await c.service.logs(actor)).total, 2)
    await assert.rejects(c.service.logs({ userId: 'other', orgId: 'org-a' }))
  } finally { await c.db.close() }
})

void test('organization account creation keeps the existing account-name initial password policy', async () => {
  const sent: Array<Record<string, unknown>> = []
  const router = new OrganizationRouterAdapter({
    baseUrl: 'http://mock', apiToken: 'test', adminUserId: '1',
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      sent.push(body)
      return new Response(JSON.stringify({ success: true, data: { id: 1000, username: body.username } }))
    },
  })
  await router.createAccount('test', 'Test')
  await router.createAccount('mo_e30d2e4b5d58cb1c1', 'Organization')
  assert.equal(sent[0]!.password, 'test1111')
  assert.equal(sent[1]!.password, 'mo_e30d2e4b5d58cb1c1')
})
