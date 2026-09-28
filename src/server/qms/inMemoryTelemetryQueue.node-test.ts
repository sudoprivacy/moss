import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InMemoryTelemetryQueue } from './inMemoryTelemetryQueue.js'

const event = (id: string) => ({ kind: 'perf' as const, payload: { value: id }, ingestId: id })
const defaults = { maxItems: 3, maxBytes: 4096, retryIntervalMs: 2 }

void describe('process-local QMS memory queue', () => {
  void it('keeps FIFO order and retries failed persistence without losing acknowledged events', async () => {
    let now = 100
    let failed = true
    const persisted: string[][] = []
    const queue = new InMemoryTelemetryQueue({ ...defaults, now: () => now, persist: async messages => {
      if (failed) throw new Error('database unavailable')
      persisted.push(messages.map(message => message.ingestId))
    } })
    await queue.enqueueMany([event('1'), event('2'), event('3')])
    await assert.rejects(queue.processBatch(2), /database unavailable/)
    assert.equal(await queue.processBatch(2), 0)
    assert.deepEqual(await queue.depths(), { pending: 3, processing: 0 })
    failed = false
    now += 3
    await queue.processBatch(2)
    await queue.processBatch(2)
    assert.deepEqual(persisted, [['1', '2'], ['3']])
    assert.equal(queue.status().bytes, 0)
  })

  void it('rejects an entire overflowing batch, including in-flight work in capacity', async () => {
    let complete!: () => void
    const gate = new Promise<void>(resolve => { complete = resolve })
    let calls = 0
    const queue = new InMemoryTelemetryQueue({ ...defaults, persist: async () => { calls++; await gate } })
    await queue.enqueueMany([event('1'), event('2')])
    const first = queue.processBatch(2)
    const second = queue.processBatch(2)
    assert.equal(first, second)
    await assert.rejects(queue.enqueueMany([event('3'), event('4')]), /queue is full/)
    assert.deepEqual(await queue.depths(), { pending: 0, processing: 2 })
    complete()
    await first
    assert.equal(calls, 1)
    assert.deepEqual(await queue.depths(), { pending: 0, processing: 0 })
  })

  void it('bounds payload bytes and snapshots data instead of retaining mutable caller objects', async () => {
    const saved: unknown[] = []
    const queue = new InMemoryTelemetryQueue({ ...defaults, maxBytes: 200, persist: async messages => { saved.push(...messages) } })
    await assert.rejects(queue.enqueueMany([{ kind: 'perf', payload: { value: 'x'.repeat(201) } }]), /queue is full/)
    assert.equal(queue.status().bytes, 0)
    const input = event('original')
    await queue.enqueueMany([input])
    input.payload.value = 'changed'
    await queue.processBatch(1)
    assert.equal((saved[0] as any).payload.value, 'original')
  })

  void it('stops accepting and flushes all remaining work with bounded retries during shutdown', async () => {
    let calls = 0
    const queue = new InMemoryTelemetryQueue({ ...defaults, persist: async () => { if (++calls === 1) throw new Error('transient') } })
    await queue.enqueueMany([event('1'), event('2')])
    assert.equal(await queue.drain(1, 1000), true)
    assert.equal(calls, 3)
    await assert.rejects(queue.enqueueMany([event('3')]), /shutting down/)
    assert.equal(queue.status().bytes, 0)
  })

  void it('reports an unsuccessful drain instead of silently discarding unsaved messages', async () => {
    const queue = new InMemoryTelemetryQueue({ ...defaults, persist: async () => { throw new Error('offline') } })
    await queue.enqueueMany([event('1')])
    assert.equal(await queue.drain(1, 10), false)
    assert.equal(queue.status().pending, 1)
    const restarted = new InMemoryTelemetryQueue({ ...defaults, persist: async () => {} })
    assert.equal(restarted.status().pending, 0)
  })
})
