import { randomUUID } from 'node:crypto'

import { onlineCommandContext } from '../application/commandContext.js'
import type { QmsSqlPort } from './qmsSchema.js'
import type { QmsScheduledTask } from './qmsScheduler.js'
import type { QmsTransactionalSqlPort } from './telemetryPostgresWriter.js'

export interface QmsRetentionPolicy {
  perfDays: number
  conversationDays: number
  crashDays: number
  aggregateDays: number
}

const CONTINUOUS_AGGREGATES = [
  'telemetry_perf_daily', 'telemetry_conversations_daily',
  'telemetry_conversation_errors_daily', 'telemetry_turns_daily',
  'telemetry_steps_daily', 'telemetry_install_daily',
] as const

function utcDay(now: Date, daysAgo: number): { bucket: Date; end: Date } {
  const bucket = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo))
  return { bucket, end: new Date(bucket.getTime() + 86_400_000) }
}

export class QmsMaintenanceService {
  constructor(private readonly options: { db: QmsTransactionalSqlPort; continuousAggregates: boolean }) {}

  async aggregateRange(startDays: number, endDays: number, now = new Date()): Promise<void> {
    if (!Number.isInteger(startDays) || !Number.isInteger(endDays) || startDays < 0 || endDays < startDays) {
      throw new Error('Invalid QMS aggregation range')
    }
    const oldest = utcDay(now, endDays).bucket
    const newest = utcDay(now, startDays).end
    if (this.options.continuousAggregates) {
      for (const view of CONTINUOUS_AGGREGATES) {
        await this.options.db.execute(`CALL refresh_continuous_aggregate('${view}', $1, $2)`, [oldest, newest])
      }
      return
    }
    for (let days = startDays; days <= endDays; days += 1) {
      const { bucket, end } = utcDay(now, days)
      await this.options.db.transaction(db => this.aggregateDay(db, bucket, end))
    }
  }

  async cleanup(policy: QmsRetentionPolicy, now = new Date()): Promise<void> {
    if (!this.options.continuousAggregates) {
      await this.options.db.transaction(async db => {
        await db.execute('DELETE FROM telemetry_perf_raw WHERE timestamp < $1', [this.cutoff(now, policy.perfDays)])
        await db.execute('DELETE FROM telemetry_install WHERE timestamp < $1', [this.cutoff(now, policy.perfDays)])
        await db.execute('DELETE FROM telemetry_conversations WHERE timestamp < $1', [this.cutoff(now, policy.conversationDays)])
        await db.execute('DELETE FROM telemetry_turns WHERE timestamp < $1', [this.cutoff(now, policy.conversationDays)])
        await db.execute('DELETE FROM telemetry_steps WHERE timestamp < $1', [this.cutoff(now, policy.conversationDays)])
        await db.execute('DELETE FROM crash_events WHERE timestamp < $1', [this.cutoff(now, policy.crashDays)])
        for (const table of [...CONTINUOUS_AGGREGATES, 'crash_daily_stats',
          'telemetry_user_conversations_daily', 'telemetry_user_turns_daily', 'telemetry_user_steps_daily']) {
          await db.execute(`DELETE FROM ${table} WHERE bucket < $1`, [this.cutoff(now, policy.aggregateDays)])
        }
      })
    }
    const receiptDays = Math.max(policy.perfDays, policy.conversationDays, policy.crashDays)
    await this.options.db.execute('DELETE FROM qms_ingest_receipts WHERE received_at < $1', [this.cutoff(now, receiptDays)])
  }

  async aggregateCrash(now = new Date()): Promise<void> {
    const { bucket, end } = utcDay(now, 1)
    await this.options.db.transaction(async db => {
      await db.execute('DELETE FROM crash_daily_stats WHERE bucket = $1', [bucket])
      await db.execute(
        `INSERT INTO crash_daily_stats (bucket, version, platform, tenant_id, type, count, created_at)
         SELECT $1, version, platform, tenant_id, type, COUNT(*)::INTEGER, NOW()
         FROM crash_events WHERE timestamp >= $1 AND timestamp < $2
         GROUP BY version, platform, tenant_id, type`, [bucket, end],
      )
    })
  }

