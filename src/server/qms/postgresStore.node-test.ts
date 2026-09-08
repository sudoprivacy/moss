import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { QmsPostgresStore, type QmsDatabaseClient } from './postgresStore.js'

class FakeClient implements QmsDatabaseClient {
  readonly statements: string[] = []
  closeCalls = 0
  failHealth = false
  timescaleAvailable = false

  async execute(sql: string): Promise<readonly Record<string, unknown>[]> {
    this.statements.push(sql)
    if (this.failHealth && sql === 'SELECT 1 AS healthy') throw new Error('database unavailable')
    if (sql.includes("FROM pg_extension")) return this.timescaleAvailable ? [{ available: true }] : []
    return [{ healthy: 1 }]
  }

  async transaction<T>(operation: (client: QmsDatabaseClient) => Promise<T>): Promise<T> {
    return operation(this)
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }
}

describe('QmsPostgresStore lifecycle', () => {
  it('connects lazily, verifies health and initializes schema', async () => {
    const client = new FakeClient()
    let factoryCalls = 0
    const store = new QmsPostgresStore('postgres://qms:secret@db/qms', () => {
      factoryCalls += 1
      return client
    })

    assert.equal(factoryCalls, 0)
    const state = await store.start()

    assert.equal(factoryCalls, 1)
    assert.equal(state.timescaleAvailable, false)
    assert.equal(client.statements[0], 'SELECT 1 AS healthy')
    assert.match(client.statements[1]!, /CREATE TABLE IF NOT EXISTS telemetry_perf_raw/)
    assert.deepEqual(await store.execute('SELECT 2 AS value'), [{ healthy: 1 }])
  })

  it('closes a partially started client when initialization fails', async () => {
    const client = new FakeClient()
    client.failHealth = true
    const store = new QmsPostgresStore('postgres://qms:secret@db/qms', () => client)

    await assert.rejects(() => store.start(), /database unavailable/)
    assert.equal(client.closeCalls, 1)
    await assert.rejects(() => store.execute('SELECT 1'), /not started/)
  })

  it('starts and stops idempotently', async () => {
    const client = new FakeClient()
    let factoryCalls = 0
    const store = new QmsPostgresStore('postgres://qms:secret@db/qms', () => {
      factoryCalls += 1
      return client
    })

    await store.start()
    await store.start()
    await store.stop()
    await store.stop()

    assert.equal(factoryCalls, 1)
    assert.equal(client.closeCalls, 1)
  })

  it('allows the migration command to force regular aggregate tables', async () => {
    const client = new FakeClient()
    client.timescaleAvailable = true
    const store = new QmsPostgresStore(
      'postgres://qms:secret@db/qms',
      () => client,
      { aggregateMode: 'regular' },
    )

    const state = await store.start()

    assert.deepEqual(state, { timescaleAvailable: true, continuousAggregates: false })
    assert(client.statements.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS telemetry_perf_daily')))
    assert.equal(client.statements.some(sql => sql.includes('CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_perf_daily')), false)
  })
})
