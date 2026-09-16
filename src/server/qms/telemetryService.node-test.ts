import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { TelemetryService, TelemetryServiceError, type TelemetryBatchQueue } from './telemetryService.js'

class RecordingQueue implements TelemetryBatchQueue {
  calls: Array<Array<{ kind: string; payload: Record<string, unknown>; ingestId?: string }>> = []

  async enqueueMany(items: readonly { kind: 'perf' | 'conversation' | 'turn' | 'step' | 'install'; payload: Record<string, unknown>; ingestId?: string }[]) {
    this.calls.push([...items])
    return { messages: [], depth: items.length }
  }
}

const tenants = { hasCode: (code: string) => code === 'tenant-a' }

describe('TelemetryService', () => {
  it('normalizes and atomically enqueues the five legacy batch arrays', async () => {
    const queue = new RecordingQueue()
    const service = new TelemetryService({ queue, tenants, now: () => 1234 })
    const result = await service.ingestBatch({
      tenant_id: 'tenant-a',
      org_id: 'legacy-org',
      user_id: '42',
      perf: [{ metric: 'startup', value_ms: 10, timestamp: 1, version: '1', platform: 'darwin' }],
      conversations: [{ session_id: 's', model_id: 'm', status: 'success', duration_ms: 2, timestamp: 2, version: '1', platform: 'darwin' }],
      turns: [{ turn_id: 't', session_id: 's', model_id: 'm', status: 'success', duration_ms: 2, timestamp: 3, version: '1', platform: 'darwin' }],
      steps: [{ step_id: 'p', turn_id: 't', session_id: 's', step_type: 'thinking', status: 'success', timestamp: 4, version: '1', platform: 'darwin' }],
      installs: [{ install_id: 'i', status: 'success', duration_ms: 5, timestamp: 5, version: '1', platform: 'darwin' }],
    })

    assert.deepEqual(result, {
      received: { perf: 1, conversations: 1, turns: 1, steps: 1, installs: 1 },
      timestamp: 1234,
      queued: true,
    })
    assert.equal(queue.calls.length, 1)
    assert.equal(queue.calls[0]?.length, 5)
    assert.equal(queue.calls[0]?.every(item => item.payload.tenant_id === 'tenant-a'), true)
    assert.equal(queue.calls[0]?.every(item => item.payload.user_id === '42'), true)
  })

  it('normalizes the newer event envelope and preserves client event ids', async () => {
    const queue = new RecordingQueue()
    const service = new TelemetryService({ queue, tenants })

    await service.ingestBatch({
      tenant_id: 'tenant-a',
      events: [{
        id: 'client-event-1', type: 'perf', timestamp: 9, version: '2', platform: 'linux',
        data: { metric: 'tool', value_ms: 7 },
      }],
    })

    assert.deepEqual(queue.calls[0]?.[0], {
      kind: 'perf',
      ingestId: 'client-event-1',
      payload: {
        metric: 'tool', value_ms: 7, timestamp: 9, version: '2', platform: 'linux',
        tenant_id: 'tenant-a',
      },
    })
  })

  it('rejects missing and unknown tenants before enqueueing any item', async () => {
    const queue = new RecordingQueue()
    const service = new TelemetryService({ queue, tenants })

    await assert.rejects(() => service.ingestBatch({ perf: [{ metric: 'x' }] }),
      (error: unknown) => error instanceof TelemetryServiceError
        && error.code === 'TENANT_ID_REQUIRED' && error.items[0] === 'perf[0]')
    await assert.rejects(() => service.ingestSingle('perf', { tenant_id: 'unknown', metric: 'x' }),
      (error: unknown) => error instanceof TelemetryServiceError
        && error.code === 'TENANT_NOT_FOUND' && error.items[0] === 'perf')
    assert.equal(queue.calls.length, 0)
  })

  it('rejects an oversized batch before queueing', async () => {
    const queue = new RecordingQueue()
    const service = new TelemetryService({ queue, tenants, maxBatchSize: 2 })

    await assert.rejects(() => service.ingestBatch({
      tenant_id: 'tenant-a',
      perf: [{ metric: 'a' }, { metric: 'b' }, { metric: 'c' }],
    }), (error: unknown) => error instanceof TelemetryServiceError && error.code === 'BATCH_TOO_LARGE')
    assert.equal(queue.calls.length, 0)
  })
})
