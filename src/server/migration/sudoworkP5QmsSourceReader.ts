import { createHash } from 'node:crypto'

import type { QmsSqlPort } from '../qms/qmsSchema.js'

export const P5_QMS_TABLES = [
  'alert_config',
  'alert_history',
  'audit_logs',
  'system_config',
  'crash_issues',
  'source_maps',
  'telemetry_perf_raw',
  'telemetry_conversations',
  'telemetry_turns',
  'telemetry_steps',
  'telemetry_install',
  'crash_events',
  'crash_daily_stats',
  'telemetry_perf_daily',
  'telemetry_conversations_daily',
  'telemetry_conversation_errors_daily',
  'telemetry_turns_daily',
  'telemetry_steps_daily',
  'telemetry_install_daily',
  'telemetry_user_conversations_daily',
  'telemetry_user_turns_daily',
  'telemetry_user_steps_daily',
] as const

export type P5QmsTableName = typeof P5_QMS_TABLES[number]

export const P5_QMS_DERIVED_AGGREGATES = [
  'telemetry_perf_daily',
  'telemetry_conversations_daily',
  'telemetry_conversation_errors_daily',
  'telemetry_turns_daily',
  'telemetry_steps_daily',
  'telemetry_install_daily',
] as const satisfies readonly P5QmsTableName[]

export interface P5QmsTableSpec {
  name: P5QmsTableName
  requiredColumns: readonly string[]
  identityColumns: readonly string[]
  timeColumn?: 'timestamp' | 'bucket' | 'sent_at' | 'created_at' | 'uploaded_at' | 'first_seen'
  tenantColumn?: 'tenant_id'
  derivedAggregate?: boolean
  ingestKind?: 'perf' | 'conversation' | 'turn' | 'step' | 'install' | 'crash'
}

const commonTelemetry = ['timestamp', 'version', 'platform'] as const

