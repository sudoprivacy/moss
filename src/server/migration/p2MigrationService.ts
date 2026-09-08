import { inspectCatalogArtifact } from '../catalog/catalogArtifactStore.js'
import type {
  CatalogAgent,
  CatalogRepository,
  CatalogResourceType,
  CatalogSkill,
} from '../catalog/catalogRepository.js'
import type { IdentityRepository } from '../identity/identityRepository.js'
import type { IdentityActor } from '../identity/organizationIdentityService.js'
import type { VisibleTo } from '../visibilityFilter.js'
import type { P2CatalogImportService } from './p2CatalogImport.js'
import type { SudoworkHubManifest, SudoworkHubResource } from './sudoworkP2SourceReader.js'

interface P2CatalogSource {
  readHubManifest(): Promise<SudoworkHubManifest>
  readArtifact(path: string): Promise<Buffer>
}

interface MigrationIssue {
  kind: CatalogResourceType
  sourceId: string
  reason: string
}

interface PlannedResource {
  kind: CatalogResourceType
  action: 'import' | 'reuse'
  source: SudoworkHubResource
  bytes: Buffer
  orgId: string
  assignedOrgIds: string[]
  availability: 'organization' | 'all' | 'assigned'
  authorId: string
}

export interface P2MigrationPlan {
  status: 'ready' | 'blocked'
  source: SudoworkHubManifest['source']
  counts: { agents: number; skills: number; imports: number; reuses: number }
  conflicts: MigrationIssue[]
  orphans: MigrationIssue[]
  resources: PlannedResource[]
}

export interface P2MigrationExecution {
  migrationRunId: string
  imported: number
  reused: number
  agents: number
  skills: number
}

export class P2MigrationBlockedError extends Error {
  constructor(readonly report: P2MigrationPlan) {
    super(`P2 迁移预检失败: ${report.conflicts.length} 个冲突, ${report.orphans.length} 个孤儿`)
    this.name = 'P2MigrationBlockedError'
  }
}

export class P2MigrationService {
  constructor(private readonly options: {
    identities: IdentityRepository
    repository: CatalogRepository
    importer: P2CatalogImportService
    source: P2CatalogSource
    platformCatalogOrgId: string
  }) {}

  async plan(): Promise<P2MigrationPlan> {
    const manifest = await this.options.source.readHubManifest()
    const conflicts: MigrationIssue[] = []
    const orphans: MigrationIssue[] = []
    const resources: PlannedResource[] = []

    for (const [kind, rows] of [
      ['agent', manifest.agents],
      ['skill', manifest.skills],
    ] as const) {
      for (const source of rows) {
        const tenantOrgIds: string[] = []
        for (const tenantCode of new Set(source.tenantIds)) {
          const profile = this.options.identities.getOrganizationProfileByCode(tenantCode)
          if (!profile) {
            orphans.push({ kind, sourceId: source.id, reason: `企业码 ${tenantCode} 未映射到 Moss Organization` })
          } else {
            tenantOrgIds.push(profile.orgId)
          }
        }
        if (source.tenantIds.length > 0 && tenantOrgIds.length !== new Set(source.tenantIds).size) continue

        const orgId = tenantOrgIds[0] ?? this.options.platformCatalogOrgId
        const authorId = resolveAuthor(this.options.identities, source.authorId, orgId)
        if (!authorId) {
          orphans.push({ kind, sourceId: source.id, reason: `作者 ${source.authorId} 未映射到 Moss User` })
          continue
        }

        let bytes: Buffer
        try {
          bytes = await this.options.source.readArtifact(source.artifactPath)
          const inspected = await inspectCatalogArtifact(kind, bytes)
          if (source.checksum && normalizeChecksum(source.checksum) !== inspected.checksum) {
            conflicts.push({ kind, sourceId: source.id, reason: `制品 checksum 不一致: ${source.artifactPath}` })
            continue
          }
        } catch (error) {
          conflicts.push({ kind, sourceId: source.id, reason: `制品校验失败: ${errorMessage(error)}` })
          continue
        }

        const providerId = manifest.source.hubProviderId
        const resolvedId = this.options.repository.resolveExternalIdentity({
          orgId,
          resourceType: kind,
          providerType: 'sudohub',
          providerId,
          externalId: source.id,
        })
        if (resolvedId) {
          const existing = this.find(kind, resolvedId)
          if (!existing || existing.name !== source.name
            || (source.checksum && existing.checksum !== normalizeChecksum(source.checksum))) {
            conflicts.push({ kind, sourceId: source.id, reason: '已有 Provider 映射与源资源内容不一致' })
            continue
          }
          resources.push({
            kind, action: 'reuse', source, bytes, orgId,
            availability: availability(tenantOrgIds),
            assignedOrgIds: tenantOrgIds.slice(1), authorId,
          })
          continue
        }

        const idCollision = this.find(kind, source.id)
        if (idCollision) {
          conflicts.push({ kind, sourceId: source.id, reason: `目标主键 ${source.id} 已存在且无对应 Provider 映射` })
          continue
        }
        const nameCollision = kind === 'agent'
          ? this.options.repository.findAgentByName(source.name, orgId)
          : this.options.repository.findSkillByName(source.name, orgId)
        if (nameCollision) {
          conflicts.push({ kind, sourceId: source.id, reason: `名称 ${source.name} 已被目标资源 ${nameCollision.id} 使用` })
          continue
        }
        resources.push({
          kind, action: 'import', source, bytes, orgId,
          availability: availability(tenantOrgIds),
          assignedOrgIds: tenantOrgIds.slice(1), authorId,
        })
      }
    }

    const imports = resources.filter(resource => resource.action === 'import').length
    const reuses = resources.filter(resource => resource.action === 'reuse').length
    return {
      status: conflicts.length || orphans.length ? 'blocked' : 'ready',
      source: manifest.source,
      counts: { agents: manifest.agents.length, skills: manifest.skills.length, imports, reuses },
      conflicts,
      orphans,
      resources,
    }
  }

