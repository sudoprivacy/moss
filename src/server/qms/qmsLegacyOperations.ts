import { randomUUID } from 'node:crypto'

import { onlineCommandContext } from '../application/commandContext.js'
import { QMS_LEGACY_ROUTES, type QmsLegacyOperationPort } from '../api/compat/sudowork/qmsRoutes.js'
import type { QmsAlertConfigInput, QmsAlertService } from './alertService.js'
import type { CrashEvent, CrashService } from './crashService.js'
import type { QmsDashboardQueryService } from './dashboardQueryService.js'
import type { QmsAdminScope } from './qmsAuthorization.js'
import type { QmsSystemService } from './qmsSystemService.js'
import type { TelemetryService } from './telemetryService.js'
import type { QmsUserStatsService } from './userStatsService.js'

type Result = { status: number; body: unknown; headers?: Record<string, string> }
type Input = Parameters<QmsLegacyOperationPort['execute']>[0]

function ok(data?: unknown): Result {
  return { status: 200, body: data === undefined ? { success: true } : { success: true, data } }
}

function number(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function scope(input: Input): QmsAdminScope {
  if (!input.scope) throw new Error('QMS administrator scope is required')
  return input.scope
}

function query(input: Input) {
  const authorized = scope(input)
  return {
    tenantId: authorized.tenantId,
    startTime: input.query.start_time ? number(input.query.start_time, NaN) : undefined,
    endTime: input.query.end_time ? number(input.query.end_time, NaN) : undefined,
    dimension: input.query.dimension,
    metric: input.query.metric,
    platform: input.query.platform,
    arch: input.query.arch,
    version: input.query.version,
    installType: input.query.install_type,
    errorCode: input.query.error_code,
    orgId: input.query.org_id,
    loginMode: input.query.login_mode,
    userId: input.query.user_id,
    stepType: input.query.step_type,
    order: input.query.order,
    limit: input.query.limit ? number(input.query.limit, 50) : undefined,
  }
}

function canonicalCrashKey(key: string): string {
  return key.replace('/api/v1/qms/crash/', '/api/v1/crash/')
}

export class QmsLegacyOperations implements QmsLegacyOperationPort {
  private readonly keys = new Set(QMS_LEGACY_ROUTES.map(([method, path]) => `${method} ${path}`))

  constructor(private readonly services: {
    telemetry: Pick<TelemetryService, 'ingestBatch' | 'ingestSingle'>
    queue: { depths(): Promise<unknown> }
    crash: Pick<CrashService, 'ingest' | 'ingestBatch' | 'listIssues' | 'getIssue' | 'updateIssue' | 'listEvents' | 'getEvent' | 'summary' | 'trend' | 'distribution'>
    dashboard: Pick<QmsDashboardQueryService, 'overview' | 'perfTrend' | 'dimensions' | 'conversationErrorTrend' | 'conversationTrend' | 'installTrend'>
    userStats: Pick<QmsUserStatsService, 'conversations' | 'turns' | 'steps' | 'leaderboard' | 'userDetail' | 'realtime'>
    alerts: Pick<QmsAlertService, 'listConfigs' | 'getConfig' | 'createConfig' | 'updateConfig' | 'deleteConfig' | 'history' | 'acknowledge' | 'testConfig'>
    system: Pick<QmsSystemService, 'health' | 'aggregationInfo' | 'initializeSchema' | 'switchToContinuousAggregates' | 'stats' | 'listConfig' | 'getConfig' | 'updateConfig' | 'environment' | 'notificationConfig' | 'updateNotifications' | 'testNotification' | 'tasks' | 'runAggregation' | 'rawStats' | 'backfill' | 'errorCodes'>
    crashTasks: { runTask(name: string): Promise<boolean> }
  }) {}

  supports(key: string): boolean { return this.keys.has(key) }

  async execute(input: Input): Promise<Result> {
    const key = canonicalCrashKey(input.key)
    if (key === 'POST /api/v1/telemetry/batch') return ok(await this.services.telemetry.ingestBatch(input.body))
    if (key === 'GET /api/v1/telemetry/queue/stats') return ok(await this.services.queue.depths())
    if (key === 'POST /api/v1/telemetry/perf') return ok(await this.services.telemetry.ingestSingle('perf', input.body))
    if (key === 'POST /api/v1/telemetry/conversation') return ok(await this.services.telemetry.ingestSingle('conversation', input.body))
    if (key === 'POST /api/v1/telemetry/install') return ok(await this.services.telemetry.ingestSingle('install', input.body))

    if (key === 'POST /api/v1/crash/events') {
      const event = bodyRecord(input.body)
      if (['type', 'timestamp', 'version', 'platform'].some(field => event[field] === undefined || event[field] === null || event[field] === '')) {
        return { status: 400, body: { success: false, error: 'Missing required fields' } }
      }
      const result = await this.services.crash.ingest(event as unknown as CrashEvent, typeof event.event_id === 'string' ? event.event_id : undefined)
      return { status: 200, body: { success: true, received: 1, issue_id: result.issueId } }
    }
    if (key === 'POST /api/v1/crash/events/batch') {
      const value = bodyRecord(input.body)
      const events = Array.isArray(value.events) ? value.events.map(event => ({ ...value, ...bodyRecord(event), events: undefined })) : []
      if (events.length === 0) return { status: 400, body: { success: false, error: 'No events provided' } }
      const result = await this.services.crash.ingestBatch(events as unknown as CrashEvent[])
      return { status: 200, body: { success: true, ...result } }
    }
    if (key === 'GET /api/v1/crash/issues') {
      const result = await this.services.crash.listIssues({
        tenantId: scope(input).tenantId, status: input.query.status, level: input.query.level,
        type: input.query.type, version: input.query.version,
        limit: number(input.query.limit, 50), offset: number(input.query.offset, 0),
      })
      return { status: 200, body: { success: true, data: result.items, total: result.total, limit: result.limit, offset: result.offset } }
    }
    if (key === 'GET /api/v1/crash/issues/:id') {
      const id = number(input.params.id, NaN)
      const issue = await this.services.crash.getIssue(id, scope(input).tenantId)
      if (!issue) return { status: 404, body: { success: false, error: 'Issue not found' } }
      const events = await this.services.crash.listEvents({
        tenantId: issue.tenant_id == null ? null : String(issue.tenant_id), issueId: id, limit: 10,
      })
      return { status: 200, body: { success: true, data: issue, events: events.items } }
    }
    if (key === 'PUT /api/v1/crash/issues/:id' || key.endsWith('/issues/:id/resolve') || key.endsWith('/issues/:id/ignore')) {
      const status = key.endsWith('/resolve') ? 'resolved' : key.endsWith('/ignore') ? 'ignored' : undefined
      const issue = await this.services.crash.updateIssue(
        number(input.params.id, NaN), status ? { status } : bodyRecord(input.body), scope(input).tenantId,
      )
      if (!issue) return { status: 404, body: { success: false, error: 'Issue not found' } }
      const message = status === 'resolved' ? 'Issue marked as resolved' : status === 'ignored' ? 'Issue marked as ignored' : undefined
      return { status: 200, body: { success: true, data: issue, ...(message ? { message } : {}) } }
    }
    if (key === 'GET /api/v1/crash/events') {
      const result = await this.services.crash.listEvents({
        tenantId: scope(input).tenantId, issueId: input.query.issue_id ? number(input.query.issue_id, NaN) : undefined,
        version: input.query.version, platform: input.query.platform, type: input.query.type,
        limit: number(input.query.limit, 100), offset: number(input.query.offset, 0),
      })
      return { status: 200, body: { success: true, data: result.items, total: result.total, limit: result.limit, offset: result.offset } }
    }
    if (key === 'GET /api/v1/crash/events/:id') {
      const event = await this.services.crash.getEvent(number(input.params.id, NaN), scope(input).tenantId)
      return event ? ok(event) : { status: 404, body: { success: false, error: 'Event not found' } }
    }
    if (key === 'GET /api/v1/crash/stats/summary') return ok(await this.services.crash.summary(scope(input).tenantId))
    if (key === 'GET /api/v1/crash/stats/trend') {
      const days = number(input.query.days, 7)
      return { status: 200, body: { success: true, data: await this.services.crash.trend(days, scope(input).tenantId), days } }
    }
    if (key === 'GET /api/v1/crash/stats/distribution') {
      const by = input.query.by ?? 'type'
      try {
        return { status: 200, body: { success: true, data: await this.services.crash.distribution(scope(input).tenantId, by as 'type' | 'version' | 'platform'), by } }
      } catch {
        return { status: 400, body: { success: false, error: "Invalid 'by' parameter" } }
      }
    }
    if (key === 'POST /api/v1/crash/admin/aggregate') {
      await this.services.crashTasks.runTask('crash-aggregation')
      return { status: 200, body: { success: true, message: 'Daily aggregation triggered' } }
    }
    if (key === 'POST /api/v1/crash/admin/cleanup') {
      await this.services.crashTasks.runTask('crash-cleanup')
      return { status: 200, body: { success: true, message: `Cleanup triggered, retention: ${number(input.query.retention, 90)} days` } }
    }

    if (key.startsWith('GET /api/v1/qms/dashboard/')) return this.dashboard(input)
    if (key.startsWith('GET /api/v1/qms/user-stats/')) return this.userStats(input)
    if (key.includes('/api/v1/qms/alerts/')) return this.alerts(input)
    if (key.includes('/api/v1/qms/system/')) return this.system(input)
    return { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'QMS route not found' } } }
  }

  private async dashboard(input: Input): Promise<Result> {
    const path = input.key.slice('GET /api/v1/qms/dashboard/'.length)
    const value = query(input)
    if (path === 'overview') return ok(await this.services.dashboard.overview(value))
    if (path === 'perf/trend') return ok(await this.services.dashboard.perfTrend(value))
    if (path === 'perf/dimensions') return ok(await this.services.dashboard.dimensions('perf', value))
    if (path === 'conversations/errors/trend') return ok(await this.services.dashboard.conversationErrorTrend(value))
    if (path === 'conversations/trend') return ok(await this.services.dashboard.conversationTrend(value))
    if (path === 'conversations/dimensions') return ok(await this.services.dashboard.dimensions('conversation', value))
    if (path === 'installs/trend') return ok(await this.services.dashboard.installTrend(value))
    if (path === 'installs/dimensions') return ok(await this.services.dashboard.dimensions('install', value))
    throw new Error(`Unsupported dashboard operation: ${path}`)
  }

  private async userStats(input: Input): Promise<Result> {
    const path = input.key.slice('GET /api/v1/qms/user-stats/'.length)
    const value = query(input)
    if (path === 'conversations') return ok(await this.services.userStats.conversations(value))
    if (path === 'turns') return ok(await this.services.userStats.turns(value))
    if (path === 'steps') return ok(await this.services.userStats.steps(value))
    if (path === 'leaderboard/:type') {
      try { return ok(await this.services.userStats.leaderboard(input.params.type, value)) }
      catch (error) { return { status: 400, body: { success: false, error: { code: 'INVALID_TYPE', message: String((error as Error).message) } } } }
    }
    if (path === 'users/:userId') return ok(await this.services.userStats.userDetail(input.params.userId, value))
    if (path === 'realtime') return ok(await this.services.userStats.realtime(value))
    throw new Error(`Unsupported user stats operation: ${path}`)
  }

  private async alerts(input: Input): Promise<Result> {
    const currentScope = scope(input)
    const key = input.key
    if (key === 'GET /api/v1/qms/alerts/configs') return ok(await this.services.alerts.listConfigs(currentScope.tenantId))
    if (key === 'GET /api/v1/qms/alerts/configs/:id') {
      const config = await this.services.alerts.getConfig(input.params.id, currentScope.tenantId)
      return config ? ok(config) : { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Alert config not found' } } }
    }
    if (key === 'POST /api/v1/qms/alerts/configs') return ok(await this.services.alerts.createConfig({
      tenantId: currentScope.tenantId, userId: currentScope.userId, input: bodyRecord(input.body) as unknown as QmsAlertConfigInput,
    }))
    if (key === 'PUT /api/v1/qms/alerts/configs/:id') {
      try {
        const config = await this.services.alerts.updateConfig({
          id: input.params.id, tenantId: currentScope.tenantId, userId: currentScope.userId, input: bodyRecord(input.body),
        })
        return config ? ok(config) : { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Alert config not found' } } }
      } catch (error) {
        if ((error as Error).message === 'No fields to update') return { status: 400, body: { success: false, error: { code: 'NO_UPDATE', message: 'No fields to update' } } }
        throw error
      }
    }
    if (key === 'DELETE /api/v1/qms/alerts/configs/:id') {
      const deleted = await this.services.alerts.deleteConfig({ id: input.params.id, tenantId: currentScope.tenantId, userId: currentScope.userId })
      return deleted ? ok({ id: input.params.id }) : { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Alert config not found' } } }
    }
    if (key === 'GET /api/v1/qms/alerts/history') return ok(await this.services.alerts.history({
      tenantId: currentScope.tenantId, configId: input.query.config_id, type: input.query.type,
      level: input.query.level, success: input.query.success === undefined ? undefined : input.query.success === 'true',
      acknowledged: input.query.acknowledged === undefined ? undefined : input.query.acknowledged === 'true',
      startTime: input.query.start_time ? number(input.query.start_time, NaN) : undefined,
      endTime: input.query.end_time ? number(input.query.end_time, NaN) : undefined,
      limit: number(input.query.limit, 50), offset: number(input.query.offset, 0),
    }))
    if (key === 'POST /api/v1/qms/alerts/history/:id/acknowledge') {
      const result = await this.services.alerts.acknowledge({
        id: number(input.params.id, NaN), tenantId: currentScope.tenantId, userId: currentScope.userId,
      })
      if (result.status === 'not_found') {
        return { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Alert history not found' } } }
      }
      if (result.status === 'already_acknowledged') {
        return { status: 400, body: { success: false, error: { code: 'ALREADY_ACKNOWLEDGED', message: 'Alert already acknowledged' } } }
      }
      if (result.status !== 'acknowledged') throw new Error(`Unsupported acknowledge status: ${result.status}`)
      return ok({
        id: number(input.params.id, NaN), acknowledged_at: result.acknowledgedAt.getTime(),
        acknowledged_by: currentScope.userId,
      })
    }
    if (key === 'POST /api/v1/qms/alerts/configs/:id/test') {
      const result = await this.services.alerts.testConfig({
        id: input.params.id, tenantId: currentScope.tenantId, userId: currentScope.userId,
        context: onlineCommandContext(`qms-alert-test:${input.params.id}:${randomUUID()}`),
      })
      if (!result) return { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Alert config not found' } } }
      return ok({
        message: result.success ? 'Test alert sent successfully' : 'Test alert partially sent',
        results: result.results,
      })
    }
    throw new Error(`Unsupported alert operation: ${key}`)
  }

  private async system(input: Input): Promise<Result> {
    const key = input.key
    if (key === 'GET /api/v1/qms/system/health') return this.services.system.health()
    if (key === 'GET /api/v1/qms/system/aggregation-info') return ok(await this.services.system.aggregationInfo())
    if (key === 'POST /api/v1/qms/system/init-schema') {
      try {
        const result = await this.services.system.initializeSchema()
        return { status: 200, body: { success: true, message: 'Database schema reinitialized successfully', timescaledb_available: result.timescaleAvailable } }
      } catch (error) {
        return { status: 500, body: { success: false, error: { code: 'SCHEMA_INIT_FAILED', message: (error as Error).message } } }
      }
    }
    if (key === 'POST /api/v1/qms/system/switch-to-continuous-aggregates') {
      try { await this.services.system.switchToContinuousAggregates(); return { status: 200, body: { success: true, message: 'Successfully switched to TimescaleDB continuous aggregates' } } }
      catch (error) {
        if ((error as Error).message === 'TIMESCALEDB_NOT_AVAILABLE') return { status: 400, body: { success: false, error: { code: 'TIMESCALEDB_NOT_AVAILABLE', message: 'TimescaleDB extension is not installed' } } }
        if ((error as Error).message.startsWith('CONTINUOUS_AGGREGATES_EXIST')) {
          const detail = (error as Error).message.split(':').slice(1).join(':').trim()
          return { status: 400, body: { success: false, error: { code: 'CONTINUOUS_AGGREGATES_EXIST', message: `Continuous aggregates already exist${detail ? `: ${detail}` : ''}` } } }
        }
        throw error
      }
    }
    if (key === 'GET /api/v1/qms/system/stats') return ok(await this.services.system.stats())
    if (key === 'GET /api/v1/qms/system/config') return ok(await this.services.system.listConfig())
    if (key === 'GET /api/v1/qms/system/config/:key') {
      const config = await this.services.system.getConfig(input.params.key)
      return config ? ok(config) : { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Config not found' } } }
    }
    if (key === 'PUT /api/v1/qms/system/config/:key') {
      const value = bodyRecord(input.body).value
      const config = await this.services.system.updateConfig({ key: input.params.key, value: String(value ?? ''), userId: scope(input).userId })
      return config ? ok(config) : { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Config not found' } } }
    }
    if (key === 'GET /api/v1/qms/system/env') return ok(this.services.system.environment())
    if (key === 'GET /api/v1/qms/system/notifications') return ok(this.services.system.notificationConfig())
    if (key === 'PUT /api/v1/qms/system/notifications') {
      await this.services.system.updateNotifications({ userId: scope(input).userId, input: bodyRecord(input.body) })
      return { status: 200, body: { success: true, message: '通知配置已更新' } }
    }
    if (key === 'POST /api/v1/qms/system/notifications/test/:channel') {
      const channel = input.params.channel
      if (channel !== 'lark' && channel !== 'email') return { status: 400, body: { success: false, error: { code: 'INVALID_CHANNEL', message: '只支持 lark 和 email 通道' } } }
      const result = await this.services.system.testNotification(channel, onlineCommandContext(`qms-notification-test:${randomUUID()}`))
      return result.success
        ? { status: 200, body: { success: true, message: `测试通知已发送到 ${channel === 'lark' ? '飞书' : '邮件'}` } }
        : { status: 400, body: { success: false, error: { code: 'TEST_FAILED', message: 'error' in result ? result.error ?? '发送失败' : '发送失败' } } }
    }
    if (key === 'GET /api/v1/qms/system/tasks') return ok(this.services.system.tasks())
    if (key === 'POST /api/v1/qms/system/aggregation/run') {
      const data = await this.services.system.runAggregation()
      const success = data.results.every((item: { success: boolean }) => item.success)
      return { status: 200, body: { success, data, message: success ? '聚合任务执行完成' : '部分聚合任务执行失败' } }
    }
    if (key === 'GET /api/v1/qms/system/raw-stats') return ok(await this.services.system.rawStats())
    if (key === 'POST /api/v1/qms/system/aggregation/backfill') {
      const days = number(String(bodyRecord(input.body).days ?? ''), 7)
      if (days < 1 || days > 30) return { status: 400, body: { success: false, error: { code: 'INVALID_DAYS', message: '天数必须在1-30之间' } } }
      await this.services.system.backfill(days)
      return { status: 200, body: { success: true, message: `历史数据回填完成，已聚合最近 ${days} 天的数据` } }
    }
    if (key === 'GET /api/v1/qms/system/error-codes') return ok(this.services.system.errorCodes())
    throw new Error(`Unsupported system operation: ${key}`)
  }
}
