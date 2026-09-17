import type { QmsSqlPort } from './qmsSchema.js'

export interface QmsDashboardQuery {
  tenantId?: string | null
  startTime?: number
  endTime?: number
  dimension?: string
  metric?: string
  platform?: string
  arch?: string
  version?: string
  installType?: string
  errorCode?: string
}

function number(value: unknown): number {
  const result = Number(value ?? 0)
  return Number.isFinite(result) ? result : 0
}

function rate(part: number, total: number, empty: number): number {
  return total === 0 ? empty : Math.round(part / total * 100)
}

function trend(current: number, previous: number): number {
  return previous === 0 ? (current > 0 ? 100 : 0) : Math.round((current - previous) / previous * 100)
}

function date(value: unknown): unknown {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value
}

function platformLabel(platform: unknown, arch: unknown): string {
  if (platform === 'win32' && arch === 'x64') return 'Windows X64'
  if (platform === 'win32' && arch === 'x86') return 'Windows X86'
  if (platform === 'darwin' && arch === 'x64') return 'macOS Intel'
  if (platform === 'darwin' && arch === 'arm64') return 'macOS ARM'
  return `${String(platform)} ${String(arch)}`
}

export class QmsDashboardQueryService {
  constructor(private readonly db: QmsSqlPort) {}

  async overview(query: QmsDashboardQuery) {
    const { start, end } = this.range(query, 86_400_000)
    const duration = end.getTime() - start.getTime()
    const previousStart = new Date(start.getTime() - duration)
    const current = this.scope(start, end, query.tenantId)
    const previous = this.scope(previousStart, start, query.tenantId)
    const [conversations, previousConversations, topErrors, previousErrors, perf, previousPerf, installs,
      installVersions, installPlatforms, crashes, crashTypes, crashPlatforms, crashVersions, crashProcesses,
      previousCrashes] = await Promise.all([
      this.db.execute(`SELECT COUNT(*)::INTEGER AS total,
        COUNT(*) FILTER (WHERE status = 'success')::INTEGER AS success,
        COUNT(*) FILTER (WHERE status = 'error')::INTEGER AS error,
        COUNT(*) FILTER (WHERE status = 'user_cancel')::INTEGER AS user_cancel,
        AVG(duration_ms)::INTEGER AS avg_duration_ms, AVG(tokens_used)::INTEGER AS avg_tokens
        FROM telemetry_conversations WHERE timestamp >= $1 AND timestamp < $2${current.sql}`, current.parameters),
      this.db.execute(`SELECT COUNT(*)::INTEGER AS previous_total FROM telemetry_conversations
        WHERE timestamp >= $1 AND timestamp < $2${previous.sql}`, previous.parameters),
      this.db.execute(`SELECT error_code, COUNT(*)::INTEGER AS count, MAX(created_at) AS last_occurrence
        FROM telemetry_conversations WHERE timestamp >= $1 AND timestamp < $2${current.sql}
        AND status = 'error' AND error_code IS NOT NULL GROUP BY error_code ORDER BY count DESC LIMIT 5`, current.parameters),
      this.db.execute(`SELECT error_code, COUNT(*)::INTEGER AS count FROM telemetry_conversations
        WHERE timestamp >= $1 AND timestamp < $2${previous.sql}
        AND status = 'error' AND error_code IS NOT NULL GROUP BY error_code`, previous.parameters),
      this.db.execute(`SELECT metric, value_ms FROM telemetry_perf_raw
        WHERE timestamp >= $1 AND timestamp < $2${current.sql}`, current.parameters),
      this.db.execute(`SELECT metric, AVG(value_ms) AS avg FROM telemetry_perf_raw
        WHERE timestamp >= $1 AND timestamp < $2${previous.sql} GROUP BY metric`, previous.parameters),
      this.db.execute(`SELECT COUNT(*)::INTEGER AS total,
        COUNT(*) FILTER (WHERE status = 'success')::INTEGER AS success,
        COUNT(*) FILTER (WHERE status = 'failed')::INTEGER AS failed,
        AVG(duration_ms)::INTEGER AS avg_duration_ms FROM telemetry_install
        WHERE timestamp >= $1 AND timestamp < $2${current.sql}`, current.parameters),
      this.groupCount('telemetry_install', 'version', current),
      this.groupCount('telemetry_install', 'platform', current),
      this.db.execute(`SELECT COUNT(*)::INTEGER AS total FROM crash_events
        WHERE timestamp >= $1 AND timestamp < $2${current.sql}`, current.parameters),
      this.groupCount('crash_events', 'type', current),
      this.groupCount('crash_events', 'platform', current),
      this.groupCount('crash_events', 'version', current),
      this.groupCount('crash_events', 'process_type', current),
      this.db.execute(`SELECT COUNT(*)::INTEGER AS previous_total FROM crash_events
        WHERE timestamp >= $1 AND timestamp < $2${previous.sql}`, previous.parameters),
    ])
    const conv = conversations[0] ?? {}
    const install = installs[0] ?? {}
    const crash = crashes[0] ?? {}
    const previousErrorMap = new Map(previousErrors.map(row => [String(row.error_code), number(row.count)]))
    const perfValues = new Map<string, number[]>()
    for (const row of perf) {
      const values = perfValues.get(String(row.metric)) ?? []
      values.push(number(row.value_ms))
      perfValues.set(String(row.metric), values)
    }
    const previousPerfMap = new Map(previousPerf.map(row => [String(row.metric), number(row.avg)]))
    const perfSummary = [...perfValues].map(([metric, values]) => {
      const sorted = [...values].sort((a, b) => a - b)
      const percentile = (value: number) => sorted[Math.max(0, Math.ceil(value / 100 * sorted.length) - 1)] ?? 0
      const average = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
      return {
        metric, min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0, avg: average, count: values.length,
        p50: percentile(50), p90: percentile(90), p95: percentile(95), p99: percentile(99),
        trend: trend(average, previousPerfMap.get(metric) ?? 0),
      }
    })
    const total = number(conv.total)
    const success = number(conv.success)
    const errors = number(conv.error)
    return {
      period: { start: start.getTime(), end: end.getTime() },
      conversations: {
        total, success, error: errors, user_cancel: number(conv.user_cancel),
        success_rate: rate(success, total, 100), avg_duration_ms: Math.round(number(conv.avg_duration_ms)),
        avg_tokens: Math.round(number(conv.avg_tokens)),
        trend: trend(total, number(previousConversations[0]?.previous_total)),
      },
      errors: {
        total: errors, error_rate: rate(errors, total, 0),
        top_errors: topErrors.map(row => ({
          error_code: row.error_code, count: number(row.count),
          last_occurrence: row.last_occurrence instanceof Date ? row.last_occurrence.getTime() : row.last_occurrence,
          trend: trend(number(row.count), previousErrorMap.get(String(row.error_code)) ?? 0),
        })),
      },
      performance: { metrics: perfSummary },
      installs: {
        total: number(install.total), success: number(install.success), failed: number(install.failed),
        success_rate: rate(number(install.success), number(install.total), 100),
        avg_duration_ms: Math.round(number(install.avg_duration_ms)),
        by_version: installVersions, by_platform: installPlatforms,
      },
      crashes: {
        total: number(crash.total), trend: trend(number(crash.total), number(previousCrashes[0]?.previous_total)),
        by_type: crashTypes, by_platform: crashPlatforms, by_version: crashVersions, by_process: crashProcesses,
      },
    }
  }

