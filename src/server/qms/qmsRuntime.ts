import Redis from 'ioredis'

import { QmsAlertService } from './alertService.js'
import { assertQmsRuntimeConfig, type QmsRuntimeConfig } from './config.js'
import { CrashService } from './crashService.js'
import { QmsDashboardQueryService } from './dashboardQueryService.js'
import { QmsNotificationAdapter } from './notificationAdapters.js'
import { QmsPostgresStore } from './postgresStore.js'
import { QmsAuthorizationService, type QmsOrganizationDirectory } from './qmsAuthorization.js'
import { PostgresQmsLeaseStore } from './qmsLeaseStore.js'
import { QmsLegacyOperations } from './qmsLegacyOperations.js'
import { createQmsScheduledTasks, QmsMaintenanceService } from './qmsMaintenanceService.js'
import { RedisTelemetryQueueBackend, type RedisScriptPort } from './redisTelemetryQueueBackend.js'
import { ReliableTelemetryQueue } from './reliableTelemetryQueue.js'
import { QmsScheduler } from './qmsScheduler.js'
import { initializeQmsSchema, type QmsSchemaState, type QmsSqlPort } from './qmsSchema.js'
import type { QmsSystemSecretPort } from './qmsSystemService.js'
import { QmsSystemService } from './qmsSystemService.js'
import { SourceMapService, type QmsSourceMapRepository } from './sourceMapService.js'
import { TelemetryPostgresWriter, type QmsTransactionalSqlPort } from './telemetryPostgresWriter.js'
import { TelemetryService } from './telemetryService.js'
import { QmsUserStatsService } from './userStatsService.js'

export interface QmsRuntimeStore extends QmsTransactionalSqlPort {
  start(): Promise<QmsSchemaState>
  stop(): Promise<void>
}

export interface QmsRuntimeRedis extends RedisScriptPort {
  connect(): Promise<unknown>
  ping(): Promise<unknown>
  quit(): Promise<unknown>
  disconnect?(): void
}

export interface QmsRuntimeDependencies {
  createStore(url: string): QmsRuntimeStore
  createRedis(url: string): QmsRuntimeRedis
}

export interface StartedQmsRuntime {
  apiKeyHeader: string
  authorization: QmsAuthorizationService
  encryption: { encryptionRequired: boolean; privateKeyPem?: string }
  operations: QmsLegacyOperations
  stop(): Promise<void>
}

export class PostgresSourceMapRepository implements QmsSourceMapRepository {
  constructor(private readonly db: QmsSqlPort) {}

  async find(tenantId: string, version: string, platform: string, fileName: string): Promise<string | null> {
    const rows = await this.db.execute(
      `SELECT map_content FROM source_maps
       WHERE (tenant_id = $1 OR tenant_id IS NULL)
         AND version = $2 AND platform = $3 AND file_name = $4
       ORDER BY tenant_id NULLS LAST
       LIMIT 1`,
      [tenantId, version, platform, fileName],
    )
    return rows[0] ? String(rows[0].map_content) : null
  }
}

function defaultDependencies(): QmsRuntimeDependencies {
  return {
    createStore: url => new QmsPostgresStore(url),
    createRedis: url => new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    }) as unknown as QmsRuntimeRedis,
  }
}

async function closeRedis(redis: QmsRuntimeRedis | undefined): Promise<void> {
  if (!redis) return
  try {
    await redis.quit()
  } catch {
    redis.disconnect?.()
  }
}

