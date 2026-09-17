import type { CatalogAgent, CatalogRepository, CatalogSkill } from '../../../catalog/catalogRepository.js'
import type { CatalogService } from '../../../catalog/catalogService.js'
import type { CatalogUploadService } from '../../../catalog/catalogUploadService.js'
import type { IdentityRepository } from '../../../identity/identityRepository.js'
import type { IdentityActor } from '../../../identity/organizationIdentityService.js'
import type { VisibilityFilter } from '../../../visibilityFilter.js'
import { isVisibleTo } from '../../../visibilityFilter.js'

export class SudoworkCatalogError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
    this.name = 'SudoworkCatalogError'
  }
}

export interface LegacyAgentDto extends Record<string, unknown> {
  id: string
  assistant_id: string
  name: string
  display_name: string
  profession: string
  tenantId: string
  tenantIds: string[]
  status: number
  latestVersion: { version: string; source_url: string | null; checksum: string | null } | null
}

export interface LegacySkillDto extends Record<string, unknown> {
  id: string
  name: string
  display_name: string
  tenant_id: string
  status: number
  latestVersion: { version: string; source_url: string | null; checksum: string | null } | null
}

export class SudoworkCatalogService {
  constructor(private readonly options: {
    repository: CatalogRepository
    catalog: CatalogService
    identities: IdentityRepository
    buildVisibility: (actor: IdentityActor) => VisibilityFilter
    uploads?: CatalogUploadService
  }) {}

  listAgents(input: {
    actor: IdentityActor
    tenantCode?: string
    cursor?: string
    limit?: number
    query?: string
    category?: string
  }) {
    const target = this.resolveOrganization(input.actor, input.tenantCode)
    const page = this.options.repository.listAgents({
      orgId: target.orgId,
      cursor: input.cursor,
      limit: input.limit,
      query: input.query,
      category: input.category,
      ...this.listAccess(input.actor),
    })
    return {
      success: true as const,
      message: 'success',
      data: {
        assistants: page.items.map((agent) => legacyAgent(agent, target.code)),
        next_cursor: page.nextCursor,
        has_more: page.hasMore,
      },
    }
  }

  listSkills(input: {
    actor: IdentityActor
    tenantCode?: string
    cursor?: string
    limit?: number
    query?: string
    category?: string
  }) {
    const target = this.resolveOrganization(input.actor, input.tenantCode)
    const page = this.options.repository.listSkills({
      orgId: target.orgId,
      cursor: input.cursor,
      limit: input.limit,
      query: input.query,
      category: input.category,
      ...this.listAccess(input.actor),
    })
    return {
      success: true as const,
      message: 'success',
      data: {
        skills: page.items.map((skill) => legacySkill(skill, target.code)),
        next_cursor: page.nextCursor,
        has_more: page.hasMore,
      },
    }
  }

  listVisibleAgents(actor: IdentityActor) {
    const profile = this.options.identities.getOrganizationProfile(actor.orgId)
    if (!profile?.localEnabled) return { success: true as const, data: [] as LegacyAgentDto[] }
    const page = this.options.catalog.listVisibleAgents({
      actor,
      mode: 'local',
      visibility: this.options.buildVisibility(actor),
      limit: 100,
    })
    return {
      success: true as const,
      data: page.items.map((agent) => legacyAgent(agent, profile.code)),
    }
  }

  listVisibleBindings(actor: IdentityActor) {
    const profile = this.options.identities.getOrganizationProfile(actor.orgId)
    if (!profile?.localEnabled) return { success: true as const, data: [] }
    const page = this.options.catalog.listVisibleAgents({
      actor,
      mode: 'local',
      visibility: this.options.buildVisibility(actor),
      limit: 100,
    })
    return {
      success: true as const,
      data: page.items.flatMap((agent) => {
        if (agent.providerType !== 'dify' || !agent.providerBinding) return []
        return [{
          assistant_id: agent.id,
          runtime: 'dify' as const,
          dify_app_id: stringValue(agent.providerBinding.appId),
          dify_app_mode: stringValue(agent.providerBinding.mode, 'agent-chat'),
          dify_tenant_id: stringValue(agent.providerBinding.tenantId),
          created_at: agent.createdAt,
          updated_at: agent.updatedAt,
        }]
      }),
    }
  }

  getAgentDetail(actor: IdentityActor, agentId: string) {
    const agent = this.requireAgent(agentId)
    this.assertCanRead(actor, agent)
    const profile = this.options.identities.getOrganizationProfile(actor.orgId)
    if (!profile?.localEnabled) throw new SudoworkCatalogError(404, '智能体不存在')
    return {
      success: true as const,
      data: {
        assistant: legacyAgent(agent, profile.code),
        versions: catalogVersions(agent),
      },
    }
  }

  getSkillDetail(actor: IdentityActor, skillId: string) {
    const skill = this.requireSkill(skillId)
    this.assertCanRead(actor, skill)
    const profile = this.options.identities.getOrganizationProfile(actor.orgId)
    if (!profile?.localEnabled) throw new SudoworkCatalogError(404, '技能不存在')
    return {
      success: true as const,
      data: {
        skill: legacySkill(skill, profile.code),
        versions: catalogVersions(skill),
      },
    }
  }

