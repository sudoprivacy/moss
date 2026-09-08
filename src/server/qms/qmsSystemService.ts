import { assertTrustedCommandContext, type CommandContext } from '../application/commandContext.js'
import type { QmsNotificationPort } from './alertService.js'
import type { QmsSqlPort } from './qmsSchema.js'
import type { QmsTaskStatus } from './qmsScheduler.js'
import type { QmsTransactionalSqlPort } from './telemetryPostgresWriter.js'

export interface QmsSystemSecretPort {
  get(key: string): string | undefined
  put(key: string, value: string): Promise<void>
  updateNotifications?(input: {
    lark?: { webhookUrl?: string }
    email?: { smtpHost?: string; smtpPort?: number; smtpUser?: string; smtpPass?: string; from?: string; to?: string }
  }): Promise<void>
}

export interface QmsSystemSchedulerPort {
  status(): QmsTaskStatus[]
  runTask(name: string): Promise<boolean>
}

export interface QmsSchemaManagementPort {
  initialize(): Promise<{ timescaleAvailable: boolean }>
  isTimescaleAvailable(): boolean
  switchToContinuousAggregates(): Promise<void>
  aggregationInfo(): Promise<{ mode: string; usingContinuousAggregates: boolean }>
}

const SECRET_CONFIG = /(?:password|secret|token|api[_-]?key|private[_-]?key|smtp_pass|webhook)/i
const MASK = '******'

const ERROR_CODE_DEFINITIONS = [
  ['E001', 'HTTP 5xx / 连接错误', 'RotatingApiClient.ts', 'nova-gateway', 'API 调用返回 HTTP 5xx、网络连接失败 (ECONNREFUSED/ENOTFOUND)'],
  ['E002', 'HTTP 超时', 'RotatingApiClient.ts', 'nova-gateway', 'API 调用超时 (timeout/timed out)'],
  ['E003', 'SSE 中断', 'AcpConnection.ts', 'acp', 'SSE 流中断、JSON-RPC 流解析失败'],
  ['E004', '空响应', 'AcpAgent.ts', 'openclaw', 'Agent 返回空响应'],
  ['E005', 'ACP 解析错', 'AcpMessagePipeline.ts', 'acp', 'ACP 协议消息解析错误'],
  ['E006', 'Gateway 鉴权失败', 'AuthService.ts', 'nova-gateway', 'Gateway 鉴权失败 (HTTP 401/403)'],
  ['E007', 'Gateway 余额不足', 'BillingService.ts', 'nova-gateway', 'Gateway 余额不足 (HTTP 402)'],
  ['E008', '渲染进程 crash', 'ConversationPage.tsx', 'client', '渲染进程 JavaScript 异常崩溃'],
  ['E009', 'Agent 内部错误', 'AcpAgent.ts / OpenClawAgent.ts', 'client', 'Agent 处理过程中未分类的内部异常（默认错误码）'],
  ['E010', 'Gateway 断开连接', 'OpenClawAgent.ts', 'sudoclaw', 'Sudoclaw Gateway WebSocket 断开连接'],
].map(([code, type, location, upstream_component, trigger_scenario]) => ({
  code, type, location, upstream_component, trigger_scenario,
}))

const STAT_TABLES = [
  'telemetry_perf_raw', 'telemetry_conversations', 'telemetry_turns', 'telemetry_steps',
  'telemetry_install', 'telemetry_perf_daily', 'telemetry_conversations_daily',
  'telemetry_conversation_errors_daily', 'telemetry_install_daily', 'crash_events',
  'crash_issues', 'crash_daily_stats', 'alert_config', 'alert_history', 'audit_logs', 'system_config',
] as const

const RAW_TABLES = [
  ['telemetry_perf_raw', '性能原始数据', 'timestamp'],
  ['telemetry_conversations', '对话原始数据', 'timestamp'],
  ['telemetry_install', '安装原始数据', 'timestamp'],
  ['crash_events', '崩溃原始数据', 'timestamp'],
  ['telemetry_perf_daily', '性能聚合数据', 'bucket'],
  ['telemetry_conversations_daily', '对话聚合数据', 'bucket'],
  ['telemetry_conversation_errors_daily', '对话错误聚合数据', 'bucket'],
  ['telemetry_install_daily', '安装聚合数据', 'bucket'],
  ['crash_daily_stats', '崩溃聚合数据', 'bucket'],
] as const