  async cleanupCrash(retentionDays: number, now = new Date()): Promise<void> {
    if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error('Invalid crash retention')
    if (!this.options.continuousAggregates) {
      await this.options.db.execute('DELETE FROM crash_events WHERE timestamp < $1', [this.cutoff(now, retentionDays)])
    }
    await this.options.db.execute(
      'DELETE FROM crash_issues WHERE id NOT IN (SELECT DISTINCT issue_id FROM crash_events WHERE issue_id IS NOT NULL)',
    )
  }

  private cutoff(now: Date, days: number): Date {
    return new Date(now.getTime() - days * 86_400_000)
  }

  private async aggregateDay(db: QmsSqlPort, bucket: Date, end: Date): Promise<void> {
    await db.execute(
      `INSERT INTO telemetry_perf_daily (
        bucket, version, platform, arch, tenant_id, metric, p50, p90, p95, p99,
        min_value, max_value, avg_value, count, created_at
       ) SELECT $1, version, platform, arch, tenant_id, metric,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY value_ms),
        percentile_cont(0.90) WITHIN GROUP (ORDER BY value_ms),
        percentile_cont(0.95) WITHIN GROUP (ORDER BY value_ms),
        percentile_cont(0.99) WITHIN GROUP (ORDER BY value_ms),
        MIN(value_ms), MAX(value_ms), AVG(value_ms), COUNT(*)::INTEGER, NOW()
       FROM telemetry_perf_raw WHERE timestamp >= $1 AND timestamp < $2
       GROUP BY version, platform, arch, tenant_id, metric
       ON CONFLICT (bucket, version, platform, arch, tenant_id, metric) DO UPDATE SET
        p50=EXCLUDED.p50,p90=EXCLUDED.p90,p95=EXCLUDED.p95,p99=EXCLUDED.p99,
        min_value=EXCLUDED.min_value,max_value=EXCLUDED.max_value,avg_value=EXCLUDED.avg_value,
        count=EXCLUDED.count,created_at=NOW()`, [bucket, end],
    )
    await db.execute(
      `INSERT INTO telemetry_conversations_daily (
        bucket, version, platform, arch, tenant_id, success_count, error_count, user_cancel_count,
        total_count, avg_duration_ms, avg_tokens, success_rate, error_rate, created_at
       ) SELECT $1, version, platform, arch, tenant_id,
        COUNT(*) FILTER (WHERE status='success'), COUNT(*) FILTER (WHERE status='error'),
        COUNT(*) FILTER (WHERE status='user_cancel'), COUNT(*), AVG(duration_ms), AVG(tokens_used),
        COALESCE(ROUND(COUNT(*) FILTER (WHERE status='success')::DECIMAL /
          NULLIF(COUNT(*) FILTER (WHERE status IN ('success','error')),0)*100),100),
        ROUND(COUNT(*) FILTER (WHERE status='error')::DECIMAL/NULLIF(COUNT(*),0)*100), NOW()
       FROM telemetry_conversations WHERE timestamp >= $1 AND timestamp < $2
       GROUP BY version, platform, arch, tenant_id
       ON CONFLICT (bucket, version, platform, arch, tenant_id) DO UPDATE SET
        success_count=EXCLUDED.success_count,error_count=EXCLUDED.error_count,
        user_cancel_count=EXCLUDED.user_cancel_count,total_count=EXCLUDED.total_count,
        avg_duration_ms=EXCLUDED.avg_duration_ms,avg_tokens=EXCLUDED.avg_tokens,
        success_rate=EXCLUDED.success_rate,error_rate=EXCLUDED.error_rate,created_at=NOW()`, [bucket, end],
    )
    await db.execute(
      `INSERT INTO telemetry_conversation_errors_daily (bucket,version,platform,arch,tenant_id,error_code,count,created_at)
       SELECT $1,version,platform,arch,tenant_id,error_code,COUNT(*)::INTEGER,NOW()
       FROM telemetry_conversations WHERE timestamp >= $1 AND timestamp < $2
        AND status='error' AND error_code IS NOT NULL GROUP BY version,platform,arch,tenant_id,error_code
       ON CONFLICT (bucket,version,platform,arch,tenant_id,error_code) DO UPDATE SET count=EXCLUDED.count,created_at=NOW()`,
      [bucket, end],
    )
    await db.execute(
      `INSERT INTO telemetry_install_daily (
        bucket,version,platform,arch,tenant_id,install_type,success_count,failed_count,total_count,avg_duration_ms,success_rate,created_at
       ) SELECT $1,version,platform,arch,tenant_id,install_type,
        COUNT(*) FILTER (WHERE status='success'),COUNT(*) FILTER (WHERE status='failed'),COUNT(*),AVG(duration_ms),
        ROUND(COUNT(*) FILTER (WHERE status='success')::DECIMAL/NULLIF(COUNT(*),0)*100),NOW()
       FROM telemetry_install WHERE timestamp >= $1 AND timestamp < $2 GROUP BY version,platform,arch,tenant_id,install_type
       ON CONFLICT (bucket,version,platform,arch,tenant_id,install_type) DO UPDATE SET
        success_count=EXCLUDED.success_count,failed_count=EXCLUDED.failed_count,total_count=EXCLUDED.total_count,
        avg_duration_ms=EXCLUDED.avg_duration_ms,success_rate=EXCLUDED.success_rate,created_at=NOW()`, [bucket, end],
    )
    await this.aggregateUsers(db, bucket, end)
  }

