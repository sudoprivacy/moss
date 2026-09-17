import { randomUUID } from 'node:crypto'

import { assertTrustedCommandContext, type CommandContext } from '../application/commandContext.js'
import type { QmsSqlPort } from './qmsSchema.js'
import type { QmsTransactionalSqlPort } from './telemetryPostgresWriter.js'

export interface QmsNotificationPort {
  send(channel: string, payload?: Record<string, unknown>): Promise<{ success: boolean; error?: string }>
}

export interface QmsAlertConfigInput {
  name: string
  type: string
  metric: string
  threshold: number
  comparison: string
  level: string
  channels: string[]
  enabled?: boolean
  cooldown_minutes?: number
  description?: string | null
}

export type QmsAlertConfigUpdate = Partial<Pick<QmsAlertConfigInput,
  'name' | 'threshold' | 'comparison' | 'level' | 'channels' | 'enabled' | 'cooldown_minutes' | 'description'
>>

type AlertConfigRow = Record<string, unknown> & {
  id: string
  tenant_id?: string | null
  name: string
  type: string
  metric: string
  threshold: number
  comparison: string
  level: string
  channels: string | string[]
  cooldown_minutes: number
}

export class QmsAlertService {
  private readonly createId: () => string

  constructor(private readonly options: {
    db: QmsTransactionalSqlPort
    notifications: QmsNotificationPort
    createId?: () => string
  }) {
    this.createId = options.createId ?? randomUUID
  }

  async createConfig(input: { tenantId: string | null; userId: string; input: QmsAlertConfigInput }) {
    const value = input.input
    if (!value.name?.trim() || !value.type?.trim() || !value.metric?.trim()) throw new Error('Invalid alert config')
    if (!Number.isFinite(value.threshold)) throw new Error('Invalid alert threshold')
    const id = this.createId()
    return this.options.db.transaction(async db => {
      const rows = await db.execute(
        `INSERT INTO alert_config (
          id, tenant_id, name, type, metric, threshold, comparison, level, channels,
          enabled, cooldown_minutes, description, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW()) RETURNING *`,
        [
          id, input.tenantId, value.name.trim(), value.type, value.metric, value.threshold,
          value.comparison, value.level, JSON.stringify(value.channels), value.enabled ?? false,
          value.cooldown_minutes ?? 30, value.description ?? null,
        ],
      )
      await this.audit(db, input.tenantId, input.userId, 'create', 'alert_config', id, value)
      return this.mapConfig(rows[0] ?? { id, tenant_id: input.tenantId, ...value })
    })
  }

  async listConfigs(tenantId?: string | null) {
    const rows = await this.options.db.execute(
      `SELECT * FROM alert_config${tenantId ? ' WHERE tenant_id = $1' : ''} ORDER BY created_at DESC`,
      tenantId ? [tenantId] : [],
    )
    return rows.map(row => this.mapConfig(row))
  }

  async getConfig(id: string, tenantId?: string | null) {
    const parameters: unknown[] = [id]
    const tenant = tenantId ? ` AND tenant_id = $${parameters.push(tenantId)}` : ''
    const rows = await this.options.db.execute(`SELECT * FROM alert_config WHERE id = $1${tenant}`, parameters)
    return rows[0] ? this.mapConfig(rows[0]) : null
  }

  async updateConfig(input: {
    id: string
    tenantId?: string | null
    userId: string
    input: QmsAlertConfigUpdate
  }) {
    const entries = Object.entries(input.input).filter(([, value]) => value !== undefined)
    if (entries.length === 0) throw new Error('No fields to update')
    if (input.input.threshold !== undefined && !Number.isFinite(input.input.threshold)) {
      throw new Error('Invalid alert threshold')
    }
    return this.options.db.transaction(async db => {
      const parameters: unknown[] = []
      const assignments = entries.map(([key, value]) => {
        parameters.push(key === 'channels' ? JSON.stringify(value) : value)
        return `${key} = $${parameters.length}`
      })
      parameters.push(input.id)
      const idPosition = parameters.length
      const tenant = input.tenantId
        ? ` AND tenant_id = $${parameters.push(input.tenantId)}`
        : ''
      const rows = await db.execute(
        `UPDATE alert_config SET ${assignments.join(', ')}, updated_at = NOW()
         WHERE id = $${idPosition}${tenant} RETURNING *`,
        parameters,
      )
      if (!rows[0]) return null
      await this.audit(db, input.tenantId ?? null, input.userId, 'alert_update', 'alert_config', input.id, input.input)
      return this.mapConfig(rows[0])
    })
  }