export class QmsSystemService {
  constructor(private readonly options: {
    db: QmsTransactionalSqlPort
    schema: QmsSchemaManagementPort
    scheduler: QmsSystemSchedulerPort
    secrets: QmsSystemSecretPort
    notifications: QmsNotificationPort
    databaseHealthy(): Promise<boolean>
    environment: { NODE_ENV: string; PORT: number; HOST: string; LOG_LEVEL: string }
    version: string
    uptime?: () => number
    memoryUsage?: () => NodeJS.MemoryUsage
    backfill?: (days: number) => Promise<void>
  }) {}

  async health() {
    const healthy = await this.options.databaseHealthy()
    return {
      status: healthy ? 200 : 503,
      body: {
        status: healthy ? 'healthy' : 'unhealthy', version: this.options.version,
        uptime: Math.floor(this.options.uptime?.() ?? process.uptime()), checks: { database: healthy },
      },
    }
  }

  async aggregationInfo() {
    const info = await this.options.schema.aggregationInfo()
    return {
      timescaledb_available: this.options.schema.isTimescaleAvailable(),
      mode: info.mode,
      using_continuous_aggregates: info.usingContinuousAggregates,
    }
  }

  initializeSchema() { return this.options.schema.initialize() }

  async switchToContinuousAggregates() {
    if (!this.options.schema.isTimescaleAvailable()) throw new Error('TIMESCALEDB_NOT_AVAILABLE')
    await this.options.schema.switchToContinuousAggregates()
  }

  async stats() {
    const tables: Array<{ name: string; count: number }> = []
    for (const name of STAT_TABLES) {
      try {
        const rows = await this.options.db.execute(`SELECT COUNT(*) AS count FROM ${name}`)
        tables.push({ name, count: Number(rows[0]?.count ?? 0) })
      } catch {
        tables.push({ name, count: 0 })
      }
    }
    const memory = this.options.memoryUsage?.() ?? process.memoryUsage()
    return {
      uptime: Math.floor(this.options.uptime?.() ?? process.uptime()), version: this.options.version,
      node_version: process.version, platform: process.platform,
      memory_usage: { rss: memory.rss, heap_total: memory.heapTotal, heap_used: memory.heapUsed, external: memory.external },
      database: { size: 0, tables },
    }
  }

  async listConfig() {
    const rows = await this.options.db.execute('SELECT * FROM system_config ORDER BY key')
    return rows.map(row => this.redactConfig(row))
  }

  async getConfig(key: string) {
    const rows = await this.options.db.execute('SELECT * FROM system_config WHERE key = $1', [key])
    return rows[0] ? this.redactConfig(rows[0]) : null
  }

  async updateConfig(input: { key: string; value: string; userId: string }) {
    if (SECRET_CONFIG.test(input.key)) {
      await this.options.secrets.put(input.key, input.value)
      await this.auditSecret(input.userId, input.key)
      return { key: input.key, value: MASK, updated_at: Date.now() }
    }
    return this.options.db.transaction(async db => {
      const existing = await db.execute('SELECT * FROM system_config WHERE key = $1', [input.key])
      if (!existing[0]) return null
      const rows = await db.execute(
        'UPDATE system_config SET value = $2, updated_at = NOW() WHERE key = $1 RETURNING *',
        [input.key, input.value],
      )
      await db.execute(
        `INSERT INTO audit_logs (user_id, action, resource, resource_id, detail, created_at)
         VALUES ($1,'config_update','system_config',$2,$3,NOW())`,
        [input.userId, input.key, `${String(existing[0].value)} -> ${input.value}`],
      )
      return rows[0] ?? null
    })
  }

  environment() { return { ...this.options.environment } }