  private async aggregateUsers(db: QmsSqlPort, bucket: Date, end: Date): Promise<void> {
    const identity = "COALESCE(NULLIF(user_id,''),NULLIF(user_phone,''))"
    await db.execute(
      `INSERT INTO telemetry_user_conversations_daily (
        bucket,user_id,org_id,tenant_id,login_mode,user_nickname,user_phone,conversation_count,
        total_tokens,input_tokens,output_tokens,success_count,error_count,user_cancel_count,avg_duration_ms,created_at
       ) SELECT $1,${identity},org_id,tenant_id,login_mode,MAX(user_nickname),MAX(user_phone),COUNT(*),
        COALESCE(SUM(tokens_used),0),COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),
        COUNT(*) FILTER (WHERE status='success'),COUNT(*) FILTER (WHERE status='error'),
        COUNT(*) FILTER (WHERE status='user_cancel'),AVG(duration_ms),NOW()
       FROM telemetry_conversations WHERE timestamp >= $1 AND timestamp < $2 AND ${identity} IS NOT NULL
       GROUP BY ${identity},org_id,tenant_id,login_mode
       ON CONFLICT (bucket,user_id,org_id,tenant_id,login_mode) DO UPDATE SET
        user_nickname=EXCLUDED.user_nickname,user_phone=EXCLUDED.user_phone,
        conversation_count=EXCLUDED.conversation_count,total_tokens=EXCLUDED.total_tokens,
        input_tokens=EXCLUDED.input_tokens,output_tokens=EXCLUDED.output_tokens,
        success_count=EXCLUDED.success_count,error_count=EXCLUDED.error_count,
        user_cancel_count=EXCLUDED.user_cancel_count,avg_duration_ms=EXCLUDED.avg_duration_ms,created_at=NOW()`, [bucket, end],
    )
    await db.execute(
      `INSERT INTO telemetry_user_turns_daily (
        bucket,user_id,org_id,tenant_id,login_mode,user_nickname,user_phone,turn_count,total_tokens,
        total_input_tokens,total_output_tokens,success_count,error_count,avg_duration_ms,created_at
       ) SELECT $1,${identity},org_id,tenant_id,login_mode,MAX(user_nickname),MAX(user_phone),COUNT(*),
        COALESCE(SUM(total_tokens),0),COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),
        COUNT(*) FILTER (WHERE status='success'),COUNT(*) FILTER (WHERE status='error'),AVG(duration_ms),NOW()
       FROM telemetry_turns WHERE timestamp >= $1 AND timestamp < $2 AND ${identity} IS NOT NULL
       GROUP BY ${identity},org_id,tenant_id,login_mode
       ON CONFLICT (bucket,user_id,org_id,tenant_id,login_mode) DO UPDATE SET
        user_nickname=EXCLUDED.user_nickname,user_phone=EXCLUDED.user_phone,turn_count=EXCLUDED.turn_count,
        total_tokens=EXCLUDED.total_tokens,total_input_tokens=EXCLUDED.total_input_tokens,
        total_output_tokens=EXCLUDED.total_output_tokens,success_count=EXCLUDED.success_count,
        error_count=EXCLUDED.error_count,avg_duration_ms=EXCLUDED.avg_duration_ms,created_at=NOW()`, [bucket, end],
    )
    await db.execute(
      `INSERT INTO telemetry_user_steps_daily (
        bucket,user_id,org_id,tenant_id,login_mode,user_nickname,user_phone,step_type,
        step_count,success_count,error_count,avg_duration_ms,created_at
       ) SELECT $1,${identity},org_id,tenant_id,login_mode,MAX(user_nickname),MAX(user_phone),step_type,
        COUNT(*),COUNT(*) FILTER (WHERE status='success'),COUNT(*) FILTER (WHERE status='error'),AVG(COALESCE(duration_ms,0)),NOW()
       FROM telemetry_steps WHERE timestamp >= $1 AND timestamp < $2 AND ${identity} IS NOT NULL
       GROUP BY ${identity},org_id,tenant_id,login_mode,step_type
       ON CONFLICT (bucket,user_id,org_id,tenant_id,login_mode,step_type) DO UPDATE SET
        user_nickname=EXCLUDED.user_nickname,user_phone=EXCLUDED.user_phone,step_count=EXCLUDED.step_count,
        success_count=EXCLUDED.success_count,error_count=EXCLUDED.error_count,
        avg_duration_ms=EXCLUDED.avg_duration_ms,created_at=NOW()`, [bucket, end],
    )
  }
}

