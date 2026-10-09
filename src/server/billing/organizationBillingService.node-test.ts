import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { SqliteDriver } from '../db/driver.js'
import { parseUsd, usdMicrosToQuota, quotaToUsd, payableCnyFen } from './modelMoney.js'
import { OrganizationRouterAdapter, type RouterFetch } from './organizationRouterAdapter.js'
import { OrganizationBillingService } from './organizationBillingService.js'
import { dispatchOrganizationBilling } from './organizationBillingRoutes.js'
import { RouterMock } from './testing/routerMock.js'

async function setup(registrationQuota = 0, transform?: (fetcher: RouterFetch) => RouterFetch, isRechargeEnabled = () => false) {
  const sqlite = new DatabaseSync(':memory:')
  const db = new SqliteDriver(sqlite)
  await db.exec(`CREATE TABLE organizations (id TEXT PRIMARY KEY); CREATE TABLE users (id TEXT PRIMARY KEY, org_id TEXT, role TEXT, status TEXT, name TEXT, display_name TEXT);
    INSERT INTO organizations VALUES ('org-a'), ('org-b');
    INSERT INTO users(id, org_id, role, status) VALUES ('admin-a', 'org-a', 'admin', 'active'), ('member-a', 'org-a', 'user', 'active'), ('member-b', 'org-a', 'user', 'active'), ('other', 'org-b', 'admin', 'active');`)
  const mock = new RouterMock({ adminToken: 'local-router-test', registrationQuota })
  const router = new OrganizationRouterAdapter({ baseUrl: 'http://mock', apiToken: 'local-router-test', adminUserId: '1', fetch: transform ? transform(mock.fetch) : mock.fetch })
  const values = new Map<string, string>()
  const secrets = {
    putSecret: async (namespace: string, key: string, value: string) => { values.set(`${namespace}/${key}`, value) },
    getSecret: async (namespace: string, key: string) => { const value = values.get(`${namespace}/${key}`); return value ? { value, status: 'enabled', version: 1 } : null },
  }
  const service = new OrganizationBillingService(db, router, secrets, { isRechargeEnabled })
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
  const queries: URL[] = []
  const c = await setup(0, fetcher => async (input, init) => {
    if (new URL(String(input)).pathname === '/api/log/query') queries.push(new URL(String(input)))
    return fetcher(input, init)
  })
  try {
    await c.service.configureOrganization('org-a', 'Example', { initialAmountUsd: '100', defaultMemberLimitUsd: null })
    for (const memberId of ['member-a', 'member-b']) {
      const token = await c.service.ensureMember('org-a', memberId)
      await c.mock.handle(new Request('http://mock/__mock/consume', { method: 'POST', headers: { Authorization: 'Bearer local-router-test', 'New-Api-User': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token_id: token.router_token_id, quota: 1_000 }) }))
    }
    const own = await c.service.logs({ userId: 'member-a', orgId: 'org-a' })
    assert.equal(own.total, 1)
    assert.equal((own.items as Array<Record<string, unknown>>)[0]!.token_id, (await c.service.token('org-a', 'member-a'))!.router_token_id)
    assert.equal(queries[0]!.searchParams.get('api_key_name'), c.mock.snapshot().tokens.find(token => token.id === (own.items as Array<Record<string, unknown>>)[0]!.token_id)!.name)
    assert.equal(queries[0]!.searchParams.get('type'), 'consumption')
    assert.equal((await c.service.logs(actor)).total, 0, 'admin without own Key sees no member logs')
    const firstPage = await c.service.memberUsage(actor, 'member-a', 1, 1)
    assert.equal(firstPage.total, 1)
    assert.ok(queries[1]!.searchParams.get('api_key_name'))
    await assert.rejects(c.service.memberUsage(actor, 'other'), { statusCode: 404 })
    await assert.rejects(c.service.memberUsage({ userId: 'member-a', orgId: 'org-a' }, 'member-b'), { statusCode: 403 })
    assert.equal((firstPage.items as unknown[]).length, 1)
    const beyond = await c.service.logs({ userId: 'member-a', orgId: 'org-a' }, 2, 1)
    assert.equal(beyond.total, 1)
    assert.deepEqual(beyond.items, [])
    assert.equal(queries.at(-1)!.searchParams.get('page_num'), '2')
    assert.equal(queries.at(-1)!.searchParams.get('page_size'), '1')
    await assert.rejects(c.service.logs({ userId: 'other', orgId: 'org-a' }))
  } finally { await c.db.close() }
})

