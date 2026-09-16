import { createHash, randomUUID } from 'node:crypto'

import type { QmsSqlPort } from './qmsSchema.js'
import type { QmsTransactionalSqlPort } from './telemetryPostgresWriter.js'

export type CrashEventType = 'native_crash' | 'renderer_crash' | 'js_exception'

export interface CrashEvent {
  type: CrashEventType
  timestamp: number
  version: string
  platform: string
  arch?: string
  org_id?: string
  user_id?: string
  tenant_id?: string
  login_mode?: 'enterprise' | 'personal'
  agent_type?: string
  user_nickname?: string
  user_phone?: string
  process_type: 'main' | 'renderer'
  crash_reason?: string
  exit_code?: number
  signal?: string
  error_name?: string
  error_message?: string
  stack_trace?: string
  context?: Record<string, unknown>
  release?: string
  environment?: string
}

export interface CrashTenantDirectory {
  hasCode(code: string): boolean
}

export interface CrashSourceMapPort {
  symbolicate(input: { tenantId: string; version: string; platform: string; stack: string }): Promise<string>
}

export class CrashServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'TENANT_ID_REQUIRED' | 'TENANT_NOT_FOUND' | 'MISSING_REQUIRED_FIELDS',
    message: string,
    readonly items: string[] = [],
  ) {
    super(message)
    this.name = 'CrashServiceError'
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function normalizedStack(stack?: string): string {
  if (!stack) return ''
  return stack.split('\n').map(line => line.replace(/:(\d+):(\d+)\)?$/, ')')).slice(0, 10).join('\n')
}

export function generateCrashFingerprint(event: CrashEvent): string {
  if (event.type === 'native_crash' || event.type === 'renderer_crash') {
    const stack = event.stack_trace?.split('\n').slice(0, 3).join('\n') || ''
    return `${event.crash_reason || 'unknown'}:${hash(stack)}`
  }
  if (event.type === 'js_exception') {
    return `${event.error_name || 'Error'}:${hash(normalizedStack(event.stack_trace))}`
  }
  return `${event.type}:${hash(event.error_message || 'unknown')}`
}

export function generateCrashIssueTitle(event: CrashEvent): string {
  if (event.type === 'native_crash' || event.type === 'renderer_crash') {
    return `Native Crash: ${event.crash_reason || 'Unknown'}`
  }
  if (event.type === 'js_exception') {
    return `${event.error_name || 'Error'}: ${event.error_message?.slice(0, 80) || 'Unknown'}`
  }
  return `Crash: ${event.type}`
}

function validateEvent(event: CrashEvent, tenants: CrashTenantDirectory): string {
  for (const field of ['type', 'timestamp', 'version', 'platform', 'process_type'] as const) {
    if (event[field] === undefined || event[field] === null || event[field] === '') {
      throw new CrashServiceError(400, 'MISSING_REQUIRED_FIELDS', `QMS crash event requires ${field}`)
    }
  }
  return validateTenant(event, tenants)
}

function validateTenant(event: CrashEvent, tenants: CrashTenantDirectory, item?: string): string {
  const tenantId = event.tenant_id?.trim()
  if (!tenantId) {
    throw new CrashServiceError(400, 'TENANT_ID_REQUIRED', 'tenant_id is required for QMS crash ingestion', item ? [item] : [])
  }
  if (!tenants.hasCode(tenantId)) {
    throw new CrashServiceError(400, 'TENANT_NOT_FOUND', `Unknown QMS tenant: ${tenantId}`, item ? [item] : [])
  }
  return tenantId
}

export class CrashService {
  constructor(private readonly options: {
    db: QmsTransactionalSqlPort
    tenants: CrashTenantDirectory
    sourceMaps?: CrashSourceMapPort
    createId?: () => string
  }) {}

