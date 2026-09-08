import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { assertTrustedCommandContext, type CommandContext } from '../application/commandContext.js'
import type { AuthCenterDb } from '../authCenter/db.js'
import type { CatalogAgent, CatalogRepository } from '../catalog/catalogRepository.js'
import type { DifyRepository } from '../dify/difyRepository.js'
import type { IdentityRepository } from '../identity/identityRepository.js'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'
import type { VisibleTo } from '../visibilityFilter.js'
import type {
  SudoworkAssistantAclSource,
  SudoworkP4Snapshot,
} from './sudoworkP4SourceReader.js'

interface P4Source {
  readSnapshot(): SudoworkP4Snapshot
}

interface P4SecretPort {
  putSecret(namespace: string, key: string, value: string, subject?: string): Promise<void>
  getSecret(namespace: string, key: string, subject?: string): Promise<{ value: string | null } | null>
}

export type P4DifyMigrationIssueCode =
  | 'ORGANIZATION_MAPPING_MISSING'
  | 'AGENT_MAPPING_MISSING'
  | 'TENANT_BINDING_MISSING'
  | 'TENANT_MISMATCH'
  | 'METHOD_CONFLICT'
  | 'TARGET_CONFLICT'
  | 'ACL_MAPPING_MISSING'
  | 'CREDENTIAL_MISSING'

export interface P4DifyMigrationIssue {
  code: P4DifyMigrationIssueCode
  source: string
  message: string
}

interface OrganizationMapping {
  enterpriseId: number
  orgId: string
  connectionId: string
}

export interface P4DifyMigrationPlan {
  status: 'ready' | 'blocked'
  sourceChecksum: string
  counts: { connections: number; apps: number; datasets: number; acl: number; metadata: number }
  issues: P4DifyMigrationIssue[]
  organizations: OrganizationMapping[]
}

export type P4DifyMigrationReport = P4DifyMigrationPlan['counts'] & {
  migrationRunId: string
  sourceChecksum: string
  deliverableExternalOutboxCount: number
}

export interface P4DifyVerification {
  status: 'matched' | 'mismatch'
  sourceChecksum: string
  issues: string[]
}

export class P4DifyMigrationBlockedError extends Error {
  constructor(readonly report: P4DifyMigrationPlan) {
    super(`P4 Dify 迁移预检失败: ${report.issues.length} 个问题`)
    this.name = 'P4DifyMigrationBlockedError'
  }
}

export class P4DifyMigrationService {
  constructor(private readonly options: {
    db: DatabaseSync
    auth: AuthCenterDb
    identities: IdentityRepository
    catalog: CatalogRepository
    dify: DifyRepository
    source: P4Source
    secrets: P4SecretPort
  }) {}

