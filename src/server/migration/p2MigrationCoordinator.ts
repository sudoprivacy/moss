interface DomainPlan {
  status: 'ready' | 'blocked'
  [key: string]: unknown
}

interface AsyncMigrationDomain {
  plan(): Promise<DomainPlan>
  execute(migrationRunId: string): Promise<unknown>
}

interface SyncMigrationDomain {
  plan(): DomainPlan
  execute(migrationRunId: string): unknown
}

export interface P2CoordinatedPlan {
  status: 'ready' | 'blocked'
  catalog: DomainPlan
  managedImages: DomainPlan
  configuration: DomainPlan
  systemConfiguration: DomainPlan
}

export class P2MigrationPreflightError extends Error {
  constructor(readonly report: P2CoordinatedPlan) {
    super('P2 迁移统一预检失败，未执行任何写入')
    this.name = 'P2MigrationPreflightError'
  }
}

export class P2MigrationCoordinator {
  constructor(private readonly domains: {
    catalog: AsyncMigrationDomain
    managedImages: AsyncMigrationDomain
    configuration: SyncMigrationDomain
    systemConfiguration: AsyncMigrationDomain
  }) {}

  async plan(): Promise<P2CoordinatedPlan> {
    const catalog = await this.domains.catalog.plan()
    const managedImages = await this.domains.managedImages.plan()
    const configuration = this.domains.configuration.plan()
    const systemConfiguration = await this.domains.systemConfiguration.plan()
    return {
      status: [catalog, managedImages, configuration, systemConfiguration].every(item => item.status === 'ready')
        ? 'ready'
        : 'blocked',
      catalog,
      managedImages,
      configuration,
      systemConfiguration,
    }
  }

  async execute(migrationRunId: string) {
    const plan = await this.plan()
    if (plan.status === 'blocked') throw new P2MigrationPreflightError(plan)
    const catalog = await this.domains.catalog.execute(migrationRunId)
    const managedImages = await this.domains.managedImages.execute(migrationRunId)
    const configuration = this.domains.configuration.execute(migrationRunId)
    const systemConfiguration = await this.domains.systemConfiguration.execute(migrationRunId)
    return { migrationRunId, catalog, managedImages, configuration, systemConfiguration }
  }
}