  async ingest(event: CrashEvent, requestedIngestId?: string): Promise<{ issueId: number; duplicate: boolean }> {
    const tenantId = validateEvent(event, this.options.tenants)
    const ingestId = requestedIngestId?.trim() || this.options.createId?.() || randomUUID()
    if (!ingestId) throw new Error('QMS crash ingest id is required')
    const fingerprint = generateCrashFingerprint(event)
    const symbolicatedStack = event.stack_trace && this.options.sourceMaps
      ? await this.options.sourceMaps.symbolicate({
          tenantId,
          version: event.release ?? event.version,
          platform: event.platform,
          stack: event.stack_trace,
        })
      : null

    return this.options.db.transaction(async db => {
      await db.execute('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenantId}:${fingerprint}`])
      const receipt = await db.execute(
        `INSERT INTO qms_ingest_receipts (ingest_id, kind, tenant_id, event_timestamp)
         VALUES ($1,'crash',$2,$3) ON CONFLICT (ingest_id) DO NOTHING RETURNING ingest_id`,
        [ingestId, tenantId, new Date(event.timestamp)],
      )
      if (!receipt[0]) {
        const duplicate = await db.execute(
          'SELECT issue_id FROM crash_events WHERE ingest_id = $1 LIMIT 1',
          [ingestId],
        )
        if (!duplicate[0]) throw new Error(`QMS ingest id already used: ${ingestId}`)
        return { issueId: Number(duplicate[0].issue_id), duplicate: true }
      }

      const existing = await db.execute(
        'SELECT id, count FROM crash_issues WHERE fingerprint = $1 AND tenant_id = $2 LIMIT 1',
        [fingerprint, tenantId],
      )
      let issueId: number
      if (existing[0]) {
        issueId = Number(existing[0].id)
        await db.execute(
          'UPDATE crash_issues SET count = count + 1, last_seen = $1, last_release = $2, updated_at = NOW() WHERE id = $3 AND tenant_id = $4',
          [new Date(event.timestamp), event.release ?? event.version, issueId, tenantId],
        )
      } else {
        const created = await db.execute(
          `INSERT INTO crash_issues (
            fingerprint, tenant_id, title, type, level, count, first_seen, last_seen,
            first_release, last_release, stack_summary, status, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,1,$6,$6,$7,$7,$8,'unresolved',NOW(),NOW()) RETURNING id`,
          [
            fingerprint, tenantId, generateCrashIssueTitle(event), event.type,
            event.type === 'js_exception' ? 'error' : 'fatal', new Date(event.timestamp),
            event.release ?? event.version, event.stack_trace?.slice(0, 500) ?? null,
          ],
        )
        issueId = Number(created[0]?.id)
        if (!Number.isInteger(issueId)) throw new Error('QMS failed to create crash issue')
      }

      await this.insertEvent(db, event, ingestId, tenantId, fingerprint, issueId, symbolicatedStack)
      return { issueId, duplicate: false }
    })
  }

  async ingestBatch(events: readonly CrashEvent[]): Promise<{ received: number; errors?: string[] }> {
    if (events.length === 0) throw new Error('No events provided')
    const missingTenantItems: string[] = []
    const unknownTenantItems: string[] = []
    for (const [index, event] of events.entries()) {
      const tenantId = event.tenant_id?.trim()
      if (!tenantId) missingTenantItems.push(`events[${index}]`)
      else if (!this.options.tenants.hasCode(tenantId)) unknownTenantItems.push(`events[${index}]`)
    }
    if (missingTenantItems.length > 0) {
      throw new CrashServiceError(400, 'TENANT_ID_REQUIRED', 'tenant_id is required for QMS crash ingestion', missingTenantItems)
    }
    if (unknownTenantItems.length > 0) {
      throw new CrashServiceError(400, 'TENANT_NOT_FOUND', 'Unknown QMS tenant', unknownTenantItems)
    }
    let received = 0
    const errors: string[] = []
    for (const event of events) {
      if (['type', 'timestamp', 'version', 'platform'].some(field => {
        const value = event[field as keyof CrashEvent]
        return value === undefined || value === null || value === ''
      })) {
        errors.push('Invalid event: missing required fields')
        continue
      }
      try {
        await this.ingest(event, typeof event.context?.event_id === 'string' ? event.context.event_id : undefined)
        received += 1
      } catch (error) {
        errors.push(`Event processing error: ${String(error)}`)
      }
    }
    return { received, ...(errors.length > 0 ? { errors } : {}) }
  }

  async listIssues(input: {
    tenantId?: string | null; status?: string; level?: string; type?: string; version?: string
    limit?: number; offset?: number
  }): Promise<{ items: readonly Record<string, unknown>[]; total: number; limit: number; offset: number }> {
    const conditions: string[] = []
    const parameters: unknown[] = []
    const add = (sql: string, value: unknown) => {
      parameters.push(value)
      conditions.push(sql.replace('?', `$${parameters.length}`))
    }
    if (input.status) add('status = ?', input.status)
    if (input.level) add('level = ?', input.level)
    if (input.type) add('type = ?', input.type)
    if (input.version) {
      parameters.push(input.version)
      conditions.push(`(first_release = $${parameters.length} OR last_release = $${parameters.length})`)
    }
    if (input.tenantId) add('tenant_id = ?', input.tenantId)
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const count = await this.options.db.execute(`SELECT COUNT(*)::INTEGER AS count FROM crash_issues ${where}`, parameters)
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500)
    const offset = Math.max(input.offset ?? 0, 0)
    const listParameters = [...parameters, limit, offset]
    const items = await this.options.db.execute(
      `SELECT * FROM crash_issues ${where} ORDER BY last_seen DESC LIMIT $${listParameters.length - 1} OFFSET $${listParameters.length}`,
      listParameters,
    )
    return { items, total: Number(count[0]?.count ?? 0), limit, offset }
  }