  plan(): P4DifyMigrationPlan {
    const source = this.options.source.readSnapshot()
    const issues: P4DifyMigrationIssue[] = []
    const organizations: OrganizationMapping[] = []
    const connectionByEnterprise = new Map(source.connections.map(item => [item.enterpriseId, item]))

    for (const connection of source.connections) {
      const mapped = this.options.identities.resolveNumericAliasGlobal('enterprise', connection.enterpriseId)
      if (!mapped) {
        issue(issues, 'ORGANIZATION_MAPPING_MISSING', `enterprise:${connection.enterpriseId}`, '旧企业未映射到 Moss Organization')
        continue
      }
      const target = this.options.identities.getIntegrationConnection(connectionId(mapped.resourceId))
      if (target && (target.orgId !== mapped.resourceId || target.config.tenantId !== connection.tenantId)) {
        issue(issues, 'TARGET_CONFLICT', `enterprise:${connection.enterpriseId}`, '目标 Dify Connection 已绑定不同租户')
        continue
      }
      organizations.push({ enterpriseId: connection.enterpriseId, orgId: mapped.resourceId, connectionId: connectionId(mapped.resourceId) })
    }

    const organizationByLegacyId = new Map(organizations.map(item => [item.enterpriseId, item]))
    const appKeys = new Set<string>()
    const appAliases = new Map<string, string>()
    for (const app of source.apps) {
      const organization = organizationByLegacyId.get(app.enterpriseId)
      if (!organization) continue
      const connection = connectionByEnterprise.get(app.enterpriseId)
      if (!connection) {
        issue(issues, 'TENANT_BINDING_MISSING', `app:${app.id}`, 'App 缺少企业 Dify 租户连接')
        continue
      }
      if (connection.tenantId !== app.tenantId) {
        issue(issues, 'TENANT_MISMATCH', `app:${app.id}`, 'App 租户与企业 Dify 租户不一致')
      }
      if (!app.appApiKey) {
        issue(issues, 'CREDENTIAL_MISSING', `app:${app.id}`, '旧 Dify App API Key 缺失，无法保持增强功能可用')
      }
      const agent = this.options.catalog.findAgent(app.assistantId)
      if (!agent || !this.options.catalog.isAvailableToOrganization('agent', app.assistantId, organization.orgId)) {
        issue(issues, 'AGENT_MAPPING_MISSING', `app:${app.id}`, `Agent ${app.assistantId} 未迁入统一 Catalog`)
      } else {
        const binding = agent.providerBinding
        if (binding && (
          binding.connectionId !== organization.connectionId
          || binding.tenantId !== app.tenantId
          || binding.appId !== app.appId
          || binding.mode !== app.mode
        )) {
          issue(issues, 'TARGET_CONFLICT', `app:${app.id}`, '目标 Agent 已存在不同 Dify App binding')
        }
      }
      const aliasKey = `${organization.orgId}:${organization.connectionId}:${app.appId}`
      const sourceAlias = appAliases.get(aliasKey)
      if (sourceAlias && sourceAlias !== app.assistantId) {
        issue(issues, 'TARGET_CONFLICT', `app:${app.id}`, '同一 Dify App 在源数据中绑定了多个 Agent')
      }
      appAliases.set(aliasKey, app.assistantId)
      const resolvedAlias = this.options.catalog.resolveExternalIdentity({
        orgId: organization.orgId,
        resourceType: 'agent',
        providerType: 'dify',
        providerId: organization.connectionId,
        externalId: app.appId,
      })
      if (resolvedAlias && resolvedAlias !== app.assistantId) {
        issue(issues, 'TARGET_CONFLICT', `app:${app.id}`, `Dify App 已映射到其他 Agent ${resolvedAlias}`)
      }
      appKeys.add(`${app.enterpriseId}:${app.assistantId}`)
    }

    for (const dataset of source.datasets) {
      const organization = organizationByLegacyId.get(dataset.enterpriseId)
      if (!organization) continue
      const connection = connectionByEnterprise.get(dataset.enterpriseId)
      if (!connection) {
        issue(issues, 'TENANT_BINDING_MISSING', `dataset:${dataset.id}`, 'Dataset 缺少企业 Dify 租户连接')
        continue
      }
      if (connection.tenantId !== dataset.tenantId) {
        issue(issues, 'TENANT_MISMATCH', `dataset:${dataset.id}`, 'Dataset 租户与企业 Dify 租户不一致')
      }
      const agent = this.options.catalog.findAgent(dataset.assistantId)
      if (!agent || !this.options.catalog.isAvailableToOrganization('agent', dataset.assistantId, organization.orgId)) {
        issue(issues, 'AGENT_MAPPING_MISSING', `dataset:${dataset.id}`, `Agent ${dataset.assistantId} 未迁入统一 Catalog`)
      }
      if (appKeys.has(`${dataset.enterpriseId}:${dataset.assistantId}`)) {
        issue(issues, 'METHOD_CONFLICT', `dataset:${dataset.id}`, '同一 Agent 同时存在 Dify App 与 Dataset-only 绑定')
      }
    }

    for (const item of [...source.acl, ...source.metadata]) {
      const organization = organizationByLegacyId.get(item.enterpriseId)
      if (!organization) continue
      const agent = this.options.catalog.findAgent(item.assistantId)
      if (!agent || !this.options.catalog.isAvailableToOrganization('agent', item.assistantId, organization.orgId)) {
        issue(issues, 'AGENT_MAPPING_MISSING', `${'subjectType' in item ? 'acl' : 'metadata'}:${item.id}`, `Agent ${item.assistantId} 未迁入统一 Catalog`)
      }
    }

    for (const acl of source.acl) {
      const organization = organizationByLegacyId.get(acl.enterpriseId)
      if (!organization || acl.subjectType === 'all' || acl.subjectType === 'role' || acl.subjectId === null) continue
      if (!this.resolveAclSubject(acl, organization.orgId)) {
        issue(issues, 'ACL_MAPPING_MISSING', `acl:${acl.id}`, `${acl.subjectType} ${acl.subjectId} 未映射到 Moss`)
      }
    }

    return {
      status: issues.length === 0 ? 'ready' : 'blocked',
      sourceChecksum: source.checksum,
      counts: {
        connections: source.connections.length,
        apps: source.apps.length,
        datasets: source.datasets.length,
        acl: source.acl.length,
        metadata: source.metadata.length,
      },
      issues,
      organizations,
    }
  }

