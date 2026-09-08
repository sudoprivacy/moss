import type { P2ConfigurationMigrationService } from './p2ConfigurationMigrationService.js'
import type { P2ManagedImageMigrationService } from './p2ManagedImageMigrationService.js'
import type { P2MigrationService } from './p2MigrationService.js'
import type { P2SystemConfigMigrationService } from './p2SystemConfigMigrationService.js'
import type { P3BillingMigrationService } from './p3BillingMigrationService.js'
import type { SudoworkP3SourceReader } from './sudoworkP3SourceReader.js'
import type { P4DifyMigrationService } from './p4DifyMigrationService.js'
import type { P5QmsMigrationService } from './p5QmsMigrationService.js'
import type {
  MigrationExecutionContext,
  MigrationPhase,
  MigrationPhaseIssue,
  MigrationPhasePlan,
  MigrationPhaseVerification,
  MigrationPlanningContext,
  MigrationVerificationContext,
} from './migrationPhaseRegistry.js'

interface WrappedPlan extends MigrationPhasePlan {
  sourceChecksum: string
  domainPlan: unknown
}

type CatalogService = Pick<P2MigrationService, 'plan' | 'execute'>
type ConfigurationService = Pick<P2ConfigurationMigrationService, 'plan' | 'execute'>
type ManagedImageService = Pick<P2ManagedImageMigrationService, 'plan' | 'execute'>
type SystemConfigurationService = Pick<P2SystemConfigMigrationService, 'plan' | 'execute'>
type DifyService = Pick<P4DifyMigrationService, 'plan' | 'execute' | 'verify'>
type BillingService = Pick<P3BillingMigrationService, 'plan' | 'execute' | 'verify'>
type BillingSource = Pick<SudoworkP3SourceReader, 'readSnapshot'>
type QmsService = Pick<P5QmsMigrationService, 'plan' | 'execute' | 'verify'>

export class CatalogMigrationPhase implements MigrationPhase {
  readonly name = 'catalog' as const

  constructor(
    private readonly service: CatalogService,
    private readonly onPlanned?: (plan: Awaited<ReturnType<CatalogService['plan']>>) => void,
  ) {}

  async plan(context: MigrationPlanningContext): Promise<WrappedPlan> {
    const domainPlan = await this.service.plan()
    this.onPlanned?.(domainPlan)
    return wrapPlan(domainPlan, context.snapshot.fingerprint)
  }

  async execute(context: MigrationExecutionContext, plan: MigrationPhasePlan) {
    requireWrappedPlan(plan, 'Catalog')
    return this.service.execute(context.runId)
  }

  async verify(_context: MigrationVerificationContext): Promise<MigrationPhaseVerification> {
    const current = await this.service.plan()
    const issues = domainIssues(current).map(issue => issue.message)
    if (current.status === 'ready' && current.counts.imports > 0) {
      issues.push(`Catalog 仍有 ${current.counts.imports} 个资源未导入`)
    }
    return { status: issues.length === 0 ? 'matched' : 'mismatch', issues }
  }
}

export class ConfigurationMigrationPhase implements MigrationPhase {
  readonly name = 'configuration' as const

  constructor(private readonly services: {
    managedImages: ManagedImageService
    configuration: ConfigurationService
    systemConfiguration: SystemConfigurationService
  }) {}

  async plan(context: MigrationPlanningContext): Promise<WrappedPlan> {
    const managedImages = await this.services.managedImages.plan()
    const configuration = this.services.configuration.plan()
    const systemConfiguration = await this.services.systemConfiguration.plan()
    const domainPlan = { managedImages, configuration, systemConfiguration }
    const issues = [managedImages, configuration, systemConfiguration].flatMap(domainIssues)
    return attachDomainPlan({
      status: issues.length === 0 ? 'ready' : 'blocked',
      issues,
      sourceChecksum: context.snapshot.fingerprint,
    }, domainPlan)
  }

  async execute(context: MigrationExecutionContext, plan: MigrationPhasePlan) {
    requireWrappedPlan(plan, 'Configuration')
    const managedImages = await this.services.managedImages.execute()
    const configuration = this.services.configuration.execute(context.runId)
    const systemConfiguration = await this.services.systemConfiguration.execute(context.runId)
    return { managedImages, configuration, systemConfiguration }
  }

