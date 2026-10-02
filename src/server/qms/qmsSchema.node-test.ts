import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { initializeQmsSchema, type QmsSqlPort } from './qmsSchema.js'

class RecordingSql implements QmsSqlPort {
  readonly statements: string[] = []
  timescaleAvailable = true
  aggregateRelationKind: string | null = null
  continuousView = false

  async execute(sql: string): Promise<readonly Record<string, unknown>[]> {
    this.statements.push(sql)
    if (sql.includes("FROM pg_extension") && sql.includes("extname = 'timescaledb'")) {
      return this.timescaleAvailable ? [{ available: true }] : []
    }
    if (sql.includes("to_regclass('telemetry_perf_daily')")) {
      return this.aggregateRelationKind ? [{ relkind: this.aggregateRelationKind }] : []
    }
    if (sql.includes('FROM timescaledb_information.continuous_aggregates')) return this.continuousView ? [{ exists: 1 }] : []
    return []
  }
}

void describe('QMS PostgreSQL schema', () => {
  void it('owns legacy-compatible QMS tables plus reliable ingest and lease metadata', async () => {
    const db = new RecordingSql()
    const result = await initializeQmsSchema(db)
    const sql = db.statements.join('\n')

    assert.equal(result.timescaleAvailable, true)
    assert.equal(result.continuousAggregates, true)
    for (const table of [
      'telemetry_perf_raw', 'telemetry_conversations', 'telemetry_turns', 'telemetry_steps',
      'telemetry_install', 'crash_events', 'crash_issues', 'crash_daily_stats', 'source_maps',
      'alert_config', 'alert_history', 'audit_logs', 'system_config', 'qms_task_leases',
      'qms_migration_checkpoints', 'qms_ingest_receipts',
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))
    }
    assert.match(sql, /ingest_id TEXT NOT NULL/)
    assert.match(sql, /UNIQUE \(ingest_id, timestamp\)/)
    assert.match(sql, /qms_ingest_receipts \(\s*ingest_id TEXT PRIMARY KEY/)
    assert.match(sql, /telemetry_user_conversations_daily[\s\S]*conversation_count INTEGER NOT NULL/)
    assert.match(sql, /telemetry_user_turns_daily[\s\S]*turn_count INTEGER NOT NULL/)
    assert.match(sql, /telemetry_user_steps_daily[\s\S]*step_count INTEGER NOT NULL/)
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_telemetry_user_conversations_daily_dimensions/)
    assert.match(sql, /COALESCE\(org_id, ''\)/)
    assert.doesNotMatch(sql, /NULLS NOT DISTINCT/)
    assert.match(sql, /create_hypertable\('telemetry_perf_raw'/)
    assert.match(sql, /CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_perf_daily/)
    assert.match(sql, /CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_turns_daily/)
    assert.match(sql, /CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_steps_daily/)
    assert.match(sql, /add_continuous_aggregate_policy\('telemetry_perf_daily'/)
    assert.match(sql, /add_continuous_aggregate_policy\('telemetry_turns_daily'/)
    assert.match(sql, /add_continuous_aggregate_policy\('telemetry_steps_daily'/)
    assert.match(sql, /add_retention_policy\('telemetry_perf_raw'/)
    assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS telemetry_perf_daily/)
  })

  void it('uses regular PostgreSQL tables when TimescaleDB is unavailable', async () => {
    const db = new RecordingSql()
    db.timescaleAvailable = false

    const result = await initializeQmsSchema(db)

    assert.equal(result.timescaleAvailable, false)
    assert.equal(result.continuousAggregates, false)
    assert.equal(db.statements.some(sql => sql.includes('create_hypertable')), false)
    const sql = db.statements.join('\n')
    assert.match(sql, /CREATE TABLE IF NOT EXISTS telemetry_perf_daily/)
    assert.doesNotMatch(sql, /CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_perf_daily/)
  })

  void it('preserves regular aggregate tables even when TimescaleDB later becomes available', async () => {
    const db = new RecordingSql()
    db.aggregateRelationKind = 'r'

    const result = await initializeQmsSchema(db)
    const sql = db.statements.join('\n')

    assert.deepEqual(result, { timescaleAvailable: true, continuousAggregates: false })
    assert.match(sql, /CREATE TABLE IF NOT EXISTS telemetry_perf_daily/)
    assert.doesNotMatch(sql, /CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_perf_daily/)
  })
})

void it('recognizes verified Timescale continuous views on restart without accepting unrelated views', async () => {
  const db = new RecordingSql()
  db.aggregateRelationKind = 'v'
  await assert.rejects(() => initializeQmsSchema(db), /Unsupported QMS aggregate relation/)
  db.continuousView = true
  assert.equal((await initializeQmsSchema(db)).continuousAggregates, true)
})
