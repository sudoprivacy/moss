import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DbDriver } from '../db/driver.js'
import { MossQmsStore, qualifyQmsTables } from './mossQmsStore.js'

void describe('QMS shared Moss PostgreSQL adapter', () => {
  void it('qualifies table identifiers while preserving strings, comments, and explicit schema references', () => {
    const sql = `SELECT 'audit_logs' AS name FROM "audit_logs" -- telemetry_perf_raw
      WHERE audit_logs.tenant_id = $1 /* system_config */`
    assert.equal(qualifyQmsTables(sql), `SELECT 'audit_logs' AS name FROM "moss_qms"."audit_logs" -- telemetry_perf_raw
      WHERE "moss_qms"."audit_logs".tenant_id = $1 /* system_config */`)
    assert.equal(qualifyQmsTables('SELECT * FROM public.audit_logs'), 'SELECT * FROM public.audit_logs')
  })

  void it('initializes only its own schema with no inbox, Redis, or Timescale requirements', async () => {
    const statements: string[] = []
    const driver = {
      kind: 'postgres',
    get: async () => ({ main_schema: 'public', has_schema: false, can_use_schema: false, has_prefixed_tables: false, can_create_schema: true }),
      exec: async (sql: string) => { statements.push(sql) },
      tryRunExclusive: async (_key: string, operation: () => Promise<unknown>) => operation(),
    } as unknown as DbDriver
    const state = await new MossQmsStore(driver).start()
    const sql = statements.join('\n')
    assert.equal(state.continuousAggregates, false)
    assert.match(sql, /CREATE SCHEMA "moss_qms"/)
    assert.match(sql, /CREATE TABLE IF NOT EXISTS "moss_qms"\."telemetry_conversations"/)
    assert.match(sql, /SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'/)
    assert.doesNotMatch(sql, /qms_migration_checkpoints|inbox|ingest_batches|CREATE EXTENSION|create_hypertable|search_path/)
  })

  void it('shares Moss transactions and normalizes PostgreSQL parameters', async () => {
    let transactions = 0
    let lastParameters: unknown[] = []
    const driver = {
      kind: 'postgres',
    get: async () => ({ main_schema: 'public', has_schema: false, can_use_schema: false, has_prefixed_tables: false, can_create_schema: true }),
      all: async (_sql: string, parameters: unknown[]) => { lastParameters = parameters; return [{ id: 1 }] },
      transaction: async (operation: () => Promise<unknown>) => { transactions++; return operation() },
    } as unknown as DbDriver
    const store = new MossQmsStore(driver, 1)
    await store.transaction(async db => {
      await db.execute('SELECT * FROM telemetry_perf_raw WHERE timestamp = $1 AND enabled = $2', [new Date(0), true])
    })
    assert.equal(transactions, 1)
    assert.deepEqual(lastParameters, ['1970-01-01T00:00:00.000Z', 'true'])
  })

  void it('limits QMS database concurrency without changing the shared connection pool', async () => {
    let active = 0
    let peak = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const driver = { kind: 'postgres',
    get: async () => ({ main_schema: 'public', has_schema: false, can_use_schema: false, has_prefixed_tables: false, can_create_schema: true }), all: async () => { active++; peak = Math.max(peak, active); await gate; active--; return [] } } as unknown as DbDriver
    const store = new MossQmsStore(driver, 2)
    const pending = Promise.all(Array.from({ length: 5 }, () => store.execute('SELECT 1')))
    assert.equal(peak, 2)
    release()
    await pending
    assert.equal(peak, 2)
  })

  void it('rejects SQLite instead of silently creating an extra database', () => {
    assert.throws(() => new MossQmsStore({ kind: 'sqlite' } as DbDriver), /Moss PostgreSQL/)
  })
})

void it('uses prefixed tables in the existing schema when the Moss role cannot create schemas', async () => {
  const statements: string[] = []
  const driver = {
    kind: 'postgres',
    get: async () => ({ main_schema: 'public', has_schema: false, can_use_schema: false, has_prefixed_tables: false, can_create_schema: false }),
    exec: async (sql: string) => { statements.push(sql) },
    tryRunExclusive: async (_key: string, operation: () => Promise<unknown>) => operation(),
  } as unknown as DbDriver
  await new MossQmsStore(driver).start()
  const sql = statements.join('\n')
  assert.doesNotMatch(sql, /CREATE SCHEMA|NULLS NOT DISTINCT|CREATE EXTENSION/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "public"\."moss_qms_telemetry_perf_raw"/)
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "moss_qms_uq_telemetry_perf_daily_dimensions"/)
})
