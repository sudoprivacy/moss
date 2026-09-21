#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(import.meta.dirname, '..')
const nodeTestFiles = [
  'src/server/api/compat/sudowork/adminService.node-test.ts',
  'src/server/api/compat/sudowork/app.node-test.ts',
  'src/server/api/compat/sudowork/billingRoutes.node-test.ts',
  'src/server/api/compat/sudowork/billingService.node-test.ts',
  'src/server/api/compat/sudowork/casService.node-test.ts',
  'src/server/api/compat/sudowork/catalogService.node-test.ts',
  'src/server/api/compat/sudowork/configService.node-test.ts',
  'src/server/api/compat/sudowork/difyAdministrationRoutes.node-test.ts',
  'src/server/api/compat/sudowork/difyDatasetRoutes.node-test.ts',
  'src/server/api/compat/sudowork/difyRoutes.node-test.ts',
  'src/server/api/compat/sudowork/hostDispatch.node-test.ts',
  'src/server/api/compat/sudowork/identityService.node-test.ts',
  'src/server/api/compat/sudowork/legacyAdminRoutes.node-test.ts',
  'src/server/api/compat/sudowork/legacyUsageRoutes.node-test.ts',
  'src/server/api/compat/sudowork/legacyUsageService.node-test.ts',
  'src/server/api/compat/sudowork/qmsRoutes.node-test.ts',
  'src/server/api/compat/sudowork/redisLegacyStore.node-test.ts',
  'src/server/api/compat/sudowork/routeInventory.node-test.ts',
  'src/server/api/compat/sudowork/sharedOperationalRoutes.node-test.ts',
  'src/server/api/compat/sudowork/sudorouterLifecycle.node-test.ts',
  'src/server/api/compat/sudowork/systemConfigService.node-test.ts',
  'src/server/api/compat/sudowork/transportContract.node-test.ts',
  'src/server/api/compat/sudowork/userProjectionService.node-test.ts',
  'src/server/api/cron.node-test.ts',
  'src/server/backends/nexusSpawnHandle.node-test.ts',
  'src/server/billing/billingCoordinator.node-test.ts',
  'src/server/billing/billingOutboxWorker.node-test.ts',
  'src/server/billing/billingRuntimeConfig.node-test.ts',
  'src/server/billing/billingSchema.node-test.ts',
  'src/server/billing/creditApplicationService.node-test.ts',
  'src/server/billing/fuiouAdapter.node-test.ts',
  'src/server/billing/rechargeService.node-test.ts',
  'src/server/billing/reconciliationService.node-test.ts',
  'src/server/billing/refundService.node-test.ts',
  'src/server/billing/sudorouterAccountService.node-test.ts',
  'src/server/billing/sudorouterAdapter.node-test.ts',
  'src/server/billing/walletService.node-test.ts',
  'src/server/catalog/catalogArtifactStore.node-test.ts',
  'src/server/catalog/catalogRepository.node-test.ts',
  'src/server/catalog/catalogSchema.node-test.ts',
  'src/server/catalog/catalogService.node-test.ts',
  'src/server/catalog/catalogUploadService.node-test.ts',
  'src/server/configuration/clientPolicyRepository.node-test.ts',
  'src/server/configuration/configAvailabilitySchema.node-test.ts',
  'src/server/configuration/configAvailabilityService.node-test.ts',
  'src/server/configuration/managedImageStore.node-test.ts',
  'src/server/configuration/modelSettings.node-test.ts',
  'src/server/dify/difyAdministrationService.node-test.ts',
  'src/server/dify/difyConnectionService.node-test.ts',
  'src/server/dify/difyDatasetService.node-test.ts',
  'src/server/dify/difyEnhancementService.node-test.ts',
  'src/server/dify/difyHttpAdapter.node-test.ts',
  'src/server/dify/difyRepository.node-test.ts',
  'src/server/dify/difyRuntimeService.node-test.ts',
  'src/server/dify/difySchema.node-test.ts',
  'src/server/dify/difyServiceFactory.node-test.ts',
  'src/server/identity/authServiceUnifiedCreate.node-test.ts',
  'src/server/identity/identityRepository.node-test.ts',
  'src/server/identity/legacyToken.node-test.ts',
  'src/server/identity/loginPolicy.node-test.ts',
  'src/server/identity/organizationAutomationPolicy.node-test.ts',
  'src/server/identity/organizationIdentityService.node-test.ts',
  'src/server/identity/passwordCompatibility.node-test.ts',
  'src/server/identity/smsVerification.node-test.ts',
  'src/server/identity/tencentSmsSender.node-test.ts',
  'src/server/identity/unifiedIdentityService.node-test.ts',
  'src/server/migration/accessMigrationPhase.node-test.ts',
  'src/server/migration/automationMigrationPhase.node-test.ts',
  'src/server/migration/coreMigrationPhases.node-test.ts',
  'src/server/migration/domainMigrationPhases.node-test.ts',
  'src/server/migration/governanceMigrationService.node-test.ts',
  'src/server/migration/identityMergePlanner.node-test.ts',
  'src/server/migration/identityMigrationService.node-test.ts',
  'src/server/migration/migrationReportFactory.node-test.ts',
  'src/server/migration/migrationReportWriter.node-test.ts',
  'src/server/migration/migrationRunStore.node-test.ts',
  'src/server/migration/migrationVerifier.node-test.ts',
  'src/server/migration/p2CatalogImport.node-test.ts',
  'src/server/migration/p2ConfigurationMigrationService.node-test.ts',
  'src/server/migration/p2ManagedImageMigrationService.node-test.ts',
  'src/server/migration/p2MigrationCoordinator.node-test.ts',
  'src/server/migration/p2MigrationService.node-test.ts',
  'src/server/migration/p2SystemConfigMigrationService.node-test.ts',
  'src/server/migration/p3BillingMigrationService.node-test.ts',
  'src/server/migration/p4DifyMigrationService.node-test.ts',
  'src/server/migration/p5QmsMigrationCli.node-test.ts',
  'src/server/migration/p5QmsMigrationService.node-test.ts',
  'src/server/migration/p5QmsMigrationTarget.node-test.ts',
  'src/server/migration/phaseBackedMigrationChecks.node-test.ts',
  'src/server/migration/planningProjections.node-test.ts',
  'src/server/migration/postCutoverChangeLog.node-test.ts',
  'src/server/migration/replayService.node-test.ts',
  'src/server/migration/sourceComponentReaders.node-test.ts',
  'src/server/migration/sudoworkGovernanceSourceReader.node-test.ts',
  'src/server/migration/sudoworkIdentitySourceReader.node-test.ts',
  'src/server/migration/sudoworkMigrationCoordinator.node-test.ts',
  'src/server/migration/sudoworkMigrationE2e.node-test.ts',
  'src/server/migration/sudoworkMigrationRegistry.node-test.ts',
  'src/server/migration/sudoworkP2SourceReader.node-test.ts',
  'src/server/migration/sudoworkP3SourceReader.node-test.ts',
  'src/server/migration/sudoworkP4SourceReader.node-test.ts',
  'src/server/migration/sudoworkP5QmsSourceReader.node-test.ts',
  'src/server/migration/sudoworkSourceSnapshot.node-test.ts',
  'src/server/migration/targetIdentitySnapshot.node-test.ts',
  'src/server/qms/alertService.node-test.ts',
  'src/server/qms/config.node-test.ts',
  'src/server/qms/crashService.node-test.ts',
  'src/server/qms/dashboardQueryService.node-test.ts',
  'src/server/qms/hybridDecryption.node-test.ts',
  'src/server/qms/notificationAdapters.node-test.ts',
  'src/server/qms/postgresStore.node-test.ts',
  'src/server/qms/qmsAuthorization.node-test.ts',
  'src/server/qms/qmsInfrastructure.integration.node-test.ts',
  'src/server/qms/qmsLeaseStore.node-test.ts',
  'src/server/qms/qmsLegacyOperations.node-test.ts',
  'src/server/qms/qmsMaintenanceService.node-test.ts',
  'src/server/qms/qmsRuntime.node-test.ts',
  'src/server/qms/qmsScheduler.node-test.ts',
  'src/server/qms/qmsSchema.node-test.ts',
  'src/server/qms/qmsSecretAdapter.node-test.ts',
  'src/server/qms/qmsSystemService.node-test.ts',
  'src/server/qms/redisTelemetryQueueBackend.node-test.ts',
  'src/server/qms/reliableTelemetryQueue.node-test.ts',
  'src/server/qms/sourceMapService.node-test.ts',
  'src/server/qms/telemetryPostgresWriter.node-test.ts',
  'src/server/qms/telemetryService.node-test.ts',
  'src/server/qms/userStatsService.node-test.ts',
  'src/server/storage/sqliteUnitOfWork.node-test.ts',
]