  async execute(migrationRunId: string): Promise<P2MigrationExecution> {
    const plan = await this.plan()
    if (plan.status === 'blocked') throw new P2MigrationBlockedError(plan)
    const actor: IdentityActor = {
      userId: 'migration-system', orgId: this.options.platformCatalogOrgId, role: 'super_admin',
    }
    let imported = 0
    let reused = 0
    for (const item of plan.resources) {
      if (item.action === 'reuse') {
        reused += 1
        continue
      }
      const common = {
        id: item.source.id,
        name: item.source.name,
        displayName: item.source.displayName,
        authorId: item.authorId,
        authorName: text(item.source.metadata.author_name),
        status: status(item.source.status),
        enabled: item.source.metadata.enabled !== false,
        version: item.source.version,
        checksum: item.source.checksum,
        supportedModes: 'local' as const,
        availability: item.availability,
        assignedOrgIds: item.assignedOrgIds,
        createdAt: dateNumber(item.source.metadata.created_at),
        updatedAt: dateNumber(item.source.metadata.updated_at),
        visibleTo: object(item.source.metadata.visible_to) as VisibleTo,
        externalIdentity: {
          providerType: 'sudohub', providerId: plan.source.hubProviderId, externalId: item.source.id,
        },
      }
      if (item.kind === 'agent') {
        await this.options.importer.importAgent({
          migrationRunId, actor, orgId: item.orgId, bytes: item.bytes,
          resource: {
            ...common,
            profession: text(item.source.metadata.profession),
            description: text(item.source.metadata.description),
            defaultInitPrompt: text(item.source.metadata.default_init_prompt ?? item.source.metadata.defaultInitPrompt),
            promptsI18n: stringArrayRecord(item.source.metadata.prompts_i18n ?? item.source.metadata.promptsI18n),
            categories: stringArray(item.source.metadata.categories),
            avatar: text(item.source.metadata.avatar),
            skills: stringArray(item.source.metadata.skills),
            promptFile: text(item.source.metadata.prompt_file ?? item.source.metadata.promptFile),
            sortOrder: finiteNumber(item.source.metadata.sort_order ?? item.source.metadata.sortOrder),
            enabledSkills: stringArray(item.source.metadata.enabled_skills ?? item.source.metadata.enabledSkills),
            providerType: 'local',
          },
        })
      } else {
        await this.options.importer.importSkill({
          migrationRunId, actor, orgId: item.orgId, bytes: item.bytes,
          resource: {
            ...common,
            description: text(item.source.metadata.description),
            category: text(item.source.metadata.category),
            categories: stringArray(item.source.metadata.categories),
            emoji: text(item.source.metadata.emoji),
            icon: text(item.source.metadata.icon),
            homepage: text(item.source.metadata.homepage),
            applicableScenarios: text(item.source.metadata.applicable_scenarios),
            coreFeatures: text(item.source.metadata.core_features),
            sortOrder: finiteNumber(item.source.metadata.sort_order ?? item.source.metadata.sortOrder),
          },
        })
      }
      imported += 1
    }
    return {
      migrationRunId,
      imported,
      reused,
      agents: plan.counts.agents,
      skills: plan.counts.skills,
    }
  }

  private find(kind: CatalogResourceType, id: string): CatalogAgent | CatalogSkill | null {
    return kind === 'agent' ? this.options.repository.findAgent(id) : this.options.repository.findSkill(id)
  }
}

function resolveAuthor(identities: IdentityRepository, sourceId: string, orgId: string): string | null {
  if (/^\d+$/.test(sourceId)) return identities.resolveNumericAlias('user', Number(sourceId), orgId)
  const identity = identities.findAuthIdentity('sudohub', 'legacy', sourceId)
  return identity?.orgId === orgId ? identity.userId : null
}

function availability(orgIds: string[]): 'organization' | 'all' | 'assigned' {
  if (orgIds.length === 0) return 'all'
  return orgIds.length === 1 ? 'organization' : 'assigned'
}

function status(value: string | number): string {
  if (value === 1 || value === '1' || value === 'approved') return 'approved'
  if (value === 2 || value === '2' || value === 'rejected') return 'rejected'
  return 'pending'
}

function normalizeChecksum(value: string): string {
  return value.trim().toLowerCase().replace(/^sha256:/, '')
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stringArrayRecord(value: unknown): Record<string, string[]> | null {
  const source = object(value)
  const entries = Object.entries(source).filter((entry): entry is [string, string[]] =>
    Array.isArray(entry[1]) && entry[1].every(item => typeof item === 'string'))
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function dateNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
