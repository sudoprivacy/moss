import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Redis from 'ioredis'

import { QmsPostgresStore } from './postgresStore.js'
import { PostgresQmsLeaseStore } from './qmsLeaseStore.js'
import { RedisTelemetryQueueBackend } from './redisTelemetryQueueBackend.js'

const postgresUrl = process.env.QMS_INTEGRATION_POSTGRES_URL
const redisUrl = process.env.QMS_INTEGRATION_REDIS_URL

describe('QMS 真实基础设施门禁', () => {
  it('在独立 PostgreSQL 测试库初始化 schema 并验证跨实例租约', { skip: !postgresUrl }, async () => {
    const store = new QmsPostgresStore(postgresUrl!, undefined, { aggregateMode: 'regular' })
    const task = `integration-${randomUUID()}`
    try {
      const state = await store.start()
      assert.equal(typeof state.timescaleAvailable, 'boolean')
      assert.equal(state.continuousAggregates, false)
      const first = new PostgresQmsLeaseStore(store)
      const second = new PostgresQmsLeaseStore(store)
      const now = Date.now()
      assert.equal(await first.tryAcquire(task, 'worker-a', now, 60_000), true)
      assert.equal(await second.tryAcquire(task, 'worker-b', now + 1, 60_000), false)
      await first.complete(task, 'worker-a', now + 2)
      assert.equal(await second.tryAcquire(task, 'worker-b', now + 3, 60_000), true)
    } finally {
      try { await store.execute('DELETE FROM qms_task_leases WHERE task_name = $1', [task]) } catch {}
      await store.stop()
    }
  })

  it('在独立 Redis 测试库验证 processing 超时恢复且不丢事件', { skip: !redisUrl }, async () => {
    const redis = new Redis(redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 })
    const namespace = `moss:qms:integration:${randomUUID()}`
    try {
      await redis.connect()
      const backend = new RedisTelemetryQueueBackend(redis, namespace)
      await backend.enqueue({ ingestId: 'event-1', kind: 'perf', payload: { metric: 'startup' } })
      const claimed = await backend.claim('worker-a', 1, 1_000, 100)
      assert.equal(claimed.length, 1)
      assert.deepEqual(await backend.depths(), { pending: 0, processing: 1 })
      assert.equal(await backend.recoverExpired(1_101), 1)
      assert.deepEqual(await backend.depths(), { pending: 1, processing: 0 })
    } finally {
      await redis.del(
        `${namespace}:telemetry:pending`, `${namespace}:telemetry:processing`,
        `${namespace}:telemetry:deadlines`, `${namespace}:telemetry:receipt-sequence`,
      )
      await redis.quit()
    }
  })
})