  async deleteConfig(input: { id: string; tenantId?: string | null; userId: string }) {
    return this.options.db.transaction(async db => {
      const parameters: unknown[] = [input.id]
      const tenant = input.tenantId
        ? ` AND tenant_id = $${parameters.push(input.tenantId)}`
        : ''
      const rows = await db.execute(
        `DELETE FROM alert_config WHERE id = $1${tenant} RETURNING id, name`,
        parameters,
      )
      if (!rows[0]) return false
      await this.audit(
        db, input.tenantId ?? null, input.userId, 'alert_delete', 'alert_config', input.id, rows[0].name,
      )
      return true
    })
  }

  async history(input: {
    tenantId?: string | null
    configId?: string
    type?: string
    level?: string
    success?: boolean
    acknowledged?: boolean
    startTime?: number
    endTime?: number
    limit?: number
    offset?: number
  }) {
    const parameters: unknown[] = []
    const conditions: string[] = []
    const add = (column: string, value: unknown) => { parameters.push(value); conditions.push(`${column} = $${parameters.length}`) }
    if (input.tenantId) add('tenant_id', input.tenantId)
    if (input.configId) add('config_id', input.configId)
    if (input.type) add('type', input.type)
    if (input.level) add('level', input.level)
    if (input.success !== undefined) add('success', input.success)
    if (input.acknowledged !== undefined) add('acknowledged', input.acknowledged)
    if (input.startTime !== undefined) {
      parameters.push(new Date(input.startTime))
      conditions.push(`sent_at >= $${parameters.length}`)
    }
    if (input.endTime !== undefined) {
      parameters.push(new Date(input.endTime))
      conditions.push(`sent_at < $${parameters.length}`)
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500)
    const offset = Math.max(input.offset ?? 0, 0)
    const listParameters = [...parameters, limit, offset]
    const items = await this.options.db.execute(
      `SELECT * FROM alert_history${where} ORDER BY sent_at DESC LIMIT $${listParameters.length - 1} OFFSET $${listParameters.length}`,
      listParameters,
    )
    const data = items.map(row => this.mapHistory(row))
    return { data, total: data.length, limit, offset }
  }

  async acknowledge(input: { id: number; tenantId?: string | null; userId: string }): Promise<
    { status: 'acknowledged'; acknowledgedAt: Date }
    | { status: 'already_acknowledged' | 'not_found' }
  > {
    return this.options.db.transaction(async db => {
      const lookupParameters: unknown[] = [input.id]
      const tenant = input.tenantId
        ? ` AND tenant_id = $${lookupParameters.push(input.tenantId)}`
        : ''
      const existing = await db.execute(
        `SELECT acknowledged FROM alert_history WHERE id = $1${tenant} FOR UPDATE`, lookupParameters,
      )
      if (!existing[0]) return { status: 'not_found' }
      if (Boolean(existing[0].acknowledged)) return { status: 'already_acknowledged' }
      const acknowledgedAt = new Date()
      await db.execute(
        `UPDATE alert_history SET acknowledged = TRUE, acknowledged_at = $2, acknowledged_by = $3
         WHERE id = $1${input.tenantId ? ' AND tenant_id = $4' : ''}`,
        input.tenantId
          ? [input.id, acknowledgedAt, input.userId, input.tenantId]
          : [input.id, acknowledgedAt, input.userId],
      )
      return { status: 'acknowledged', acknowledgedAt }
    })
  }

  async testNotification(channel: string, context: CommandContext) {
    assertTrustedCommandContext(context)
    if (context.externalEffects === 'suppress_external') {
      return { success: true, suppressed: true }
    }
    return this.options.notifications.send(channel, { title: 'QMS Test Alert', test: true })
  }

