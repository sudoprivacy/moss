import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import type { TelemetryKind, TelemetryQueueMessage } from './telemetryTypes.js'
import { TelemetryServiceError } from './telemetryService.js'

type Entry = { message: TelemetryQueueMessage; bytes: number }

/** Volatile, bounded FIFO. A successful ingestion response means accepted into this process. */
export class InMemoryTelemetryQueue {
  private readonly pending: Entry[] = []
  private bytes = 0
  private processing = 0
  private accepting = true
  private inFlight?: Promise<number>
  private nextAttemptAt = 0
  private failures = 0

  constructor(
    private readonly options: {
      maxItems: number
      maxBytes: number
      retryIntervalMs: number
      persist(messages: readonly TelemetryQueueMessage[]): Promise<void>
      now?: () => number
    },
  ) {
    for (const value of [options.maxItems, options.maxBytes, options.retryIntervalMs]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error('QMS memory queue limits must be positive integers')
    }
  }

  async enqueueMany(
    items: readonly { kind: TelemetryKind; payload: Record<string, unknown>; ingestId?: string }[],
  ) {
    if (!this.accepting)
      throw new TelemetryServiceError(503, 'QUEUE_CLOSED', 'QMS is shutting down; retry another instance')
    if (this.pending.length + items.length > this.options.maxItems) {
      throw new TelemetryServiceError(503, 'QUEUE_FULL', 'QMS memory queue is full; retry later')
    }
    const entries = items.map((item) => {
      const message = { kind: item.kind, payload: item.payload, ingestId: item.ingestId ?? randomUUID() }
      const json = JSON.stringify(message)
      return { message: JSON.parse(json) as TelemetryQueueMessage, bytes: Buffer.byteLength(json) }
    })
    const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    if (
      this.pending.length + entries.length > this.options.maxItems ||
      this.bytes + bytes > this.options.maxBytes
    ) {
      throw new TelemetryServiceError(503, 'QUEUE_FULL', 'QMS memory queue is full; retry later')
    }
    this.pending.push(...entries)
    this.bytes += bytes
    return { messages: entries.map((entry) => entry.message), depth: this.pending.length }
  }

  processBatch(limit: number, force = false): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1)
      return Promise.reject(new Error('Invalid QMS queue batch size'))
    if (this.inFlight) return this.inFlight
    if (!this.pending.length || (!force && this.now() < this.nextAttemptAt)) return Promise.resolve(0)
    const batch = this.pending.slice(0, limit)
    this.processing = batch.length
    const operation = Promise.resolve().then(async () => {
      try {
        await this.options.persist(batch.map((entry) => entry.message))
        this.pending.splice(0, batch.length)
        this.bytes -= batch.reduce((sum, entry) => sum + entry.bytes, 0)
        this.failures = 0
        this.nextAttemptAt = 0
        return batch.length
      } catch (error) {
        this.failures++
        this.nextAttemptAt =
          this.now() + Math.min(30_000, this.options.retryIntervalMs * 2 ** Math.min(this.failures - 1, 10))
        throw error
      } finally {
        this.processing = 0
        this.inFlight = undefined
      }
    })
    this.inFlight = operation
    return operation
  }

  async depths() {
    return { pending: this.pending.length - this.processing, processing: this.processing }
  }

  status() {
    return {
      queue_mode: 'memory',
      pending: this.pending.length - this.processing,
      processing: this.processing,
      bytes: this.bytes,
      capacity: this.options.maxItems,
      max_bytes: this.options.maxBytes,
      accepting: this.accepting,
      consecutive_failures: this.failures,
    }
  }

  close(): void {
    this.accepting = false
  }

  /** Stop accepting, wait for current persistence, then flush the remainder within the grace period. */
  async drain(batchSize: number, timeoutMs: number): Promise<boolean> {
    this.close()
    const deadline = Date.now() + timeoutMs
    while (this.pending.length) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const completed = await Promise.race([
          this.processBatch(batchSize, true).then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), remaining)
          }),
        ])
        if (!completed) return false
      } catch {
        await delay(Math.min(this.options.retryIntervalMs, Math.max(0, deadline - Date.now())))
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    return true
  }

  private now() {
    return this.options.now?.() ?? Date.now()
  }
}