export const P5_QMS_TABLE_SPECS: Readonly<Record<P5QmsTableName, P5QmsTableSpec>> = {
  alert_config: spec('alert_config', ['id', 'name', 'type', 'metric', 'threshold', 'comparison', 'level', 'channels', 'enabled', 'cooldown_minutes', 'created_at', 'updated_at'], ['id'], 'created_at'),
  alert_history: spec('alert_history', ['id', 'config_id', 'type', 'title', 'level', 'channels', 'sent_at'], ['id'], 'sent_at'),
  audit_logs: spec('audit_logs', ['id', 'action', 'created_at'], ['id'], 'created_at'),
  system_config: spec('system_config', ['key', 'value', 'updated_at'], ['key']),
  crash_issues: spec('crash_issues', ['id', 'fingerprint', 'title', 'type', 'level', 'count', 'first_seen', 'last_seen', 'status'], ['id'], 'first_seen', true),
  source_maps: spec('source_maps', ['id', 'version', 'platform', 'file_name', 'map_content', 'uploaded_at'], ['id'], 'uploaded_at'),
  telemetry_perf_raw: telemetrySpec('telemetry_perf_raw', [...commonTelemetry, 'id', 'metric', 'value_ms'], ['id', 'timestamp'], 'perf'),
  telemetry_conversations: telemetrySpec('telemetry_conversations', [...commonTelemetry, 'id', 'session_id', 'model_id', 'status', 'duration_ms'], ['id', 'timestamp'], 'conversation'),
  telemetry_turns: telemetrySpec('telemetry_turns', [...commonTelemetry, 'id', 'turn_id', 'session_id', 'model_id', 'duration_ms', 'status'], ['id', 'timestamp'], 'turn'),
  telemetry_steps: telemetrySpec('telemetry_steps', [...commonTelemetry, 'id', 'step_id', 'turn_id', 'session_id', 'step_type', 'status'], ['id', 'timestamp'], 'step'),
  telemetry_install: telemetrySpec('telemetry_install', [...commonTelemetry, 'install_id', 'status', 'duration_ms'], ['install_id', 'timestamp'], 'install'),
  crash_events: telemetrySpec('crash_events', [...commonTelemetry, 'id', 'process_type', 'type', 'fingerprint'], ['id', 'timestamp'], 'crash'),
  crash_daily_stats: aggregateSpec('crash_daily_stats', ['bucket', 'version', 'platform', 'type', 'count'], ['bucket', 'version', 'platform', 'tenant_id', 'type']),
  telemetry_perf_daily: aggregateSpec('telemetry_perf_daily', ['bucket', 'version', 'platform', 'arch', 'metric', 'count'], ['bucket', 'version', 'platform', 'arch', 'tenant_id', 'metric'], true),
  telemetry_conversations_daily: aggregateSpec('telemetry_conversations_daily', ['bucket', 'version', 'platform', 'arch', 'total_count'], ['bucket', 'version', 'platform', 'arch', 'tenant_id'], true),
  telemetry_conversation_errors_daily: aggregateSpec('telemetry_conversation_errors_daily', ['bucket', 'version', 'platform', 'arch', 'error_code', 'count'], ['bucket', 'version', 'platform', 'arch', 'tenant_id', 'error_code'], true),
  telemetry_turns_daily: aggregateSpec('telemetry_turns_daily', ['bucket', 'version', 'platform', 'arch', 'model_id', 'total_count'], ['bucket', 'version', 'platform', 'arch', 'tenant_id', 'model_id', 'model_provider'], true),
  telemetry_steps_daily: aggregateSpec('telemetry_steps_daily', ['bucket', 'version', 'platform', 'arch', 'step_type', 'total_count'], ['bucket', 'version', 'platform', 'arch', 'tenant_id', 'step_type'], true),
  telemetry_install_daily: aggregateSpec('telemetry_install_daily', ['bucket', 'version', 'platform', 'arch', 'success_count', 'failed_count', 'total_count'], ['bucket', 'version', 'platform', 'arch', 'tenant_id', 'install_type'], true),
  telemetry_user_conversations_daily: aggregateSpec('telemetry_user_conversations_daily', ['id', 'bucket', 'user_id', 'conversation_count'], ['bucket', 'user_id', 'org_id', 'tenant_id', 'login_mode']),
  telemetry_user_turns_daily: aggregateSpec('telemetry_user_turns_daily', ['id', 'bucket', 'user_id', 'turn_count'], ['bucket', 'user_id', 'org_id', 'tenant_id', 'login_mode']),
  telemetry_user_steps_daily: aggregateSpec('telemetry_user_steps_daily', ['id', 'bucket', 'user_id', 'step_type', 'step_count'], ['bucket', 'user_id', 'org_id', 'tenant_id', 'login_mode', 'step_type']),
}

export interface P5QmsSourceTableSnapshot {
  exists: boolean
  relationKind: string | null
  columns: string[]
  count: number
  checksum: string
  tenants: string[]
  minTime: string | null
  maxTime: string | null
}

export interface P5QmsSourceSnapshot {
  timescaleAvailable: boolean
  aggregateMode: 'regular' | 'continuous' | 'unknown'
  checksum: string
  tables: Record<P5QmsTableName, P5QmsSourceTableSnapshot>
}

function spec(
  name: P5QmsTableName,
  requiredColumns: readonly string[],
  identityColumns: readonly string[],
  timeColumn?: P5QmsTableSpec['timeColumn'],
  tenant = false,
): P5QmsTableSpec {
  return { name, requiredColumns, identityColumns, timeColumn, tenantColumn: tenant ? 'tenant_id' : undefined }
}

function telemetrySpec(
  name: P5QmsTableName,
  requiredColumns: readonly string[],
  identityColumns: readonly string[],
  ingestKind: P5QmsTableSpec['ingestKind'],
): P5QmsTableSpec {
  return { name, requiredColumns, identityColumns, timeColumn: 'timestamp', tenantColumn: 'tenant_id', ingestKind }
}

function aggregateSpec(
  name: P5QmsTableName,
  requiredColumns: readonly string[],
  identityColumns: readonly string[],
  derivedAggregate = false,
): P5QmsTableSpec {
  return { name, requiredColumns, identityColumns, timeColumn: 'bucket', tenantColumn: 'tenant_id', derivedAggregate }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function normalized(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(normalized)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalized(item)]))
  }
  return value
}

