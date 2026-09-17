import type { ManualResolution } from './identityMergePlanner.js'
import type {
  IdentityMigrationPlan,
  IdentityMigrationService,
} from './identityMigrationService.js'
import type {
  GovernanceMigrationPlan,
  GovernanceMigrationResolutions,
  GovernanceMigrationService,
} from './governanceMigrationService.js'
import type {
  MigrationExecutionContext,
  MigrationPhase,
  MigrationPhaseIssue,
  MigrationPhasePlan,
  MigrationPhaseVerification,
  MigrationPlanningContext,
  MigrationVerificationContext,
} from './migrationPhaseRegistry.js'

interface IdentityPhasePlan extends MigrationPhasePlan {
  sourceChecksum: string
  domainPlan: IdentityMigrationPlan
}

interface GovernancePhasePlan extends MigrationPhasePlan {
  sourceChecksum: string
  domainPlan: GovernanceMigrationPlan
}

export class OrganizationMigrationPhase implements MigrationPhase {
  readonly name = 'organizations' as const

  constructor(
    private readonly service: Pick<IdentityMigrationService, 'plan' | 'executeOrganizations' | 'verify'>,
    private readonly resolutions: readonly ManualResolution[] = [],
    private readonly onPlanned?: (plan: IdentityMigrationPlan) => void,
    private readonly beforeExecute?: () => void,
  ) {}

  async plan(_context: MigrationPlanningContext): Promise<IdentityPhasePlan> {
    const plan = this.service.plan(this.resolutions)
    this.onPlanned?.(plan)
    return identityPlan(plan)
  }

  async execute(context: MigrationExecutionContext, plan: MigrationPhasePlan) {
    this.beforeExecute?.()
    const domain = requireIdentityPlan(plan)
    return this.service.executeOrganizations(
      domain,
      context.commandContext(`migration:phase:organizations:${domain.sourceChecksum}`),
    )
  }

  async verify(_context: MigrationVerificationContext): Promise<MigrationPhaseVerification> {
    const plan = this.service.plan(this.resolutions)
    return this.service.verify(plan)
  }
}

export class UserIdentityMigrationPhase implements MigrationPhase {
  readonly name = 'identities' as const

  constructor(
    private readonly service: Pick<IdentityMigrationService, 'plan' | 'executeUsers' | 'verify'>,
    private readonly resolutions: readonly ManualResolution[] = [],
    private readonly onPlanned?: (plan: IdentityMigrationPlan) => void,
    private readonly beforeExecute?: () => void,
  ) {}

  async plan(_context: MigrationPlanningContext): Promise<IdentityPhasePlan> {
    const plan = this.service.plan(this.resolutions)
    this.onPlanned?.(plan)
    return identityPlan(plan)
  }

  async execute(context: MigrationExecutionContext, plan: MigrationPhasePlan) {
    this.beforeExecute?.()
    const domain = requireIdentityPlan(plan)
    return this.service.executeUsers(
      domain,
      context.commandContext(`migration:phase:identities:${domain.sourceChecksum}`),
    )
  }

  async verify(_context: MigrationVerificationContext): Promise<MigrationPhaseVerification> {
    const plan = this.service.plan(this.resolutions)
    return this.service.verify(plan)
  }
}

export class GovernanceMigrationPhase implements MigrationPhase {
  readonly name = 'governance' as const

  constructor(
    private readonly service: Pick<GovernanceMigrationService, 'plan' | 'execute' | 'verify'>,
    private readonly resolutions: GovernanceMigrationResolutions = {},
  ) {}

  async plan(_context: MigrationPlanningContext): Promise<GovernancePhasePlan> {
    const domainPlan = this.service.plan(this.resolutions)
    return attachDomainPlan({
      status: domainPlan.status,
      sourceChecksum: domainPlan.sourceChecksum,
      issues: domainPlan.issues.map(issue => ({
        code: issue.code,
        resourceType: issue.sourceType,
        resourceId: issue.sourceId,
        message: issue.message,
      })),
    }, domainPlan)
  }

  async execute(context: MigrationExecutionContext, plan: MigrationPhasePlan) {
    const domain = requireGovernancePlan(plan)
    return this.service.execute(
      domain,
      context.commandContext(`migration:phase:governance:${domain.sourceChecksum}`),
    )
  }

  async verify(_context: MigrationVerificationContext): Promise<MigrationPhaseVerification> {
    const plan = this.service.plan(this.resolutions)
    return this.service.verify(plan)
  }
}

function identityPlan(domainPlan: IdentityMigrationPlan): IdentityPhasePlan {
  return attachDomainPlan({
    status: domainPlan.status,
    sourceChecksum: domainPlan.sourceChecksum,
    issues: domainPlan.issues.map((issue): MigrationPhaseIssue => ({
      code: issue.code,
      resourceType: issue.resourceType,
      resourceId: issue.sourceId,
      message: issue.message,
      detail: { candidateTargetIds: issue.candidateTargetIds },
    })),
  }, domainPlan)
}

function attachDomainPlan<T extends object, D>(value: T, domainPlan: D): T & { domainPlan: D } {
  return Object.defineProperty(value, 'domainPlan', {
    value: domainPlan,
    enumerable: false,
    writable: false,
    configurable: false,
  }) as T & { domainPlan: D }
}

function requireIdentityPlan(plan: MigrationPhasePlan): IdentityMigrationPlan {
  const domain = plan.domainPlan
  if (!domain || typeof domain !== 'object' || !('sourceChecksum' in domain)) {
    throw new Error('身份迁移阶段缺少领域预检结果')
  }
  return domain as IdentityMigrationPlan
}

function requireGovernancePlan(plan: MigrationPhasePlan): GovernanceMigrationPlan {
  const domain = plan.domainPlan
  if (!domain || typeof domain !== 'object' || !('sourceChecksum' in domain)) {
    throw new Error('治理迁移阶段缺少领域预检结果')
  }
  return domain as GovernanceMigrationPlan
}
