import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveQmsConfig } from './config.js'
import type { DbDriver } from '../db/driver.js'
import { PostgresSourceMapRepository, startQmsRuntime } from './qmsRuntime.js'

function setup() {
  const statements: string[] = []
  let closes = 0
  let fail = false
  const driver = {
    kind: 'postgres',
    get: async () => ({ main_schema: 'public', has_schema: false, can_use_schema: false, has_prefixed_tables: false, can_create_schema: true }),
    exec: async (sql: string) => { statements.push(sql); if (fail) throw new Error('postgres unavailable') },
    all: async (sql: string, params: unknown[]) => {
      statements.push(sql)
      if (fail) throw new Error('postgres unavailable')
      return sql.includes('INSERT INTO "moss_qms"."qms_ingest_receipts"') ? [{ ingest_id: params[0] }] : []
    },
    transaction: async (operation: () => Promise<unknown>) => operation(),
    tryRunExclusive: async (_key: string, operation: () => Promise<unknown>) => operation(),
    close: async () => { closes++ },
  } as unknown as DbDriver
  const config = resolveQmsConfig({ enabled: true, queueFlushIntervalMs: 10000, queueDrainTimeoutMs: 10, queueRetryIntervalMs: 1 }, { QMS_API_KEY: 'secret' })
  return {
    statements, closes: () => closes, fail: () => { fail = true },
    options: { config, driver, ownerId: 'instance-1', organizations: { getCode: async () => 'tenant-a', hasCode: async () => true }, secrets: { get: () => undefined, put: async () => {} } },
  }
}

void describe('QMS shared-store runtime lifecycle', () => {
  void it('prefers tenant source maps', async () => {
    const statements: string[] = []
    const repository = new PostgresSourceMapRepository({ execute: async sql => { statements.push(sql); return [{ map_content: '{}' }] } })
    assert.equal(await repository.find('ENT-A', '1', 'darwin', 'main.js'), '{}')
    assert.match(statements[0]!, /ORDER BY tenant_id NULLS LAST/)
  })

  void it('does not use storage while disabled', async () => {
    const value = setup()
    const runtime = await startQmsRuntime({ ...value.options, config: { ...value.options.config, enabled: false } })
    assert.equal(runtime, undefined)
    assert.equal(value.statements.length, 0)
  })

  void it('flushes volatile telemetry on shutdown and never closes the borrowed Moss driver', async () => {
    const value = setup()
    const runtime = await startQmsRuntime(value.options)
    assert(runtime)
    await runtime.operations.execute({ key: 'POST /api/v1/telemetry/batch', params: {}, query: {}, body: { events: [{ id: 'event', type: 'perf', timestamp: 1, version: '1', platform: 'darwin', tenant_id: 'tenant-a', data: { metric: 'startup', value_ms: 1 } }] } })
    assert.equal(value.statements.some(sql => sql.includes('INSERT INTO "moss_qms"."telemetry_perf_raw"')), false)
    await Promise.all([runtime.stop(), runtime.stop()])
    assert.equal(value.statements.filter(sql => sql.includes('INSERT INTO "moss_qms"."telemetry_perf_raw"')).length, 1)
    assert.equal(value.closes(), 0)
  })

  void it('does not close shared storage if schema initialization fails', async () => {
    const value = setup()
    value.fail()
    await assert.rejects(startQmsRuntime(value.options), /postgres unavailable/)
    assert.equal(value.closes(), 0)
  })

  void it('reports unsaved memory events on drain timeout while preserving shared storage ownership', async () => {
    const value = setup()
    const warnings: string[] = []
    const runtime = await startQmsRuntime({ ...value.options, warn: message => warnings.push(message) })
    assert(runtime)
    await runtime.operations.execute({ key: 'POST /api/v1/telemetry/batch', params: {}, query: {}, body: { events: [{ id: 'event', type: 'perf', timestamp: 1, version: '1', platform: 'darwin', tenant_id: 'tenant-a', data: { metric: 'startup', value_ms: 1 } }] } })
    value.fail()
    await runtime.stop()
    assert.match(warnings[0]!, /1 telemetry events remain in volatile memory/)
    assert.equal(value.closes(), 0)
  })
})
