import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { MIGRATION_PHASES } from './migrationRunStore.js'
import { createSudoworkMigrationPhaseRegistry } from './sudoworkMigrationRegistry.js'

describe('createSudoworkMigrationPhaseRegistry', () => {
  test('装配固定顺序的十个真实领域阶段，不允许空占位', () => {
    const identity = {
      plan: () => ({ status: 'ready', sourceChecksum: 'identity', issues: [] }),
      executeOrganizations: () => ({}), executeUsers: () => ({}),
      verify: () => ({ status: 'matched', issues: [] }),
    }
    const registry = createSudoworkMigrationPhaseRegistry({
      identity: identity as never,
      governance: {
        plan: () => ({ status: 'ready', sourceChecksum: 'governance', issues: [] }),
        execute: () => ({}), verify: () => ({ status: 'matched', issues: [] }),
      } as never,
      catalog: {} as never,
      configuration: { managedImages: {}, configuration: {}, systemConfiguration: {} } as never,
      dify: {} as never,
      billing: { service: {}, source: {} } as never,
      automationSource: {} as never,
      qms: {} as never,
      access: {} as never,
    })

    assert.deepEqual(registry.phases.map(phase => phase.name), MIGRATION_PHASES)
    assert.deepEqual(registry.phases.map(phase => phase.constructor.name), [
      'OrganizationMigrationPhase',
      'UserIdentityMigrationPhase',
      'GovernanceMigrationPhase',
      'CatalogMigrationPhase',
      'ConfigurationMigrationPhase',
      'DifyMigrationPhase',
      'BillingMigrationPhase',
      'AutomationMigrationPhase',
      'QmsMigrationPhase',
      'AccessMigrationPhase',
    ])
  })
})
