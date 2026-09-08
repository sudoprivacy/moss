import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { RedisTelemetryQueueBackend, type RedisScriptPort } from './redisTelemetryQueueBackend.js'

class FakeRedis implements RedisScriptPort {
  readonly calls: Array<{ script: string; keys: number; args: string[] }> = []
  responses: unknown[] = []

  async eval(script: string, keys: number, ...args: string[]): Promise<unknown> {
    this.calls.push({ script, keys, args })
    return this.responses.shift()
  }

  async llen(key: string): Promise<number> {
    return key.endsWith(':pending') ? 4 : 0
  }

  async hlen(key: string): Promise<number> {
    return key.endsWith(':processing') ? 2 : 0
  }

  async rpush(_key: string, ..._values: string[]): Promise<number> {
    return 7
  }
}

describe('RedisTelemetryQueueBackend', () => {
  it('uses one atomic claim script and decodes receipt/message pairs', async () => {
    const redis = new FakeRedis()
    redis.responses.push([
      'worker-a:1', JSON.stringify({ ingestId: 'event-1', kind: 'perf', payload: { value_ms: 5 } }),
    ])
    const backend = new RedisTelemetryQueueBackend(redis, 'qms:test')

    const claimed = await backend.claim('worker-a', 10, 1_000, 500)

    assert.equal(redis.calls.length, 1)
    assert.equal(redis.calls[0]?.keys, 4)
    assert.deepEqual(claimed, [{
      ingestId: 'event-1',
      kind: 'perf',
      payload: { value_ms: 5 },
      receipt: 'worker-a:1',
      claimedAt: 1_000,
      visibleAt: 1_500,
    }])
  })

  it('acknowledges and recovers through atomic scripts', async () => {
    const redis = new FakeRedis()
    redis.responses.push(2, 3)
    const backend = new RedisTelemetryQueueBackend(redis, 'qms:test')

    await backend.acknowledge(['r1', 'r2'])
    assert.equal(await backend.recoverExpired(2_000), 3)
    assert.equal(redis.calls.length, 2)
    assert.equal(redis.calls[0]?.keys, 2)
    assert.equal(redis.calls[1]?.keys, 3)
  })

  it('keeps queue keys namespaced and reports pending plus processing depths', async () => {
    const redis = new FakeRedis()
    const backend = new RedisTelemetryQueueBackend(redis, 'moss:qms')

    assert.equal(await backend.enqueue({ ingestId: 'event-1', kind: 'install', payload: {} }), 7)
    assert.deepEqual(await backend.depths(), { pending: 4, processing: 2 })
  })

  it('pushes a batch with one Redis command', async () => {
    const redis = new FakeRedis()
    let pushes = 0
    redis.rpush = async (_key: string, ...values: string[]) => {
      pushes += 1
      assert.equal(values.length, 2)
      return 2
    }
    const backend = new RedisTelemetryQueueBackend(redis, 'moss:qms')

    await backend.enqueueMany([
      { ingestId: 'one', kind: 'perf', payload: {} },
      { ingestId: 'two', kind: 'step', payload: {} },
    ])
    assert.equal(pushes, 1)
  })
})
