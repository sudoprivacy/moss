import { MIGRATION_PHASES, type MigrationRunStore } from './migrationRunStore.js'
import type { SudoworkSourceSnapshot } from './sudoworkSourceSnapshot.js'

export const REQUIRED_MIGRATION_CHECKS = [
  'organization_mapping',
  'user_mapping',
  'numeric_aliases',
  'referential_integrity',
  'billing_reconciliation',
  'catalog_artifacts',
  'configuration_secrets',
  'uploaded_files',
  'qms_ranges',
  'authentication_samples',
] as const

export type MigrationVerificationCheckName = typeof REQUIRED_MIGRATION_CHECKS[number]

export interface MigrationCheckResult {
  status: 'matched' | 'mismatch'
  issues: string[]
  metrics: Record<string, number | string | boolean | null>
}

export interface MigrationVerificationCheck {
  readonly name: MigrationVerificationCheckName
  verify(context: { runId: string; snapshot: SudoworkSourceSnapshot }): Promise<MigrationCheckResult>
}

export interface CompleteMigrationVerification {
  runId: string
  sourceFingerprint: string
  status: 'matched' | 'mismatch'
  checks: Array<{ name: MigrationVerificationCheckName; result: MigrationCheckResult }>
  issues: string[]
  suppressedEffects: {
    count: number
    deliverableCount: number
  }
}

export class MigrationVerifier {
  private readonly checks: readonly MigrationVerificationCheck[]

  constructor(private readonly runs: MigrationRunStore, checks: readonly MigrationVerificationCheck[]) {
    const names = checks.map(check => check.name)
    if (
      names.length !== REQUIRED_MIGRATION_CHECKS.length
      || new Set(names).size !== REQUIRED_MIGRATION_CHECKS.length
      || names.some((name, index) => name !== REQUIRED_MIGRATION_CHECKS[index])
    ) {
      throw new Error(`迁移校验项清单必须完整且顺序固定: ${REQUIRED_MIGRATION_CHECKS.join(', ')}`)
    }
    this.checks = Object.freeze([...checks])
  }

  async verify(runId: string, snapshot: SudoworkSourceSnapshot): Promise<CompleteMigrationVerification> {
    const run = this.runs.getRun(runId)
    if (!run) throw new Error(`迁移批次不存在: ${runId}`)
    if (run.sourceFingerprint !== snapshot.fingerprint) throw new Error('迁移源指纹与执行批次不一致')
    const phases = this.runs.listPhases(runId)
    if (phases.length !== MIGRATION_PHASES.length || phases.some(phase => phase.status !== 'complete')) {
      throw new Error('迁移阶段尚未全部完成，不能执行最终校验')
    }

    const checks: CompleteMigrationVerification['checks'] = []
    const issues: string[] = []
    for (const check of this.checks) {
      const result = await check.verify({ runId, snapshot })
      checks.push({ name: check.name, result })
      issues.push(...result.issues)
    }
    const suppressedEffects = {
      count: this.runs.listSuppressedEffects(runId).length,
      deliverableCount: this.runs.countDeliverableMigrationEffects(runId),
    }
    if (suppressedEffects.deliverableCount > 0) {
      issues.push(`迁移来源存在 ${suppressedEffects.deliverableCount} 个可投递外部副作用`)
    }
    return {
      runId,
      sourceFingerprint: snapshot.fingerprint,
      status: checks.every(check => check.result.status === 'matched') && issues.length === 0 ? 'matched' : 'mismatch',
      checks,
      issues,
      suppressedEffects,
    }
  }
}
