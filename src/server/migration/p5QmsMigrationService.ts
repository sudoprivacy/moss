import { createHash } from 'node:crypto'

import { assertTrustedCommandContext, type CommandContext } from '../application/commandContext.js'
import type { QmsOrganizationDirectory } from '../qms/qmsAuthorization.js'
import type { QmsSchemaState, QmsSqlPort } from '../qms/qmsSchema.js'
import type { QmsTransactionalSqlPort } from '../qms/telemetryPostgresWriter.js'
import {
  canonicalQmsRow,
  P5_QMS_DERIVED_AGGREGATES,
  P5_QMS_TABLES,
  P5_QMS_TABLE_SPECS,
  type P5QmsSourceSnapshot,
  type P5QmsTableName,
} from './sudoworkP5QmsSourceReader.js'

type Row = Record<string, unknown>

export interface P5QmsSourcePort {
  inspect(batchSize?: number): Promise<P5QmsSourceSnapshot>
  readBatch(table: P5QmsTableName, offset: number, limit: number, knownColumns?: readonly string[]): Promise<readonly Row[]>
}

export interface P5QmsTargetCheckpoint {
  sourceChecksum: string
  offset: number
  migratedRows: number
  status: 'running' | 'complete'
}

export interface P5QmsWriteBatch {
  migrationId: string
  table: P5QmsTableName
  sourceChecksum: string
  rows: readonly Readonly<Row>[]
  receipts: readonly Readonly<Row>[]
  nextOffset: number
  migratedRows: number
  complete: boolean
}

export interface P5QmsMigrationTarget {
  schemaState(): Promise<QmsSchemaState>
  count(table: P5QmsTableName): Promise<number>
  checkpoint(migrationId: string, table: P5QmsTableName): Promise<P5QmsTargetCheckpoint | null>
  writeBatch(input: P5QmsWriteBatch): Promise<void>
  readBatch(table: P5QmsTableName, columns: readonly string[], offset: number, limit: number): Promise<readonly Row[]>
  resetSequence(table: P5QmsTableName): Promise<void>
  refreshContinuousAggregates(start: Date, end: Date): Promise<void>
  summary(table: P5QmsTableName, timeColumn: string): Promise<{ count: number; minTime: string | null; maxTime: string | null }>
}

export type P5QmsMigrationIssueCode =
  | 'MISSING_TABLE'
  | 'MISSING_COLUMN'
  | 'UNKNOWN_ORGANIZATION'
  | 'DUPLICATE_SOURCE_IDENTITY'
  | 'ORPHAN_CRASH_ISSUE'
  | 'PLAINTEXT_SECRET'
  | 'TARGET_CONFLICT'
  | 'AGGREGATE_HISTORY_NOT_REBUILDABLE'

export interface P5QmsMigrationIssue {
  code: P5QmsMigrationIssueCode
  table: P5QmsTableName
  message: string
}

export interface P5QmsMigrationTablePlan {
  table: P5QmsTableName
  sourceChecksum: string
  sourceRows: number
  migrateRows: number
  targetColumns: string[]
  expectedChecksum: string
  skipped: boolean
}

export interface P5QmsMigrationPlan {
  status: 'ready' | 'blocked'
  migrationId: string
  sourceChecksum: string
  aggregateMode: 'regular' | 'continuous'
  issues: P5QmsMigrationIssue[]
  tables: P5QmsMigrationTablePlan[]
}

export interface P5QmsMigrationReport {
  status: 'matched' | 'mismatch'
  migrationRunId: string
  sourceChecksum: string
  migratedRows: number
  resumedTables: number
  issues: string[]
  deliverableExternalOutboxCount: 0
}

export class P5QmsMigrationBlockedError extends Error {
  constructor(readonly plan: P5QmsMigrationPlan) {
    super(`P5 QMS 迁移预检失败: ${plan.issues.length} 个问题`)
    this.name = 'P5QmsMigrationBlockedError'
  }
}

const MIGRATION_ID = 'sudowork-p5-qms-v1'
const sensitiveConfigKey = /(?:password|passwd|smtp_pass|secret|token|api[_-]?key|webhook|private[_-]?key)/i
const derivedAggregates = new Set<P5QmsTableName>(P5_QMS_DERIVED_AGGREGATES)