export function createQmsScheduledTasks(options: {
  queue: { recoverExpired(): Promise<number>; processBatch(limit: number): Promise<number> }
  maintenance: Pick<QmsMaintenanceService, 'aggregateRange' | 'cleanup' | 'aggregateCrash' | 'cleanupCrash'>
  alerts: { evaluateType(input: { type: string; context: ReturnType<typeof onlineCommandContext> }): Promise<unknown> }
  batchSize: number
  flushIntervalMs: number
  retention: QmsRetentionPolicy
}): QmsScheduledTask[] {
  return [
    {
      name: 'queue-process', intervalMs: options.flushIntervalMs, leaseMs: Math.max(options.flushIntervalMs * 10, 60_000),
      run: async () => { await options.queue.recoverExpired(); await options.queue.processBatch(options.batchSize) },
    },
    { name: 'aggregation', intervalMs: 3_600_000, leaseMs: 30 * 60_000, run: () => options.maintenance.aggregateRange(1, 1) },
    { name: 'cleanup', intervalMs: 3_600_000, leaseMs: 30 * 60_000, run: () => options.maintenance.cleanup(options.retention) },
    {
      name: 'alert', intervalMs: 300_000, leaseMs: 240_000,
      run: async () => {
        const runId = randomUUID()
        for (const type of ['perf', 'error', 'conversation', 'install', 'crash']) {
          await options.alerts.evaluateType({ type, context: onlineCommandContext(`qms-alert:${runId}:${type}`) })
        }
      },
    },
    { name: 'crash-aggregation', intervalMs: 3_600_000, leaseMs: 30 * 60_000, run: () => options.maintenance.aggregateCrash() },
    { name: 'crash-cleanup', intervalMs: 6 * 3_600_000, leaseMs: 30 * 60_000, run: () => options.maintenance.cleanupCrash(options.retention.crashDays) },
  ]
}
