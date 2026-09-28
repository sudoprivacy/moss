import type { DbDriver } from '../db/driver.js'

import { QmsAlertService } from './alertService.js'
import { assertQmsRuntimeConfig, type QmsRuntimeConfig } from './config.js'
import { CrashService } from './crashService.js'
import { QmsDashboardQueryService } from './dashboardQueryService.js'
import { QmsNotificationAdapter } from './notificationAdapters.js'
import { MossQmsStore } from './mossQmsStore.js'
import { InMemoryTelemetryQueue } from './inMemoryTelemetryQueue.js'
import { QmsAuthorizationService, type QmsOrganizationDirectory } from './qmsAuthorization.js'
import { PostgresQmsLeaseStore } from './qmsLeaseStore.js'
import { QmsLegacyOperations } from './qmsLegacyOperations.js'
import { createQmsScheduledTasks, QmsMaintenanceService } from './qmsMaintenanceService.js'
import { QmsScheduler } from './qmsScheduler.js'
import type { QmsSqlPort } from './qmsSchema.js'
import type { QmsSystemSecretPort } from './qmsSystemService.js'
import { QmsSystemService } from './qmsSystemService.js'
import { SourceMapService, type QmsSourceMapRepository } from './sourceMapService.js'
import { TelemetryPostgresWriter } from './telemetryPostgresWriter.js'
import { TelemetryService } from './telemetryService.js'
import { QmsUserStatsService } from './userStatsService.js'

export interface StartedQmsRuntime {
  apiKeyHeader: string
  authorization: QmsAuthorizationService
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

export async function startQmsRuntime(options: {
  config: QmsRuntimeConfig
  driver: DbDriver
  ownerId: string
  organizations: QmsOrganizationDirectory
  secrets: QmsSystemSecretPort
  environment?: { NODE_ENV: string; PORT: number; HOST: string; LOG_LEVEL: string }
  warn?: (message: string) => void
  signal?: AbortSignal
}): Promise<StartedQmsRuntime | undefined> {
  if (!options.config.enabled) return undefined
  options.signal?.throwIfAborted()
  assertQmsRuntimeConfig(options.config)
  if (!options.ownerId.trim()) throw new Error('QMS runtime owner id is required')

  const store = new MossQmsStore(options.driver)
  await store.start(options.signal)
  options.signal?.throwIfAborted()
  const writer = new TelemetryPostgresWriter(store)
  const queue = new InMemoryTelemetryQueue({
    maxItems: options.config.queue.maxItems,
    maxBytes: options.config.queue.maxBytes,
    retryIntervalMs: options.config.queue.retryIntervalMs,
    persist: messages => writer.persist(messages),
  })

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
    continuousAggregates: false,
  })
  const tasks = createQmsScheduledTasks({
    queue,
    maintenance,
    alerts,
    batchSize: options.config.queue.batchSize,
    flushIntervalMs: options.config.queue.flushIntervalMs,
    retention: options.config.retention,
  })
  const scheduler = new QmsScheduler({
    ownerId: options.ownerId,
    leases: new PostgresQmsLeaseStore(store),
    tasks,
  })

  const schema = {
    initialize: () => store.start(),
    isTimescaleAvailable: () => false,
    switchToContinuousAggregates: async () => { throw new Error('TIMESCALEDB_NOT_AVAILABLE') },
    aggregationInfo: async () => ({ mode: 'regular', usingContinuousAggregates: false }),
  }
  const system = new QmsSystemService({
    db: store,
    schema,
    scheduler,
    secrets: options.secrets,
    notifications,
    queue,
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
    apiKey: () => options.config.secrets.apiKey,
    organizations: options.organizations,
  })
  scheduler.start()

  let stopping: Promise<void> | undefined
  return {
    apiKeyHeader: options.config.apiKeyHeader,
    authorization,
    operations,
    stop: () => {
      if (stopping) return stopping
      queue.close()
      stopping = (async () => {
        await scheduler.stopAndWait()
        if (!await queue.drain(options.config.queue.batchSize, options.config.queue.drainTimeoutMs)) {
          const status = queue.status()
          const warn = options.warn ?? console.warn
          warn(`[QMS] Shutdown timeout: ${status.pending + status.processing} telemetry events remain in volatile memory`)
        }
      })()
      return stopping
    },
  }
}