  notificationConfig() {
    const read = (key: string) => this.options.secrets.get(key)
    return {
      lark: { webhookUrl: read('notification_lark_webhook') ? MASK : '' },
      email: {
        smtpHost: read('notification_email_smtp_host') ?? '',
        smtpPort: Number(read('notification_email_smtp_port') ?? 587),
        smtpUser: read('notification_email_smtp_user') ? MASK : '',
        smtpPass: read('notification_email_smtp_pass') ? MASK : '',
        from: read('notification_email_from') ?? '', to: read('notification_email_to') ?? '',
      },
    }
  }

  async updateNotifications(input: {
    userId: string
    input: {
      lark?: { webhookUrl?: string }
      email?: { smtpHost?: string; smtpPort?: number; smtpUser?: string; smtpPass?: string; from?: string; to?: string }
    }
  }) {
    if (this.options.secrets.updateNotifications) {
      await this.options.secrets.updateNotifications(input.input)
      for (const key of [
        ...(input.input.lark ? ['notification_lark_webhook'] : []),
        ...(input.input.email ? ['notification_email_smtp_url'] : []),
      ]) await this.auditSecret(input.userId, key)
      return
    }
    const entries: Array<[string, unknown]> = [
      ['notification_lark_webhook', input.input.lark?.webhookUrl],
      ['notification_email_smtp_host', input.input.email?.smtpHost],
      ['notification_email_smtp_port', input.input.email?.smtpPort],
      ['notification_email_smtp_user', input.input.email?.smtpUser],
      ['notification_email_smtp_pass', input.input.email?.smtpPass],
      ['notification_email_from', input.input.email?.from],
      ['notification_email_to', input.input.email?.to],
    ]
    for (const [key, value] of entries) {
      if (value === undefined) continue
      await this.options.secrets.put(key, String(value))
      await this.auditSecret(input.userId, key)
    }
  }

  async testNotification(channel: string, context: CommandContext) {
    assertTrustedCommandContext(context)
    if (channel !== 'lark' && channel !== 'email') throw new Error('INVALID_CHANNEL')
    if (context.externalEffects === 'suppress_external') return { success: true, suppressed: true }
    return this.options.notifications.send(channel, { title: 'QMS 测试通知', test: true })
  }

  tasks() {
    return this.options.scheduler.status().map(task => ({
      name: task.name, last_run: task.lastRun, next_run: task.nextRun,
      running: task.running, last_error: task.lastError,
    }))
  }

  async runAggregation() {
    const results = []
    for (const task of ['aggregation', 'crash-aggregation']) {
      try {
        const success = await this.options.scheduler.runTask(task)
        results.push({ task: task === 'aggregation' ? 'telemetry_aggregation' : 'crash_aggregation', success })
      } catch (error) {
        results.push({ task: task === 'aggregation' ? 'telemetry_aggregation' : 'crash_aggregation', success: false, error: String(error) })
      }
    }
    return { results, timestamp: Date.now() }
  }

  async rawStats() {
    const stats = []
    for (const [table, label, timeColumn] of RAW_TABLES) {
      const rows = await this.options.db.execute(
        `SELECT COUNT(*) AS count, MIN(${timeColumn}) AS earliest, MAX(${timeColumn}) AS latest FROM ${table}`,
      )
      const row = rows[0] ?? {}
      stats.push({
        table, label, count: Number(row.count ?? 0),
        earliest: row.earliest ? new Date(row.earliest as string | number | Date).toISOString() : null,
        latest: row.latest ? new Date(row.latest as string | number | Date).toISOString() : null,
      })
    }
    return stats
  }

  async backfill(days = 7) {
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('INVALID_DAYS')
    if (!this.options.backfill) throw new Error('BACKFILL_NOT_CONFIGURED')
    await this.options.backfill(days)
  }

  errorCodes() { return ERROR_CODE_DEFINITIONS }

  private redactConfig(row: Record<string, unknown>) {
    return SECRET_CONFIG.test(String(row.key)) ? { ...row, value: MASK } : { ...row }
  }

  private async auditSecret(userId: string, key: string) {
    await this.options.db.execute(
      `INSERT INTO audit_logs (user_id, action, resource, resource_id, detail, created_at)
       VALUES ($1,'config_update','notification',$2,$3,NOW())`,
      [userId, key, 'secret updated'],
    )
  }
}
