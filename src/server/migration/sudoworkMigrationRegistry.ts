import { AccessMigrationPhase } from './accessMigrationPhase.js'
import { AutomationMigrationPhase, SudoworkAutomationSourceReader } from './automationMigrationPhase.js'
import {
  GovernanceMigrationPhase,
  OrganizationMigrationPhase,
  UserIdentityMigrationPhase,
} from './coreMigrationPhases.js'
import {
  BillingMigrationPhase,
  CatalogMigrationPhase,
  ConfigurationMigrationPhase,
  DifyMigrationPhase,
  QmsMigrationPhase,
} from './domainMigrationPhases.js'
import type { GovernanceMigrationResolutions, GovernanceMigrationService } from './governanceMigrationService.js'
import type { ManualResolution } from './identityMergePlanner.js'
import type { IdentityMigrationService } from './identityMigrationService.js'
import { MigrationPhaseRegistry } from './migrationPhaseRegistry.js'
import type { P2ConfigurationMigrationService } from './p2ConfigurationMigrationService.js'
import type { P2ManagedImageMigrationService } from './p2ManagedImageMigrationService.js'
import type { P2MigrationService } from './p2MigrationService.js'
import type { P2SystemConfigMigrationService } from './p2SystemConfigMigrationService.js'
import type { P3BillingMigrationService } from './p3BillingMigrationService.js'
import type { P4DifyMigrationService } from './p4DifyMigrationService.js'
import type { P5QmsMigrationService } from './p5QmsMigrationService.js'
import type { SudoworkP3SourceReader } from './sudoworkP3SourceReader.js'

type IdentityServices = Pick<IdentityMigrationService, 'plan' | 'executeOrganizations' | 'executeUsers' | 'verify'>

export interface SudoworkMigrationRegistryOptions {
  identity: IdentityServices
  identityResolutions?: readonly ManualResolution[]
  onIdentityPlanned?: (plan: ReturnType<IdentityServices['plan']>) => void
  beforeIdentityExecute?: () => void
  governance: Pick<GovernanceMigrationService, 'plan' | 'execute' | 'verify'>
  governanceResolutions?: GovernanceMigrationResolutions
  catalog: Pick<P2MigrationService, 'plan' | 'execute'>
  onCatalogPlanned?: (plan: Awaited<ReturnType<P2MigrationService['plan']>>) => void
  configuration: {
    managedImages: Pick<P2ManagedImageMigrationService, 'plan' | 'execute'>
    configuration: Pick<P2ConfigurationMigrationService, 'plan' | 'execute'>
    systemConfiguration: Pick<P2SystemConfigMigrationService, 'plan' | 'execute'>
  }
  dify: Pick<P4DifyMigrationService, 'plan' | 'execute' | 'verify'>
  billing: {
    service: Pick<P3BillingMigrationService, 'plan' | 'execute' | 'verify'>
    source: Pick<SudoworkP3SourceReader, 'readSnapshot'>
  }
  automationSource: Pick<SudoworkAutomationSourceReader, 'readSnapshot'>
  qms: Pick<P5QmsMigrationService, 'plan' | 'execute' | 'verify'>
  access: ConstructorParameters<typeof AccessMigrationPhase>[0]
}

export function createSudoworkMigrationPhaseRegistry(
  options: SudoworkMigrationRegistryOptions,
): MigrationPhaseRegistry {
  return new MigrationPhaseRegistry([
    new OrganizationMigrationPhase(options.identity, options.identityResolutions, options.onIdentityPlanned, options.beforeIdentityExecute),
    new UserIdentityMigrationPhase(options.identity, options.identityResolutions, options.onIdentityPlanned, options.beforeIdentityExecute),
    new GovernanceMigrationPhase(options.governance, options.governanceResolutions),
    new CatalogMigrationPhase(options.catalog, options.onCatalogPlanned),
    new ConfigurationMigrationPhase(options.configuration),
    new DifyMigrationPhase(options.dify),
    new BillingMigrationPhase(options.billing.service, options.billing.source),
    new AutomationMigrationPhase(options.automationSource),
    new QmsMigrationPhase(options.qms),
    new AccessMigrationPhase(options.access),
  ])
}