  async testConfig(input: {
    id: string
    tenantId?: string | null
    userId: string
    context: CommandContext
    now?: Date
  }) {
    assertTrustedCommandContext(input.context)
    const config = await this.getConfig(input.id, input.tenantId)
    if (!config) return null
    const channels = this.parseChannels(config.channels as string | string[])
    const now = input.now ?? new Date()
    const payload = {
      title: `[TEST] ${String(config.name)}`,
      message: `这是一条测试告警消息。当前阈值: ${String(config.threshold)} (${String(config.comparison)})`,
      level: String(config.level), type: String(config.type),
      detail: config.description || '测试告警', timestamp: now.getTime(),
    }

    await this.audit(
      this.options.db, input.tenantId ?? null, input.userId,
      'alert_test', 'alert_config', input.id, config.name,
    )
    if (input.context.externalEffects === 'suppress_external') {
      return { success: true, suppressed: true, results: [] }
    }

    const deliveryKey = `${input.context.idempotencyKey}:test:${input.id}`
    const reserved = await this.options.db.execute(
      `INSERT INTO alert_history (
        tenant_id, config_id, type, title, detail, level, channels, sent_at, success, delivery_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,$9)
       ON CONFLICT (delivery_key) DO NOTHING RETURNING id`,
      [input.tenantId ?? null, input.id, 'test', payload.title, payload.message,
        config.level, JSON.stringify(channels), now, deliveryKey],
    )
    if (!reserved[0]) return { success: true, suppressed: true, results: [] }

    const results = await Promise.all(channels.map(async channel => ({
      channel, ...await this.options.notifications.send(channel, payload),
    })))
    const success = results.every(result => result.success)
    const error = results.find(result => result.error)?.error ?? null
    await this.options.db.execute(
      'UPDATE alert_history SET success = $2, channel_results = $3, error_message = $4 WHERE id = $1',
      [reserved[0].id, success, JSON.stringify(results), error],
    )
    return { success, results }
  }

  async evaluateType(input: { type: string; context: CommandContext; now?: Date }) {
    assertTrustedCommandContext(input.context)
    const now = input.now ?? new Date()
    const configs = await this.options.db.execute(
      'SELECT * FROM alert_config WHERE enabled = TRUE AND type = $1 ORDER BY id',
      [input.type],
    ) as readonly AlertConfigRow[]
    let triggered = 0
    let suppressed = 0

    for (const config of configs) {
      const value = await this.metricValue(config, now)
      if (value === null || !this.thresholdMatches(value, Number(config.threshold), config.comparison)) continue
      if (input.context.externalEffects === 'suppress_external') {
        suppressed += 1
        continue
      }
      const recent = await this.options.db.execute(
        `SELECT sent_at FROM alert_history
         WHERE config_id = $1 AND success = TRUE AND sent_at > $2
         ORDER BY sent_at DESC LIMIT 1`,
        [config.id, new Date(now.getTime() - Number(config.cooldown_minutes) * 60_000)],
      )
      if (recent.length > 0) {
        suppressed += 1
        continue
      }
      const delivered = await this.deliver(config, value, input.context, now)
      if (delivered) triggered += 1
      else suppressed += 1
    }
    return { checked: configs.length, triggered, suppressed }
  }

  private async deliver(config: AlertConfigRow, value: number, context: CommandContext, now: Date): Promise<boolean> {
    const channels = this.parseChannels(config.channels)
    const deliveryKey = `${context.idempotencyKey}:${config.id}`
    const title = `[${config.level.toUpperCase()}] ${config.name}`
    const detail = `${config.metric} 当前值: ${value.toFixed(2)}, 阈值: ${config.threshold} (${config.comparison})`
    const reserved = await this.options.db.execute(
      `INSERT INTO alert_history (
        tenant_id, config_id, type, title, detail, level, channels, sent_at, success, delivery_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,$9)
       ON CONFLICT (delivery_key) DO NOTHING RETURNING id`,
      [config.tenant_id ?? null, config.id, config.type, title, detail, config.level, JSON.stringify(channels), now, deliveryKey],
    )
    if (!reserved[0]) return false

    const payload = {
      title, message: detail, level: config.level, type: config.type,
      detail: config.description, timestamp: now.getTime(),
    }
    const results = await Promise.all(channels.map(async channel => ({
      channel,
      ...await this.options.notifications.send(channel, payload),
    })))
    const success = results.every(result => result.success)
    const error = results.find(result => result.error)?.error ?? null
    await this.options.db.execute(
      `UPDATE alert_history SET success = $2, channel_results = $3, error_message = $4 WHERE id = $1`,
      [reserved[0].id, success, JSON.stringify(results), error],
    )
    return true
  }

