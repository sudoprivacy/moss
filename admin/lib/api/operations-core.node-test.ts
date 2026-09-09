import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createOperationsApi, type OperationsHttpClient } from './operations-core.js'

function setup() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const client: OperationsHttpClient = {
    get: async path => { calls.push({ method: 'GET', path }); return {} },
    post: async (path, body) => { calls.push({ method: 'POST', path, body }); return {} },
    put: async (path, body) => { calls.push({ method: 'PUT', path, body }); return {} },
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
      { method: 'GET', path: '/api/moss/v1/operations/invitation-codes?page=2&page_size=10&status=0' },
      { method: 'POST', path: '/api/moss/v1/operations/invitation-codes', body: { count: 3, initial_quota_usd: 12 } },
      { method: 'DELETE', path: '/api/moss/v1/operations/invitation-codes/27' },
    ])
  })

  test('用户审批与财务操作使用旧兼容路径和稳定字段', async () => {
    const { calls, api } = setup()
    await api.approvePendingUser(17)
    await api.rejectPendingUser(18)
    await api.deletePendingUser(19)
    await api.rechargeUser(17, { points: 1000, reason: '补偿', paymentReference: 'OFFLINE-1' })
    await api.adjustUserPoints(17, { amount: 20, operation: 'subtract', reason: '冲正', syncSudorouter: true })
    await api.syncUserQuota(17)
    await api.listUserLedger(17, 50)
    assert.deepEqual(calls, [
      { method: 'POST', path: '/api/moss/v1/operations/approve', body: { userId: 17 } },
      { method: 'POST', path: '/api/moss/v1/operations/reject', body: { userId: 18 } },
      { method: 'POST', path: '/api/moss/v1/operations/delete', body: { userId: 19 } },
      { method: 'POST', path: '/api/moss/v1/operations/users/17/recharge', body: { points: 1000, reason: '补偿', payment_reference: 'OFFLINE-1' } },
      { method: 'POST', path: '/api/moss/v1/operations/users/17/points', body: { amount: 20, operation: 'subtract', reason: '冲正', sync_sudorouter: true } },
      { method: 'POST', path: '/api/moss/v1/operations/users/17/sync-quota', body: undefined },
      { method: 'GET', path: '/api/moss/v1/operations/users/17/ledger?limit=50' },
    ])
  })

  test('完整账务和系统配置操作保持兼容请求结构', async () => {
    const { calls, api } = setup()
    await api.getRechargeStats()
    await api.getBillingOrder('ORDER/7')
    await api.retryBillingOrder(7)
    await api.syncPendingBillingOrders()
    await api.getRefundCalculation('ORDER/7')
    await api.refundBillingOrder('ORDER/7', '重复付款')
    await api.getCreditApplication(8)
    await api.retryCreditApplicationSync(8)
    await api.getSudoworkSystemConfig()
    await api.updateSudoworkSystemConfig({ recharge_mode: 'approve' })
    assert.deepEqual(calls, [
      { method: 'GET', path: '/api/moss/v1/operations/recharge/stats' },
      { method: 'GET', path: '/api/moss/v1/operations/recharge/orders/ORDER%2F7' },
      { method: 'POST', path: '/api/moss/v1/operations/recharge/orders/7/retry', body: undefined },
      { method: 'POST', path: '/api/moss/v1/operations/recharge/sync', body: undefined },
      { method: 'GET', path: '/api/moss/v1/operations/recharge/refund-calc/ORDER%2F7' },
      { method: 'POST', path: '/api/moss/v1/operations/recharge/orders/ORDER%2F7/refund', body: { reason: '重复付款' } },
      { method: 'GET', path: '/api/moss/v1/operations/credit-applications/8' },
      { method: 'POST', path: '/api/moss/v1/operations/credit-applications/8/retry-sync', body: undefined },
      { method: 'GET', path: '/api/moss/v1/operations/system-config' },
      { method: 'PUT', path: '/api/moss/v1/operations/system-config', body: { recharge_mode: 'approve' } },
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
      { method: 'GET', path: '/api/moss/v1/operations/recharge/orders?page=1&pageSize=20&status=2' },
      { method: 'GET', path: '/api/moss/v1/operations/recharge-records?page=3&pageSize=50' },
      { method: 'GET', path: '/api/moss/v1/operations/credit-applications?page=1&pageSize=20&status=PENDING' },
      { method: 'POST', path: '/api/moss/v1/operations/credit-applications/8/approve', body: { approved_points: 100, admin_comment: '通过' } },
      { method: 'GET', path: '/api/moss/v1/operations/logs?page=1&page_size=20&action=USER_APPROVE' },
    ])
  })

  test('业务审计透传用户、动作和日期范围', async () => {
    const { calls, api } = setup()
    await api.listAuditEvents({ page: 2, pageSize: 50, userId: 17, action: 'RECHARGE', dateFrom: 10, dateTo: 20 })
    assert.deepEqual(calls, [{ method: 'GET', path: '/api/moss/v1/operations/logs?page=2&page_size=50&action=RECHARGE&user_id=17&date_from=10&date_to=20' }])
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
      { method: 'GET', path: '/api/moss/v1/operations/qms/dashboard/overview?start_time=10&end_time=20' },
      { method: 'GET', path: '/api/moss/v1/operations/qms/user-stats/leaderboard/conversations?limit=10' },
      { method: 'GET', path: '/api/moss/v1/operations/qms/system/health' },
      { method: 'POST', path: '/api/moss/v1/operations/qms/alerts/history/12/acknowledge', body: undefined },
      { method: 'POST', path: '/api/moss/v1/operations/qms/crash/issues/9/resolve', body: undefined },
      { method: 'POST', path: '/api/moss/v1/operations/qms/system/aggregation/run', body: undefined },
    ])
  })

  test('QMS 完整运维请求覆盖趋势、用户、Crash、告警和系统配置', async () => {
    const { calls, api } = setup()
    await api.getConversationTrend({ startTime: 10, endTime: 20, dimension: 'platform' })
    await api.getInstallTrend({ startTime: 10, endTime: 20, dimension: 'version' })
    await api.getPerformanceTrend({ metric: 'latency', platform: 'darwin' })
    await api.getQualityUserDetail('user/a', { startTime: 10, endTime: 20 })
    await api.getCrashIssue(9)
    await api.updateCrashIssue(9, { status: 'processing', assigned_to: 17 })
    await api.createAlertConfig({ name: '高错误率', enabled: true })
    await api.updateAlertConfig('cfg/1', { enabled: false })
    await api.deleteAlertConfig('cfg/1')
    await api.updateQmsSystemConfig('retention/days', '30')
    await api.updateQmsNotifications({ email: { enabled: true } })
    assert.deepEqual(calls, [
      { method: 'GET', path: '/api/moss/v1/operations/qms/dashboard/conversations/trend?start_time=10&end_time=20&dimension=platform' },
      { method: 'GET', path: '/api/moss/v1/operations/qms/dashboard/installs/trend?start_time=10&end_time=20&dimension=version' },
      { method: 'GET', path: '/api/moss/v1/operations/qms/dashboard/perf/trend?metric=latency&platform=darwin' },
      { method: 'GET', path: '/api/moss/v1/operations/qms/user-stats/users/user%2Fa?start_time=10&end_time=20' },
      { method: 'GET', path: '/api/moss/v1/operations/qms/crash/issues/9' },
      { method: 'PUT', path: '/api/moss/v1/operations/qms/crash/issues/9', body: { status: 'processing', assigned_to: 17 } },
      { method: 'POST', path: '/api/moss/v1/operations/qms/alerts/configs', body: { name: '高错误率', enabled: true } },
      { method: 'PUT', path: '/api/moss/v1/operations/qms/alerts/configs/cfg%2F1', body: { enabled: false } },
      { method: 'DELETE', path: '/api/moss/v1/operations/qms/alerts/configs/cfg%2F1' },
      { method: 'PUT', path: '/api/moss/v1/operations/qms/system/config/retention%2Fdays', body: { value: '30' } },
      { method: 'PUT', path: '/api/moss/v1/operations/qms/system/notifications', body: { email: { enabled: true } } },
    ])
  })
})