const TARGET_COLUMNS: Readonly<Record<P5QmsTableName, readonly string[]>> = {
  alert_config: ['id', 'tenant_id', 'name', 'type', 'metric', 'threshold', 'comparison', 'level', 'channels', 'enabled', 'cooldown_minutes', 'description', 'created_at', 'updated_at'],
  alert_history: ['id', 'tenant_id', 'config_id', 'type', 'title', 'detail', 'level', 'channels', 'channel_results', 'sent_at', 'success', 'error_message', 'acknowledged', 'acknowledged_at', 'acknowledged_by', 'delivery_key'],
  audit_logs: ['id', 'tenant_id', 'user_id', 'action', 'resource', 'resource_id', 'detail', 'ip_address', 'created_at'],
  system_config: ['key', 'value', 'description', 'updated_at'],
  crash_issues: ['id', 'fingerprint', 'tenant_id', 'title', 'type', 'level', 'count', 'user_count', 'first_seen', 'last_seen', 'status', 'assigned_to', 'first_release', 'last_release', 'stack_summary', 'created_at', 'updated_at'],
  source_maps: ['id', 'tenant_id', 'version', 'platform', 'file_name', 'map_content', 'uploaded_at', 'uploaded_by'],
  telemetry_perf_raw: ['id', 'ingest_id', 'timestamp', 'version', 'platform', 'arch', 'org_id', 'user_id', 'tenant_id', 'login_mode', 'agent_type', 'user_nickname', 'user_phone', 'metric', 'value_ms', 'session_id', 'created_at'],
  telemetry_conversations: ['id', 'ingest_id', 'timestamp', 'version', 'platform', 'arch', 'org_id', 'user_id', 'tenant_id', 'login_mode', 'agent_type', 'user_nickname', 'user_phone', 'session_id', 'model_id', 'model_provider', 'status', 'duration_ms', 'tokens_used', 'input_tokens', 'output_tokens', 'error_code', 'created_at'],
  telemetry_turns: ['id', 'ingest_id', 'timestamp', 'version', 'platform', 'arch', 'org_id', 'user_id', 'tenant_id', 'login_mode', 'agent_type', 'user_nickname', 'user_phone', 'turn_id', 'session_id', 'model_id', 'model_provider', 'input_tokens', 'output_tokens', 'total_tokens', 'duration_ms', 'status', 'error_code', 'created_at'],
  telemetry_steps: ['id', 'ingest_id', 'timestamp', 'version', 'platform', 'arch', 'org_id', 'user_id', 'tenant_id', 'login_mode', 'agent_type', 'user_nickname', 'user_phone', 'step_id', 'turn_id', 'session_id', 'step_type', 'tool_name', 'tool_kind', 'file_path', 'permission_kind', 'thinking_tokens', 'duration_ms', 'status', 'created_at'],
  telemetry_install: ['install_id', 'ingest_id', 'timestamp', 'version', 'platform', 'arch', 'org_id', 'user_id', 'tenant_id', 'login_mode', 'agent_type', 'user_nickname', 'user_phone', 'status', 'duration_ms', 'install_type', 'previous_version', 'error_message', 'created_at'],
  crash_events: ['id', 'ingest_id', 'timestamp', 'version', 'platform', 'arch', 'org_id', 'user_id', 'tenant_id', 'login_mode', 'agent_type', 'user_nickname', 'user_phone', 'process_type', 'type', 'crash_reason', 'exit_code', 'signal', 'error_name', 'error_message', 'stack_trace', 'symbolicated_stack', 'context', 'release', 'environment', 'fingerprint', 'issue_id', 'created_at'],
  crash_daily_stats: ['id', 'bucket', 'version', 'platform', 'tenant_id', 'type', 'count', 'created_at'],
  telemetry_perf_daily: ['id', 'bucket', 'version', 'platform', 'arch', 'tenant_id', 'metric', 'p50', 'p90', 'p95', 'p99', 'min_value', 'max_value', 'avg_value', 'count', 'created_at'],
  telemetry_conversations_daily: ['id', 'bucket', 'version', 'platform', 'arch', 'tenant_id', 'success_count', 'error_count', 'user_cancel_count', 'total_count', 'avg_duration_ms', 'avg_tokens', 'success_rate', 'error_rate', 'created_at'],
  telemetry_conversation_errors_daily: ['id', 'bucket', 'version', 'platform', 'arch', 'tenant_id', 'error_code', 'count', 'created_at'],
  telemetry_turns_daily: ['id', 'bucket', 'version', 'platform', 'arch', 'tenant_id', 'model_id', 'model_provider', 'success_count', 'error_count', 'total_count', 'total_tokens', 'total_input_tokens', 'total_output_tokens', 'avg_duration_ms', 'success_rate', 'created_at'],
  telemetry_steps_daily: ['id', 'bucket', 'version', 'platform', 'arch', 'tenant_id', 'step_type', 'success_count', 'error_count', 'total_count', 'avg_duration_ms', 'success_rate', 'created_at'],
  telemetry_install_daily: ['id', 'bucket', 'version', 'platform', 'arch', 'tenant_id', 'install_type', 'success_count', 'failed_count', 'total_count', 'avg_duration_ms', 'success_rate', 'created_at'],
  telemetry_user_conversations_daily: ['id', 'bucket', 'user_id', 'org_id', 'tenant_id', 'login_mode', 'user_nickname', 'user_phone', 'conversation_count', 'total_tokens', 'input_tokens', 'output_tokens', 'success_count', 'error_count', 'user_cancel_count', 'avg_duration_ms', 'created_at'],
  telemetry_user_turns_daily: ['id', 'bucket', 'user_id', 'org_id', 'tenant_id', 'login_mode', 'user_nickname', 'user_phone', 'turn_count', 'total_tokens', 'total_input_tokens', 'total_output_tokens', 'success_count', 'error_count', 'avg_duration_ms', 'created_at'],
  telemetry_user_steps_daily: ['id', 'bucket', 'user_id', 'org_id', 'tenant_id', 'login_mode', 'user_nickname', 'user_phone', 'step_type', 'step_count', 'success_count', 'error_count', 'avg_duration_ms', 'created_at'],
}

