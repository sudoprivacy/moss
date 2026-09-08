import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Hono } from 'hono'
import type { IdentityActor } from '../../../identity/organizationIdentityService.js'
import { registerSudoworkLegacyUsageRoutes, type SudoworkLegacyUsagePort } from './legacyUsageRoutes.js'

const user: IdentityActor = { userId: 'user-1', orgId: 'org-1', role: 'user' }
const admin: IdentityActor = { userId: 'admin-1', orgId: 'org-1', role: 'admin' }

function createApp(overrides: Partial<SudoworkLegacyUsagePort> = {}) {
  const calls: Array<{ name: string; input?: unknown }> = []
  const usage: SudoworkLegacyUsagePort = {
    listModels() { calls.push({ name: 'listModels' }); return [{ label: '模型一', value: 'model-1' }] },
    reportUsage(input) {
      calls.push({ name: 'reportUsage', input })
      return { success: true, deducted: 1, newBalance: 9 }
    },
    getDashboard(actor) { calls.push({ name: 'getDashboard', input: actor }); return { points: {} } },
    listLedger(input) { calls.push({ name: 'listLedger', input }); return { data: [{ id: 1 }], total: 1 } },
    getStats(actor) { calls.push({ name: 'getStats', input: actor }); return { points: {} } },
    getModelUsageStats(input) { calls.push({ name: 'getModelUsageStats', input }); return [{ model: 'model-1' }] },
    listAdminUserLedger(input) { calls.push({ name: 'listAdminUserLedger', input }); return [{ id: 2 }] },
    ...overrides,
  }
  const app = new Hono()
  registerSudoworkLegacyUsageRoutes(app, {
    usage,
    getActor: authorization => authorization === 'Bearer user' ? user : authorization === 'Bearer admin' ? admin : null,
    getAdminActor: authorization => authorization === 'Bearer admin' ? admin : null,
  })
  return { app, calls }
}

describe('Sudowork legacy usage routes', () => {
  test('保留模型列表和用量上报响应结构并传递幂等键', async () => {
    const { app, calls } = createApp()
    const models = await app.request('/api/v1/router/models')
    assert.equal(models.status, 200)
    assert.deepEqual(await models.json(), { success: true, data: [{ label: '模型一', value: 'model-1' }] })

    const report = await app.request('/api/v1/usage/report', {
      method: 'POST',
      headers: { authorization: 'Bearer user', 'content-type': 'application/json', 'idempotency-key': 'usage-1' },
      body: JSON.stringify({ inputTokens: 500, outputTokens: 500, model: 'model-1' }),
    })
    assert.equal(report.status, 200)
    assert.deepEqual(await report.json(), { success: true, deducted: 1, newBalance: 9 })
    assert.equal((calls.find(call => call.name === 'reportUsage')?.input as any).idempotencyKey, 'usage-1')
  })

  test('用户和管理员接口分别执行旧鉴权边界', async () => {
    const { app, calls } = createApp()
    assert.equal((await app.request('/api/v1/user/dashboard')).status, 401)
    assert.equal((await app.request('/api/v1/admin/users/17/ledger', {
      headers: { authorization: 'Bearer user' },
    })).status, 401)
    const response = await app.request('/api/v1/admin/users/17/ledger?limit=5', {
      headers: { authorization: 'Bearer admin' },
    })
    assert.deepEqual(await response.json(), { success: true, data: [{ id: 2 }] })

    const headers = { authorization: 'Bearer user' }
    const dashboard = await app.request('/api/v1/user/dashboard', { headers })
    assert.deepEqual(await dashboard.json(), { success: true, data: { points: {} } })
    const ledger = await app.request('/api/v1/user/ledger?time_from=10&time_to=20', { headers })
    assert.deepEqual(await ledger.json(), { success: true, data: [{ id: 1 }], total: 1 })
    const stats = await app.request('/api/v1/user/stats', { headers })
    assert.deepEqual(await stats.json(), { success: true, data: { points: {} } })
    const modelStats = await app.request(
      '/api/v1/user/model-usage-stats?start_date=2026-09-01&end_date=2026-09-07',
      { headers },
    )
    assert.deepEqual(await modelStats.json(), { success: true, data: [{ model: 'model-1' }] })
    assert.deepEqual(
      calls.filter(call => ['getDashboard', 'listLedger', 'getStats', 'getModelUsageStats'].includes(call.name)).map(call => call.name),
      ['getDashboard', 'listLedger', 'getStats', 'getModelUsageStats'],
    )
  })

  test('模型用量统计保持旧日期校验文案且不调用服务', async () => {
    const { app, calls } = createApp()
    const headers = { authorization: 'Bearer user' }
    const missing = await app.request('/api/v1/user/model-usage-stats', { headers })
    assert.equal(missing.status, 400)
    assert.deepEqual(await missing.json(), { success: false, msg: '缺少日期参数' })

    const invalid = await app.request('/api/v1/user/model-usage-stats?start_date=x&end_date=2026-09-07', { headers })
    assert.equal(invalid.status, 400)
    assert.deepEqual(await invalid.json(), { success: false, msg: '日期格式无效' })

    const reversed = await app.request('/api/v1/user/model-usage-stats?start_date=2026-09-08&end_date=2026-09-07', { headers })
    assert.equal(reversed.status, 400)
    assert.deepEqual(await reversed.json(), { success: false, msg: '开始日期不能晚于结束日期' })

    const tooLong = await app.request('/api/v1/user/model-usage-stats?start_date=2026-07-01&end_date=2026-09-07', { headers })
    assert.equal(tooLong.status, 400)
    assert.deepEqual(await tooLong.json(), { success: false, msg: '时间范围不能超过30天' })
    assert.equal(calls.some(call => call.name === 'getModelUsageStats'), false)
  })
})