  async perfTrend(query: QmsDashboardQuery) {
    const dimension = this.dimension(query.dimension)
    const range = this.scopeRange(query)
    const filters = this.filters(range.parameters, [
      ['metric', query.metric], ['platform', query.platform], ['arch', query.arch], ['version', query.version],
    ])
    const dimensions = dimension === 'platform' ? ', platform, arch' : dimension === 'version' ? ', version' : ''
    const rows = await this.db.execute(
      `SELECT bucket AS date, metric${dimensions}, AVG(p50)::INTEGER AS p50, AVG(p90)::INTEGER AS p90,
       AVG(p95)::INTEGER AS p95, AVG(avg_value)::INTEGER AS avg_value, SUM(count)::INTEGER AS count
       FROM telemetry_perf_daily WHERE bucket >= $1 AND bucket < $2${range.sql}${filters.sql}
       GROUP BY bucket, metric${dimensions} ORDER BY bucket ASC${dimensions}`,
      filters.parameters,
    )
    return rows.map(row => ({ ...row, date: date(row.date) }))
  }

  async conversationErrorTrend(query: QmsDashboardQuery) {
    const range = this.scopeRange(query)
    const filters = this.filters(range.parameters, [['error_code', query.errorCode]])
    const rows = await this.db.execute(
      `SELECT DATE_TRUNC('day', timestamp) AS date, error_code, COUNT(*)::INTEGER AS count
       FROM telemetry_conversations WHERE timestamp >= $1 AND timestamp < $2${range.sql}${filters.sql}
       AND status = 'error' AND error_code IS NOT NULL
       GROUP BY DATE_TRUNC('day', timestamp), error_code ORDER BY date ASC`, filters.parameters,
    )
    return rows.map(row => ({ date: date(row.date), error_code: row.error_code, count: row.count }))
  }

  async conversationTrend(query: QmsDashboardQuery) {
    const dimension = this.dimension(query.dimension)
    const range = this.scopeRange(query)
    const dimensions = dimension === 'platform' ? ', platform, arch' : dimension === 'version' ? ', version' : ''
    const rows = await this.db.execute(
      `SELECT DATE_TRUNC('day', timestamp) AS date${dimensions},
       COUNT(*) FILTER (WHERE status = 'success')::INTEGER AS success_count,
       COUNT(*) FILTER (WHERE status = 'error')::INTEGER AS error_count,
       COUNT(*) FILTER (WHERE status = 'user_cancel')::INTEGER AS user_cancel_count,
       COUNT(*)::INTEGER AS total_count, AVG(duration_ms)::INTEGER AS avg_duration_ms,
       AVG(tokens_used)::INTEGER AS avg_tokens,
       COALESCE(ROUND((COUNT(*) FILTER (WHERE status = 'success')::DECIMAL /
         NULLIF(COUNT(*) FILTER (WHERE status IN ('success','error')), 0)) * 100), 100)::INTEGER AS success_rate
       FROM telemetry_conversations WHERE timestamp >= $1 AND timestamp < $2${range.sql}
       GROUP BY DATE_TRUNC('day', timestamp)${dimensions} ORDER BY date ASC${dimensions}`,
      range.parameters,
    )
    return rows.map(row => ({ ...row, date: date(row.date) }))
  }