function collectNodeTests(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...collectNodeTests(absolute))
    else if (entry.name.endsWith('.node-test.ts')) found.push(relative(repoRoot, absolute).replaceAll('\\', '/'))
  }
  return found
}

const discovered = collectNodeTests(join(repoRoot, 'src', 'server')).sort()
const listed = [...nodeTestFiles].sort()
const unlisted = discovered.filter(file => !listed.includes(file))
const missing = listed.filter(file => !discovered.includes(file) || !existsSync(join(repoRoot, file)))
if (unlisted.length > 0 || missing.length > 0) {
  if (unlisted.length > 0) console.error(`Unlisted node-test files:\n  ${unlisted.join('\n  ')}`)
  if (missing.length > 0) console.error(`Listed but absent node-test files:\n  ${missing.join('\n  ')}`)
  process.exit(1)
}

const selectors = process.argv.slice(2).map(value => value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, ''))
const selected = selectors.length === 0
  ? nodeTestFiles
  : nodeTestFiles.filter(file => selectors.some((selector) => {
      const prefix = selector.startsWith('src/server/') ? selector : `src/server/${selector}`
      return file === prefix || file.startsWith(`${prefix}/`) || file.split('/').includes(selector)
    }))

if (selected.length === 0) {
  console.error(`No node-test files matched: ${selectors.join(', ')}`)
  process.exit(1)
}

console.log(`Running ${selected.length}/${nodeTestFiles.length} explicitly listed node-test files`)
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const result = spawnSync(process.execPath, [tsxCli, '--test', ...selected], {
  cwd: repoRoot,
  stdio: 'inherit',
})
if (result.error) {
  console.error(result.error)
  process.exit(2)
}
process.exit(result.status ?? 2)
