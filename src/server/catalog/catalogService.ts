import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { assertTrustedCommandContext, type CommandContext } from '../application/commandContext.js'
import type { IdentityActor } from '../identity/organizationIdentityService.js'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'
import type { VisibilityFilter, VisibleTo } from '../visibilityFilter.js'
import {
  CatalogRepository,
  type CatalogProviderType,
  type CatalogSupportedModes,
} from './catalogRepository.js'

export class CatalogDomainError extends Error {
  constructor(readonly code: 'FORBIDDEN' | 'AGENT_NOT_FOUND' | 'SKILL_NOT_FOUND' | 'INVALID_IMPORT_CONTEXT', message: string) {
    super(message)
    this.name = 'CatalogDomainError'
  }
}

export class CatalogService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly repository: CatalogRepository,
  ) {}

  createAgent(input: {
    actor: IdentityActor
    orgId?: string
    id?: string
    name: string
    displayName?: string | null
    profession?: string | null
    description?: string | null
    defaultInitPrompt?: string | null
    promptsI18n?: Record<string, string[]> | null
    categories?: string[]
    avatar?: string | null
    skills?: string[]
    promptFile?: string | null
    sortOrder?: number
    version?: string | null
    sourceUrl?: string | null
    checksum?: string | null
    filePath?: string | null
    providerType: CatalogProviderType
    providerBinding?: Record<string, unknown> | null
    supportedModes: CatalogSupportedModes
    availability?: 'organization' | 'all' | 'assigned'
    externalIdentity?: { providerType: string; providerId: string; externalId: string }
  }, context: CommandContext) {
    assertTrustedCommandContext(context)
    const previous = this.repository.getCommandResult<{ resourceId: string }>(
      'catalog.create_agent', context.idempotencyKey,
    )
    const orgId = input.orgId ?? input.actor.orgId
    this.assertCanCreate(input.actor, orgId)
    if (previous) {
      const existing = this.repository.getAgent(previous.resourceId, orgId)
      if (existing) return existing
    }
    const id = input.id ?? randomUUID()
    return runInTransaction(this.db, () => {
      const repeated = this.repository.getCommandResult<{ resourceId: string }>(
        'catalog.create_agent', context.idempotencyKey,
      )
      if (repeated) {
        const existing = this.repository.getAgent(repeated.resourceId, orgId)
        if (existing) return existing
      }
      const agent = this.repository.createAgent({
        id,
        orgId,
        name: input.name,
        displayName: input.displayName,
        profession: input.profession,
        description: input.description,
        defaultInitPrompt: input.defaultInitPrompt,
        promptsI18n: input.promptsI18n,
        categories: input.categories,
        avatar: input.avatar,
        skills: input.skills,
        promptFile: input.promptFile,
        sortOrder: input.sortOrder,
        version: input.version,
        sourceUrl: input.sourceUrl,
        checksum: input.checksum,
        filePath: input.filePath,
        authorId: input.actor.userId,
        status: input.actor.role === 'user' ? 'pending' : 'approved',
        providerType: input.providerType,
        providerBinding: input.providerBinding,
        supportedModes: input.supportedModes,
        availability: input.availability,
        sourceProvider: input.externalIdentity?.providerType ?? 'moss',
        sourceResourceId: input.externalIdentity?.externalId ?? id,
      })
      if (input.externalIdentity) {
        this.repository.bindExternalIdentity({
          id: randomUUID(),
          orgId,
          resourceType: 'agent',
          resourceId: id,
          ...input.externalIdentity,
        })
      }
      this.repository.recordCommandResult(
        'catalog.create_agent', context.idempotencyKey, context.source, { resourceId: agent.id },
      )
      return agent
    })
  }

  createSkill(input: {
    actor: IdentityActor
    orgId?: string
    id?: string
    name: string
    displayName?: string | null
    description?: string | null
    category?: string | null
    categories?: string[]
    emoji?: string | null
    icon?: string | null
    homepage?: string | null
    applicableScenarios?: string | null
    coreFeatures?: string | null
    sortOrder?: number
    version?: string | null
    checksum?: string | null
    filePath?: string | null
    sourceUrl?: string | null
    supportedModes: CatalogSupportedModes
    availability?: 'organization' | 'all' | 'assigned'
    externalIdentity?: { providerType: string; providerId: string; externalId: string }
  }, context: CommandContext) {
    assertTrustedCommandContext(context)
    const previous = this.repository.getCommandResult<{ resourceId: string }>(
      'catalog.create_skill', context.idempotencyKey,
    )
    const orgId = input.orgId ?? input.actor.orgId
    this.assertCanCreate(input.actor, orgId)
    if (previous) {
      const existing = this.repository.getSkill(previous.resourceId, orgId)
      if (existing) return existing
    }
    const id = input.id ?? randomUUID()
    return runInTransaction(this.db, () => {
      const repeated = this.repository.getCommandResult<{ resourceId: string }>(
        'catalog.create_skill', context.idempotencyKey,
      )
      if (repeated) {
        const existing = this.repository.getSkill(repeated.resourceId, orgId)
        if (existing) return existing
      }
      const skill = this.repository.createSkill({
        id,
        orgId,
        name: input.name,
        displayName: input.displayName,
        description: input.description,
        category: input.category,
        categories: input.categories,
        emoji: input.emoji,
        icon: input.icon,
        homepage: input.homepage,
        applicableScenarios: input.applicableScenarios,
        coreFeatures: input.coreFeatures,
        sortOrder: input.sortOrder,
        version: input.version,
        checksum: input.checksum,
        filePath: input.filePath,
        sourceUrl: input.sourceUrl,
        authorId: input.actor.userId,
        status: input.actor.role === 'user' ? 'pending' : 'approved',
        supportedModes: input.supportedModes,
        availability: input.availability,
        sourceProvider: input.externalIdentity?.providerType ?? 'moss',
        sourceResourceId: input.externalIdentity?.externalId ?? id,
      })
      if (input.externalIdentity) {
        this.repository.bindExternalIdentity({
          id: randomUUID(), orgId, resourceType: 'skill', resourceId: id, ...input.externalIdentity,
        })
      }
      this.repository.recordCommandResult(
        'catalog.create_skill', context.idempotencyKey, context.source, { resourceId: skill.id },
      )
      return skill
    })
  }

  importAgent(input: {
    actor: IdentityActor
    orgId: string
    id: string
    name: string
    authorId: string
    displayName?: string | null
    profession?: string | null
    description?: string | null
    defaultInitPrompt?: string | null
    promptsI18n?: Record<string, string[]> | null
    categories?: string[]
    avatar?: string | null
    skills?: string[]
    promptFile?: string | null
    sortOrder?: number
    version?: string | null
    status: string
    sourceUrl?: string | null
    checksum?: string | null
    filePath?: string | null
    enabledSkills?: string[]
    enabled?: boolean
    visibleTo?: VisibleTo
    providerType: CatalogProviderType
    providerBinding?: Record<string, unknown> | null
    supportedModes: CatalogSupportedModes
    availability?: 'organization' | 'all' | 'assigned'
    assignedOrgIds?: string[]
    authorName?: string | null
    createdAt?: number
    updatedAt?: number
    externalIdentity?: { providerType: string; providerId: string; externalId: string }
  }, context: CommandContext) {
    this.assertImportContext(context)
    this.assertCanCreate(input.actor, input.orgId)
    return this.importResource('agent', input, context)
  }

  importSkill(input: {
    actor: IdentityActor
    orgId: string
    id: string
    name: string
    authorId: string
    displayName?: string | null
    description?: string | null
    category?: string | null
    categories?: string[]
    emoji?: string | null
    icon?: string | null
    homepage?: string | null
    applicableScenarios?: string | null
    coreFeatures?: string | null
    sortOrder?: number
    version?: string | null
    status: string
    sourceUrl?: string | null
    checksum?: string | null
    filePath?: string | null
    enabled?: boolean
    visibleTo?: VisibleTo
    supportedModes: CatalogSupportedModes
    availability?: 'organization' | 'all' | 'assigned'
    assignedOrgIds?: string[]
    authorName?: string | null
    createdAt?: number
    updatedAt?: number
    externalIdentity?: { providerType: string; providerId: string; externalId: string }
  }, context: CommandContext) {
    this.assertImportContext(context)
    this.assertCanCreate(input.actor, input.orgId)
    return this.importResource('skill', input, context)
  }

  listVisibleAgents(input: {
    actor: IdentityActor
    mode: 'local' | 'cloud'
    visibility: VisibilityFilter
    cursor?: string
    limit?: number
    query?: string
  }) {
    return this.repository.listAgents({
      orgId: input.actor.orgId,
      mode: input.mode,
      status: 'approved',
      visibility: input.visibility,
      cursor: input.cursor,
      limit: input.limit,
      query: input.query,
    })
  }

  reviewSkill(input: {
    actor: IdentityActor
    orgId?: string
    skillId: string
    approved: boolean
    reviewNote?: string
  }): void {
    const orgId = input.orgId ?? input.actor.orgId
    this.assertCanManage(input.actor, orgId)
    runInTransaction(this.db, () => {
      if (!this.repository.reviewSkill(input.skillId, orgId, input.approved, input.actor.userId, input.reviewNote)) {
        throw new CatalogDomainError('SKILL_NOT_FOUND', 'Skill 不存在')
      }
    })
  }

  reviewAgent(input: {
    actor: IdentityActor
    orgId?: string
    agentId: string
    approved: boolean
    reviewNote?: string
  }): void {
    const orgId = input.orgId ?? input.actor.orgId
    this.assertCanManage(input.actor, orgId)
    runInTransaction(this.db, () => {
      if (!this.repository.reviewAgent(input.agentId, orgId, input.approved, input.actor.userId, input.reviewNote)) {
        throw new CatalogDomainError('AGENT_NOT_FOUND', 'Agent 不存在')
      }
    })
  }

  deleteAgent(actor: IdentityActor, agentId: string, orgId = actor.orgId): void {
    this.assertCanManage(actor, orgId)
    runInTransaction(this.db, () => {
      if (!this.repository.deleteAgent(agentId, orgId)) {
        throw new CatalogDomainError('AGENT_NOT_FOUND', 'Agent 不存在')
      }
    })
  }

  deleteSkill(actor: IdentityActor, skillId: string, orgId = actor.orgId): void {
    this.assertCanManage(actor, orgId)
    runInTransaction(this.db, () => {
      if (!this.repository.deleteSkill(skillId, orgId)) {
        throw new CatalogDomainError('SKILL_NOT_FOUND', 'Skill 不存在')
      }
    })
  }

  private assertCanManage(actor: IdentityActor, orgId: string): void {
    if (actor.role === 'super_admin') return
    if (actor.role === 'admin' && actor.orgId === orgId) return
    throw new CatalogDomainError('FORBIDDEN', '无权管理此组织的目录资源')
  }

  private assertCanCreate(actor: IdentityActor, orgId: string): void {
    if (actor.role === 'super_admin' || actor.orgId === orgId) return
    throw new CatalogDomainError('FORBIDDEN', '无权在此组织创建目录资源')
  }

  private assertImportContext(context: CommandContext): void {
    assertTrustedCommandContext(context)
    if (context.source !== 'migration' && context.source !== 'replay') {
      throw new CatalogDomainError('INVALID_IMPORT_CONTEXT', '迁移导入命令只允许 migration 或 replay 上下文')
    }
  }

  private importResource<T extends 'agent' | 'skill'>(
    kind: T,
    input: T extends 'agent'
      ? Parameters<CatalogRepository['createAgent']>[0] & {
          actor: IdentityActor
          assignedOrgIds?: string[]
          externalIdentity?: { providerType: string; providerId: string; externalId: string }
        }
      : Parameters<CatalogRepository['createSkill']>[0] & {
          actor: IdentityActor
          assignedOrgIds?: string[]
          externalIdentity?: { providerType: string; providerId: string; externalId: string }
        },
    context: CommandContext,
  ): T extends 'agent' ? ReturnType<CatalogRepository['createAgent']> : ReturnType<CatalogRepository['createSkill']> {
    const commandType = `catalog.import_${kind}`
    const previous = this.repository.getCommandResult<{ resourceId: string }>(commandType, context.idempotencyKey)
    if (previous) {
      const existing = kind === 'agent'
        ? this.repository.getAgent(previous.resourceId, input.orgId)
        : this.repository.getSkill(previous.resourceId, input.orgId)
      if (existing) return existing as never
    }

    return runInTransaction(this.db, () => {
      const repeated = this.repository.getCommandResult<{ resourceId: string }>(commandType, context.idempotencyKey)
      if (repeated) {
        const existing = kind === 'agent'
          ? this.repository.getAgent(repeated.resourceId, input.orgId)
          : this.repository.getSkill(repeated.resourceId, input.orgId)
        if (existing) return existing as never
      }
      const { actor: _actor, assignedOrgIds, externalIdentity, ...record } = input
      const resource = kind === 'agent'
        ? this.repository.createAgent({
            ...(record as Parameters<CatalogRepository['createAgent']>[0]),
            sourceProvider: externalIdentity?.providerType ?? record.sourceProvider ?? 'moss',
            sourceResourceId: externalIdentity?.externalId ?? record.sourceResourceId ?? record.id,
          })
        : this.repository.createSkill({
            ...(record as Parameters<CatalogRepository['createSkill']>[0]),
            sourceProvider: externalIdentity?.providerType ?? record.sourceProvider ?? 'moss',
            sourceResourceId: externalIdentity?.externalId ?? record.sourceResourceId ?? record.id,
          })
      if (externalIdentity) {
        this.repository.bindExternalIdentity({
          id: randomUUID(), orgId: input.orgId, resourceType: kind,
          resourceId: resource.id, ...externalIdentity,
        })
      }
      for (const orgId of new Set(assignedOrgIds ?? [])) {
        if (orgId !== input.orgId) this.repository.assignToOrganization(kind, resource.id, orgId)
      }
      this.repository.recordCommandResult(commandType, context.idempotencyKey, context.source, { resourceId: resource.id })
      return resource as never
    })
  }
}