  listCategories(actor: IdentityActor, type: 'agent' | 'skill') {
    const visibility = this.options.buildVisibility(actor)
    const profile = this.options.identities.getOrganizationProfile(actor.orgId)
    if (!profile?.localEnabled) return { success: true as const, data: [] as string[] }
    const categories = this.options.repository.listCategories({
      type, orgId: actor.orgId, mode: 'local', status: 'approved', visibility,
    })
    return { success: true as const, data: categories.sort((left, right) => left.localeCompare(right, 'zh-CN')) }
  }

  async uploadAgent(input: {
    actor: IdentityActor
    tenantCode: string
    name: string
    profession: string
    description?: string | null
    defaultInitPrompt?: string | null
    categories?: string[]
    skills?: string[]
    version?: string
    bytes: Buffer
    idempotencyKey: string
  }) {
    this.resolveOrganization(input.actor, input.tenantCode)
    if (!this.options.uploads) throw new SudoworkCatalogError(500, '制品存储未配置')
    const agent = await this.options.uploads.uploadAgent(input)
    const profile = this.options.identities.getOrganizationProfile(agent.orgId)
    return {
      success: true as const,
      message: 'success',
      data: { assistant: legacyAgent(agent, profile?.code ?? input.tenantCode) },
    }
  }

  async uploadSkill(input: {
    actor: IdentityActor
    tenantCode: string
    name: string
    displayName: string
    description?: string | null
    category?: string | null
    categories?: string[]
    emoji?: string | null
    icon?: string | null
    homepage?: string | null
    applicableScenarios?: string | null
    coreFeatures?: string | null
    version?: string
    bytes: Buffer
    idempotencyKey: string
  }) {
    this.resolveOrganization(input.actor, input.tenantCode)
    if (!this.options.uploads) throw new SudoworkCatalogError(500, '制品存储未配置')
    const skill = await this.options.uploads.uploadSkill(input)
    const profile = this.options.identities.getOrganizationProfile(skill.orgId)
    return {
      success: true as const,
      message: 'success',
      data: { skill: legacySkill(skill, profile?.code ?? input.tenantCode) },
    }
  }

  async getArtifact(kind: 'agent' | 'skill', resourceId: string): Promise<{
    bytes: Buffer
    filename: string
  }> {
    if (!this.options.uploads) throw new SudoworkCatalogError(404, '制品不存在')
    const resource = kind === 'agent' ? this.requireAgent(resourceId) : this.requireSkill(resourceId)
    if (!resource.enabled || resource.status !== 'approved' || !resource.filePath || !resource.checksum) {
      throw new SudoworkCatalogError(404, '制品不存在')
    }
    return {
      bytes: await this.options.uploads.readArtifact(resource.filePath, resource.checksum),
      filename: `${resource.name}-${resource.version ?? '1.0.0'}.zip`,
    }
  }

  reviewAgent(actor: IdentityActor, agentId: string): void {
    const resource = this.requireAgent(agentId)
    try {
      this.options.catalog.reviewAgent({ actor, orgId: resource.orgId, agentId, approved: true })
    } catch (error) {
      throw mapDomainError(error)
    }
  }

  reviewSkill(actor: IdentityActor, skillId: string): void {
    const resource = this.requireSkill(skillId)
    try {
      this.options.catalog.reviewSkill({ actor, orgId: resource.orgId, skillId, approved: true })
    } catch (error) {
      throw mapDomainError(error)
    }
  }

  deleteAgent(actor: IdentityActor, agentId: string): void {
    const resource = this.requireAgent(agentId)
    try {
      this.options.catalog.deleteAgent(actor, agentId, resource.orgId)
    } catch (error) {
      throw mapDomainError(error)
    }
  }

  deleteSkill(actor: IdentityActor, skillId: string): void {
    const resource = this.requireSkill(skillId)
    try {
      this.options.catalog.deleteSkill(actor, skillId, resource.orgId)
    } catch (error) {
      throw mapDomainError(error)
    }
  }

  private resolveOrganization(actor: IdentityActor, tenantCode?: string): { orgId: string; code: string } {
    const profile = tenantCode
      ? this.options.identities.getOrganizationProfileByCode(tenantCode)
      : this.options.identities.getOrganizationProfile(actor.orgId)
    if (!profile) throw new SudoworkCatalogError(404, '租户不存在')
    if (actor.role !== 'super_admin' && actor.orgId !== profile.orgId) {
      throw new SudoworkCatalogError(403, '权限不足')
    }
    return { orgId: profile.orgId, code: profile.code }
  }

  private listAccess(actor: IdentityActor) {
    if (actor.role === 'admin' || actor.role === 'super_admin') return { includeDisabled: true as const }
    return {
      mode: 'local' as const,
      status: 'approved',
      visibility: this.options.buildVisibility(actor),
    }
  }

