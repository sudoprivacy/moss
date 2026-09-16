import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { QmsSqlPort } from './qmsSchema.js'
import { TelemetryPostgresWriter, type QmsTransactionalSqlPort } from './telemetryPostgresWriter.js'

class TransactionalSql implements QmsTransactionalSqlPort {
  statements: Array<{ sql: string; parameters: readonly unknown[] }> = []
  transactions = 0
  receipts = new Set<string>()

  async execute(sql: string, parameters: readonly unknown[] = []) {
    this.statements.push({ sql, parameters })
    if (sql.includes('INSERT INTO qms_ingest_receipts')) {
      const ingestId = String(parameters[0])
      if (this.receipts.has(ingestId)) return []
      this.receipts.add(ingestId)
      return [{ ingest_id: ingestId }]
    }
    return []
  }

  async transaction<T>(operation: (client: QmsSqlPort) => Promise<T>): Promise<T> {
    this.transactions += 1
    return operation(this)
  }
}

describe('TelemetryPostgresWriter', () => {
  it('persists a mixed claimed batch in one transaction with ingest id conflict protection', async () => {
    const db = new TransactionalSql()
    const writer = new TelemetryPostgresWriter(db)

    await writer.persist([
      {
        ingestId: 'perf-1', kind: 'perf', payload: {
          timestamp: 1_000, version: '1.0', platform: 'darwin', tenant_id: 'tenant-a',
          metric: 'startup', value_ms: 12,
        },
      },
      {
        ingestId: 'install-1', kind: 'install', payload: {
          install_id: 'install-a', timestamp: 2_000, version: '1.0', platform: 'linux',
          tenant_id: 'tenant-a', status: 'success', duration_ms: 20,
        },
      },
    ])

    assert.equal(db.transactions, 1)
    assert.equal(db.statements.length, 4)
    assert.match(db.statements[0]!.sql, /INSERT INTO qms_ingest_receipts/)
    assert.match(db.statements[1]!.sql, /INSERT INTO telemetry_perf_raw/)
    assert.equal(db.statements[1]!.parameters[0], 'perf-1')
    assert.match(db.statements[3]!.sql, /INSERT INTO telemetry_install/)
  })

  it('deduplicates an ingest id globally even when a replay changes the timestamp', async () => {
    const db = new TransactionalSql()
    const writer = new TelemetryPostgresWriter(db)
    const base = {
      ingestId: 'same-id', kind: 'perf' as const,
      payload: { timestamp: 1_000, version: '1.0', platform: 'darwin', tenant_id: 'tenant-a', metric: 'startup', value_ms: 12 },
    }

    await writer.persist([base])
    await writer.persist([{ ...base, payload: { ...base.payload, timestamp: 2_000 } }])

    assert.equal(db.statements.filter(item => item.sql.includes('INSERT INTO telemetry_perf_raw')).length, 1)
  })

  it('validates required fields before opening a transaction', async () => {
    const db = new TransactionalSql()
    const writer = new TelemetryPostgresWriter(db)

    await assert.rejects(() => writer.persist([
      { ingestId: 'bad', kind: 'conversation', payload: { tenant_id: 'tenant-a' } },
    ]), /timestamp/)
    assert.equal(db.transactions, 0)
  })
})