void test('query log response maps cost as quota and rejects mismatched Key names or non-consumption rows', async () => {
  const token = { id: 282, user_id: 9882, name: 'member-own', status: 1, remain_quota: 1000000, unlimited_quota: false, expired_time: -1 }
  const row = { created_at: 1791444132, type: 'consumption', api_key_name: 'member-own', model_name: 'gpt-4o-mini',
    prompt_tokens: 11, completion_tokens: 2, cost: 1, detail: 'must not reach UI', other: { request_id: 'request-1', sensitive: 'hidden' } }
  let responseRow = row
  let duplicates = false
  let logCalls = 0
  const router = new OrganizationRouterAdapter({ baseUrl: 'http://router', apiToken: 'admin', adminUserId: '76',
    fetch: async input => {
      const url = new URL(String(input))
      if (url.pathname === '/api/user/tokens') return Response.json({ success: true, data: { count: duplicates ? 2 : 1, data: duplicates ? [token, { ...token, id: 283 }] : [token] } })
      if (url.pathname === '/api/user/9882') return Response.json({ success: true, data: { id: 9882, username: 'org', status: 1, quota: 5000000, used_quota: 0 } })
      assert.equal(url.pathname, '/api/log/query')
      assert.deepEqual(Object.fromEntries(url.searchParams), { user_id: '9882', type: 'consumption', page_num: '1', page_size: '20', order_by: 'created_at', desc: 'true', api_key_name: 'member-own' })
      logCalls++
      return Response.json({ success: true, data: { count: 1, data: [responseRow] } })
    },
  })
  const result = await router.listLogs(9882, 1, 20, 282)
  assert.equal(result.total, 1)
  assert.equal(result.items[0]!.token_id, 282)
  assert.equal(quotaToUsd(result.items[0]!.quota), '0.000002')
  assert.equal(result.items[0]!.request_id, 'request-1')
  assert.equal('detail' in result.items[0]!, false)
  assert.equal('other' in result.items[0]!, false)
  responseRow = { ...row, api_key_name: 'member-other' }
  await assert.rejects(router.listLogs(9882, 1, 20, 282), /scope/)
  responseRow = { ...row, type: 'login' }
  await assert.rejects(router.listLogs(9882, 1, 20, 282), /scope/)
  const previousCalls = logCalls
  duplicates = true
  await assert.rejects(router.listLogs(9882, 1, 20, 282), /ambiguous/)
  await assert.rejects(router.listLogs(9882, 1, 20, 9999), /ambiguous/)
  assert.equal(logCalls, previousCalls, 'missing or ambiguous names must not fall back to all organization logs')
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

void test('documented Token API uses user_id/id, enable, PUT deltas and validates scope before writes', async () => {
  const calls: Array<{ path: string; method: string; body: Record<string, unknown> | undefined }> = []
  const token = { id: 278, user_id: 9880, status: 1, name: 'member', remain_quota: 2500000,
    unlimited_quota: false, expired_time: -1, used_quota: 0, key: 'never-expose-this-full-key' }
  const router = new OrganizationRouterAdapter({ baseUrl: 'http://router', apiToken: 'admin', adminUserId: '76',
    fetch: async (input, init) => {
      const url = new URL(String(input))
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ path: url.pathname + url.search, method: init?.method ?? 'GET', body })
      assert.equal(new Headers(init?.headers).get('New-Api-User'), '76')
      if (url.pathname === '/api/user/tokens') return Response.json({ success: true, data: { count: 1, data: [token] } })
      if (url.pathname === '/api/user/9880') return Response.json({ success: true, data: { id: 9880, username: 'org', quota: 5000000, used_quota: 0, status: 1 } })
      return Response.json({ success: true, data: { ...token, status: body?.status === 'disabled' ? 2 : 1 } })
    },
  })
  const list = await router.listTokens(9880, 278)
  assert.equal(list[0]!.key_masked, 'neve****-key')
  assert.equal(JSON.stringify(list).includes(token.key), false)
  await router.setTokenStatus(9880, 278, 'enabled', 'enable-once')
  await router.adjustTokenQuota(9880, 278, 500000, 'limit-once')
  assert.equal(calls[0]!.path, '/api/user/tokens?user_id=9880&id=278')
  const writes = calls.filter(call => call.method === 'PUT')
  assert.deepEqual(writes.map(call => [call.path, call.body]), [
    ['/api/user/token/status', { id: 278, status: 'enable', comment: 'Moss member status enable-once' }],
    ['/api/user/token/quota', { id: 278, delta_quota: 500000, unlimited_quota: false, comment: 'Moss member limit limit-once' }],
  ])
  await assert.rejects(router.setTokenStatus(9999, 278, 'disabled', 'wrong-org'), /scope/)
  await assert.rejects(router.adjustTokenQuota(9880, 279, 1, 'wrong-token'), /scope/)
  assert.equal(calls.filter(call => call.method === 'PUT').length, 2)
})

