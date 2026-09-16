import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createQmsScheduledTasks, QmsMaintenanceService } from './qmsMaintenanceService.js'
import type { QmsSqlPort } from './qmsSchema.js'
import type { QmsTransactionalSqlPort } from './telemetryPostgresWriter.js'

class MaintenanceSql implements QmsTransactionalSqlPort {
  statements: Array<{ sql: string; parameters: readonly unknown[] }> = []
  transactions = 0
  async execute(sql: string, parameters: readonly unknown[] = []) {
    this.statements.push({ sql, parameters })
    return []
  }
  async transaction<T>(operation: (client: QmsSqlPort) => Promise<T>) {
    this.transactions += 1
    return operation(this)
  }
}

describe('QmsMaintenanceService', () => {
  it('refreshes Timescale aggregates and relies on retention policies for raw cleanup', async () => {
    const db = new MaintenanceSql()
    const service = new QmsMaintenanceService({ db, continuousAggregates: true })

    await service.aggregateRange(1, 2, new Date('2026-09-07T00:00:00Z'))
    await service.cleanup({ perfDays: 90, conversationDays: 180, crashDays: 90, aggregateDays: 365 })

    assert.equal(db.statements.filter(item => item.sql.includes('refresh_continuous_aggregate')).length, 6)
    assert.ok(db.statements.some(item => item.sql.includes("'telemetry_turns_daily'")))
    assert.ok(db.statements.some(item => item.sql.includes("'telemetry_steps_daily'")))
    assert.equal(db.statements.some(item => item.sql.includes('DELETE FROM telemetry_perf_raw')), false)
  })

  it('uses separate transactions for regular daily aggregation and retention cleanup', async () => {
    const db = new MaintenanceSql()
    const service = new QmsMaintenanceService({ db, continuousAggregates: false })

    await service.aggregateRange(1, 1, new Date('2026-09-07T12:00:00Z'))
    await service.cleanup({ perfDays: 90, conversationDays: 180, crashDays: 90, aggregateDays: 365 })

    assert.equal(db.transactions, 2)
    assert.ok(db.statements.some(item => item.sql.includes('INSERT INTO telemetry_perf_daily')))
    assert.ok(db.statements.some(item => item.sql.includes('INSERT INTO telemetry_user_steps_daily')))
    assert.ok(db.statements.some(item => item.sql.includes('DELETE FROM telemetry_perf_raw')))
    assert.ok(db.statements.some(item => item.sql.includes('DELETE FROM crash_events')))
  })

  it('builds exactly six leased task definitions and recovers the queue before processing', async () => {
    const calls: string[] = []
    const tasks = createQmsScheduledTasks({
      queue: {
        recoverExpired: async () => { calls.push('recover'); return 0 },
        processBatch: async () => { calls.push('process'); return 0 },
      },
      maintenance: {
        aggregateRange: async () => { calls.push('aggregate') },
        cleanup: async () => { calls.push('cleanup') },
        aggregateCrash: async () => { calls.push('crash-aggregate') },
        cleanupCrash: async () => { calls.push('crash-cleanup') },
      },
      alerts: { evaluateType: async ({ type }: { type: string }) => { calls.push(`alert:${type}`) } },
      batchSize: 50,
      flushIntervalMs: 3_000,
      retention: { perfDays: 90, conversationDays: 180, crashDays: 90, aggregateDays: 365 },
    })

    assert.deepEqual(tasks.map(task => task.name), [
      'queue-process', 'aggregation', 'cleanup', 'alert', 'crash-aggregation', 'crash-cleanup',
    ])
    await tasks[0]!.run()
    assert.deepEqual(calls, ['recover', 'process'])
  })
})
