import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import Redis from 'ioredis'
import postgres, { type Sql } from 'postgres'
import { createConfigItemsApi } from './api/configItems.js'
import { SudoworkConfigService } from './api/compat/sudowork/configService.js'
import { RedisLegacyTokenStore } from './api/compat/sudowork/redisLegacyStore.js'
import { SudoworkSystemConfigService } from './api/compat/sudowork/systemConfigService.js'
import { AuthCenterDb } from './authCenter/db.js'
import { BillingRepository } from './billing/billingRepository.js'
import { WalletService } from './billing/walletService.js'
import { CatalogArtifactStore } from './catalog/catalogArtifactStore.js'
import { CatalogRepository } from './catalog/catalogRepository.js'
import { CatalogService } from './catalog/catalogService.js'
import { ClientPolicyRepository } from './configuration/clientPolicyRepository.js'
import { ManagedImageStore } from './configuration/managedImageStore.js'
import { ConfigStore } from './configStore/configStore.js'
import { DirectConnectStore } from './db.js'
import { DifyRepository } from './dify/difyRepository.js'
import { IdentityRepository } from './identity/identityRepository.js'
import { UnifiedIdentityService } from './identity/unifiedIdentityService.js'
import { AccessMigrationPhase, SudoworkAccessSourceReader } from './migration/accessMigrationPhase.js'
import { SudoworkAutomationSourceReader } from './migration/automationMigrationPhase.js'
import { GovernanceMigrationService } from './migration/governanceMigrationService.js'
import { IdentityMergePlanner } from './migration/identityMergePlanner.js'
import { IdentityMigrationService } from './migration/identityMigrationService.js'
import { MigrationRunStore } from './migration/migrationRunStore.js'
import { buildMigrationReport } from './migration/migrationReportFactory.js'
import { MigrationReportWriter } from './migration/migrationReportWriter.js'
import { P2CatalogImportService } from './migration/p2CatalogImport.js'
import { P2ConfigurationMigrationService } from './migration/p2ConfigurationMigrationService.js'
import { P2ManagedImageMigrationService } from './migration/p2ManagedImageMigrationService.js'
import { P2MigrationService } from './migration/p2MigrationService.js'
import { P2SystemConfigMigrationService } from './migration/p2SystemConfigMigrationService.js'
import { P3BillingMigrationService } from './migration/p3BillingMigrationService.js'
import { P4DifyMigrationService } from './migration/p4DifyMigrationService.js'
import { P5QmsMigrationService, PostgresP5QmsMigrationTarget } from './migration/p5QmsMigrationService.js'
import { createPhaseBackedMigrationChecks } from './migration/phaseBackedMigrationChecks.js'
import { PlanningCatalogProjection, PlanningIdentityProjection } from './migration/planningProjections.js'
import {
  QmsSourceComponentReader,
  RedisAccessComponentReader,
  SqliteFileComponentReader,
} from './migration/sourceComponentReaders.js'
import { SudoworkGovernanceSourceReader } from './migration/sudoworkGovernanceSourceReader.js'
import { SudoworkIdentitySourceReader } from './migration/sudoworkIdentitySourceReader.js'
import { SudoworkMigrationCoordinator } from './migration/sudoworkMigrationCoordinator.js'
import { MigrationVerifier } from './migration/migrationVerifier.js'
import { createSudoworkMigrationPhaseRegistry } from './migration/sudoworkMigrationRegistry.js'
import { SudoworkP2SourceReader } from './migration/sudoworkP2SourceReader.js'
import { SudoworkP3SourceReader } from './migration/sudoworkP3SourceReader.js'
import { SudoworkP4SourceReader } from './migration/sudoworkP4SourceReader.js'
import { SudoworkP5QmsSourceReader } from './migration/sudoworkP5QmsSourceReader.js'
import { FileTreeSnapshotReader, SudoworkSourceSnapshotReader } from './migration/sudoworkSourceSnapshot.js'
import { readTargetIdentitySnapshot } from './migration/targetIdentitySnapshot.js'
import { NexusClient } from './nexus/nexusClient.js'
import { QmsPostgresStore } from './qms/postgresStore.js'
import type { QmsSqlPort } from './qms/qmsSchema.js'
import type { MigrationCliConfig } from './migrationCli.js'

