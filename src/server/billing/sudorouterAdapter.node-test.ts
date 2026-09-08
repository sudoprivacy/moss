import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SudorouterAdapter, pointsToQuota, quotaToPoints } from './sudorouterAdapter.js'

describe('SudorouterAdapter', () => {
  test('保持旧服务 0.002 的积分额度换算', () => {
    assert.equal(pointsToQuota(1_000), 500_000)
    assert.equal(quotaToPoints(500_000), 1_000)
  })

  test('按旧协议查询用户并更新额度，同时发送稳定幂等键', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const adapter = new SudorouterAdapter({
      baseUrl: 'https://router.example.test/',
      apiToken: 'secret',
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        return new Response(JSON.stringify(requests.length === 1
          ? { success: true, data: { id: 9, quota: 1000, used_quota: 20 } }
          : { success: true, data: true }), { status: 200 })
      },
    })

    assert.deepEqual(await adapter.getUser('9'), { externalUserId: '9', quotaUnits: 1000, usedQuotaUnits: 20 })
    assert.deepEqual(await adapter.changeQuota({
      externalUserId: '9', deltaUnits: 500, comment: 'test', idempotencyKey: 'quota-op-1',
    }), { success: true })
    assert.equal(requests[0]?.url, 'https://router.example.test/api/user/9')
    assert.equal(requests[1]?.url, 'https://router.example.test/api/user/quota')
    assert.equal(requests[1]?.init?.method, 'PUT')
    assert.equal(new Headers(requests[1]?.init?.headers).get('Idempotency-Key'), 'quota-op-1')
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), { id: 9, quota: 500, comment: 'test' })
  })
})
