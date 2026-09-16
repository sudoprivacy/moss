import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ReliableTelemetryQueue,
  type ClaimedTelemetryMessage,
  type TelemetryQueueBackend,
  type TelemetryQueueMessage,
} from './reliableTelemetryQueue.js'

class MemoryQueue implements TelemetryQueueBackend {
  readonly pending: TelemetryQueueMessage[] = []
  readonly processing = new Map<string, ClaimedTelemetryMessage>()

  async enqueue(message: TelemetryQueueMessage): Promise<number> {
    this.pending.push(message)
    return this.pending.length
  }

  async enqueueMany(messages: readonly TelemetryQueueMessage[]): Promise<number> {
    this.pending.push(...messages)
    return this.pending.length
  }

  async claim(_workerId: string, limit: number, now: number, visibilityTimeoutMs: number) {
    const claimed = this.pending.splice(0, limit).map(message => ({
      ...message,
      receipt: `receipt:${message.ingestId}`,
      claimedAt: now,
      visibleAt: now + visibilityTimeoutMs,
    }))
    for (const message of claimed) this.processing.set(message.receipt, message)
    return claimed
  }

  async acknowledge(receipts: string[]): Promise<void> {
    for (const receipt of receipts) this.processing.delete(receipt)
  }

  async recoverExpired(now: number): Promise<number> {
    let recovered = 0
    for (const [receipt, message] of this.processing) {
      if (message.visibleAt > now) continue
      this.processing.delete(receipt)
      this.pending.push({ ingestId: message.ingestId, kind: message.kind, payload: message.payload })
      recovered += 1
    }
    return recovered
  }

  async depths() {
    return { pending: this.pending.length, processing: this.processing.size }
  }
}

describe('ReliableTelemetryQueue', () => {
  it('does not acknowledge a claimed batch when PostgreSQL persistence fails', async () => {
    const backend = new MemoryQueue()
    let fail = true
    const persisted: string[] = []
    const queue = new ReliableTelemetryQueue({
      backend,
      workerId: 'worker-a',
      visibilityTimeoutMs: 100,
      persist: async messages => {
        if (fail) throw new Error('postgres unavailable')
        persisted.push(...messages.map(message => message.ingestId))
      },
    })

    await queue.enqueue('perf', { metric: 'startup', value_ms: 12 }, 'event-1')
    await assert.rejects(() => queue.processBatch(10, 1_000), /postgres unavailable/)
    assert.deepEqual(await backend.depths(), { pending: 0, processing: 1 })

    assert.equal(await queue.recoverExpired(1_101), 1)
    fail = false
    assert.equal(await queue.processBatch(10, 1_102), 1)
    assert.deepEqual(persisted, ['event-1'])
    assert.deepEqual(await backend.depths(), { pending: 0, processing: 0 })
  })

  it('preserves a caller event id and generates one when the old payload has none', async () => {
    const backend = new MemoryQueue()
    const queue = new ReliableTelemetryQueue({
      backend,
      workerId: 'worker-a',
      visibilityTimeoutMs: 100,
      persist: async () => {},
      createId: () => 'generated-id',
    })

    const explicit = await queue.enqueue('conversation', { session_id: 's-1' }, 'client-event')
    const generated = await queue.enqueue('conversation', { session_id: 's-2' })

    assert.equal(explicit.ingestId, 'client-event')
    assert.equal(generated.ingestId, 'generated-id')
    assert.equal((await backend.depths()).pending, 2)
  })

  it('rejects an empty event id before touching Redis', async () => {
    const backend = new MemoryQueue()
    const queue = new ReliableTelemetryQueue({
      backend,
      workerId: 'worker-a',
      visibilityTimeoutMs: 100,
      persist: async () => {},
    })

    await assert.rejects(() => queue.enqueue('step', {}, '  '), /ingest id/)
    assert.equal((await backend.depths()).pending, 0)
  })

  it('enqueues a complete batch through one backend operation', async () => {
    const backend = new MemoryQueue()
    const queue = new ReliableTelemetryQueue({
      backend,
      workerId: 'worker-a',
      visibilityTimeoutMs: 100,
      persist: async () => {},
      createId: (() => {
        let value = 0
        return () => `generated-${++value}`
      })(),
    })

    const result = await queue.enqueueMany([
      { kind: 'perf', payload: { metric: 'startup' } },
      { kind: 'step', payload: { step_id: 'step-1' } },
    ])

    assert.deepEqual(result.messages.map(message => message.ingestId), ['generated-1', 'generated-2'])
    assert.equal(result.depth, 2)
  })
})
