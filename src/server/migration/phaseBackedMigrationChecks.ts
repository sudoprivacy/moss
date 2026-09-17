import type { MigrationPhaseName } from './migrationRunStore.js'
import type {
  MigrationPhaseRegistry,
  MigrationPhaseVerification,
  MigrationVerificationContext,
} from './migrationPhaseRegistry.js'
import {
  REQUIRED_MIGRATION_CHECKS,
  type MigrationCheckResult,
  type MigrationVerificationCheck,
  type MigrationVerificationCheckName,
} from './migrationVerifier.js'

const CHECK_PHASES: Record<MigrationVerificationCheckName, readonly MigrationPhaseName[]> = {
  organization_mapping: ['organizations'],
  user_mapping: ['identities'],
  numeric_aliases: ['organizations', 'identities', 'governance', 'billing'],
  referential_integrity: ['governance', 'catalog', 'configuration', 'dify', 'billing', 'automation'],
  billing_reconciliation: ['billing'],
  catalog_artifacts: ['catalog'],
  configuration_secrets: ['configuration', 'dify'],
  uploaded_files: ['configuration'],
  qms_ranges: ['qms'],
  authentication_samples: ['access'],
}

export function createPhaseBackedMigrationChecks(
  registry: MigrationPhaseRegistry,
): MigrationVerificationCheck[] {
  let cacheKey = ''
  let cached: Promise<Map<MigrationPhaseName, MigrationPhaseVerification>> | undefined

  const verifyAll = (context: MigrationVerificationContext) => {
    const key = `${context.runId}\0${context.snapshot.fingerprint}`
    if (!cached || cacheKey !== key) {
      cacheKey = key
      cached = Promise.all(registry.phases.map(async phase => [
        phase.name,
        await phase.verify(context),
      ] as const)).then(entries => new Map(entries))
    }
    return cached
  }

  return REQUIRED_MIGRATION_CHECKS.map(name => ({
    name,
    async verify(context): Promise<MigrationCheckResult> {
      const phaseNames = CHECK_PHASES[name]
      const results = await verifyAll(context)
      const issues = phaseNames.flatMap(phaseName => (
        results.get(phaseName)?.issues ?? [`${phaseName} 阶段缺少校验结果`]
      ).map(issue => `${phaseName}: ${issue}`))
      return {
        status: issues.length === 0 && phaseNames.every(phaseName => results.get(phaseName)?.status === 'matched')
          ? 'matched'
          : 'mismatch',
        issues,
        metrics: { phasesChecked: phaseNames.length, issueCount: issues.length },
      }
    },
  }))
}
