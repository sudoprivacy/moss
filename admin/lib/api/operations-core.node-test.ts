import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createOperationsApi, type OperationsHttpClient } from './operations-core.js'

function setup() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const client: OperationsHttpClient = {
    get: async path => { calls.push({ method: 'GET', path }); return {} },
    post: async (path, body) => { calls.push({ method: 'POST', path, body }); return {} },
    delete: async path => { calls.push({ method: 'DELETE', path }); return {} },
  }
  return { calls, api: createOperationsApi(client) }
}

describe('Moss Admin 统一运营 API client', () => {
  test('邀请码请求使用当前组织作用域，不要求旧 enterprise_id', async () => {
    const { calls, api } = setup()
    await api.listInvitations({ page: 2, pageSize: 10, status: 0 })
    await api.createInvitations({ count: 3, initialQuotaUsd: 12 })
    await api.deleteInvitation(27)
    assert.deepEqual(calls, [
      { method: 'GET', path: '/api/v1/admin/invitation-codes?page=2&page_size=10&status=0' },
      { method: 'POST', path: '/api/v1/admin/invitation-codes', body: { count: 3, initial_quota_usd: 12 } },
      { method: 'DELETE', path: '/api/v1/admin/invitation-codes/27' },
    ])
  })

  test('账务、授信和审计请求保留旧兼容路径与参数名', async () => {
    const { calls, api } = setup()
    await api.listBillingOrders({ page: 1, pageSize: 20, status: '2' })
    await api.listRechargeRecords({ page: 3, pageSize: 50 })
    await api.listCreditApplications({ page: 1, pageSize: 20, status: 'PENDING' })
    await api.approveCreditApplication(8, { approvedPoints: 100, adminComment: '通过' })
    await api.listAuditEvents({ page: 1, pageSize: 20, action: 'USER_APPROVE' })
    assert.deepEqual(calls, [
      { method: 'GET', path: '/api/v1/admin/recharge/orders?page=1&pageSize=20&status=2' },
      { method: 'GET', path: '/api/v1/admin/recharge-records?page=3&pageSize=50' },
      { method: 'GET', path: '/api/v1/admin/credit-applications?page=1&pageSize=20&status=PENDING' },
      { method: 'POST', path: '/api/v1/admin/credit-applications/8/approve', body: { approved_points: 100, admin_comment: '通过' } },
      { method: 'GET', path: '/api/v1/admin/logs?page=1&page_size=20&action=USER_APPROVE' },
    ])
  })

  test('QMS 查询固定使用由服务端解析的当前组织，不发送 tenant_id', async () => {
    const { calls, api } = setup()
    await api.getQualityOverview({ startTime: 10, endTime: 20 })
    await api.getQualityLeaderboard('conversations', { limit: 10 })
    await api.getQualitySystemHealth()
    await api.acknowledgeQualityAlert(12)
    await api.resolveCrashIssue(9)
    await api.runQualityAggregation()
    assert.deepEqual(calls, [
      { method: 'GET', path: '/api/v1/qms/dashboard/overview?start_time=10&end_time=20' },
      { method: 'GET', path: '/api/v1/qms/user-stats/leaderboard/conversations?limit=10' },
      { method: 'GET', path: '/api/v1/qms/system/health' },
      { method: 'POST', path: '/api/v1/qms/alerts/history/12/acknowledge', body: undefined },
      { method: 'POST', path: '/api/v1/qms/crash/issues/9/resolve', body: undefined },
      { method: 'POST', path: '/api/v1/qms/system/aggregation/run', body: undefined },
    ])
  })
})
