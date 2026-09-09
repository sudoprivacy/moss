import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SudorouterAdapter, pointsToQuota, quotaToPoints } from './sudorouterAdapter.js'

describe('SudorouterAdapter', () => {
  test('按旧协议分页读取用户模型用量', async () => {
    let requestUrl = ''
    const adapter = new SudorouterAdapter({
      baseUrl: 'https://router.example.test', apiToken: 'admin-token', adminUserId: '76',
      fetch: async url => {
        requestUrl = String(url)
        return new Response(JSON.stringify({
          success: true,
          data: {
            count: 1,
            data: [{
              id: 8, user_id: 9, created_at: 1_700_000_000, type: 2,
              model_name: 'model-a', cost: 500, prompt_tokens: 30, completion_tokens: 20,
            }],
          },
        }))
      },
    })

    assert.deepEqual(await adapter.listUsageLogs({
      externalUserId: '9', fromSeconds: 10, toSeconds: 20, page: 2, pageSize: 100,
    }), {
      total: 1,
      list: [{
        id: '8', createdAtSeconds: 1_700_000_000, type: '2', model: 'model-a',
        costQuotaUnits: 500, inputTokens: 30, outputTokens: 20,
      }],
    })
    assert.equal(
      requestUrl,
      'https://router.example.test/api/log/query?user_id=9&time_from=10&time_to=20&page_num=2&page_size=100&order_by=created_at&desc=true',
    )
  })

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

  test('按旧协议精确查找、创建用户并创建无限额度 Token', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const responses = [
      { success: true, data: { items: [
        { id: 8, username: 'user-17-other', quota: 1, used_quota: 0, status: 1 },
        { id: 9, username: 'user-17', quota: 100, used_quota: 2, status: 1 },
      ] } },
      { success: true, data: { id: 10, username: 'short', quota: 0, used_quota: 0 } },
      { success: true, data: { key: 'sk-user-token' } },
    ]
    const adapter = new SudorouterAdapter({
      baseUrl: 'https://router.example.test/', apiToken: 'admin-token', adminUserId: '76',
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        return new Response(JSON.stringify(responses.shift()), { status: 200 })
      },
    })

    assert.deepEqual(await adapter.findUserByUsername('user-17'), {
      externalUserId: '9', username: 'user-17', quotaUnits: 100, usedQuotaUnits: 2,
    })
    assert.deepEqual(await adapter.createUser({
      username: 'short', displayName: '新用户', idempotencyKey: 'create-user-10',
    }), {
      externalUserId: '10', username: 'short', quotaUnits: 0, usedQuotaUnits: 0,
    })
    assert.equal(await adapter.createToken({
      externalUserId: '10', name: 'short-token', idempotencyKey: 'create-token-10',
    }), 'sk-user-token')

    assert.equal(requests[0]?.url, 'https://router.example.test/api/user/search?keyword=user-17&page=1&page_size=100')
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
      username: 'short', password: 'short111', display_name: '新用户', role: 1, utm_source: 'sudowork',
    })
    assert.equal(new Headers(requests[1]?.init?.headers).get('Idempotency-Key'), 'create-user-10')
    assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), {
      name: 'short-token', expired_time: -1, unlimited_quota: true, user_id: 10,
    })
    assert.equal(new Headers(requests[2]?.init?.headers).get('Idempotency-Key'), 'create-token-10')
    for (const request of requests) {
      assert.equal(new Headers(request.init?.headers).get('Authorization'), 'Bearer admin-token')
      assert.equal(new Headers(request.init?.headers).get('New-Api-User'), '76')
    }
  })

  test('查找只接受可用的精确用户名且 Provider 错误明确失败', async () => {
    const fuzzy = new SudorouterAdapter({
      baseUrl: 'https://router.example.test', apiToken: 'secret',
      fetch: async () => new Response(JSON.stringify({
        success: true, data: { items: [{ id: 8, username: 'target-other', status: 1 }] },
      })),
    })
    assert.equal(await fuzzy.findUserByUsername('target'), null)

    const failed = new SudorouterAdapter({
      baseUrl: 'https://router.example.test', apiToken: 'secret',
      fetch: async () => new Response(JSON.stringify({ success: false, message: 'provider rejected' }), { status: 502 }),
    })
    await assert.rejects(failed.findUserByUsername('target'), /provider rejected/)
    await assert.rejects(failed.createUser({
      username: 'target', displayName: 'Target', idempotencyKey: 'create-target',
    }), /provider rejected/)
    await assert.rejects(failed.createToken({
      externalUserId: '8', name: 'target-token', idempotencyKey: 'token-target',
    }), /provider rejected/)
  })
})