export class P5QmsMigrationService {
  private readonly batchSize: number

  constructor(private readonly options: {
    source: P5QmsSourcePort
    target: P5QmsMigrationTarget
    organizations: Pick<QmsOrganizationDirectory, 'hasCode'>
    batchSize?: number
  }) {
    this.batchSize = options.batchSize ?? 500
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 10_000) {
      throw new Error('P5 QMS 迁移批次大小必须在 1 到 10000 之间')
    }
  }

  async plan(): Promise<P5QmsMigrationPlan> {
    const source = await this.options.source.inspect(this.batchSize)
    const targetState = await this.options.target.schemaState()
    const issues: P5QmsMigrationIssue[] = []
    const issueIdentities = new Map<P5QmsTableName, Set<string>>()
    const crashIssueIds = new Set<string>()
    const crashIssueReferences: string[] = []
    const tables: P5QmsMigrationTablePlan[] = []

    for (const table of P5_QMS_TABLES) {
      const spec = P5_QMS_TABLE_SPECS[table]
      const metadata = source.tables[table]
      if (!metadata.exists) {
        issues.push({ code: 'MISSING_TABLE', table, message: `旧 QMS 缺少数据表 ${table}` })
        tables.push(emptyTablePlan(table, metadata.checksum, targetState.continuousAggregates))
        continue
      }
      for (const column of spec.requiredColumns) {
        if (!metadata.columns.includes(column)) {
          issues.push({ code: 'MISSING_COLUMN', table, message: `旧 QMS 缺少字段 ${table}.${column}` })
        }
      }
      for (const tenant of metadata.tenants) {
        if (!this.options.organizations.hasCode(tenant)) {
          issues.push({ code: 'UNKNOWN_ORGANIZATION', table, message: `tenant_id ${tenant} 未映射到 Moss Organization` })
        }
      }

      const skipped = targetState.continuousAggregates && derivedAggregates.has(table)
      const columns = migrationColumns(table, metadata.columns)
      const expected = createHash('sha256')
      let migrateRows = 0
      for (let offset = 0; ; offset += this.batchSize) {
        const rows = await this.options.source.readBatch(table, offset, this.batchSize, metadata.columns)
        for (const row of rows) {
          const identity = sourceIdentity(table, row)
          const identities = issueIdentities.get(table) ?? new Set<string>()
          if (identities.has(identity)) {
            issues.push({ code: 'DUPLICATE_SOURCE_IDENTITY', table, message: `${table} 存在重复逻辑键 ${identity}` })
          }
          identities.add(identity)
          issueIdentities.set(table, identities)
          if (table === 'crash_issues') crashIssueIds.add(String(row.id))
          if (table === 'crash_events' && row.issue_id != null) crashIssueReferences.push(String(row.issue_id))
          if (table === 'system_config' && sensitiveConfigKey.test(String(row.key)) && String(row.value ?? '').trim()) {
            issues.push({ code: 'PLAINTEXT_SECRET', table, message: `system_config.${String(row.key)} 含明文凭据，必须先迁入 Nexus 并清空旧值` })
          }
          if (!skipped && migratableRow(table, row)) {
            const transformed = transformRow(table, row, columns)
            expected.update(canonicalQmsRow(transformed)).update('\n')
            migrateRows += 1
          }
        }
        if (rows.length < this.batchSize) break
      }

      const checkpoint = await this.options.target.checkpoint(MIGRATION_ID, table)
      const targetCount = skipped ? 0 : await this.options.target.count(table)
      if (!skipped && targetCount > 0 && checkpoint?.sourceChecksum !== metadata.checksum) {
        issues.push({ code: 'TARGET_CONFLICT', table, message: `${table} 已有非本次迁移管理的数据` })
      }
      if (checkpoint && checkpoint.sourceChecksum !== metadata.checksum) {
        issues.push({ code: 'TARGET_CONFLICT', table, message: `${table} checkpoint 对应另一份源快照` })
      }
      if (!skipped && checkpoint?.sourceChecksum === metadata.checksum) {
        const expectedRows = checkpoint.status === 'complete' ? migrateRows : checkpoint.migratedRows
        if (targetCount !== expectedRows || checkpoint.offset > metadata.count || checkpoint.migratedRows > migrateRows) {
          issues.push({
            code: 'TARGET_CONFLICT',
            table,
            message: `${table} checkpoint 与目标表实际进度不一致`,
          })
        }
      }
      tables.push({
        table,
        sourceChecksum: metadata.checksum,
        sourceRows: metadata.count,
        migrateRows: skipped ? 0 : migrateRows,
        targetColumns: columns,
        expectedChecksum: expected.digest('hex'),
        skipped,
      })
    }

    for (const issueId of crashIssueReferences) {
      if (!crashIssueIds.has(issueId)) {
        issues.push({ code: 'ORPHAN_CRASH_ISSUE', table: 'crash_events', message: `crash_events.issue_id ${issueId} 没有对应 crash_issues` })
      }
    }
    if (targetState.continuousAggregates) this.validateRebuildWindow(source, issues)

    return {
      status: issues.length === 0 ? 'ready' : 'blocked',
      migrationId: MIGRATION_ID,
      sourceChecksum: source.checksum,
      aggregateMode: targetState.continuousAggregates ? 'continuous' : 'regular',
      issues,
      tables,
    }
  }

  async execute(plan: P5QmsMigrationPlan, context: CommandContext): Promise<P5QmsMigrationReport> {
    assertTrustedCommandContext(context)
    if (context.source !== 'migration' || context.externalEffects !== 'suppress_external' || !context.migrationRunId) {
      throw new Error('P5 QMS 迁移必须使用抑制外部副作用的迁移上下文')
    }
    if (plan.status === 'blocked') throw new P5QmsMigrationBlockedError(plan)
    const current = await this.options.source.inspect(this.batchSize)
    if (current.checksum !== plan.sourceChecksum) throw new Error('P5 QMS 源快照在预检后发生变化')

    let migratedRows = 0
    let resumedTables = 0
    for (const tablePlan of plan.tables) {
      if (tablePlan.skipped) continue
      const checkpoint = await this.options.target.checkpoint(plan.migrationId, tablePlan.table)
      if (checkpoint?.sourceChecksum !== undefined && checkpoint.sourceChecksum !== tablePlan.sourceChecksum) {
        throw new Error(`P5 QMS ${tablePlan.table} checkpoint 与源快照不一致`)
      }
      if (checkpoint?.status === 'complete') {
        resumedTables += 1
        continue
      }
      let offset = checkpoint?.offset ?? 0
      let tableMigratedRows = checkpoint?.migratedRows ?? 0
      if (offset > 0) resumedTables += 1
      for (;;) {
        const sourceRows = await this.options.source.readBatch(
          tablePlan.table,
          offset,
          this.batchSize,
          current.tables[tablePlan.table].columns,
        )
        const rows = sourceRows
          .filter(row => migratableRow(tablePlan.table, row))
          .map(row => transformRow(tablePlan.table, row, tablePlan.targetColumns))
        const receipts = rows.flatMap(row => receiptFor(tablePlan.table, row))
        const nextOffset = offset + sourceRows.length
        tableMigratedRows += rows.length
        const complete = sourceRows.length < this.batchSize
        await this.options.target.writeBatch({
          migrationId: plan.migrationId,
          table: tablePlan.table,
          sourceChecksum: tablePlan.sourceChecksum,
          rows,
          receipts,
          nextOffset,
          migratedRows: tableMigratedRows,
          complete,
        })
        migratedRows += rows.length
        offset = nextOffset
        if (complete) break
      }
      if (tablePlan.targetColumns.includes('id')) await this.options.target.resetSequence(tablePlan.table)
    }

    if (plan.aggregateMode === 'continuous') {
      const range = sourceRawRange(current)
      if (range) await this.options.target.refreshContinuousAggregates(range.start, range.end)
    }
    const verification = await this.verify(plan)
    return {
      ...verification,
      migrationRunId: context.migrationRunId,
      sourceChecksum: plan.sourceChecksum,
      migratedRows,
      resumedTables,
      deliverableExternalOutboxCount: 0,
    }
  }

  async verify(plan: P5QmsMigrationPlan): Promise<{ status: 'matched' | 'mismatch'; issues: string[] }> {
    const source = await this.options.source.inspect(this.batchSize)
    const issues: string[] = []
    if (source.checksum !== plan.sourceChecksum) issues.push('源快照校验和已变化')
    for (const tablePlan of plan.tables) {
      if (tablePlan.skipped) {
        const sourceTable = source.tables[tablePlan.table]
        const summary = await this.options.target.summary(tablePlan.table, 'bucket')
        if (summary.count !== sourceTable.count
          || summary.minTime !== sourceTable.minTime
          || summary.maxTime !== sourceTable.maxTime) {
          issues.push(`${tablePlan.table} 连续聚合行数或时间窗口不一致`)
        }
        continue
      }
      const count = await this.options.target.count(tablePlan.table)
      if (count !== tablePlan.migrateRows) {
        issues.push(`${tablePlan.table} 行数不一致: source=${tablePlan.migrateRows}, target=${count}`)
        continue
      }
      const hash = createHash('sha256')
      for (let offset = 0; ; offset += this.batchSize) {
        const rows = await this.options.target.readBatch(
          tablePlan.table,
          tablePlan.targetColumns,
          offset,
          this.batchSize,
        )
        for (const row of rows) hash.update(canonicalQmsRow(row)).update('\n')
        if (rows.length < this.batchSize) break
      }
      if (hash.digest('hex') !== tablePlan.expectedChecksum) issues.push(`${tablePlan.table} 内容校验和不一致`)
      const checkpoint = await this.options.target.checkpoint(plan.migrationId, tablePlan.table)
      if (checkpoint?.status !== 'complete') issues.push(`${tablePlan.table} checkpoint 未完成`)
    }
    return { status: issues.length === 0 ? 'matched' : 'mismatch', issues }
  }

  private validateRebuildWindow(source: P5QmsSourceSnapshot, issues: P5QmsMigrationIssue[]): void {
    const rawByAggregate: Partial<Record<P5QmsTableName, P5QmsTableName>> = {
      telemetry_perf_daily: 'telemetry_perf_raw',
      telemetry_conversations_daily: 'telemetry_conversations',
      telemetry_conversation_errors_daily: 'telemetry_conversations',
      telemetry_turns_daily: 'telemetry_turns',
      telemetry_steps_daily: 'telemetry_steps',
      telemetry_install_daily: 'telemetry_install',
    }
    for (const aggregate of P5_QMS_DERIVED_AGGREGATES) {
      const aggregateState = source.tables[aggregate]
      if (aggregateState.count === 0) continue
      const raw = source.tables[rawByAggregate[aggregate]!]
      if (!raw.minTime || !aggregateState.minTime || startOfUtcDay(raw.minTime) > aggregateState.minTime) {
        issues.push({
          code: 'AGGREGATE_HISTORY_NOT_REBUILDABLE',
          table: aggregate,
          message: `${aggregate} 的历史窗口早于可用原始数据，不能重建连续聚合`,
        })
      }
    }
  }
}