  async execute(plan: P4DifyMigrationPlan, context: CommandContext): Promise<P4DifyMigrationReport> {
    assertTrustedCommandContext(context)
    if (context.source !== 'migration' || context.externalEffects !== 'suppress_external' || !context.migrationRunId) {
      throw new Error('P4 Dify 迁移必须使用抑制外部副作用的迁移上下文')
    }
    if (plan.status === 'blocked') throw new P4DifyMigrationBlockedError(plan)
    const source = this.options.source.readSnapshot()
    if (source.checksum !== plan.sourceChecksum) throw new Error('P4 Dify 源快照在预检后发生变化')
    const organizationByLegacyId = new Map(plan.organizations.map(item => [item.enterpriseId, item]))
    const pendingOutboxBefore = this.pendingOutboxCount()

    for (const connection of source.connections) {
      const organization = organizationByLegacyId.get(connection.enterpriseId)!
      await this.options.secrets.putSecret(
        secretNamespace(organization.orgId), 'service-api-key', connection.apiKey, `org:${organization.orgId}`,
      )
    }
    for (const app of source.apps) {
      const organization = organizationByLegacyId.get(app.enterpriseId)!
      await this.options.secrets.putSecret(
        secretNamespace(organization.orgId), appSecretKey(app.appId), app.appApiKey!, `org:${organization.orgId}`,
      )
    }

    runInTransaction(this.options.db, () => {
      for (const connection of source.connections) {
        const organization = organizationByLegacyId.get(connection.enterpriseId)!
        this.options.identities.putIntegrationConnection({
          id: organization.connectionId,
          orgId: organization.orgId,
          providerType: 'dify',
          name: 'Dify',
          enabled: true,
          secretRef: secretReference(secretNamespace(organization.orgId), 'service-api-key'),
          config: {
            tenantId: connection.tenantId,
            systemAccountId: connection.systemAccountId,
            isDefault: true,
            createdAt: connection.createdAt,
          },
        })
      }

      const datasetsByAgent = groupBy(source.datasets, item => `${item.enterpriseId}:${item.assistantId}`)
      for (const app of source.apps) {
        const organization = organizationByLegacyId.get(app.enterpriseId)!
        const agent = this.requireAgent(app.assistantId, organization.orgId)
        this.options.catalog.updateAgentConfiguration(agent.id, agent.orgId, {
          providerType: 'dify',
          supportedModes: 'both',
          providerBinding: {
            ...(agent.providerBinding ?? {}),
            connectionId: organization.connectionId,
            tenantId: app.tenantId,
            appId: app.appId,
            mode: app.mode,
            appSecretRef: secretReference(secretNamespace(organization.orgId), appSecretKey(app.appId)),
            datasetIds: [],
          },
        })
        const resolved = this.options.catalog.resolveExternalIdentity({
          orgId: agent.orgId,
          resourceType: 'agent',
          providerType: 'dify',
          providerId: organization.connectionId,
          externalId: app.appId,
        })
        if (!resolved) this.options.catalog.bindExternalIdentity({
          id: stableId('p4-dify-app-alias', app.id),
          orgId: agent.orgId,
          resourceType: 'agent',
          resourceId: agent.id,
          providerType: 'dify',
          providerId: organization.connectionId,
          externalId: app.appId,
          createdAt: app.createdAt,
        })
      }

      for (const [key, bindings] of datasetsByAgent) {
        const [enterpriseIdText, assistantId] = splitKey(key)
        const organization = organizationByLegacyId.get(Number(enterpriseIdText))!
        const agent = this.requireAgent(assistantId, organization.orgId)
        const datasetIds = [...new Set(bindings.map(item => item.datasetId))]
        this.options.catalog.updateAgentConfiguration(agent.id, agent.orgId, {
          providerType: 'dify',
          supportedModes: 'both',
          providerBinding: {
            ...(agent.providerBinding ?? {}),
            connectionId: organization.connectionId,
            tenantId: bindings[0]!.tenantId,
            mode: 'rag-only',
            datasetIds,
          },
        })
        for (const binding of bindings) this.options.dify.putResource({
          id: stableId('p4-dify-dataset', `${organization.orgId}:${binding.datasetId}`),
          orgId: organization.orgId,
          connectionId: organization.connectionId,
          resourceType: 'dataset',
          externalId: binding.datasetId,
          metadata: {},
          createdAt: binding.createdAt,
          updatedAt: binding.createdAt,
        })
      }

      for (const metadata of source.metadata) {
        const organization = organizationByLegacyId.get(metadata.enterpriseId)!
        const agent = this.requireAgent(metadata.assistantId, organization.orgId)
        this.options.catalog.updateAgentConfiguration(agent.id, agent.orgId, {
          name: metadata.name,
          displayName: metadata.name,
          profession: metadata.profession,
          description: metadata.description,
          defaultInitPrompt: metadata.defaultInitPrompt,
          promptsI18n: metadata.promptsI18n,
          categories: metadata.categories,
          skills: metadata.skills,
          promptFile: metadata.promptFile,
          avatar: metadata.avatar,
          version: metadata.version,
        })
      }

      for (const [key, entries] of groupBy(source.acl, item => `${item.enterpriseId}:${item.assistantId}`)) {
        const [enterpriseIdText, assistantId] = splitKey(key)
        const organization = organizationByLegacyId.get(Number(enterpriseIdText))!
        const agent = this.requireAgent(assistantId, organization.orgId)
        this.options.catalog.updateAgentConfiguration(agent.id, agent.orgId, {
          visibleTo: this.visibleTo(entries, organization.orgId),
        })
      }

      this.options.dify.putMigrationCheckpoint({
        migrationRunId: context.migrationRunId!,
        sourceChecksum: source.checksum,
        phase: 'p4-dify',
        status: 'completed',
        detail: { ...plan.counts, externalEffects: 'suppressed' },
      })
    })

    const report = {
      migrationRunId: context.migrationRunId,
      sourceChecksum: source.checksum,
      ...plan.counts,
      deliverableExternalOutboxCount: this.pendingOutboxCount() - pendingOutboxBefore,
    }
    const verification = await this.verify()
    if (verification.status !== 'matched') throw new Error(`P4 Dify 迁移校验失败: ${verification.issues.join('; ')}`)
    return report
  }

