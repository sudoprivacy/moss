import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { QmsUserStatsService } from './userStatsService.js'
import type { QmsSqlPort } from './qmsSchema.js'

class UserStatsSql implements QmsSqlPort {
  statements: Array<{ sql: string; parameters: readonly unknown[] }> = []
  async execute(sql: string, parameters: readonly unknown[] = []) {
    this.statements.push({ sql, parameters })
    if (sql.includes('AS conversation_count') && sql.includes('WITH combined')) return [{
      user_id: 'u1', tenant_id: 'tenant-a', conversation_count: '3', total_tokens: '12',
      input_tokens: '5', output_tokens: '7', avg_duration_ms: '9', success_count: '2',
      error_count: '1', success_rate: '67',
    }]
    if (sql.includes('AS turn_count') && sql.includes('WITH combined')) return [{ user_id: 'u1', turn_count: 4, total_tokens: 20 }]
    if (sql.includes('AS total_users')) return [{ total_users: 1 }]
    if (sql.includes('AS total_conversations')) return [{ total_conversations: 3 }]
    if (sql.includes('AS total_turns')) return [{ total_turns: 4 }]
    if (sql.includes('AS total_steps')) return [{ total_steps: 5 }]
    if (sql.includes('AS total_tokens')) return [{ total_tokens: 20 }]
    return []
  }
}

describe('QmsUserStatsService', () => {
  it('merges historical daily and current raw data at a UTC boundary with tenant scope', async () => {
    const db = new UserStatsSql()
    const service = new QmsUserStatsService(db, () => new Date('2026-09-07T12:00:00Z'))

    const result = await service.conversations({
      tenantId: 'tenant-a', startTime: Date.parse('2026-09-01T00:00:00Z'),
      endTime: Date.parse('2026-09-07T12:00:00Z'),
    })

    assert.equal(result[0]?.conversation_count, 3)
    assert.equal(result[0]?.success_rate, 67)
    assert.match(db.statements[0]!.sql, /telemetry_user_conversations_daily/)
    assert.match(db.statements[0]!.sql, /telemetry_conversations/)
    assert.match(db.statements[0]!.sql, /tenant_id = \$/)
    assert.ok(db.statements[0]!.parameters.includes('tenant-a'))
  })

  it('validates leaderboard types and assigns stable ranks', async () => {
    const db = new UserStatsSql()
    const service = new QmsUserStatsService(db)

    await assert.rejects(() => service.leaderboard('tenant_id', { tenantId: 'tenant-a' }), /Invalid leaderboard type/)
    assert.equal(db.statements.length, 0)

    const rows = await service.leaderboard('conversations', { tenantId: 'tenant-a' })
    assert.deepEqual(rows.map(row => ({ rank: row.rank, user_id: row.user_id, value: row.value })), [
      { rank: 1, user_id: 'u1', value: 3 },
    ])
  })

  it('scopes every realtime counter to the authorized tenant', async () => {
    const db = new UserStatsSql()
    const service = new QmsUserStatsService(db)

    const result = await service.realtime({ tenantId: 'tenant-a' })

    assert.deepEqual(result, {
      total_users: 1, total_conversations: 3, total_turns: 4, total_steps: 5, total_tokens: 20,
    })
    assert.equal(db.statements.length, 5)
    assert.equal(db.statements.every(statement => statement.parameters.includes('tenant-a')), true)
  })

  it('filters raw rows by the same user identity fallback used for grouping', async () => {
    const db = new UserStatsSql()
    const service = new QmsUserStatsService(db)

    await service.conversations({ tenantId: 'tenant-a', userId: '13800000000' })

    const sql = db.statements[0]!.sql
    assert.match(sql, /telemetry_user_conversations_daily[\s\S]*AND user_id = \$\d+/)
    assert.match(sql, /telemetry_conversations[\s\S]*AND COALESCE\(NULLIF\(user_id, ''\), NULLIF\(user_phone, ''\)\) = \$\d+/)
  })
})
