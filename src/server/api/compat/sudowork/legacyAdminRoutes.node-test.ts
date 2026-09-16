import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Hono } from 'hono'
import type { IdentityActor } from '../../../identity/organizationIdentityService.js'
import { registerSudoworkLegacyAdminRoutes, type SudoworkLegacyAdminPort } from './legacyAdminRoutes.js'

const admin: IdentityActor = { userId: 'admin-1', orgId: 'org-1', role: 'admin' }

function setup() {
  const calls: Array<{ name: string; input?: unknown }> = []
  const administration: SudoworkLegacyAdminPort = {
    getFeatureFlags(actor) { calls.push({ name: 'features', input: actor }); return { dify: { enabled: true, missingEnv: [] } } },
    listOperationLogs(input) { calls.push({ name: 'logs', input }); return { items: [{ id: 1 }], total: 1, page: 2, page_size: 5 } },
    listMembers(actor) { calls.push({ name: 'members', input: actor }); return [{ id: 7 }] },
    getAdminStats(actor) { calls.push({ name: 'stats', input: actor }); return { users: 1 } },
    approveUser(input) { calls.push({ name: 'approve', input }) },
    rejectUser(input) { calls.push({ name: 'reject', input }) },
    deletePendingUser(input) { calls.push({ name: 'delete', input }) },
  }
  const billing = {
    syncUserQuota(input: unknown) { calls.push({ name: 'sync', input }); return { id: 7, quota: 10 } },
  } as any
  const app = new Hono()
  registerSudoworkLegacyAdminRoutes(app, {
    administration,
    billing,
    getAdminActor: authorization => authorization === 'Bearer admin' ? admin : null,
  })
  return { app, calls }
}

describe('Sudowork legacy admin routes', () => {
  test('四个查询接口保持旧 envelope、分页参数与管理员鉴权', async () => {
    const { app, calls } = setup()
    assert.equal((await app.request('/api/v1/admin/features')).status, 401)
    const headers = { authorization: 'Bearer admin' }
    assert.deepEqual(await (await app.request('/api/v1/admin/features', { headers })).json(), {
      success: true, data: { dify: { enabled: true, missingEnv: [] } },
    })
    assert.deepEqual(await (await app.request('/api/v1/admin/members', { headers })).json(), {
      success: true, data: [{ id: 7 }],
    })
    assert.deepEqual(await (await app.request('/api/v1/admin/stats', { headers })).json(), {
      success: true, data: { users: 1 },
    })
    assert.deepEqual(await (await app.request(
      '/api/v1/admin/logs?user_id=7&action=LOGIN&page=2&page_size=5', { headers },
    )).json(), {
      success: true, data: { items: [{ id: 1 }], total: 1, page: 2, page_size: 5 },
    })
    const logInput = calls.find(call => call.name === 'logs')?.input as any
    assert.equal(logInput.query.user_id, '7')
    assert.equal(logInput.query.page, '2')
  })

  test('审批、拒绝、删除保留旧文案并传递数字 ID 与幂等键', async () => {
    const { app, calls } = setup()
    const headers = {
      authorization: 'Bearer admin',
      'content-type': 'application/json',
      'idempotency-key': 'request-1',
    }
    for (const [path, callName, message] of [
      ['/api/v1/admin/approve', 'approve', '审批成功'],
      ['/api/v1/admin/reject', 'reject', '已拒绝申请'],
      ['/api/v1/admin/delete', 'delete', '用户已删除'],
    ] as const) {
      const response = await app.request(path, { method: 'POST', headers, body: JSON.stringify({ userId: 7 }) })
      assert.deepEqual(await response.json(), { success: true, msg: message })
      const input = calls.find(call => call.name === callName)?.input as any
      assert.equal(input.legacyUserId, 7)
      assert.equal(input.idempotencyKey, 'request-1')
    }
  })

  test('手动同步额度复用统一 Billing 服务并保持旧响应', async () => {
    const { app, calls } = setup()
    const response = await app.request('/api/v1/admin/members/7/sync-quota', {
      method: 'POST',
      headers: { authorization: 'Bearer admin', 'idempotency-key': 'sync-7' },
    })
    assert.deepEqual(await response.json(), {
      success: true, msg: '额度同步成功', data: { id: 7, quota: 10 },
    })
    assert.equal((calls.find(call => call.name === 'sync')?.input as any).legacyUserId, 7)
  })
})