  async verify(): Promise<P4DifyVerification> {
    const source = this.options.source.readSnapshot()
    const plan = this.plan()
    const issues = plan.issues.map(item => item.message)
    if (plan.status === 'ready') {
      for (const connection of source.connections) {
        const organization = plan.organizations.find(item => item.enterpriseId === connection.enterpriseId)!
        const target = this.options.identities.getIntegrationConnection(organization.connectionId)
        if (!target || target.config.tenantId !== connection.tenantId
          || target.config.systemAccountId !== connection.systemAccountId
          || target.secretRef !== secretReference(secretNamespace(organization.orgId), 'service-api-key')) {
          issues.push(`企业 ${connection.enterpriseId} 的 Dify Connection 不一致`)
        }
        const serviceSecret = await this.options.secrets.getSecret(
          secretNamespace(organization.orgId), 'service-api-key', `org:${organization.orgId}`,
        ).catch(() => null)
        if (serviceSecret?.value !== connection.apiKey) {
          issues.push(`企业 ${connection.enterpriseId} 的 Dify Service API Key 不一致`)
        }
      }
      for (const app of source.apps) {
        const organization = plan.organizations.find(item => item.enterpriseId === app.enterpriseId)!
        const agent = this.requireAgent(app.assistantId, organization.orgId)
        if (agent.providerType !== 'dify'
          || agent.providerBinding?.connectionId !== organization.connectionId
          || agent.providerBinding?.tenantId !== app.tenantId
          || agent.providerBinding?.appId !== app.appId
          || agent.providerBinding?.mode !== app.mode
          || agent.providerBinding?.appSecretRef !== secretReference(
            secretNamespace(organization.orgId), appSecretKey(app.appId),
          )) {
          issues.push(`Agent ${app.assistantId} 的 Dify App binding 不一致`)
        }
        const alias = this.options.catalog.resolveExternalIdentity({
          orgId: organization.orgId,
          resourceType: 'agent',
          providerType: 'dify',
          providerId: organization.connectionId,
          externalId: app.appId,
        })
        if (alias !== app.assistantId) issues.push(`Agent ${app.assistantId} 的 Dify App 外部别名不一致`)
        const appSecret = await this.options.secrets.getSecret(
          secretNamespace(organization.orgId), appSecretKey(app.appId), `org:${organization.orgId}`,
        ).catch(() => null)
        if (appSecret?.value !== app.appApiKey) issues.push(`Agent ${app.assistantId} 的 Dify App API Key 不一致`)
      }
      const datasetsByAgent = groupBy(source.datasets, item => `${item.enterpriseId}:${item.assistantId}`)
      for (const dataset of source.datasets) {
        const organization = plan.organizations.find(item => item.enterpriseId === dataset.enterpriseId)!
        const resource = this.options.dify.getResourceByExternalId(
          organization.orgId, organization.connectionId, 'dataset', dataset.datasetId,
        )
        if (!resource) issues.push(`Dataset ${dataset.datasetId} 未迁移`)
      }
      for (const [key, bindings] of datasetsByAgent) {
        const [enterpriseIdText, assistantId] = splitKey(key)
        const organization = plan.organizations.find(item => item.enterpriseId === Number(enterpriseIdText))!
        const agent = this.requireAgent(assistantId, organization.orgId)
        const expectedDatasetIds = [...new Set(bindings.map(item => item.datasetId))].sort()
        const actualDatasetIds = Array.isArray(agent.providerBinding?.datasetIds)
          ? agent.providerBinding.datasetIds.filter((item): item is string => typeof item === 'string').sort()
          : []
        if (agent.providerType !== 'dify'
          || agent.providerBinding?.connectionId !== organization.connectionId
          || agent.providerBinding?.tenantId !== bindings[0]!.tenantId
          || agent.providerBinding?.mode !== 'rag-only'
          || !sameJson(actualDatasetIds, expectedDatasetIds)) {
          issues.push(`Agent ${assistantId} 的 Dataset binding 不一致`)
        }
      }
      for (const metadata of source.metadata) {
        const organization = plan.organizations.find(item => item.enterpriseId === metadata.enterpriseId)!
        const agent = this.requireAgent(metadata.assistantId, organization.orgId)
        const actual = {
          name: agent.name,
          displayName: agent.displayName,
          profession: agent.profession,
          description: agent.description,
          defaultInitPrompt: agent.defaultInitPrompt,
          promptsI18n: agent.promptsI18n,
          categories: agent.categories,
          skills: agent.skills,
          promptFile: agent.promptFile,
          avatar: agent.avatar,
          version: agent.version,
        }
        const expected = {
          name: metadata.name,
          displayName: metadata.name,
          profession: metadata.profession,
          description: metadata.description,
          defaultInitPrompt: metadata.defaultInitPrompt,
          promptsI18n: metadata.promptsI18n,
          categories: metadata.categories,
          skills: metadata.skills,
          promptFile: metadata.promptFile,
          avatar: metadata.avatar,
          version: metadata.version,
        }
        if (!sameJson(actual, expected)) issues.push(`Agent ${metadata.assistantId} 的元数据不一致`)
      }
      for (const [key, entries] of groupBy(source.acl, item => `${item.enterpriseId}:${item.assistantId}`)) {
        const [enterpriseIdText, assistantId] = splitKey(key)
        const organization = plan.organizations.find(item => item.enterpriseId === Number(enterpriseIdText))!
        const agent = this.requireAgent(assistantId, organization.orgId)
        if (!sameJson(agent.visibleTo, this.visibleTo(entries, organization.orgId))) {
          issues.push(`Agent ${assistantId} 的 ACL 不一致`)
        }
      }
    }
    return { status: issues.length === 0 ? 'matched' : 'mismatch', sourceChecksum: source.checksum, issues }
  }