void test('lost Token quota responses never replay non-idempotent member or service deltas', async () => {
  let writes = 0
  const c = await setup(0, fetcher => async (input, init) => {
    const response = await fetcher(input, init)
    if (String(input).endsWith('/api/user/token/quota') && init?.method === 'PUT') {
      writes++
      throw new Error('remote write succeeded but response was lost')
    }
    return response
  })
  try {
    const account = await c.service.configureOrganization('org-a', 'Example', { initialAmountUsd: '10', defaultMemberLimitUsd: '2' })
    const member = await c.service.ensureMember('org-a', 'member-a')
    await assert.rejects(c.service.adjustMemberLimit(actor, 'member-a', '1', 'increase', 'lost-member'))
    await assert.rejects(c.service.adjustMemberLimit(actor, 'member-a', '1', 'increase', 'lost-member'), /待核对/)
    await assert.rejects(c.service.adjustMemberLimit(actor, 'member-a', '1', 'increase', 'new-reference'), /待核对/)
    assert.equal((await c.router.listTokens(account.router_user_id!, member.router_token_id!))[0]!.remain_quota, 1500000)
    await assert.rejects(c.service.manageService(actor, 'lost-service', { amountUsd: '1', direction: 'increase' }))
    await assert.rejects(c.service.manageService(actor, 'lost-service', { amountUsd: '1', direction: 'increase' }), /待核对/)
    await assert.rejects(c.service.manageService(actor, 'new-service-reference', { amountUsd: '1', direction: 'increase' }), /待核对/)
    assert.equal(writes, 2)
    assert.equal((await c.router.getAccount(account.router_user_id!)).quota, 5000000)
  } finally { await c.db.close() }
})

void test('Token list rejects incomplete or duplicate results instead of hiding members', async () => {
  const token = { id: 278, user_id: 9880, status: 1, remain_quota: 2500000, unlimited_quota: false, expired_time: -1 }
  for (const data of [{ count: 2, data: [token] }, { count: 2, data: [token, token] }]) {
    const router = new OrganizationRouterAdapter({ baseUrl: 'http://router', apiToken: 'test', adminUserId: '76',
      fetch: async () => Response.json({ success: true, data }),
    })
    await assert.rejects(router.listTokens(9880))
  }
})