  async getIssue(id: number, tenantId?: string | null): Promise<Record<string, unknown> | null> {
    const rows = await this.options.db.execute(
      `SELECT * FROM crash_issues WHERE id = $1${tenantId ? ' AND tenant_id = $2' : ''} LIMIT 1`,
      tenantId ? [id, tenantId] : [id],
    )
    return rows[0] ?? null
  }

  async updateIssue(id: number, updates: { status?: string; assigned_to?: string | number | null }, tenantId?: string | null) {
    const existing = await this.getIssue(id, tenantId)
    if (!existing) return null
    const assignments: string[] = []
    const parameters: unknown[] = []
    if (updates.status !== undefined) {
      if (!['unresolved', 'resolved', 'ignored'].includes(updates.status)) throw new Error('Invalid crash issue status')
      parameters.push(updates.status)
      assignments.push(`status = $${parameters.length}`)
    }
    if (updates.assigned_to !== undefined) {
      parameters.push(updates.assigned_to)
      assignments.push(`assigned_to = $${parameters.length}`)
    }
    if (assignments.length === 0) return null
    parameters.push(id)
    let where = `id = $${parameters.length}`
    if (tenantId) {
      parameters.push(tenantId)
      where += ` AND tenant_id = $${parameters.length}`
    }
    await this.options.db.execute(
      `UPDATE crash_issues SET ${assignments.join(', ')}, updated_at = NOW() WHERE ${where}`,
      parameters,
    )
    return this.getIssue(id, tenantId)
  }