export async function startQmsRuntime(options: {
  config: QmsRuntimeConfig
  ownerId: string
  organizations: QmsOrganizationDirectory
  secrets: QmsSystemSecretPort
  environment?: { NODE_ENV: string; PORT: number; HOST: string; LOG_LEVEL: string }
  dependencies?: Partial<QmsRuntimeDependencies>
}): Promise<StartedQmsRuntime | undefined> {
  if (!options.config.enabled) return undefined
  assertQmsRuntimeConfig(options.config)
  if (!options.ownerId.trim()) throw new Error('QMS runtime owner id is required')

  const defaults = defaultDependencies()
  const dependencies = { ...defaults, ...options.dependencies }
  const store = dependencies.createStore(options.config.secrets.postgresUrl!)
  let redis: QmsRuntimeRedis | undefined
  let scheduler: QmsScheduler | undefined

  try {
    const schemaState = await store.start()
    redis = dependencies.createRedis(options.config.secrets.redisUrl!)
    await redis.connect()
    await redis.ping()

    const backend = new RedisTelemetryQueueBackend(redis)
    const writer = new TelemetryPostgresWriter(store)
    const queue = new ReliableTelemetryQueue({
      backend,
      workerId: options.ownerId,
      visibilityTimeoutMs: options.config.queue.visibilityTimeoutMs,
      persist: messages => writer.persist(messages),
    })
    await queue.recoverExpired()

    const telemetry = new TelemetryService({ queue, tenants: options.organizations })
    const sourceMaps = new SourceMapService(new PostgresSourceMapRepository(store))
    const crash = new CrashService({ db: store, tenants: options.organizations, sourceMaps })
    const dashboard = new QmsDashboardQueryService(store)
    const userStats = new QmsUserStatsService(store)
    const notifications = new QmsNotificationAdapter({ config: () => ({
      larkWebhookUrl: options.config.secrets.larkWebhookUrl,
      smtpUrl: options.config.secrets.smtpUrl,
    }) })
    const alerts = new QmsAlertService({ db: store, notifications })
    const maintenance = new QmsMaintenanceService({
      db: store,
      continuousAggregates: schemaState.continuousAggregates,
    })
    const tasks = createQmsScheduledTasks({
      queue,
      maintenance,
      alerts,
      batchSize: options.config.queue.batchSize,
      flushIntervalMs: options.config.queue.flushIntervalMs,
      retention: options.config.retention,
    })
    scheduler = new QmsScheduler({
      ownerId: options.ownerId,
      leases: new PostgresQmsLeaseStore(store),
      tasks,
    })

    let timescaleAvailable = schemaState.timescaleAvailable
    const schema = {
      initialize: async () => {
        const result = await initializeQmsSchema(store)
        timescaleAvailable = result.timescaleAvailable
        return result
      },
      isTimescaleAvailable: () => timescaleAvailable,
      switchToContinuousAggregates: async () => {
        if (!timescaleAvailable) throw new Error('TIMESCALEDB_NOT_AVAILABLE')
        const existing = await store.execute(
          "SELECT view_name FROM timescaledb_information.continuous_aggregates WHERE view_name LIKE 'telemetry_%_daily'",
        )
        if (existing.length > 0) {
          throw new Error(`CONTINUOUS_AGGREGATES_EXIST: ${existing.map(row => String(row.view_name)).join(', ')}`)
        }
        for (const table of [
          'telemetry_perf_daily', 'telemetry_conversations_daily', 'telemetry_conversation_errors_daily',
          'telemetry_turns_daily', 'telemetry_steps_daily', 'telemetry_install_daily',
        ]) await store.execute(`DROP TABLE IF EXISTS ${table} CASCADE`)
        await initializeQmsSchema(store, { aggregateMode: 'continuous' })
      },
      aggregationInfo: async () => {
        if (!timescaleAvailable) return { mode: 'regular', usingContinuousAggregates: false }
        const rows = await store.execute(
          "SELECT view_name FROM timescaledb_information.continuous_aggregates WHERE view_name LIKE 'telemetry_%_daily'",
        )
        return { mode: rows.length > 0 ? 'continuous' : 'regular', usingContinuousAggregates: rows.length > 0 }
      },
    }
    const system = new QmsSystemService({
      db: store,
      schema,
      scheduler,
      secrets: options.secrets,
      notifications,
      databaseHealthy: async () => {
        try { await store.execute('SELECT 1 AS healthy'); return true } catch { return false }
      },
      environment: options.environment ?? {
        NODE_ENV: process.env.NODE_ENV ?? 'production', PORT: 0, HOST: '0.0.0.0', LOG_LEVEL: 'info',
      },
      version: '1.0.0',
      backfill: days => maintenance.aggregateRange(1, days),
    })
    const operations = new QmsLegacyOperations({
      telemetry, queue, crash, dashboard, userStats, alerts, system, crashTasks: scheduler,
    })
    const authorization = new QmsAuthorizationService({
      apiKey: options.config.secrets.apiKey,
      organizations: options.organizations,
    })
    scheduler.start()

    let stopped = false
    return {
      apiKeyHeader: options.config.apiKeyHeader,
      authorization,
      encryption: {
        encryptionRequired: options.config.encryptionRequired,
        privateKeyPem: options.config.secrets.privateKeyPem,
      },
      operations,
      stop: async () => {
        if (stopped) return
        stopped = true
        scheduler?.stop()
        await closeRedis(redis)
        await store.stop()
      },
    }
  } catch (error) {
    scheduler?.stop()
    await closeRedis(redis)
    await store.stop()
    throw error
  }
}