export class PostgresP5QmsMigrationTarget implements P5QmsMigrationTarget {
  constructor(private readonly db: QmsTransactionalSqlPort, private readonly state: QmsSchemaState) {}

  schemaState(): Promise<QmsSchemaState> { return Promise.resolve(this.state) }

  async count(table: P5QmsTableName): Promise<number> {
    assertTable(table)
    const rows = await this.db.execute(`SELECT COUNT(*)::BIGINT AS count FROM ${quote(table)}`)
    return Number(rows[0]?.count ?? 0)
  }

  async checkpoint(migrationId: string, table: P5QmsTableName): Promise<P5QmsTargetCheckpoint | null> {
    const rows = await this.db.execute(
      `SELECT source_checksum, cursor_json, migrated_rows, status FROM qms_migration_checkpoints
       WHERE migration_id = $1 AND table_name = $2`,
      [migrationId, table],
    )
    const row = rows[0]
    if (!row) return null
    const cursor = asRecord(row.cursor_json)
    return {
      sourceChecksum: String(row.source_checksum),
      offset: Number(cursor.offset ?? 0),
      migratedRows: Number(row.migrated_rows ?? 0),
      status: row.status === 'complete' ? 'complete' : 'running',
    }
  }

  async writeBatch(input: P5QmsWriteBatch): Promise<void> {
    assertTable(input.table)
    await this.db.transaction(async transaction => {
      for (const receipt of input.receipts) {
        const inserted = await transaction.execute(
          `INSERT INTO qms_ingest_receipts (ingest_id, kind, tenant_id, event_timestamp)
           VALUES ($1,$2,$3,$4) ON CONFLICT (ingest_id) DO NOTHING RETURNING ingest_id`,
          [receipt.ingest_id, receipt.kind, receipt.tenant_id, receipt.event_timestamp],
        )
        if (!inserted[0]) throw new Error(`P5 QMS ingest receipt 冲突: ${String(receipt.ingest_id)}`)
      }
      for (const row of input.rows) {
        const columns = Object.keys(row)
        assertColumns(input.table, columns)
        const values = columns.map(column => row[column])
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(',')
        const inserted = await transaction.execute(
          `INSERT INTO ${quote(input.table)} (${columns.map(quote).join(',')}) VALUES (${placeholders})
           ON CONFLICT DO NOTHING RETURNING 1 AS inserted`,
          values,
        )
        if (!inserted[0]) throw new Error(`P5 QMS 目标行冲突: ${input.table}`)
      }
      const checkpoint = await transaction.execute(
        `INSERT INTO qms_migration_checkpoints
          (migration_id, table_name, source_checksum, cursor_json, migrated_rows, status, updated_at)
         VALUES ($1,$2,$3,$4::JSONB,$5,$6,NOW())
         ON CONFLICT (migration_id, table_name) DO UPDATE SET
          cursor_json=EXCLUDED.cursor_json, migrated_rows=EXCLUDED.migrated_rows,
          status=EXCLUDED.status, updated_at=NOW()
         WHERE qms_migration_checkpoints.source_checksum=EXCLUDED.source_checksum
         RETURNING table_name`,
        [input.migrationId, input.table, input.sourceChecksum, JSON.stringify({ offset: input.nextOffset }), input.migratedRows, input.complete ? 'complete' : 'running'],
      )
      if (!checkpoint[0]) throw new Error(`P5 QMS checkpoint 冲突: ${input.table}`)
    })
  }