  async listEvents(input: {
    tenantId?: string | null; issueId?: number; version?: string; platform?: string; type?: string
    limit?: number; offset?: number
  }): Promise<{ items: readonly Record<string, unknown>[]; total: number; limit: number; offset: number }> {
    const conditions: string[] = []
    const parameters: unknown[] = []
    const add = (column: string, value: unknown) => {
      parameters.push(value)
      conditions.push(`${column} = $${parameters.length}`)
    }
    if (input.issueId) add('e.issue_id', input.issueId)
    if (input.version) add('e.version', input.version)
    if (input.platform) add('e.platform', input.platform)
    if (input.type) add('e.type', input.type)
    if (input.tenantId) add('e.tenant_id', input.tenantId)
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const countWhere = where.replaceAll('e.', '')
    const count = await this.options.db.execute(`SELECT COUNT(*)::INTEGER AS count FROM crash_events ${countWhere}`, parameters)
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500)
    const offset = Math.max(input.offset ?? 0, 0)
    const listParameters = [...parameters, limit, offset]
    const items = await this.options.db.execute(
      `SELECT e.*, i.title AS issue_title, i.level AS issue_level, i.status AS issue_status
       FROM crash_events e LEFT JOIN crash_issues i ON e.issue_id = i.id ${where}
       ORDER BY e.timestamp DESC LIMIT $${listParameters.length - 1} OFFSET $${listParameters.length}`,
      listParameters,
    )
    return { items, total: Number(count[0]?.count ?? 0), limit, offset }
  }

  async getEvent(id: number, tenantId?: string | null): Promise<Record<string, unknown> | null> {
    const rows = await this.options.db.execute(
      `SELECT e.*, i.title AS issue_title, i.level AS issue_level, i.status AS issue_status
       FROM crash_events e LEFT JOIN crash_issues i ON e.issue_id = i.id
       WHERE e.id = $1${tenantId ? ' AND e.tenant_id = $2' : ''} LIMIT 1`,
      tenantId ? [id, tenantId] : [id],
    )
    return rows[0] ?? null
  }

  async summary(tenantId?: string | null, now = Date.now()) {
    const tenant = tenantId ? ' AND tenant_id = $1' : ''
    const parameters = tenantId ? [tenantId] : []
    const rows = await this.options.db.execute(
      `SELECT
        (SELECT COUNT(*) FROM crash_events WHERE TRUE${tenant})::INTEGER AS total_events,
        (SELECT COUNT(*) FROM crash_issues WHERE status = 'unresolved'${tenant})::INTEGER AS unresolved_issues,
        (SELECT COUNT(*) FROM crash_issues WHERE level = 'fatal'${tenant})::INTEGER AS fatal_issues,
        (SELECT COUNT(*) FROM crash_issues WHERE level = 'error'${tenant})::INTEGER AS error_issues,
        (SELECT COUNT(*) FROM crash_events WHERE timestamp >= TO_TIMESTAMP($${parameters.length + 1} / 1000.0)${tenant})::INTEGER AS recent_24h,
        (SELECT COUNT(*) FROM crash_events WHERE timestamp >= TO_TIMESTAMP($${parameters.length + 2} / 1000.0)${tenant})::INTEGER AS recent_7d`,
      [...parameters, now - 86_400_000, now - 7 * 86_400_000],
    )
    return rows[0] ?? {
      total_events: 0, unresolved_issues: 0, fatal_issues: 0, error_issues: 0, recent_24h: 0, recent_7d: 0,
    }
  }

  async distribution(tenantId: string | null | undefined, by: 'version' | 'platform' | 'type') {
    if (!['version', 'platform', 'type'].includes(by)) throw new Error("Invalid 'by' parameter")
    const parameters = tenantId ? [tenantId] : []
    const where = tenantId ? 'WHERE tenant_id = $1' : ''
    const rows = await this.options.db.execute(
      `SELECT ${by} AS key, COUNT(*)::INTEGER AS count FROM crash_events ${where} GROUP BY ${by} ORDER BY count DESC LIMIT 10`,
      parameters,
    )
    const total = rows.reduce((sum, row) => sum + Number(row.count ?? 0), 0)
    return rows.map(row => ({ ...row, percentage: total ? Math.round(Number(row.count) / total * 100) : 0 }))
  }

  async trend(days = 7, tenantId?: string | null, now = new Date()) {
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Invalid crash trend days')
    const start = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
    const parameters: unknown[] = [start]
    const tenant = tenantId ? ` AND tenant_id = $${parameters.push(tenantId)}` : ''
    const rows = await this.options.db.execute(
      `SELECT bucket AS date, type, SUM(count)::INTEGER AS count FROM crash_daily_stats
       WHERE bucket >= $1${tenant} GROUP BY bucket, type ORDER BY bucket ASC`,
      parameters,
    )
    return rows.map(row => ({
      date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date,
      type: row.type,
      count: Number(row.count ?? 0),
    }))
  }

  private async insertEvent(
    db: QmsSqlPort,
    event: CrashEvent,
    ingestId: string,
    tenantId: string,
    fingerprint: string,
    issueId: number,
    symbolicatedStack: string | null,
  ): Promise<void> {
    const columns = [
      'ingest_id', 'timestamp', 'version', 'platform', 'arch', 'org_id', 'user_id', 'tenant_id',
      'login_mode', 'agent_type', 'user_nickname', 'user_phone', 'process_type', 'type',
      'crash_reason', 'exit_code', 'signal', 'error_name', 'error_message', 'stack_trace', 'symbolicated_stack', 'context',
      'release', 'environment', 'fingerprint', 'issue_id',
    ]
    const values = [
      ingestId, new Date(event.timestamp), event.version, event.platform, event.arch ?? 'unknown',
      event.org_id ?? null, event.user_id ?? null, tenantId, event.login_mode ?? null,
      event.agent_type ?? null, event.user_nickname ?? null, event.user_phone ?? null,
      event.process_type, event.type, event.crash_reason ?? null, event.exit_code ?? null,
      event.signal ?? null, event.error_name ?? null, event.error_message ?? null,
      event.stack_trace ?? null, symbolicatedStack, event.context ? JSON.stringify(event.context) : null,
      event.release ?? null, event.environment ?? null, fingerprint, issueId,
    ]
    await db.execute(
      `INSERT INTO crash_events (${columns.join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      values,
    )
  }
}
