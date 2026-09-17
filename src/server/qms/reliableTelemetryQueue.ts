import { randomUUID } from 'node:crypto'

export type TelemetryKind = 'perf' | 'conversation' | 'turn' | 'step' | 'install'

export interface TelemetryQueueMessage {
  ingestId: string
  kind: TelemetryKind
  payload: Record<string, unknown>
}

export interface ClaimedTelemetryMessage extends TelemetryQueueMessage {
  receipt: string
  claimedAt: number
  visibleAt: number
}

export interface TelemetryQueueBackend {
  enqueue(message: TelemetryQueueMessage): Promise<number>
  enqueueMany(messages: readonly TelemetryQueueMessage[]): Promise<number>
  claim(workerId: string, limit: number, now: number, visibilityTimeoutMs: number): Promise<ClaimedTelemetryMessage[]>
  acknowledge(receipts: string[]): Promise<void>
  recoverExpired(now: number): Promise<number>
  depths(): Promise<{ pending: number; processing: number }>
}

export interface ReliableTelemetryQueueOptions {
  backend: TelemetryQueueBackend
  workerId: string
  visibilityTimeoutMs: number
  persist(messages: readonly TelemetryQueueMessage[]): Promise<void>
  createId?: () => string
}

export class ReliableTelemetryQueue {
  private readonly createId: () => string

  constructor(private readonly options: ReliableTelemetryQueueOptions) {
    if (!options.workerId.trim()) throw new Error('QMS queue worker id is required')
    if (!Number.isInteger(options.visibilityTimeoutMs) || options.visibilityTimeoutMs <= 0) {
      throw new Error('QMS queue visibility timeout must be a positive integer')
    }
    this.createId = options.createId ?? randomUUID
  }

  async enqueue(
    kind: TelemetryKind,
    payload: Record<string, unknown>,
    requestedIngestId?: string,
  ): Promise<{ ingestId: string; depth: number }> {
    if (requestedIngestId !== undefined && !requestedIngestId.trim()) {
      throw new Error('QMS ingest id must not be empty')
    }
    const ingestId = requestedIngestId?.trim() || this.createId()
    if (!ingestId.trim()) throw new Error('QMS ingest id must not be empty')
    const depth = await this.options.backend.enqueue({ ingestId, kind, payload })
    return { ingestId, depth }
  }

  async enqueueMany(
    inputs: readonly { kind: TelemetryKind; payload: Record<string, unknown>; ingestId?: string }[],
  ): Promise<{ messages: TelemetryQueueMessage[]; depth: number }> {
    const messages = inputs.map(input => {
      if (input.ingestId !== undefined && !input.ingestId.trim()) {
        throw new Error('QMS ingest id must not be empty')
      }
      const ingestId = input.ingestId?.trim() || this.createId()
      if (!ingestId.trim()) throw new Error('QMS ingest id must not be empty')
      return { ingestId, kind: input.kind, payload: input.payload }
    })
    const depth = messages.length === 0
      ? (await this.options.backend.depths()).pending
      : await this.options.backend.enqueueMany(messages)
    return { messages, depth }
  }

  async processBatch(limit: number, now = Date.now()): Promise<number> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('QMS queue batch limit must be a positive integer')
    const claimed = await this.options.backend.claim(
      this.options.workerId,
      limit,
      now,
      this.options.visibilityTimeoutMs,
    )
    if (claimed.length === 0) return 0

    await this.options.persist(claimed.map(({ receipt: _receipt, claimedAt: _claimedAt, visibleAt: _visibleAt, ...message }) => message))
    await this.options.backend.acknowledge(claimed.map(message => message.receipt))
    return claimed.length
  }

  recoverExpired(now = Date.now()): Promise<number> {
    return this.options.backend.recoverExpired(now)
  }

  depths(): Promise<{ pending: number; processing: number }> {
    return this.options.backend.depths()
  }
}
