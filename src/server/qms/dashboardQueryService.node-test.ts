import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { QmsDashboardQueryService } from './dashboardQueryService.js'
import type { QmsSqlPort } from './qmsSchema.js'

class DashboardSql implements QmsSqlPort {
  statements: Array<{ sql: string; parameters: readonly unknown[] }> = []
  async execute(sql: string, parameters: readonly unknown[] = []) {
    this.statements.push({ sql, parameters })
    if (sql.includes('SELECT DISTINCT platform')) return [{ platform: 'darwin', arch: 'arm64' }]
    if (sql.includes('SELECT DISTINCT version')) return [{ version: '1.2.0' }]
    if (sql.includes('SELECT DISTINCT metric')) return [{ metric: 'startup' }]
    if (sql.includes('COUNT(*)::INTEGER AS total') && sql.includes('telemetry_conversations')) {
      return [{ total: 10, success: 8, error: 1, user_cancel: 1, avg_duration_ms: 40, avg_tokens: 20 }]
    }
    if (sql.includes('AS previous_total')) return [{ previous_total: 5 }]
    return []
  }
}

describe('QmsDashboardQueryService', () => {
  it('scopes every overview query to the authorized tenant and keeps legacy rates', async () => {
    const db = new DashboardSql()
    const service = new QmsDashboardQueryService(db)
    const result = await service.overview({
      tenantId: 'tenant-a', startTime: 1_000, endTime: 2_000,
    })

    assert.equal(result.conversations.total, 10)
    assert.equal(result.conversations.success_rate, 80)
    assert.equal(result.errors.error_rate, 10)
    assert.equal(db.statements.length > 5, true)
    for (const statement of db.statements) {
      assert.match(statement.sql, /tenant_id = \$/)
      assert.ok(statement.parameters.includes('tenant-a'))
    }
  })

  it('returns legacy dimension labels from tenant-scoped data', async () => {
    const db = new DashboardSql()
    const service = new QmsDashboardQueryService(db)

    const result = await service.dimensions('perf', { tenantId: 'tenant-a', endTime: 2_000 })

    assert.deepEqual(result, {
      platforms: [{ platform: 'darwin', arch: 'arm64', label: 'macOS ARM', value: 'darwin|arm64' }],
      versions: ['1.2.0'],
      metrics: ['startup'],
    })
    assert.equal(db.statements.every(statement => statement.parameters.includes('tenant-a')), true)
  })

  it('rejects unsupported dimensions before querying', async () => {
    const db = new DashboardSql()
    const service = new QmsDashboardQueryService(db)

    await assert.rejects(
      () => service.conversationTrend({ tenantId: 'tenant-a', dimension: 'tenant_id' }),
      /Invalid dashboard dimension/,
    )
    assert.equal(db.statements.length, 0)
  })
})