  private requireAgent(id: string): CatalogAgent {
    const resource = this.options.repository.findAgent(id)
    if (!resource) throw new SudoworkCatalogError(404, '智能体不存在')
    return resource
  }

  private requireSkill(id: string): CatalogSkill {
    const resource = this.options.repository.findSkill(id)
    if (!resource) throw new SudoworkCatalogError(404, '技能不存在')
    return resource
  }

  private assertCanRead(actor: IdentityActor, resource: CatalogAgent | CatalogSkill): void {
    if (actor.role === 'super_admin') return
    const type = 'providerType' in resource ? 'agent' : 'skill'
    if (!this.options.repository.isAvailableToOrganization(type, resource.id, actor.orgId)) {
      throw new SudoworkCatalogError(404, '资源不存在')
    }
    if (actor.role === 'admin' || resource.authorId === actor.userId) return
    const visible = resource.enabled && resource.status === 'approved'
      && isVisibleTo(resource.visibleTo, this.options.buildVisibility(actor))
    if (!visible) throw new SudoworkCatalogError(404, '资源不存在')
  }
}

function catalogVersions(resource: CatalogAgent | CatalogSkill): Array<Record<string, unknown>> {
  if (!resource.version) return []
  return [{
    version: resource.version,
    source_url: resource.sourceUrl,
    checksum: resource.checksum,
    created_at: new Date(resource.createdAt).toISOString(),
  }]
}

function legacyAgent(agent: CatalogAgent, tenantCode: string): LegacyAgentDto {
  const latestVersion = agent.version ? {
    version: agent.version,
    source_url: agent.sourceUrl,
    checksum: agent.checksum,
  } : null
  const enhancement = agent.providerType === 'dify' && agent.providerBinding ? {
    enabled: true,
    mode: stringValue(agent.providerBinding.mode, 'agent-chat'),
    dify_app_id: stringValue(agent.providerBinding.appId),
    dify_tenant_id: stringValue(agent.providerBinding.tenantId),
  } : { enabled: false }
  return {
    id: agent.id,
    assistant_id: agent.id,
    name: agent.name,
    display_name: agent.displayName ?? agent.profession ?? agent.name,
    profession: agent.profession ?? agent.displayName ?? agent.name,
    description: agent.description ?? '',
    tenantId: tenantCode,
    tenantIds: [tenantCode],
    tenant_id: tenantCode,
    tenant_ids: [tenantCode],
    promptsI18n: agent.promptsI18n,
    prompts_i18n: agent.promptsI18n,
    avatar: agent.avatar,
    categories: agent.categories,
    skills: agent.skills,
    defaultInitPrompt: agent.defaultInitPrompt,
    default_init_prompt: agent.defaultInitPrompt,
    promptFile: agent.promptFile,
    prompt_file: agent.promptFile,
    sourceUrl: agent.sourceUrl,
    source_url: agent.sourceUrl,
    version: agent.version,
    latestVersion,
    latest_version: latestVersion,
    sortOrder: agent.sortOrder,
    sort_order: agent.sortOrder,
    status: legacyStatus(agent.status),
    createdAt: new Date(agent.createdAt).toISOString(),
    created_at: new Date(agent.createdAt).toISOString(),
    updatedAt: new Date(agent.updatedAt).toISOString(),
    updated_at: new Date(agent.updatedAt).toISOString(),
    visible_to: agent.visibleTo,
    enhancement,
  }
}

function legacySkill(skill: CatalogSkill, tenantCode: string): LegacySkillDto {
  const latestVersion = skill.version ? {
    version: skill.version,
    source_url: skill.sourceUrl,
    checksum: skill.checksum,
  } : null
  return {
    id: skill.id,
    name: skill.name,
    display_name: skill.displayName ?? skill.name,
    description: skill.description ?? '',
    category: skill.category,
    categories: skill.categories,
    emoji: skill.emoji,
    icon: skill.icon,
    homepage: skill.homepage,
    applicable_scenarios: skill.applicableScenarios,
    core_features: skill.coreFeatures,
    sort_order: skill.sortOrder,
    author_id: skill.authorId,
    tenantId: tenantCode,
    tenantIds: [tenantCode],
    tenant_id: tenantCode,
    tenant_ids: [tenantCode],
    status: legacyStatus(skill.status),
    source_url: skill.sourceUrl,
    checksum: skill.checksum,
    version: skill.version ?? '',
    latestVersion,
    created_at: new Date(skill.createdAt).toISOString(),
    updated_at: new Date(skill.updatedAt).toISOString(),
    visible_to: skill.visibleTo,
  }
}

function legacyStatus(status: string): number {
  return status === 'approved' ? 1 : status === 'rejected' ? 2 : 0
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function mapDomainError(error: unknown): SudoworkCatalogError {
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === 'FORBIDDEN') return new SudoworkCatalogError(403, '权限不足')
    if (error.code === 'AGENT_NOT_FOUND') return new SudoworkCatalogError(404, '智能体不存在')
    if (error.code === 'SKILL_NOT_FOUND') return new SudoworkCatalogError(404, '技能不存在')
  }
  throw error
}
