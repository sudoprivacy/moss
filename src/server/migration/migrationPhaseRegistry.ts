import type { CommandContext } from '../application/commandContext.js'
import { MIGRATION_PHASES, type MigrationPhaseName } from './migrationRunStore.js'
import type { SudoworkSourceSnapshot } from './sudoworkSourceSnapshot.js'

export interface MigrationPhaseIssue {
  code: string
  message: string
  resourceType?: string
  resourceId?: string
  detail?: Record<string, unknown>
}

export interface MigrationPhasePlan {
  status: 'ready' | 'blocked'
  issues: MigrationPhaseIssue[]
  [key: string]: unknown
}

export type MigrationPhaseResult = object

export interface MigrationPhaseVerification {
  status: 'matched' | 'mismatch'
  issues: string[]
}

export interface MigrationPlanningContext {
  snapshot: SudoworkSourceSnapshot
}

export interface MigrationExecutionContext extends MigrationPlanningContext {
  runId: string
  commandContext(idempotencyKey: string): CommandContext
}

export interface MigrationVerificationContext extends MigrationPlanningContext {
  runId: string
}

export interface MigrationPhase {
  readonly name: MigrationPhaseName
  plan(context: MigrationPlanningContext): Promise<MigrationPhasePlan>
  execute(context: MigrationExecutionContext, plan: MigrationPhasePlan): Promise<MigrationPhaseResult>
  verify(context: MigrationVerificationContext): Promise<MigrationPhaseVerification>
}

export class MigrationPhaseRegistry {
  readonly phases: readonly MigrationPhase[]

  constructor(phases: readonly MigrationPhase[]) {
    const actual = phases.map(phase => phase.name)
    if (actual.length !== MIGRATION_PHASES.length || new Set(actual).size !== MIGRATION_PHASES.length) {
      throw new Error(`迁移阶段清单必须完整且唯一: ${MIGRATION_PHASES.join(', ')}`)
    }
    if (actual.some((name, index) => name !== MIGRATION_PHASES[index])) {
      throw new Error(`迁移阶段顺序必须固定为: ${MIGRATION_PHASES.join(', ')}`)
    }
    this.phases = Object.freeze([...phases])
  }
}