export function canonicalQmsRow(row: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(normalized(row))
}

export class SudoworkP5QmsSourceReader {
  constructor(private readonly db: QmsSqlPort) {}

  async readBatch(
    table: P5QmsTableName,
    offset: number,
    limit: number,
    knownColumns?: readonly string[],
  ): Promise<readonly Record<string, unknown>[]> {
    if (!P5_QMS_TABLES.includes(table)) throw new Error(`不允许读取 QMS 白名单外数据表: ${String(table)}`)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('QMS 源分页参数非法')
    }
    const columns = knownColumns ?? await this.columns(table)
    const spec = P5_QMS_TABLE_SPECS[table]
    const orderColumns = spec.identityColumns.filter(column => columns.includes(column))
    const stableColumns = orderColumns.length > 0 ? orderColumns : [...columns].sort()
    if (stableColumns.length === 0) return []
    const order = stableColumns.map(column => `${quoteIdentifier(column)} ASC NULLS FIRST`).join(', ')
    return this.db.execute(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${order} OFFSET $1 LIMIT $2`, [offset, limit])
  }

  async inspect(batchSize = 500): Promise<P5QmsSourceSnapshot> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new Error('QMS 源批次大小必须在 1 到 10000 之间')
    }
    const extension = await this.db.execute(
      "SELECT TRUE AS available FROM pg_extension WHERE extname = 'timescaledb' LIMIT 1",
    )
    const tables = {} as Record<P5QmsTableName, P5QmsSourceTableSnapshot>
    const overall = createHash('sha256')
    for (const table of P5_QMS_TABLES) {
      const relation = await this.db.execute('SELECT relkind FROM pg_class WHERE oid = to_regclass($1)', [table])
      const relationKind = relation[0]?.relkind == null ? null : String(relation[0].relkind)
      if (!relationKind) {
        const missing = { exists: false, relationKind: null, columns: [], count: 0, checksum: emptyChecksum(), tenants: [], minTime: null, maxTime: null }
        tables[table] = missing
        overall.update(`${table}:${missing.checksum};`)
        continue
      }
      const columns = await this.columns(table)
      const hash = createHash('sha256')
      const tenants = new Set<string>()
      let count = 0
      let minTime: string | null = null
      let maxTime: string | null = null
      for (let offset = 0; ; offset += batchSize) {
        const rows = await this.readBatch(table, offset, batchSize, columns)
        for (const row of rows) {
          hash.update(canonicalQmsRow(row)).update('\n')
          count += 1
          const tenant = row.tenant_id == null ? '' : String(row.tenant_id).trim()
          if (tenant) tenants.add(tenant)
          const timeColumn = P5_QMS_TABLE_SPECS[table].timeColumn
          if (timeColumn && row[timeColumn] != null) {
            const time = timestampText(row[timeColumn], `${table}.${timeColumn}`)
            if (minTime === null || time < minTime) minTime = time
            if (maxTime === null || time > maxTime) maxTime = time
          }
        }
        if (rows.length < batchSize) break
      }
      const checksum = hash.digest('hex')
      tables[table] = {
        exists: true,
        relationKind,
        columns: [...columns].sort(),
        count,
        checksum,
        tenants: [...tenants].sort(),
        minTime,
        maxTime,
      }
      overall.update(`${table}:${checksum};`)
    }
    const aggregateKind = tables.telemetry_perf_daily.relationKind
    return {
      timescaleAvailable: extension.length > 0,
      aggregateMode: aggregateKind === 'm' ? 'continuous' : aggregateKind === 'r' || aggregateKind === 'p' ? 'regular' : 'unknown',
      checksum: overall.digest('hex'),
      tables,
    }
  }

  private async columns(table: P5QmsTableName): Promise<string[]> {
    const rows = await this.db.execute(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = ANY(current_schemas(FALSE)) AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    )
    return rows.map(row => String(row.column_name))
  }
}

function timestampText(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} 包含非法时间`)
  return date.toISOString()
}

function emptyChecksum(): string {
  return createHash('sha256').digest('hex')
}