  private async metricValue(config: AlertConfigRow, now: Date): Promise<number | null> {
    const start = new Date(now.getTime() - 5 * 60_000)
    const parameters: unknown[] = [start, now]
    const tenant = config.tenant_id
      ? ` AND tenant_id = $${parameters.push(config.tenant_id)}`
      : ''
    let sql: string
    if ((config.type === 'error' || config.type === 'conversation') && config.metric === 'error_rate') {
      sql = `SELECT COUNT(*) FILTER (WHERE status = 'error') AS matched, COUNT(*) AS total
             FROM telemetry_conversations WHERE timestamp >= $1 AND timestamp < $2${tenant}`
      const row = (await this.options.db.execute(sql, parameters))[0]
      const total = Number(row?.total ?? 0)
      return total > 0 ? Number(row?.matched ?? 0) / total * 100 : 0
    }
    if (config.type === 'error' && config.metric === 'error_count') {
      sql = `SELECT COUNT(*) AS value FROM telemetry_conversations
             WHERE status = 'error' AND timestamp >= $1 AND timestamp < $2${tenant}`
    } else if (config.type === 'error' && config.metric.startsWith('error_code:')) {
      parameters.push(config.metric.slice('error_code:'.length))
      sql = `SELECT COUNT(*) AS value FROM telemetry_conversations
             WHERE status = 'error' AND error_code = $${parameters.length}
             AND timestamp >= $1 AND timestamp < $2${tenant}`
    } else if (config.type === 'conversation' && config.metric === 'avg_duration') {
      sql = `SELECT AVG(duration_ms) AS value FROM telemetry_conversations
             WHERE timestamp >= $1 AND timestamp < $2${tenant}`
    } else if (config.type === 'perf') {
      parameters.push(config.metric)
      sql = `SELECT AVG(value_ms) AS value FROM telemetry_perf_raw
             WHERE metric = $${parameters.length} AND timestamp >= $1 AND timestamp < $2${tenant}`
    } else if (config.type === 'install' && config.metric === 'failure_count') {
      sql = `SELECT COUNT(*) AS value FROM telemetry_install
             WHERE status = 'failed' AND timestamp >= $1 AND timestamp < $2${tenant}`
    } else if (config.type === 'crash') {
      const crashFilter = this.crashMetricFilter(config.metric, parameters)
      if (crashFilter === null) return null
      sql = `SELECT COUNT(*) AS value FROM crash_events
             WHERE timestamp >= $1 AND timestamp < $2${tenant}${crashFilter}`
    } else {
      return null
    }
    const row = (await this.options.db.execute(sql, parameters))[0]
    return row?.value === null || row?.value === undefined ? null : Number(row.value)
  }

  private crashMetricFilter(metric: string, parameters: unknown[]): string | null {
    if (metric === 'crash_count') return ''
    if (metric === 'native_crash_count') return " AND type IN ('native_crash', 'renderer_crash')"
    if (metric === 'js_exception_count') return " AND type = 'js_exception'"
    if (metric.startsWith('crash_type:')) {
      parameters.push(metric.slice('crash_type:'.length))
      return ` AND type = $${parameters.length}`
    }
    if (metric.startsWith('process_type:')) {
      parameters.push(metric.slice('process_type:'.length))
      return ` AND process_type = $${parameters.length}`
    }
    return null
  }

  private thresholdMatches(value: number, threshold: number, comparison: string): boolean {
    if (comparison === 'gt') return value > threshold
    if (comparison === 'gte') return value >= threshold
    if (comparison === 'lt') return value < threshold
    if (comparison === 'lte') return value <= threshold
    if (comparison === 'eq') return value === threshold
    if (comparison === 'neq') return value !== threshold
    return false
  }

  private parseChannels(value: string | string[]): string[] {
    return typeof value === 'string' ? JSON.parse(value) as string[] : value
  }

  private async audit(
    db: QmsSqlPort,
    tenantId: string | null,
    userId: string,
    action: string,
    resource: string,
    resourceId: string,
    detail: unknown,
  ): Promise<void> {
    await db.execute(
      `INSERT INTO audit_logs (tenant_id, user_id, action, resource, resource_id, detail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
      [tenantId, userId, action, resource, resourceId, JSON.stringify(detail)],
    )
  }

  private mapConfig(row: Record<string, unknown>): Record<string, unknown> & { channels: unknown; enabled: boolean } {
    return {
      ...row,
      channels: typeof row.channels === 'string' ? JSON.parse(row.channels) : row.channels,
      enabled: Boolean(row.enabled),
    }
  }

  private mapHistory(row: Record<string, unknown>) {
    return {
      ...row,
      channels: typeof row.channels === 'string' ? JSON.parse(row.channels) : row.channels,
      channel_results: typeof row.channel_results === 'string' ? JSON.parse(row.channel_results) : row.channel_results,
      success: Boolean(row.success),
      acknowledged: Boolean(row.acknowledged),
      sent_at: row.sent_at instanceof Date ? row.sent_at.getTime() : row.sent_at,
      acknowledged_at: row.acknowledged_at instanceof Date ? row.acknowledged_at.getTime() : row.acknowledged_at,
    }
  }
}