  async installTrend(query: QmsDashboardQuery) {
    const dimension = this.dimension(query.dimension)
    const range = this.scopeRange(query)
    const filters = this.filters(range.parameters, [['version', query.version], ['install_type', query.installType]])
    const dimensions = dimension === 'platform' ? ', platform, arch' : dimension === 'version' ? ', version' : ''
    const rows = await this.db.execute(
      `SELECT bucket AS date${dimensions}, install_type,
       SUM(success_count)::INTEGER AS success_count, SUM(failed_count)::INTEGER AS failed_count,
       SUM(total_count)::INTEGER AS total_count, ROUND(AVG(success_rate))::INTEGER AS success_rate
       FROM telemetry_install_daily WHERE bucket >= $1 AND bucket < $2${range.sql}${filters.sql}
       GROUP BY bucket${dimensions}, install_type ORDER BY bucket ASC${dimensions}`,
      filters.parameters,
    )
    return rows.map(row => ({ ...row, date: date(row.date) }))
  }

  async dimensions(kind: 'perf' | 'conversation' | 'install', query: QmsDashboardQuery) {
    const range = this.scopeRange(query)
    const table = kind === 'perf' ? 'telemetry_perf_daily' : kind === 'install' ? 'telemetry_install_daily' : 'telemetry_conversations'
    const time = kind === 'conversation' ? 'timestamp' : 'bucket'
    const [platforms, versions] = await Promise.all([
      this.db.execute(`SELECT DISTINCT platform, arch FROM ${table}
        WHERE ${time} >= $1 AND ${time} < $2${range.sql} ORDER BY platform, arch`, range.parameters),
      this.db.execute(`SELECT DISTINCT version FROM ${table}
        WHERE ${time} >= $1 AND ${time} < $2${range.sql} ORDER BY version DESC`, range.parameters),
    ])
    const metrics = kind === 'perf'
      ? await this.db.execute(`SELECT DISTINCT metric FROM ${table}
          WHERE ${time} >= $1 AND ${time} < $2${range.sql} ORDER BY metric`, range.parameters)
      : []
    const result: Record<string, unknown> = {
      platforms: platforms.map(row => ({
        platform: row.platform, arch: row.arch, label: platformLabel(row.platform, row.arch),
        value: `${String(row.platform)}|${String(row.arch)}`,
      })),
      versions: versions.map(row => row.version),
    }
    if (kind === 'perf') result.metrics = metrics.map(row => row.metric)
    if (kind === 'install') {
      const installTypes = await this.db.execute(`SELECT DISTINCT install_type FROM ${table}
        WHERE ${time} >= $1 AND ${time} < $2${range.sql} AND install_type IS NOT NULL ORDER BY install_type`, range.parameters)
      result.install_types = installTypes.map(row => row.install_type)
    }
    return result
  }

  private dimension(value?: string): 'all' | 'platform' | 'version' {
    const dimension = value ?? 'all'
    if (dimension !== 'all' && dimension !== 'platform' && dimension !== 'version') {
      throw new Error(`Invalid dashboard dimension: ${dimension}`)
    }
    return dimension
  }

  private range(query: QmsDashboardQuery, defaultDuration = 7 * 86_400_000) {
    const endMs = query.endTime ?? Date.now()
    const startMs = query.startTime ?? endMs - defaultDuration
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) throw new Error('Invalid dashboard time range')
    return { start: new Date(startMs), end: new Date(endMs) }
  }

  private scopeRange(query: QmsDashboardQuery) {
    const { start, end } = this.range(query)
    return this.scope(start, end, query.tenantId)
  }

  private scope(start: Date, end: Date, tenantId?: string | null) {
    const parameters: unknown[] = [start, end]
    return {
      sql: tenantId ? ` AND tenant_id = $${parameters.push(tenantId)}` : '',
      parameters,
    }
  }

  private filters(parameters: readonly unknown[], filters: ReadonlyArray<readonly [string, unknown]>) {
    const result = [...parameters]
    let sql = ''
    for (const [column, value] of filters) {
      if (value === undefined || value === null || value === '') continue
      result.push(value)
      sql += ` AND ${column} = $${result.length}`
    }
    return { sql, parameters: result }
  }

  private groupCount(table: string, column: string, scope: { sql: string; parameters: readonly unknown[] }) {
    return this.db.execute(
      `SELECT ${column}, COUNT(*)::INTEGER AS count FROM ${table}
       WHERE timestamp >= $1 AND timestamp < $2${scope.sql}
       GROUP BY ${column} ORDER BY count DESC LIMIT 5`, scope.parameters,
    )
  }
}