void test('limit mode preserves identity, spent usage and disabled status; switching back sets a fresh remaining budget', async () => {
  const c = await setup()
  try {
    const account = await c.service.configureOrganization('org-a', 'Example', { initialAmountUsd: '10', defaultMemberLimitUsd: '2' })
    const binding = await c.service.ensureMember('org-a', 'member-a')
    await c.mock.handle(new Request('http://mock/__mock/consume', { method: 'POST', headers: { Authorization: 'Bearer local-router-test', 'New-Api-User': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token_id: binding.router_token_id, quota: 1000 }) }))
    await c.service.setMemberStatus(actor, 'member-a', 'disabled', 'mode-disable')
    const balance = (await c.router.getAccount(account.router_user_id!)).quota
    const unlimited = await c.service.setMemberLimitMode(actor, 'member-a', null, 'mode-unlimited')
    assert.equal(unlimited.unlimited_quota, true)
    const finite = await c.service.setMemberLimitMode(actor, 'member-a', '5', 'mode-finite')
    assert.equal(finite.remain_quota, 2500000)
    assert.equal(finite.id, binding.router_token_id)
    assert.equal(finite.used_quota, 1000)
    assert.equal(finite.admin_status, 'disabled')
    await c.service.setMemberLimitMode(actor, 'member-a', null, 'mode-unlimited')
    assert.equal((await c.router.listTokens(account.router_user_id!, binding.router_token_id!))[0]!.unlimited_quota, false, 'replaying an old command cannot undo a later switch')
    await c.service.setMemberLimitMode(actor, 'member-a', null, 'mode-unlimited-again')
    const zero = await c.service.setMemberLimitMode(actor, 'member-a', '0', 'mode-zero')
    assert.equal(zero.remain_quota, 0)
    assert.equal((await c.router.getAccount(account.router_user_id!)).quota, balance)
  } finally { await c.db.close() }
})

void test('unknown mode changes block both another mode change and quota increments', async () => {
  let writes = 0
  const c = await setup(0, fetcher => async (input, init) => {
    const result = await fetcher(input, init)
    if (String(input).endsWith('/api/user/token/quota')) { writes++; throw new Error('lost response') }
    return result
  })
  try {
    await c.service.configureOrganization('org-a', 'Example', { initialAmountUsd: '10', defaultMemberLimitUsd: '2' })
    await c.service.ensureMember('org-a', 'member-a')
    await assert.rejects(c.service.setMemberLimitMode(actor, 'member-a', null, 'unknown-mode'))
    await assert.rejects(c.service.setMemberLimitMode(actor, 'member-a', '5', 'next-mode'), /待核对/)
    await assert.rejects(c.service.adjustMemberLimit(actor, 'member-a', '5', 'increase', 'next-delta'), /待核对/)
    assert.equal(writes, 1)
  } finally { await c.db.close() }
})

void test('mode reset plus new budget preserves negative history; a partial switch cannot replay', async () => {
  let rejectBudget = false
  let writes = 0
  const c = await setup(0, fetcher => async (input, init) => {
    if (String(input).endsWith('/api/user/token/quota')) {
      writes++
      const body = JSON.parse(String(init?.body))
      if (rejectBudget && body.delta_quota > 0) return Response.json({ success: false, message: 'explicit rejection' }, { status: 400 })
      const response = await fetcher(input, init)
      return response
    }
    return fetcher(input, init)
  })
  try {
    const account = await c.service.configureOrganization('org-a', 'Example', { initialAmountUsd: '10', defaultMemberLimitUsd: null })
    const member = await c.service.ensureMember('org-a', 'member-a')
    const rawConsume = () => c.mock.handle(new Request('http://mock/__mock/consume', { method: 'POST', headers: { Authorization: 'Bearer local-router-test', 'New-Api-User': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token_id: member.router_token_id, quota: 1000 }) }))
    await rawConsume()
    assert.equal((await c.router.listTokens(account.router_user_id!, member.router_token_id!))[0]!.remain_quota, -1000)
    let finite = await c.service.setMemberLimitMode(actor, 'member-a', '5', 'negative-to-finite')
    assert.equal(finite.remain_quota, 2500000); assert.equal(finite.used_quota, 1000)
    await c.service.setMemberLimitMode(actor, 'member-a', null, 'positive-to-unlimited')
    finite = await c.service.setMemberLimitMode(actor, 'member-a', '5', 'same-remaining-to-finite')
    assert.equal(finite.remain_quota, 2500000, 'same amount must not be doubled')
    await c.service.setMemberLimitMode(actor, 'member-a', null, 'before-partial')
    rejectBudget = true
    await assert.rejects(c.service.setMemberLimitMode(actor, 'member-a', '5', 'partial-switch'))
    const previousWrites = writes
    await assert.rejects(c.service.setMemberLimitMode(actor, 'member-a', '5', 'partial-switch'), /待核对/)
    await assert.rejects(c.service.adjustMemberLimit(actor, 'member-a', '5', 'increase', 'after-partial'), /待核对/)
    assert.equal(writes, previousWrites)
    assert.equal((await c.router.listTokens(account.router_user_id!, member.router_token_id!))[0]!.remain_quota, 0)
  } finally { await c.db.close() }
})

