import type { TelemetryKind, TelemetryQueueMessage } from './reliableTelemetryQueue.js'

export interface TelemetryBatchQueue {
  enqueueMany(items: readonly {
    kind: TelemetryKind
    payload: Record<string, unknown>
    ingestId?: string
  }[]): Promise<{ messages: TelemetryQueueMessage[]; depth: number }>
}

export interface TelemetryTenantDirectory {
  hasCode(code: string): boolean
}

export class TelemetryServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly items: string[] = [],
  ) {
    super(message)
    this.name = 'TelemetryServiceError'
  }
}

const KINDS: readonly TelemetryKind[] = ['perf', 'conversation', 'turn', 'step', 'install']
const LEGACY_KEYS: Record<string, TelemetryKind> = {
  perf: 'perf',
  conversations: 'conversation',
  turns: 'turn',
  steps: 'step',
  installs: 'install',
}
const COMMON_FIELDS = [
  'org_id', 'user_id', 'tenant_id', 'login_mode', 'agent_type', 'user_nickname', 'user_phone',
] as const

interface NormalizedTelemetryInput {
  kind: TelemetryKind
  payload: Record<string, unknown>
  ingestId?: string
  ref: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function mergeDefined(...sources: Array<Record<string, unknown> | null | undefined>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const source of sources) {
    if (!source) continue
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) output[key] = value
    }
  }
  return output
}

export class TelemetryService {
  private readonly now: () => number
  private readonly maxBatchSize: number

  constructor(private readonly options: {
    queue: TelemetryBatchQueue
    tenants: TelemetryTenantDirectory
    now?: () => number
    maxBatchSize?: number
  }) {
    this.now = options.now ?? Date.now
    this.maxBatchSize = options.maxBatchSize ?? 1_000
  }

  async ingestBatch(body: unknown, authenticatedTenant?: string): Promise<{
    received: { perf: number; conversations: number; turns: number; steps: number; installs: number }
    timestamp: number
    queued: true
  }> {
    const input = record(body)
    if (!input) throw new TelemetryServiceError(400, 'INVALID_PAYLOAD', 'Invalid telemetry payload')
    const items = Array.isArray(input.events)
      ? this.fromEventEnvelope(input, authenticatedTenant)
      : this.fromLegacyEnvelope(input, authenticatedTenant)
    if (items.length > this.maxBatchSize) {
      throw new TelemetryServiceError(413, 'BATCH_TOO_LARGE', 'Telemetry batch is too large')
    }
    this.validateTenants(items)
    await this.options.queue.enqueueMany(items.map(({ ref: _ref, ...item }) => item))
    const received = { perf: 0, conversations: 0, turns: 0, steps: 0, installs: 0 }
    for (const item of items) {
      const key = item.kind === 'conversation' ? 'conversations'
        : item.kind === 'turn' ? 'turns'
          : item.kind === 'step' ? 'steps'
            : item.kind === 'install' ? 'installs'
              : 'perf'
      received[key] += 1
    }
    return { received, timestamp: this.now(), queued: true }
  }

  async ingestSingle(kind: 'perf' | 'conversation' | 'install', body: unknown, authenticatedTenant?: string): Promise<{
    timestamp: number
    queued: true
  }> {
    const input = record(body)
    if (!input) throw new TelemetryServiceError(400, 'INVALID_PAYLOAD', 'Invalid telemetry payload')
    const payload = this.withTenant(input, authenticatedTenant)
    const item: NormalizedTelemetryInput = { kind, payload, ingestId: text(input.event_id), ref: kind }
    this.validateTenants([item])
    const { ref: _ref, ...queued } = item
    await this.options.queue.enqueueMany([queued])
    return { timestamp: this.now(), queued: true }
  }

  private fromLegacyEnvelope(input: Record<string, unknown>, authenticatedTenant?: string) {
    const common: Record<string, unknown> = {}
    for (const field of COMMON_FIELDS) {
      if (input[field] !== undefined) common[field] = input[field]
    }
    const items: NormalizedTelemetryInput[] = []
    for (const [key, kind] of Object.entries(LEGACY_KEYS)) {
      const values = input[key]
      if (!Array.isArray(values)) continue
      for (const [index, raw] of values.entries()) {
        const item = record(raw)
        if (!item) throw new TelemetryServiceError(400, 'INVALID_PAYLOAD', `Invalid ${key} event`)
        const payload = this.withTenant(mergeDefined(common, item), authenticatedTenant)
        items.push({ kind, payload, ingestId: text(item.event_id), ref: `${key}[${index}]` })
      }
    }
    return items
  }

  private fromEventEnvelope(input: Record<string, unknown>, authenticatedTenant?: string) {
    const items: NormalizedTelemetryInput[] = []
    for (const [index, raw] of (input.events as unknown[]).entries()) {
      const event = record(raw)
      if (!event) throw new TelemetryServiceError(400, 'INVALID_PAYLOAD', 'Invalid telemetry event')
      const kind = text(event.type) as TelemetryKind | undefined
      const data = record(event.data)
      if (!kind || !KINDS.includes(kind) || !data) continue
      const envelope: Record<string, unknown> = {}
      for (const field of ['timestamp', 'version', 'platform', 'arch', ...COMMON_FIELDS]) {
        if (event[field] !== undefined) envelope[field] = event[field]
      }
      const common: Record<string, unknown> = {}
      for (const field of COMMON_FIELDS) {
        if (input[field] !== undefined) common[field] = input[field]
      }
      const payload = this.withTenant(mergeDefined(common, data, envelope), authenticatedTenant)
      items.push({ kind, payload, ingestId: text(event.id) ?? text(event.event_id), ref: `events[${index}]` })
    }
    return items
  }

  private withTenant(payload: Record<string, unknown>, authenticatedTenant?: string): Record<string, unknown> {
    const tenantId = text(payload.tenant_id) ?? text(authenticatedTenant)
    return tenantId ? { ...payload, tenant_id: tenantId } : payload
  }

  private validateTenants(items: readonly Pick<NormalizedTelemetryInput, 'payload' | 'ref'>[]): void {
    const missing: string[] = []
    for (const item of items) {
      const tenantId = text(item.payload.tenant_id)
      if (!tenantId) {
        missing.push(item.ref)
      } else if (!this.options.tenants.hasCode(tenantId)) {
        throw new TelemetryServiceError(400, 'TENANT_NOT_FOUND', `Unknown QMS tenant: ${tenantId}`, [item.ref])
      }
    }
    if (missing.length > 0) {
      throw new TelemetryServiceError(400, 'TENANT_ID_REQUIRED', 'tenant_id is required for QMS telemetry ingestion', missing)
    }
  }
}
