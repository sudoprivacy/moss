import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildOperationsSummary } from './operations-dashboard.js'

test('运营看板合并身份、财务和质量摘要', () => {
  assert.deepEqual(buildOperationsSummary(
    { enterprises: 2, users: 10, pending: 3, points: { total: 1200 } },
    { today: { amount_usd: 20, orders: 4 }, total: { pending_count: 2 } },
    { success_rate: 98.5, total_conversations: 100 },
  ), {
    organizations: 2, users: 10, pendingUsers: 3, points: 1200,
    todayRechargeUsd: 20, todayOrders: 4, pendingOrders: 2,
    qualitySuccessRate: 98.5, conversations: 100,
  })
})
