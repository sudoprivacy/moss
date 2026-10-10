import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RouterMock } from './testing/routerMock.js'

void test('hybrid discovery forwards only a known member Key and keeps inference blocked', async () => {
  const calls: Array<{ url: string; authorization: string | null }> = []
  const state = new RouterMock({ adminToken: 'local-admin' }).snapshot()
  state.accounts.push({ id: 1001, username: 'test-org', quota: 500000, used_quota: 0, status: 1 })
  state.tokens.push({ id: 2001, user_id: 1001, name: 'member', key: 'sk-member-test', admin_status: 'enabled',
    effective_status: 'active', unlimited_quota: false, remain_quota: 500000, used_quota: 0, expired_time: -1 })
  const mock = new RouterMock({ adminToken: 'local-admin', state,
    upstream: { baseUrl: 'http://upstream.test', apiToken: 'upstream-admin', adminUserId: '76' },
    fetch: async (url, init) => {
      calls.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') })
      return Response.json({ data: [{ id: 'test-chat-model', object: 'model' }] })
    },
  })
  const catalog = await mock.handle(new Request('http://mock/v1/models', { headers: { Authorization: 'Bearer sk-member-test' } }))
  assert.equal(catalog.status, 200)
  assert.deepEqual(await catalog.json(), { data: [{ id: 'test-chat-model', object: 'model' }] })
  assert.deepEqual(calls, [{ url: 'http://upstream.test/v1/models', authorization: 'Bearer sk-member-test' }])
  const unknown = await mock.handle(new Request('http://mock/v1/models', { headers: { Authorization: 'Bearer unknown-key' } }))
  assert.equal(unknown.status, 401)
  for (const route of ['/v1/chat/completions', '/v1/responses', '/v1/models']) {
    const response = await mock.handle(new Request(`http://mock${route}`, { method: 'POST', headers: { Authorization: 'Bearer sk-member-test' }, body: '{}' }))
    assert.equal(response.status, 409)
  }
  assert.equal(calls.length, 1, 'neither unknown Keys nor inference requests reach the upstream')
  const failing = new RouterMock({ adminToken: 'local-admin', state,
    upstream: { baseUrl: 'http://upstream.test', apiToken: 'upstream-admin', adminUserId: '76' },
    fetch: async () => Response.json({ error: 'upstream unavailable' }, { status: 503 }),
  })
  const unavailable = await failing.handle(new Request('http://mock/v1/models', { headers: { Authorization: 'Bearer sk-member-test' } }))
  assert.equal(unavailable.status, 503, 'a failed real catalog must not fall back to simulated models')
})