  async verify(_context: MigrationVerificationContext): Promise<MigrationPhaseVerification> {
    const managedImages = await this.services.managedImages.plan()
    const configuration = this.services.configuration.plan()
    const systemConfiguration = await this.services.systemConfiguration.plan()
    const issues = [managedImages, configuration, systemConfiguration].flatMap(domainIssues).map(issue => issue.message)
    if (managedImages.status === 'ready' && managedImages.counts.imports > 0) {
      issues.push(`仍有 ${managedImages.counts.imports} 个配置图片未导入`)
    }
    if (configuration.status === 'ready' && configuration.counts.imports > 0) {
      issues.push(`仍有 ${configuration.counts.imports} 个配置项未导入`)
    }
    return { status: issues.length === 0 ? 'matched' : 'mismatch', issues }
  }
}

export class DifyMigrationPhase implements MigrationPhase {
  readonly name = 'dify' as const

  constructor(private readonly service: DifyService) {}

  async plan(_context: MigrationPlanningContext): Promise<WrappedPlan> {
    const domainPlan = this.service.plan()
    return wrapPlan(domainPlan, domainPlan.sourceChecksum)
  }

  async execute(context: MigrationExecutionContext, plan: MigrationPhasePlan) {
    const domain = requireWrappedPlan(plan, 'Dify') as ReturnType<DifyService['plan']>
    return this.service.execute(
      domain,
      context.commandContext(`migration:phase:dify:${domain.sourceChecksum}`),
    )
  }

  async verify(_context: MigrationVerificationContext): Promise<MigrationPhaseVerification> {
    return this.service.verify()
  }
}

export class BillingMigrationPhase implements MigrationPhase {
  readonly name = 'billing' as const

  constructor(private readonly service: BillingService, private readonly source: BillingSource) {}

  async plan(_context: MigrationPlanningContext): Promise<WrappedPlan> {
    const domainPlan = this.service.plan(this.source.readSnapshot())
    return wrapPlan(domainPlan, domainPlan.sourceChecksum)
  }

  async execute(context: MigrationExecutionContext, plan: MigrationPhasePlan) {
    const domain = requireWrappedPlan(plan, 'Billing') as ReturnType<BillingService['plan']>
    return this.service.execute(
      domain,
      context.commandContext(`migration:phase:billing:${domain.sourceChecksum}`),
    )
  }

  async verify(_context: MigrationVerificationContext): Promise<MigrationPhaseVerification> {
    return this.service.verify(this.source.readSnapshot())
  }
}

export class QmsMigrationPhase implements MigrationPhase {
  readonly name = 'qms' as const

  constructor(private readonly service: QmsService) {}

  async plan(_context: MigrationPlanningContext): Promise<WrappedPlan> {
    const domainPlan = await this.service.plan()
    return wrapPlan(domainPlan, domainPlan.sourceChecksum)
  }

  async execute(context: MigrationExecutionContext, plan: MigrationPhasePlan) {
    const domain = requireWrappedPlan(plan, 'QMS') as Awaited<ReturnType<QmsService['plan']>>
    return this.service.execute(
      domain,
      context.commandContext(`migration:phase:qms:${domain.sourceChecksum}`),
    )
  }

  async verify(_context: MigrationVerificationContext): Promise<MigrationPhaseVerification> {
    const plan = await this.service.plan()
    return this.service.verify(plan)
  }
}

function wrapPlan<T extends { status: 'ready' | 'blocked' }>(domainPlan: T, sourceChecksum: string): WrappedPlan {
  return attachDomainPlan({
    status: domainPlan.status,
    issues: domainIssues(domainPlan),
    sourceChecksum,
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

function requireWrappedPlan(plan: MigrationPhasePlan, label: string): unknown {
  if (!plan.domainPlan || typeof plan.domainPlan !== 'object') {
    throw new Error(`${label} 迁移阶段缺少领域预检结果`)
  }
  return plan.domainPlan
}

function domainIssues(plan: unknown): MigrationPhaseIssue[] {
  if (!plan || typeof plan !== 'object') return [{ code: 'INVALID_PLAN', message: '领域预检结果无效' }]
  const value = plan as Record<string, unknown>
  const arrays = [value.issues, value.conflicts, value.orphans]
  const result: MigrationPhaseIssue[] = []
  for (const items of arrays) {
    if (!Array.isArray(items)) continue
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const issue = item as Record<string, unknown>
      result.push({
        code: typeof issue.code === 'string' ? issue.code : 'DOMAIN_CONFLICT',
        message: String(issue.message ?? issue.reason ?? '领域预检失败'),
        resourceType: typeof issue.sourceType === 'string'
          ? issue.sourceType
          : typeof issue.kind === 'string' ? issue.kind : undefined,
        resourceId: issue.sourceId == null ? undefined : String(issue.sourceId),
      })
    }
  }
  return result
}