void test('payment access is local, authorized and independent of Router availability', async () => {
  let isOffline = false; let requests = 0; let isEnabled = true
  const c = await setup(0, fetcher => async (input, init) => {
    if (isOffline) { requests++; throw new Error('upstream unavailable') }
    return fetcher(input, init)
  }, () => isEnabled)
  try {
    await c.service.configureOrganization('org-a', 'Example', { initialAmountUsd: '0', defaultMemberLimitUsd: null })
    isOffline = true
    const access = await dispatchOrganizationBilling(c.service, actor, 'GET', new URL('http://test/api/v1/model-account/access'), {})
    assert.equal(access.status, 200)
    assert.equal((access.body as { data: { can_recharge: boolean } }).data.can_recharge, true)
    assert.equal(requests, 0, 'access must not initiate any Router requests, including slow ones')
    assert.equal((await c.service.access({ ...actor, userId: 'member-a' })).can_recharge, false)
    await c.db.run("INSERT INTO users(id, role, status) VALUES ('root', 'super_admin', 'active')")
    assert.equal((await c.service.access({ ...actor, userId: 'root' })).can_recharge, false)
    for (const userId of ['other', 'missing']) {
      const result = await dispatchOrganizationBilling(c.service, { ...actor, userId }, 'GET', new URL('http://test/api/v1/model-account/access'), {})
      assert.equal(result.status, 403)
    }
    isEnabled = false
    assert.equal((await c.service.access(actor)).can_recharge, false)
    await c.db.run("UPDATE users SET status = 'disabled' WHERE id = 'admin-a'")
    await assert.rejects(c.service.access(actor), /无权/)
    assert.equal(requests, 0)
  } finally { await c.db.close() }
})

void test('dashboard degrades independently without fabricated balances or cross-member data and recovers', async () => {
  let failure: 'none' | 'tokens' | 'account' | 'both' = 'none'
  const c = await setup(0, fetcher => async (input, init) => {
    const path = new URL(String(input)).pathname
    if ((failure === 'tokens' || failure === 'both') && path === '/api/user/tokens' || (failure === 'account' || failure === 'both') && /^\/api\/user\/\d+$/.test(path)) {
      return new Response(JSON.stringify({ success: false, message: 'private upstream detail' }))
    }
    return fetcher(input, init)
  }, () => true)
  try {
    await c.service.configureOrganization('org-a', 'Example', { initialAmountUsd: '10', defaultMemberLimitUsd: '5' })
    await c.service.ensureMember('org-a', 'admin-a')
    failure = 'tokens'
    const partial = await c.service.dashboard(actor)
    assert.equal(partial.can_recharge, true)
    assert.equal(partial.balance_status, 'available')
    assert.equal(partial.model_balance_usd, '10.00')
    assert.equal(partial.member_usage_status, 'unavailable')
    assert.equal(partial.member, null)
    assert.equal(JSON.stringify(partial).includes('private upstream detail'), false)
    failure = 'account'
    const withoutBalance = await c.service.dashboard(actor)
    assert.equal(withoutBalance.balance_status, 'unavailable')
    assert.equal('model_balance_usd' in withoutBalance, false)
    assert.equal('used_amount_usd' in withoutBalance, false)
    assert.equal(withoutBalance.member_usage_status, 'unavailable', 'Token effective status also requires the parent account status')
    failure = 'both'
    const unavailable = await c.service.dashboard(actor)
    assert.equal(unavailable.member, null)
    assert.equal(unavailable.balance_status, 'unavailable')
    failure = 'none'
    assert.equal((await c.service.dashboard(actor)).member_usage_status, 'available')
    const pending = await c.service.dashboard({ ...actor, userId: 'member-a' })
    assert.equal(pending.balance_status, 'not_applicable')
    assert.equal(pending.member_usage_status, 'pending')
    assert.equal('model_balance_usd' in pending, false)
  } finally { await c.db.close() }
})
