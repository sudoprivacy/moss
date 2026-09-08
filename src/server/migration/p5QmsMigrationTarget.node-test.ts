import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { QmsSqlPort } from '../qms/qmsSchema.js'
import type { QmsTransactionalSqlPort } from '../qms/telemetryPostgresWriter.js'
import { PostgresP5QmsMigrationTarget } from './p5QmsMigrationService.js'

class RecordingDatabase implements QmsTransactionalSqlPort {
  readonly statements: Array<{ sql: string; parameters: readonly unknown[]; inTransaction: boolean }> = []
  transactionDepth = 0
  conflictReceipt = false

  async execute(sql: string, parameters: readonly unknown[] = []): Promise<readonly Record<string, unknown>[]> {
    this.statements.push({ sql, parameters, inTransaction: this.transactionDepth > 0 })
    if (sql.includes('INSERT INTO qms_ingest_receipts')) return this.conflictReceipt ? [] : [{ ingest_id: parameters[0] }]
    if (sql.includes('INSERT INTO "telemetry_perf_raw"')) return [{ inserted: 1 }]
    if (sql.includes('INSERT INTO qms_migration_checkpoints')) return [{ table_name: parameters[1] }]
    return []
  }

  async transaction<T>(operation: (client: QmsSqlPort) => Promise<T>): Promise<T> {
    this.transactionDepth += 1
    try { return await operation(this) } finally { this.transactionDepth -= 1 }
  }
}

describe('P5 QMS PostgreSQL 迁移目标', () => {
  it('在同一 PostgreSQL 事务中写 receipt、业务行和 checkpoint', async () => {
    const db = new RecordingDatabase()
    const target = new PostgresP5QmsMigrationTarget(db, { timescaleAvailable: true, continuousAggregates: false })

    await target.writeBatch({
      migrationId: 'm1', table: 'telemetry_perf_raw', sourceChecksum: 'abc',
      rows: [{ id: 1, ingest_id: 'migration:p5:1', timestamp: new Date(1), version: '1', platform: 'darwin', metric: 'x', value_ms: 1 }],
      receipts: [{ ingest_id: 'migration:p5:1', kind: 'perf', tenant_id: 'ENT-A', event_timestamp: new Date(1) }],
      nextOffset: 1, migratedRows: 1, complete: true,
    })

    assert.equal(db.statements.length, 3)
    assert(db.statements.every(statement => statement.inTransaction))
    assert.match(db.statements[2]!.sql, /source_checksum=EXCLUDED.source_checksum/)
  })

  it('ingest receipt 冲突时不继续业务行或 checkpoint', async () => {
    const db = new RecordingDatabase()
    db.conflictReceipt = true
    const target = new PostgresP5QmsMigrationTarget(db, { timescaleAvailable: false, continuousAggregates: false })

    await assert.rejects(() => target.writeBatch({
      migrationId: 'm1', table: 'telemetry_perf_raw', sourceChecksum: 'abc',
      rows: [{ id: 1, ingest_id: 'migration:p5:1' }],
      receipts: [{ ingest_id: 'migration:p5:1', kind: 'perf', tenant_id: 'ENT-A', event_timestamp: new Date(1) }],
      nextOffset: 1, migratedRows: 1, complete: false,
    }), /ingest receipt 冲突/)

    assert.equal(db.statements.length, 1)
  })
})
