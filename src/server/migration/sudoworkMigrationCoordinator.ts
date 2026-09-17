import { migrationCommandContext } from '../application/commandContext.js'
import {
  type MigrationPhasePlan,
  type MigrationPhaseResult,
  type MigrationPhaseVerification,
  type MigrationPhaseRegistry,
} from './migrationPhaseRegistry.js'
import { type MigrationIssue, type MigrationPhaseName, type MigrationRunStore } from './migrationRunStore.js'
import type { CompleteMigrationVerification } from './migrationVerifier.js'
import type { SudoworkSourceSnapshot, SudoworkSourceSnapshotReader } from './sudoworkSourceSnapshot.js'

export interface MigrationPlanReport {
  status: 'ready' | 'blocked'
  source: SudoworkSourceSnapshot
  phases: Array<{ name: MigrationPhaseName; plan: MigrationPhasePlan }>
}

export interface MigrationExecutionReport {
  runId: string
  sourceFingerprint: string
  resumed: boolean
  phases: Array<{ name: MigrationPhaseName; result: MigrationPhaseResult; skipped: boolean }>
}

export interface MigrationVerificationReport {
  runId: string
  sourceFingerprint: string
  status: 'matched' | 'mismatch'
  phases: Array<{ name: MigrationPhaseName; verification: MigrationPhaseVerification }>
  finalVerification?: CompleteMigrationVerification
}

interface FinalMigrationVerifier {
  verify(runId: string, snapshot: SudoworkSourceSnapshot): Promise<CompleteMigrationVerification>
}

export class SudoworkMigrationBlockedError extends Error {
  constructor(readonly report: MigrationPlanReport) {
    super('Sudowork 迁移预检存在未解决冲突，未写入任何目标业务数据')
    this.name = 'SudoworkMigrationBlockedError'
  }
}

interface SourceSnapshotPort {
  capture(): Promise<SudoworkSourceSnapshot>
  assertUnchanged(expectedFingerprint: string): Promise<void>
}

export class SudoworkMigrationCoordinator {
  constructor(private readonly options: {
    runs: MigrationRunStore
    source: SourceSnapshotPort | SudoworkSourceSnapshotReader
    phases: MigrationPhaseRegistry
    finalVerifier?: FinalMigrationVerifier
  }) {}

  async dryRun(): Promise<MigrationPlanReport> {
    const source = await this.options.source.capture()
    const phases: MigrationPlanReport['phases'] = []
    for (const phase of this.options.phases.phases) {
      phases.push({ name: phase.name, plan: await phase.plan({ snapshot: source }) })
    }
    return {
      status: phases.every(item => item.plan.status === 'ready') ? 'ready' : 'blocked',
      source,
      phases,
    }
  }

  async execute(): Promise<MigrationExecutionReport> {
    const planned = await this.dryRun()
    if (planned.status === 'blocked') throw new SudoworkMigrationBlockedError(planned)
    const run = this.options.runs.createRun({
      sourceFingerprint: planned.source.fingerprint,
      sourceMetadata: sourceMetadata(planned.source),
    })
    return this.executePlanned(run.id, planned, false)
  }

  async resume(runId: string): Promise<MigrationExecutionReport> {
    const source = await this.options.source.capture()
    this.options.runs.requireResumableRun(runId, source.fingerprint)
    const phases: MigrationPlanReport['phases'] = []
    for (const phase of this.options.phases.phases) {
      phases.push({ name: phase.name, plan: await phase.plan({ snapshot: source }) })
    }
    const planned: MigrationPlanReport = {
      status: phases.every(item => item.plan.status === 'ready') ? 'ready' : 'blocked',
      source,
      phases,
    }
    if (planned.status === 'blocked') throw new SudoworkMigrationBlockedError(planned)
    return this.executePlanned(runId, planned, true)
  }

  async verify(runId: string): Promise<MigrationVerificationReport> {
    const source = await this.options.source.capture()
    const run = this.options.runs.getRun(runId)
    if (!run) throw new Error(`迁移批次不存在: ${runId}`)
    if (run.sourceFingerprint !== source.fingerprint) throw new Error('迁移源指纹与执行批次不一致')
    const phases: MigrationVerificationReport['phases'] = []
    for (const phase of this.options.phases.phases) {
      phases.push({ name: phase.name, verification: await phase.verify({ runId, snapshot: source }) })
    }
    const finalVerification = this.options.finalVerifier
      ? await this.options.finalVerifier.verify(runId, source)
      : undefined
    const report: MigrationVerificationReport = {
      runId,
      sourceFingerprint: source.fingerprint,
      status: phases.every(item => item.verification.status === 'matched')
        && (!finalVerification || finalVerification.status === 'matched') ? 'matched' : 'mismatch',
      phases,
      ...(finalVerification ? { finalVerification } : {}),
    }
    if (report.status === 'matched') this.options.runs.markVerified(runId)
    return report
  }

  private async executePlanned(
    runId: string,
    planned: MigrationPlanReport,
    resumed: boolean,
  ): Promise<MigrationExecutionReport> {
    const results: MigrationExecutionReport['phases'] = []
    for (let index = 0; index < this.options.phases.phases.length; index += 1) {
      const phase = this.options.phases.phases[index]
      const checkpoint = this.options.runs.getPhase(runId, phase.name)
      if (checkpoint?.status === 'complete') {
        results.push({ name: phase.name, result: checkpoint.result ?? {}, skipped: true })
        continue
      }

      await this.options.source.assertUnchanged(planned.source.fingerprint)
      this.options.runs.beginPhase(runId, phase.name)
      try {
        const result = await phase.execute({
          runId,
          snapshot: planned.source,
          commandContext: idempotencyKey => migrationCommandContext(runId, idempotencyKey),
        }, planned.phases[index].plan)
        await this.options.source.assertUnchanged(planned.source.fingerprint)
        this.options.runs.completePhase(runId, phase.name, result as Record<string, unknown>)
        results.push({ name: phase.name, result, skipped: false })
      } catch (error) {
        this.options.runs.failPhase(runId, phase.name, phaseError(phase.name, error))
        throw error
      }
    }
    return { runId, sourceFingerprint: planned.source.fingerprint, resumed, phases: results }
  }
}

function phaseError(phase: MigrationPhaseName, error: unknown): MigrationIssue {
  return {
    phase,
    code: 'PHASE_EXECUTION_FAILED',
    severity: 'blocker',
    resourceType: 'migration_phase',
    resourceId: phase,
    message: error instanceof Error ? error.message : String(error),
    detail: {},
  }
}

function sourceMetadata(snapshot: SudoworkSourceSnapshot): Record<string, unknown> {
  return {
    capturedAt: snapshot.capturedAt,
    components: {
      sqlite: snapshot.sqlite,
      redis: snapshot.redis,
      qms: snapshot.qms,
      files: snapshot.files,
    },
    includedDomains: snapshot.includedDomains,
    excludedLocalData: snapshot.excludedLocalData,
  }
}
