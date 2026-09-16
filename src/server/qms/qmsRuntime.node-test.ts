import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { QmsRuntimeConfig } from './config.js'
import type { QmsSqlPort } from './qmsSchema.js'
import { PostgresSourceMapRepository, startQmsRuntime } from './qmsRuntime.js'

function config(overrides: Partial<QmsRuntimeConfig['secrets']> = {}): QmsRuntimeConfig {
  return {
    enabled: true,
    apiKeyHeader: 'X-QMS-Key',
    queue: { flushIntervalMs: 10_000, batchSize: 20, visibilityTimeoutMs: 60_000 },
    retention: { perfDays: 90, conversationDays: 180, crashDays: 90, aggregateDays: 365 },
    encryptionRequired: false,
    secrets: { postgresUrl: 'postgres://user:pass@db/qms', redisUrl: 'redis://cache', apiKey: 'secret', ...overrides },
  }
}

class FakeStore {
  starts = 0
  stops = 0
  async start() { this.starts += 1; return { timescaleAvailable: false, continuousAggregates: false } }
  async stop() { this.stops += 1 }
  async execute(sql: string): Promise<readonly Record<string, unknown>[]> {
    if (sql.includes('continuous_aggregates')) return []
    return []
  }
  async transaction<T>(operation: (client: QmsSqlPort) => Promise<T>) { return operation(this) }
}

class FakeRedis {
  connects = 0
  pings = 0
  quits = 0
  failPing = false
  async connect() { this.connects += 1 }
  async ping() { this.pings += 1; if (this.failPing) throw new Error('redis unavailable'); return 'PONG' }
  async quit() { this.quits += 1; return 'OK' }
  async eval() { return [] }
  async llen() { return 0 }
  async hlen() { return 0 }
  async rpush() { return 1 }
}

describe('QMS runtime lifecycle', () => {
  it('prefers tenant source maps and falls back to migrated global source maps', async () => {
    const statements: string[] = []
    const repository = new PostgresSourceMapRepository({
      execute: async sql => { statements.push(sql); return [{ map_content: '{}' }] },
    })

    assert.equal(await repository.find('ENT-A', '1.0.0', 'darwin', 'main.js'), '{}')
    assert.match(statements[0]!, /tenant_id = \$1 OR tenant_id IS NULL/)
    assert.match(statements[0]!, /ORDER BY tenant_id NULLS LAST/)
  })

  it('does not create external resources while QMS is disabled', async () => {
    let created = false
    const result = await startQmsRuntime({
      config: { ...config(), enabled: false }, ownerId: 'instance-1',
      organizations: { getCode: () => null, hasCode: () => false },
      secrets: { get: () => undefined, put: async () => undefined },
      dependencies: {
        createStore: () => { created = true; return new FakeStore() },
        createRedis: () => { created = true; return new FakeRedis() },
      },
    })
    assert.equal(result, undefined)
    assert.equal(created, false)
  })

  it('starts one unified service graph and stops external resources idempotently', async () => {
    const store = new FakeStore()
    const redis = new FakeRedis()
    const runtime = await startQmsRuntime({
      config: config(), ownerId: 'instance-1',
      organizations: { getCode: orgId => orgId === 'org-a' ? 'tenant-a' : null, hasCode: code => code === 'tenant-a' },
      secrets: { get: () => undefined, put: async () => undefined },
      dependencies: { createStore: () => store, createRedis: () => redis },
    })

    assert.ok(runtime)
    assert.equal(store.starts, 1)
    assert.equal(redis.connects, 1)
    assert.equal(redis.pings, 1)
    assert.equal(runtime.apiKeyHeader, 'X-QMS-Key')
    assert.equal(runtime.operations.supports('GET /api/v1/qms/system/health'), true)

    await runtime.stop()
    await runtime.stop()
    assert.equal(redis.quits, 1)
    assert.equal(store.stops, 1)
  })

  it('closes PostgreSQL and Redis when startup fails after connecting', async () => {
    const store = new FakeStore()
    const redis = new FakeRedis()
    redis.failPing = true

    await assert.rejects(() => startQmsRuntime({
      config: config(), ownerId: 'instance-1',
      organizations: { getCode: () => null, hasCode: () => false },
      secrets: { get: () => undefined, put: async () => undefined },
      dependencies: { createStore: () => store, createRedis: () => redis },
    }), /redis unavailable/)

    assert.equal(redis.quits, 1)
    assert.equal(store.stops, 1)
  })
})