export async function createProductionMigrationRuntime(config: MigrationCliConfig): Promise<{
  coordinator: SudoworkMigrationCoordinator
  writeReport(mode: 'dry-run' | 'execute' | 'resume' | 'verify', result: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}> {
  const targetStore = new DirectConnectStore(config.target.mossDbPath)
  const auth = new AuthCenterDb(targetStore.db, config.target.mossDbPath)
  const baseIdentities = new IdentityRepository(targetStore.db)
  const identityProjection = new PlanningIdentityProjection(baseIdentities)
  const identities = identityProjection.repository
  const unified = new UnifiedIdentityService(targetStore.db, auth, identities)
  const runs = new MigrationRunStore(targetStore.db)

  const sourceIdentity = new SudoworkIdentitySourceReader(config.source.snapshotDir)
  const identity = new IdentityMigrationService({
    db: targetStore.db,
    auth,
    identities,
    unified,
    runs,
    source: sourceIdentity,
    planner: new IdentityMergePlanner(readTargetIdentitySnapshot(auth, baseIdentities)),
    createPlanner: () => new IdentityMergePlanner(readTargetIdentitySnapshot(auth, baseIdentities)),
  })
  const governance = new GovernanceMigrationService({
    db: targetStore.db,
    identities,
    runs,
    source: new SudoworkGovernanceSourceReader(config.source.snapshotDir),
    defaultInitialQuota: config.migration.defaultInitialQuota,
  })

  const sourceP2 = new SudoworkP2SourceReader(config.source.snapshotDir)
  const baseCatalog = new CatalogRepository(targetStore.db)
  const catalogProjection = new PlanningCatalogProjection(baseCatalog)
  const catalogService = new CatalogService(targetStore.db, baseCatalog)
  const artifacts = new CatalogArtifactStore(join(config.target.runtimeDir, 'catalog-artifacts'))
  const catalog = new P2MigrationService({
    identities,
    repository: baseCatalog,
    importer: new P2CatalogImportService({
      db: targetStore.db,
      repository: baseCatalog,
      catalog: catalogService,
      artifacts,
      publicBaseUrl: config.target.publicBaseUrl,
    }),
    source: sourceP2,
    platformCatalogOrgId: config.migration.platformCatalogOrgId,
  })

  const nexus = new NexusClient(config.target.nexusEndpoint, config.target.nexusAuthToken)
  const configStore = new ConfigStore(nexus)
  const managedImages = new ManagedImageStore(join(config.target.runtimeDir, 'uploads'))
  const configurationService = new SudoworkConfigService({
    db: targetStore.db,
    configItems: createConfigItemsApi(targetStore),
    identities,
    authDb: auth,
    managedImages,
  })
  const systemConfigurationService = new SudoworkSystemConfigService({
    db: targetStore.db,
    policies: new ClientPolicyRepository(targetStore.db),
    identities,
    defaults: {
      loginMethod: config.target.loginMethod,
      skillhubBaseUrl: config.target.skillhubBaseUrl,
      sudorouterBaseUrl: config.target.sudorouterBaseUrl,
    },
    smsConfigured: config.target.smsConfigured,
    secrets: configStore,
  })
  const configuration = {
    managedImages: new P2ManagedImageMigrationService({ source: sourceP2, target: managedImages }),
    configuration: new P2ConfigurationMigrationService({
      db: targetStore.db,
      identities,
      config: configurationService,
      source: sourceP2,
      platformConfigOrgId: config.migration.platformConfigOrgId,
    }),
    systemConfiguration: new P2SystemConfigMigrationService({
      db: targetStore.db,
      identities,
      service: systemConfigurationService,
      source: sourceP2,
      platformOrgId: config.migration.platformConfigOrgId,
    }),
  }

  const dify = new P4DifyMigrationService({
    db: targetStore.db,
    auth,
    identities,
    catalog: catalogProjection.repository,
    dify: new DifyRepository(targetStore.db),
    source: new SudoworkP4SourceReader(config.source.snapshotDir),
    secrets: nexus,
  })
  const billingRepository = new BillingRepository(targetStore.db)
  const billing = new P3BillingMigrationService(
    targetStore.db,
    identities,
    billingRepository,
    new WalletService(targetStore.db, billingRepository),
    Date.now,
    identityProjection,
  )
  const billingSource = new SudoworkP3SourceReader(config.source.snapshotDir)

  const sourceRedisClient = redisClient(config.source.redisUrl)
  const targetRedisClient = redisClient(config.target.redisUrl)
  const sourceRedis = new RedisLegacyTokenStore(sourceRedisClient)
  const targetRedis = new RedisLegacyTokenStore(targetRedisClient)
  const accessSource = new SudoworkAccessSourceReader(config.source.snapshotDir, sourceRedis)

  const sourceQmsSql = postgres(config.source.qmsPostgresUrl, {
    max: 1, idle_timeout: 5, connect_timeout: 10, prepare: true,
  })
  const readonlyQms = new ReadonlyQmsPostgresPort(sourceQmsSql)
  await readonlyQms.initialize()
  const sourceQms = new SudoworkP5QmsSourceReader(readonlyQms)
  const targetQmsStore = new QmsPostgresStore(config.target.qmsPostgresUrl)
  const targetQmsState = await targetQmsStore.start()
  const qms = new P5QmsMigrationService({
    source: sourceQms,
    target: new PostgresP5QmsMigrationTarget(targetQmsStore, targetQmsState),
    organizations: { hasCode: code => identities.getOrganizationProfileByCode(code) !== null },
    batchSize: config.migration.qmsBatchSize,
  })

  const snapshot = new SudoworkSourceSnapshotReader({
    sqlite: new SqliteFileComponentReader(join(config.source.snapshotDir, 'sudowork.sqlite')),
    redis: new RedisAccessComponentReader(sourceRedis),
    qms: new QmsSourceComponentReader(sourceQms, config.migration.qmsBatchSize),
    files: new FileTreeSnapshotReader(config.source.snapshotDir, config.source.fileAllowlist),
  })
  const registry = createSudoworkMigrationPhaseRegistry({
    identity,
    identityResolutions: config.migration.identityResolutions,
    onIdentityPlanned: plan => identityProjection.install(plan, plan.source),
    beforeIdentityExecute: () => identityProjection.deactivate(),
    governance,
    governanceResolutions: config.migration.governanceResolutions,
    catalog,
    onCatalogPlanned: plan => catalogProjection.install(plan),
    configuration,
    dify,
    billing: { service: billing, source: billingSource },
    automationSource: new SudoworkAutomationSourceReader(config.source.snapshotDir),
    qms,
    access: {
      source: accessSource,
      target: targetRedis,
      identities,
      sourceLegacyJwtSecret: config.secrets.sourceLegacyJwtSecret,
      targetLegacyJwtSecret: config.secrets.targetLegacyJwtSecret,
    },
  })

  const finalVerifier = new MigrationVerifier(runs, createPhaseBackedMigrationChecks(registry))
  const coordinator = new SudoworkMigrationCoordinator({
    runs,
    source: snapshot,
    phases: registry,
    finalVerifier,
  })
  const reportWriter = new MigrationReportWriter(runs)
  return {
    coordinator,
    writeReport: async (mode, result) => {
      const runId = String(result.runId ?? '')
      if (!runId) return { report: 'dry-run 不持久化报告' }
      const storedRun = runs.getRun(runId)
      const sourceFingerprint = String(result.sourceFingerprint ?? storedRun?.sourceFingerprint ?? '')
      const suppressed = runs.listSuppressedEffects(runId)
      const report = buildMigrationReport({
        mode,
        result: { ...result, sourceFingerprint },
        createdAt: storedRun?.createdAt ?? 0,
        suppressedEffects: {
          count: suppressed.length,
          deliverableCount: runs.countDeliverableMigrationEffects(runId),
          items: suppressed.map(effect => ({
            effectType: effect.effectType,
            resourceType: effect.resourceType,
            resourceId: effect.resourceId,
            idempotencyKey: effect.idempotencyKey,
            reason: effect.reason,
          })),
        },
      })
      return reportWriter.write(report, config.reportsDir)
    },
    close: async () => {
      targetStore.close()
      await Promise.allSettled([
        closeRedis(sourceRedisClient),
        closeRedis(targetRedisClient),
        readonlyQms.close(),
        targetQmsStore.stop(),
      ])
    },
  }
}

function redisClient(url: string): Redis {
  return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 })
}

async function closeRedis(client: Redis): Promise<void> {
  if (client.status !== 'wait' && client.status !== 'end') await client.quit()
}

class ReadonlyQmsPostgresPort implements QmsSqlPort {
  constructor(private readonly sql: Sql) {}

  async initialize(): Promise<void> {
    await this.sql.unsafe('SET default_transaction_read_only = on')
    await this.sql.unsafe('SELECT 1 AS healthy')
  }

  async execute(query: string, parameters: readonly unknown[] = []): Promise<readonly Record<string, unknown>[]> {
    if (!/^\s*SELECT\b/i.test(query)) throw new Error('Sudowork QMS 源连接只允许 SELECT')
    return await this.sql.unsafe(query, [...parameters] as never[]) as unknown as readonly Record<string, unknown>[]
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 })
  }
}