  async readBatch(table: P5QmsTableName, columns: readonly string[], offset: number, limit: number): Promise<readonly Row[]> {
    assertTable(table)
    assertColumns(table, columns)
    const orderColumns = P5_QMS_TABLE_SPECS[table].identityColumns.filter(column => columns.includes(column))
    const order = (orderColumns.length > 0 ? orderColumns : columns).map(column => `${quote(column)} ASC NULLS FIRST`).join(',')
    return this.db.execute(
      `SELECT ${columns.map(quote).join(',')} FROM ${quote(table)} ORDER BY ${order} OFFSET $1 LIMIT $2`,
      [offset, limit],
    )
  }

  async resetSequence(table: P5QmsTableName): Promise<void> {
    assertTable(table)
    if (!TARGET_COLUMNS[table].includes('id')) return
    await this.db.execute(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${quote(table)}`,
      [table],
    )
  }

  async refreshContinuousAggregates(start: Date, end: Date): Promise<void> {
    for (const table of P5_QMS_DERIVED_AGGREGATES) {
      await this.db.execute(`CALL refresh_continuous_aggregate('${table}', $1, $2)`, [start, end])
    }
  }

  async summary(table: P5QmsTableName, timeColumn: string): Promise<{ count: number; minTime: string | null; maxTime: string | null }> {
    assertTable(table)
    assertColumns(table, [timeColumn])
    const rows = await this.db.execute(
      `SELECT COUNT(*)::BIGINT AS count, MIN(${quote(timeColumn)}) AS min_time, MAX(${quote(timeColumn)}) AS max_time
       FROM ${quote(table)}`,
    )
    return {
      count: Number(rows[0]?.count ?? 0),
      minTime: optionalTimestamp(rows[0]?.min_time),
      maxTime: optionalTimestamp(rows[0]?.max_time),
    }
  }
}

function emptyTablePlan(table: P5QmsTableName, checksum: string, continuous: boolean): P5QmsMigrationTablePlan {
  return {
    table,
    sourceChecksum: checksum,
    sourceRows: 0,
    migrateRows: 0,
    targetColumns: [],
    expectedChecksum: createHash('sha256').digest('hex'),
    skipped: continuous && derivedAggregates.has(table),
  }
}

function migrationColumns(table: P5QmsTableName, sourceColumns: readonly string[]): string[] {
  const extra = new Set<string>()
  if (P5_QMS_TABLE_SPECS[table].ingestKind) extra.add('ingest_id')
  if (table === 'alert_history') extra.add('delivery_key')
  return TARGET_COLUMNS[table].filter(column => sourceColumns.includes(column) || extra.has(column))
}

function migratableRow(table: P5QmsTableName, row: Readonly<Row>): boolean {
  return table !== 'system_config' || !sensitiveConfigKey.test(String(row.key))
}

function transformRow(table: P5QmsTableName, source: Readonly<Row>, columns: readonly string[]): Row {
  const row: Row = {}
  for (const column of columns) {
    if (column === 'ingest_id') row[column] = migrationIngestId(table, source)
    else if (column === 'delivery_key') row[column] = `migration:p5:alert:${String(source.id)}`
    else row[column] = source[column]
  }
  return row
}

function migrationIngestId(table: P5QmsTableName, row: Readonly<Row>): string {
  const identity = sourceIdentity(table, row)
  return `migration:p5:${table}:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
}

function sourceIdentity(table: P5QmsTableName, row: Readonly<Row>): string {
  return canonicalQmsRow(Object.fromEntries(P5_QMS_TABLE_SPECS[table].identityColumns.map(column => [column, row[column] ?? null])))
}

function receiptFor(table: P5QmsTableName, row: Readonly<Row>): Row[] {
  const kind = P5_QMS_TABLE_SPECS[table].ingestKind
  if (!kind) return []
  return [{
    ingest_id: row.ingest_id,
    kind,
    tenant_id: row.tenant_id ?? null,
    event_timestamp: row.timestamp,
  }]
}

function sourceRawRange(source: P5QmsSourceSnapshot): { start: Date; end: Date } | null {
  const states = [
    source.tables.telemetry_perf_raw,
    source.tables.telemetry_conversations,
    source.tables.telemetry_turns,
    source.tables.telemetry_steps,
    source.tables.telemetry_install,
  ]
  const starts = states.flatMap(state => state.minTime ? [state.minTime] : []).sort()
  const ends = states.flatMap(state => state.maxTime ? [state.maxTime] : []).sort()
  if (!starts[0] || !ends.at(-1)) return null
  return { start: new Date(starts[0]), end: new Date(new Date(ends.at(-1)!).getTime() + 86_400_000) }
}

function startOfUtcDay(value: string): string {
  const date = new Date(value)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString()
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function assertTable(table: P5QmsTableName): void {
  if (!P5_QMS_TABLES.includes(table)) throw new Error(`不允许访问 QMS 白名单外数据表: ${String(table)}`)
}

function assertColumns(table: P5QmsTableName, columns: readonly string[]): void {
  for (const column of columns) {
    if (!TARGET_COLUMNS[table].includes(column)) throw new Error(`不允许访问 QMS 未知字段: ${table}.${column}`)
  }
}

function asRecord(value: unknown): Row {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Row } catch { return {} }
  }
  return {}
}

function optionalTimestamp(value: unknown): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(date.getTime())) throw new Error(`QMS 目标时间字段非法: ${String(value)}`)
  return date.toISOString()
}
