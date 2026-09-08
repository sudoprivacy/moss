import type { QmsSqlPort } from './qmsSchema.js'
import type { TelemetryKind, TelemetryQueueMessage } from './reliableTelemetryQueue.js'

export interface QmsTransactionalSqlPort extends QmsSqlPort {
  transaction<T>(operation: (client: QmsSqlPort) => Promise<T>): Promise<T>
}

const COMMON_COLUMNS = [
  'ingest_id', 'timestamp', 'version', 'platform', 'arch', 'org_id', 'user_id', 'tenant_id',
  'login_mode', 'agent_type', 'user_nickname', 'user_phone',
] as const

const KIND_COLUMNS: Record<TelemetryKind, readonly string[]> = {
  perf: ['metric', 'value_ms', 'session_id'],
  conversation: [
    'session_id', 'model_id', 'model_provider', 'status', 'duration_ms', 'tokens_used',
    'input_tokens', 'output_tokens', 'error_code',
  ],
  turn: [
    'turn_id', 'session_id', 'model_id', 'model_provider', 'input_tokens', 'output_tokens',
    'total_tokens', 'duration_ms', 'status', 'error_code',
  ],
  step: [
    'step_id', 'turn_id', 'session_id', 'step_type', 'tool_name', 'tool_kind', 'file_path',
    'permission_kind', 'thinking_tokens', 'duration_ms', 'status',
  ],
  install: ['install_id', 'status', 'duration_ms', 'install_type', 'previous_version', 'error_message'],
}

const TABLES: Record<TelemetryKind, string> = {
  perf: 'telemetry_perf_raw',
  conversation: 'telemetry_conversations',
  turn: 'telemetry_turns',
  step: 'telemetry_steps',
  install: 'telemetry_install',
}

const REQUIRED_FIELDS: Record<TelemetryKind, readonly string[]> = {
  perf: ['timestamp', 'version', 'platform', 'tenant_id', 'metric', 'value_ms'],
  conversation: ['timestamp', 'version', 'platform', 'tenant_id', 'session_id', 'model_id', 'status', 'duration_ms'],
  turn: ['timestamp', 'version', 'platform', 'tenant_id', 'turn_id', 'session_id', 'model_id', 'status', 'duration_ms'],
  step: ['timestamp', 'version', 'platform', 'tenant_id', 'step_id', 'turn_id', 'session_id', 'step_type', 'status'],
  install: ['timestamp', 'version', 'platform', 'tenant_id', 'install_id', 'status', 'duration_ms'],
}

function valueFor(column: string, message: TelemetryQueueMessage): unknown {
  if (column === 'ingest_id') return message.ingestId
  if (column === 'timestamp') return new Date(Number(message.payload.timestamp))
  if (column === 'arch') return message.payload.arch ?? 'unknown'
  return message.payload[column] ?? null
}

function validate(message: TelemetryQueueMessage): void {
  if (!message.ingestId.trim()) throw new Error('QMS telemetry ingest id is required')
  for (const field of REQUIRED_FIELDS[message.kind]) {
    const value = message.payload[field]
    if (value === undefined || value === null || value === '') {
      throw new Error(`QMS ${message.kind} event requires ${field}`)
    }
    if (field === 'timestamp' && !Number.isFinite(Number(value))) {
      throw new Error(`QMS ${message.kind} event requires a valid timestamp`)
    }
  }
}

export class TelemetryPostgresWriter {
  constructor(private readonly db: QmsTransactionalSqlPort) {}

  async persist(messages: readonly TelemetryQueueMessage[]): Promise<void> {
    for (const message of messages) validate(message)
    if (messages.length === 0) return
    await this.db.transaction(async transaction => {
      for (const message of messages) {
        const receipt = await transaction.execute(
          `INSERT INTO qms_ingest_receipts (ingest_id, kind, tenant_id, event_timestamp)
           VALUES ($1,$2,$3,$4) ON CONFLICT (ingest_id) DO NOTHING RETURNING ingest_id`,
          [message.ingestId, message.kind, message.payload.tenant_id, new Date(Number(message.payload.timestamp))],
        )
        if (!receipt[0]) continue
        const columns = [...COMMON_COLUMNS, ...KIND_COLUMNS[message.kind]]
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ')
        await transaction.execute(
          `INSERT INTO ${TABLES[message.kind]} (${columns.join(', ')}) VALUES (${placeholders})`,
          columns.map(column => valueFor(column, message)),
        )
      }
    })
  }
}