  private requireAgent(assistantId: string, orgId: string): CatalogAgent {
    const agent = this.options.catalog.findAgent(assistantId)
    if (!agent || !this.options.catalog.isAvailableToOrganization('agent', assistantId, orgId)) {
      throw new Error(`Agent ${assistantId} 未映射`)
    }
    return agent
  }

  private resolveAclSubject(entry: SudoworkAssistantAclSource, orgId: string): string | null {
    if (entry.subjectId === null) return null
    if (entry.subjectType === 'role') return normalizeRole(entry.subjectId)
    if (!/^\d+$/.test(entry.subjectId)) return null
    return this.options.identities.resolveNumericAlias(entry.subjectType, Number(entry.subjectId), orgId)
  }

  private visibleTo(entries: SudoworkAssistantAclSource[], orgId: string): VisibleTo {
    if (entries.length === 0 || entries.some(item => item.subjectType === 'all')) return null
    const values = (type: SudoworkAssistantAclSource['subjectType']) => {
      const mapped = entries.filter(item => item.subjectType === type)
        .flatMap(item => this.resolveAclSubject(item, orgId) ?? [])
      return mapped.length > 0 ? [...new Set(mapped)] : null
    }
    return { user_ids: values('user'), department_ids: values('department'), role_ids: values('role') }
  }

  private pendingOutboxCount(): number {
    const exists = this.options.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbox_events'").get()
    if (!exists) return 0
    return Number((this.options.db.prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE status='pending'").get() as { count: number }).count)
  }
}

function connectionId(orgId: string): string {
  return `dify:${orgId}`
}

function secretNamespace(orgId: string): string {
  return `org:${orgId}:dify`
}

function appSecretKey(appId: string): string {
  return `apps/${appId}-api-key`
}

function secretReference(namespace: string, key: string): string {
  return `nexus://${namespace}/${key}`
}

function stableId(prefix: string, value: string | number): string {
  return `${prefix}:${createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const output = new Map<string, T[]>()
  for (const item of items) output.set(key(item), [...(output.get(key(item)) ?? []), item])
  return output
}

function splitKey(value: string): [string, string] {
  const separator = value.indexOf(':')
  return [value.slice(0, separator), value.slice(separator + 1)]
}

function normalizeRole(value: string): string {
  return value.trim().toLowerCase()
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function issue(
  issues: P4DifyMigrationIssue[],
  code: P4DifyMigrationIssueCode,
  source: string,
  message: string,
): void {
  if (!issues.some(item => item.code === code && item.source === source && item.message === message)) {
    issues.push({ code, source, message })
  }
}
