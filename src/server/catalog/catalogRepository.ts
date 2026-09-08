import type { DatabaseSync } from 'node:sqlite'
import type { VisibilityFilter, VisibleTo } from '../visibilityFilter.js'
import { isVisibleTo } from '../visibilityFilter.js'
import { ensureCatalogSchema } from './catalogSchema.js'

export type CatalogProviderType = 'local' | 'moss_runtime' | 'dify'
export type CatalogSupportedModes = 'local' | 'cloud' | 'both'
export type CatalogResourceType = 'agent' | 'skill'
export type CatalogAvailability = 'organization' | 'all' | 'assigned'

export class CatalogPolicyError extends Error {
  constructor(readonly code: 'INVALID_CURSOR' | 'SECRET_MATERIAL_FORBIDDEN' | 'RESOURCE_NOT_FOUND', message: string) {
    super(message)
    this.name = 'CatalogPolicyError'
  }
}

export interface CatalogAgent {
  id: string
  orgId: string
  name: string
  displayName: string | null
  profession: string | null
  description: string | null
  defaultInitPrompt: string | null
  promptsI18n: Record<string, string[]> | null
  categories: string[]
  avatar: string | null
  skills: string[]
  promptFile: string | null
  sortOrder: number
  version: string | null
  authorId: string
  authorName: string | null
  status: string
  sourceUrl: string | null
  checksum: string | null
  filePath: string | null
  enabledSkills: string[]
  enabled: boolean
  visibleTo: VisibleTo
  providerType: CatalogProviderType
  providerBinding: Record<string, unknown> | null
  supportedModes: CatalogSupportedModes
  availability: CatalogAvailability
  sourceProvider: string
  sourceResourceId: string
  createdAt: number
  updatedAt: number
}

export interface CatalogSkill {
  id: string
  orgId: string
  name: string
  displayName: string | null
  description: string | null
  category: string | null
  categories: string[]
  emoji: string | null
  icon: string | null
  homepage: string | null
  applicableScenarios: string | null
  coreFeatures: string | null
  sortOrder: number
  version: string | null
  authorId: string
  authorName: string | null
  status: string
  sourceUrl: string | null
  checksum: string | null
  filePath: string | null
  enabled: boolean
  visibleTo: VisibleTo
  supportedModes: CatalogSupportedModes
  availability: CatalogAvailability
  sourceProvider: string
  sourceResourceId: string
  createdAt: number
  updatedAt: number
}

type ListOptions = {
  orgId: string
  mode?: 'local' | 'cloud'
  status?: string
  query?: string
  category?: string
  cursor?: string
  limit?: number
  visibility?: VisibilityFilter
  includeDisabled?: boolean
}

type SqlRow = Record<string, unknown>

export class CatalogRepository {
  constructor(private readonly db: DatabaseSync) {
    ensureCatalogSchema(db)
  }

  createAgent(input: {
    id: string
    orgId: string
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
    status?: string
    sourceUrl?: string | null
    checksum?: string | null
    filePath?: string | null
    enabledSkills?: string[]
    enabled?: boolean
    visibleTo?: VisibleTo
    providerType?: CatalogProviderType
    providerBinding?: Record<string, unknown> | null
    supportedModes?: CatalogSupportedModes
    availability?: CatalogAvailability
    sourceProvider?: string
    sourceResourceId?: string
    authorName?: string | null
    createdAt?: number
    updatedAt?: number
  }): CatalogAgent {
    assertSafeProviderBinding(input.providerBinding)
    const timestamp = input.updatedAt ?? input.createdAt ?? Date.now()
    this.db.prepare(`
      INSERT INTO tenant_assistants (
        id, name, display_name, profession, description, default_init_prompt, prompts_i18n,
        categories, avatar, skills, prompt_file, sort_order, version, author_id, author_name, status,
        source_url, checksum, file_path, enabled_skills, enabled, visible_to, org_id,
        provider_type, provider_binding, supported_modes, availability, source_provider, source_resource_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.name,
      input.displayName ?? null,
      input.profession ?? null,
      input.description ?? null,
      input.defaultInitPrompt ?? null,
      input.promptsI18n ? JSON.stringify(input.promptsI18n) : null,
      input.categories ? JSON.stringify(input.categories) : null,
      input.avatar ?? null,
      input.skills ? JSON.stringify(input.skills) : null,
      input.promptFile ?? null,
      input.sortOrder ?? 0,
      input.version ?? null,
      input.authorId,
      input.authorName ?? null,
      input.status ?? 'pending',
      input.sourceUrl ?? null,
      input.checksum ?? null,
      input.filePath ?? null,
      input.enabledSkills ? JSON.stringify(input.enabledSkills) : null,
      input.enabled === false ? 0 : 1,
      input.visibleTo ? JSON.stringify(input.visibleTo) : null,
      input.orgId,
      input.providerType ?? 'moss_runtime',
      input.providerBinding ? JSON.stringify(input.providerBinding) : null,
      input.supportedModes ?? 'both',
      input.availability ?? 'organization',
      input.sourceProvider ?? 'moss',
      input.sourceResourceId ?? input.id,
      input.createdAt ?? timestamp,
      timestamp,
    )
    return this.getAgent(input.id, input.orgId)!
  }

  createSkill(input: {
    id: string
    orgId: string
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
    status?: string
    sourceUrl?: string | null
    checksum?: string | null
    filePath?: string | null
    enabled?: boolean
    visibleTo?: VisibleTo
    supportedModes?: CatalogSupportedModes
    availability?: CatalogAvailability
    sourceProvider?: string
    sourceResourceId?: string
    authorName?: string | null
    createdAt?: number
    updatedAt?: number
  }): CatalogSkill {
    const timestamp = input.updatedAt ?? input.createdAt ?? Date.now()
    this.db.prepare(`
      INSERT INTO tenant_skills (
        id, name, display_name, description, category, categories, emoji, icon, homepage,
        applicable_scenarios, core_features, sort_order, version, author_id, author_name, status,
        source_url, checksum, file_path, enabled, visible_to, org_id,
        supported_modes, availability, source_provider, source_resource_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.name,
      input.displayName ?? null,
      input.description ?? null,
      input.category ?? null,
      input.categories ? JSON.stringify(input.categories) : null,
      input.emoji ?? null,
      input.icon ?? null,
      input.homepage ?? null,
      input.applicableScenarios ?? null,
      input.coreFeatures ?? null,
      input.sortOrder ?? 0,
      input.version ?? null,
      input.authorId,
      input.authorName ?? null,
      input.status ?? 'pending',
      input.sourceUrl ?? null,
      input.checksum ?? null,
      input.filePath ?? null,
      input.enabled === false ? 0 : 1,
      input.visibleTo ? JSON.stringify(input.visibleTo) : null,
      input.orgId,
      input.supportedModes ?? 'both',
      input.availability ?? 'organization',
      input.sourceProvider ?? 'moss',
      input.sourceResourceId ?? input.id,
      input.createdAt ?? timestamp,
      timestamp,
    )
    return this.getSkill(input.id, input.orgId)!
  }

  getAgent(id: string, orgId: string): CatalogAgent | null {
    const row = this.db.prepare('SELECT * FROM tenant_assistants WHERE id = ? AND org_id = ?').get(id, orgId) as SqlRow | undefined
    return row ? mapAgent(row) : null
  }

  getSkill(id: string, orgId: string): CatalogSkill | null {
    const row = this.db.prepare('SELECT * FROM tenant_skills WHERE id = ? AND org_id = ?').get(id, orgId) as SqlRow | undefined
    return row ? mapSkill(row) : null
  }

  findAgent(id: string): CatalogAgent | null {
    const row = this.db.prepare('SELECT * FROM tenant_assistants WHERE id = ?').get(id) as SqlRow | undefined
    return row ? mapAgent(row) : null
  }

  findSkill(id: string): CatalogSkill | null {
    const row = this.db.prepare('SELECT * FROM tenant_skills WHERE id = ?').get(id) as SqlRow | undefined
    return row ? mapSkill(row) : null
  }

  findAgentByName(name: string, orgId: string): CatalogAgent | null {
    const row = this.db.prepare(`
      SELECT * FROM tenant_assistants WHERE org_id = ? AND name = ? LIMIT 1
    `).get(orgId, name) as SqlRow | undefined
    return row ? mapAgent(row) : null
  }

  findSkillByName(name: string, orgId: string): CatalogSkill | null {
    const row = this.db.prepare(`
      SELECT * FROM tenant_skills WHERE org_id = ? AND name = ? LIMIT 1
    `).get(orgId, name) as SqlRow | undefined
    return row ? mapSkill(row) : null
  }

  updateAgentConfiguration(id: string, orgId: string, patch: {
    name?: string
    displayName?: string | null
    profession?: string | null
    description?: string | null
    defaultInitPrompt?: string | null
    promptsI18n?: Record<string, string[]> | null
    categories?: string[]
    avatar?: string | null
    skills?: string[]
    promptFile?: string | null
    version?: string | null
    sourceUrl?: string | null
    checksum?: string | null
    filePath?: string | null
    visibleTo?: VisibleTo
    providerType?: CatalogProviderType
    providerBinding?: Record<string, unknown> | null
    supportedModes?: CatalogSupportedModes
    availability?: CatalogAvailability
    enabled?: boolean
    status?: string
  }): CatalogAgent | null {
    const current = this.getAgent(id, orgId)
    if (!current) return null
    assertSafeProviderBinding(patch.providerBinding)
    this.db.prepare(`
      UPDATE tenant_assistants SET
        name = ?, display_name = ?, profession = ?, description = ?, default_init_prompt = ?,
        prompts_i18n = ?, categories = ?, avatar = ?, skills = ?, prompt_file = ?,
        version = ?, source_url = ?, checksum = ?, file_path = ?, visible_to = ?,
        provider_type = ?, provider_binding = ?, supported_modes = ?, availability = ?,
        enabled = ?, status = ?, updated_at = ?
      WHERE id = ? AND org_id = ?
    `).run(
      patch.name ?? current.name,
      patch.displayName === undefined ? current.displayName : patch.displayName,
      patch.profession === undefined ? current.profession : patch.profession,
      patch.description === undefined ? current.description : patch.description,
      patch.defaultInitPrompt === undefined ? current.defaultInitPrompt : patch.defaultInitPrompt,
      patch.promptsI18n === undefined
        ? (current.promptsI18n ? JSON.stringify(current.promptsI18n) : null)
        : (patch.promptsI18n ? JSON.stringify(patch.promptsI18n) : null),
      patch.categories === undefined ? JSON.stringify(current.categories) : JSON.stringify(patch.categories),
      patch.avatar === undefined ? current.avatar : patch.avatar,
      patch.skills === undefined ? JSON.stringify(current.skills) : JSON.stringify(patch.skills),
      patch.promptFile === undefined ? current.promptFile : patch.promptFile,
      patch.version === undefined ? current.version : patch.version,
      patch.sourceUrl === undefined ? current.sourceUrl : patch.sourceUrl,
      patch.checksum === undefined ? current.checksum : patch.checksum,
      patch.filePath === undefined ? current.filePath : patch.filePath,
      patch.visibleTo === undefined ? JSON.stringify(current.visibleTo) : JSON.stringify(patch.visibleTo),
      patch.providerType ?? current.providerType,
      patch.providerBinding === undefined
        ? (current.providerBinding ? JSON.stringify(current.providerBinding) : null)
        : (patch.providerBinding ? JSON.stringify(patch.providerBinding) : null),
      patch.supportedModes ?? current.supportedModes,
      patch.availability ?? current.availability,
      (patch.enabled ?? current.enabled) ? 1 : 0,
      patch.status ?? current.status,
      Date.now(), id, orgId,
    )
    return this.getAgent(id, orgId)
  }

  reviewAgent(id: string, orgId: string, approved: boolean, reviewedBy: string, reviewNote?: string): boolean {
    const timestamp = Date.now()
    return this.db.prepare(`
      UPDATE tenant_assistants
      SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ?
      WHERE id = ? AND org_id = ?
    `).run(
      approved ? 'approved' : 'rejected', reviewedBy, timestamp, reviewNote ?? null,
      timestamp, id, orgId,
    ).changes === 1
  }

  reviewSkill(id: string, orgId: string, approved: boolean, reviewedBy: string, reviewNote?: string): boolean {
    const timestamp = Date.now()
    return this.db.prepare(`
      UPDATE tenant_skills
      SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ?
      WHERE id = ? AND org_id = ?
    `).run(
      approved ? 'approved' : 'rejected', reviewedBy, timestamp, reviewNote ?? null,
      timestamp, id, orgId,
    ).changes === 1
  }

  deleteAgent(id: string, orgId: string): boolean {
    const deleted = this.db.prepare('DELETE FROM tenant_assistants WHERE id = ? AND org_id = ?').run(id, orgId).changes === 1
    if (!deleted) return false
    this.db.prepare(`
      DELETE FROM resource_external_aliases
      WHERE resource_type = 'agent' AND resource_id = ? AND org_id = ?
    `).run(id, orgId)
    this.db.prepare(`
      DELETE FROM catalog_resource_org_assignments WHERE resource_type = 'agent' AND resource_id = ?
    `).run(id)
    return true
  }

  deleteSkill(id: string, orgId: string): boolean {
    const deleted = this.db.prepare('DELETE FROM tenant_skills WHERE id = ? AND org_id = ?').run(id, orgId).changes === 1
    if (!deleted) return false
    this.db.prepare(`
      DELETE FROM resource_external_aliases
      WHERE resource_type = 'skill' AND resource_id = ? AND org_id = ?
    `).run(id, orgId)
    this.db.prepare(`
      DELETE FROM catalog_resource_org_assignments WHERE resource_type = 'skill' AND resource_id = ?
    `).run(id)
    return true
  }

  listAgents(options: ListOptions): { items: CatalogAgent[]; hasMore: boolean; nextCursor: string | null } {
    return paginate(
      this.db.prepare(`
        SELECT * FROM tenant_assistants resource
        WHERE resource.org_id = ? OR resource.availability = 'all' OR EXISTS (
          SELECT 1 FROM catalog_resource_org_assignments assignment
          WHERE assignment.resource_type = 'agent' AND assignment.resource_id = resource.id AND assignment.org_id = ?
        )
        ORDER BY resource.updated_at DESC, resource.id DESC
      `).all(options.orgId, options.orgId) as SqlRow[],
      options,
      mapAgent,
    )
  }

  listSkills(options: ListOptions): { items: CatalogSkill[]; hasMore: boolean; nextCursor: string | null } {
    return paginate(
      this.db.prepare(`
        SELECT * FROM tenant_skills resource
        WHERE resource.org_id = ? OR resource.availability = 'all' OR EXISTS (
          SELECT 1 FROM catalog_resource_org_assignments assignment
          WHERE assignment.resource_type = 'skill' AND assignment.resource_id = resource.id AND assignment.org_id = ?
        )
        ORDER BY resource.updated_at DESC, resource.id DESC
      `).all(options.orgId, options.orgId) as SqlRow[],
      options,
      mapSkill,
    )
  }

  listCategories(options: Omit<ListOptions, 'category' | 'cursor' | 'limit'> & { type: CatalogResourceType }): string[] {
    const categories = new Set<string>()
    let cursor: string | undefined
    do {
      const page = options.type === 'agent'
        ? this.listAgents({ ...options, cursor, limit: 100 })
        : this.listSkills({ ...options, cursor, limit: 100 })
      for (const item of page.items) {
        if ('category' in item && item.category) categories.add(item.category)
        for (const category of item.categories) if (category) categories.add(category)
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return [...categories]
  }

  assignToOrganization(resourceType: CatalogResourceType, resourceId: string, orgId: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO catalog_resource_org_assignments (resource_type, resource_id, org_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(resourceType, resourceId, orgId, Date.now())
  }

  replaceOrganizationAssignments(
    resourceType: CatalogResourceType,
    resourceId: string,
    orgIds: string[],
  ): void {
    this.db.prepare(`
      DELETE FROM catalog_resource_org_assignments
      WHERE resource_type = ? AND resource_id = ?
    `).run(resourceType, resourceId)
    for (const orgId of new Set(orgIds.filter(Boolean))) {
      this.assignToOrganization(resourceType, resourceId, orgId)
    }
  }

  listAssignedOrganizationIds(resourceType: CatalogResourceType, resourceId: string): string[] {
    return (this.db.prepare(`
      SELECT org_id FROM catalog_resource_org_assignments
      WHERE resource_type = ? AND resource_id = ? ORDER BY org_id
    `).all(resourceType, resourceId) as Array<{ org_id: string }>).map(row => row.org_id)
  }

  isAvailableToOrganization(resourceType: CatalogResourceType, resourceId: string, orgId: string): boolean {
    const table = resourceType === 'agent' ? 'tenant_assistants' : 'tenant_skills'
    return Boolean(this.db.prepare(`
      SELECT 1 FROM ${table} resource
      WHERE resource.id = ? AND (
        resource.org_id = ? OR resource.availability = 'all' OR EXISTS (
          SELECT 1 FROM catalog_resource_org_assignments assignment
          WHERE assignment.resource_type = ? AND assignment.resource_id = resource.id AND assignment.org_id = ?
        )
      )
    `).get(resourceId, orgId, resourceType, orgId))
  }

  bindExternalIdentity(input: {
    id: string
    orgId: string
    resourceType: CatalogResourceType
    resourceId: string
    providerType: string
    providerId: string
    externalId: string
    createdAt?: number
  }): void {
    const exists = input.resourceType === 'agent'
      ? this.getAgent(input.resourceId, input.orgId)
      : this.getSkill(input.resourceId, input.orgId)
    if (!exists) throw new CatalogPolicyError('RESOURCE_NOT_FOUND', '目录资源不存在')
    this.db.prepare(`
      INSERT INTO resource_external_aliases (
        id, org_id, resource_type, resource_id, provider_type, provider_id, external_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.orgId, input.resourceType, input.resourceId, input.providerType,
      input.providerId, input.externalId, input.createdAt ?? Date.now(),
    )
  }

  resolveExternalIdentity(input: {
    orgId: string
    resourceType: CatalogResourceType
    providerType: string
    providerId: string
    externalId: string
  }): string | null {
    const row = this.db.prepare(`
      SELECT resource_id FROM resource_external_aliases
      WHERE org_id = ? AND resource_type = ? AND provider_type = ? AND provider_id = ? AND external_id = ?
    `).get(
      input.orgId, input.resourceType, input.providerType, input.providerId, input.externalId,
    ) as { resource_id: string } | undefined
    return row?.resource_id ?? null
  }

  getCommandResult<T>(commandType: string, idempotencyKey: string): T | null {
    const row = this.db.prepare(`
      SELECT result_json FROM command_executions
      WHERE command_type = ? AND idempotency_key = ? LIMIT 1
    `).get(commandType, idempotencyKey) as { result_json: string } | undefined
    return row ? JSON.parse(row.result_json) as T : null
  }

  recordCommandResult(
    commandType: string,
    idempotencyKey: string,
    contextSource: 'online' | 'migration' | 'replay',
    result: unknown,
  ): void {
    this.db.prepare(`
      INSERT INTO command_executions (command_type, idempotency_key, context_source, result_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(commandType, idempotencyKey, contextSource, JSON.stringify(result), Date.now())
  }

  clearCommandResult(commandType: string, idempotencyKey: string): void {
    this.db.prepare(`
      DELETE FROM command_executions WHERE command_type = ? AND idempotency_key = ?
    `).run(commandType, idempotencyKey)
  }
}

function paginate<T extends CatalogAgent | CatalogSkill>(
  rows: SqlRow[],
  options: ListOptions,
  mapper: (row: SqlRow) => T,
): { items: T[]; hasMore: boolean; nextCursor: string | null } {
  const cursor = options.cursor ? decodeCursor(options.cursor) : null
  const query = options.query?.trim().toLocaleLowerCase()
  const category = options.category?.trim().toLocaleLowerCase()
  const limit = Math.max(1, Math.min(options.limit ?? 100, 100))
  const filtered = rows.map(mapper).filter((item) => {
    if (cursor && !(item.updatedAt < cursor.updatedAt || (item.updatedAt === cursor.updatedAt && item.id < cursor.id))) return false
    if (options.status && item.status !== options.status) return false
    if (query && !`${item.name}\n${item.displayName ?? ''}\n${item.description ?? ''}`.toLocaleLowerCase().includes(query)) return false
    if (category) {
      const categories = 'categories' in item ? item.categories : []
      const primary = 'category' in item ? item.category : null
      if (![primary, ...categories].some((value) => value?.toLocaleLowerCase() === category)) return false
    }
    if (options.mode === 'local' && item.supportedModes !== 'local' && item.supportedModes !== 'both') return false
    if (options.mode === 'cloud') {
      if (item.supportedModes !== 'cloud' && item.supportedModes !== 'both') return false
      if ('providerType' in item && item.providerType === 'local') return false
    }
    if (!options.includeDisabled && !item.enabled) return false
    return !options.visibility || isVisibleTo(item.visibleTo, options.visibility)
  })
  const items = filtered.slice(0, limit)
  return {
    items,
    hasMore: filtered.length > limit,
    nextCursor: filtered.length > limit && items.length > 0
      ? encodeCursor(items[items.length - 1]!)
      : null,
  }
}

function encodeCursor(item: { updatedAt: number; id: string }): string {
  return Buffer.from(JSON.stringify({ updatedAt: item.updatedAt, id: item.id })).toString('base64url')
}

function decodeCursor(value: string): { updatedAt: number; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    if (!Number.isFinite(parsed.updatedAt) || typeof parsed.id !== 'string' || !parsed.id) throw new Error()
    return { updatedAt: Number(parsed.updatedAt), id: parsed.id }
  } catch {
    throw new CatalogPolicyError('INVALID_CURSOR', '游标无效')
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function parseVisibleTo(value: unknown): VisibleTo {
  return parseObject(value) as VisibleTo
}

function mapAgent(row: SqlRow): CatalogAgent {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    name: String(row.name),
    displayName: typeof row.display_name === 'string' ? row.display_name : null,
    profession: typeof row.profession === 'string' ? row.profession : null,
    description: typeof row.description === 'string' ? row.description : null,
    defaultInitPrompt: typeof row.default_init_prompt === 'string' ? row.default_init_prompt : null,
    promptsI18n: parseObject(row.prompts_i18n) as Record<string, string[]> | null,
    categories: parseStringArray(row.categories),
    avatar: typeof row.avatar === 'string' ? row.avatar : null,
    skills: parseStringArray(row.skills),
    promptFile: typeof row.prompt_file === 'string' ? row.prompt_file : null,
    sortOrder: Number(row.sort_order) || 0,
    version: typeof row.version === 'string' ? row.version : null,
    authorId: String(row.author_id),
    authorName: typeof row.author_name === 'string' ? row.author_name : null,
    status: String(row.status),
    sourceUrl: typeof row.source_url === 'string' ? row.source_url : null,
    checksum: typeof row.checksum === 'string' ? row.checksum : null,
    filePath: typeof row.file_path === 'string' ? row.file_path : null,
    enabledSkills: parseStringArray(row.enabled_skills),
    enabled: Number(row.enabled) === 1,
    visibleTo: parseVisibleTo(row.visible_to),
    providerType: String(row.provider_type) as CatalogProviderType,
    providerBinding: parseObject(row.provider_binding),
    supportedModes: String(row.supported_modes) as CatalogSupportedModes,
    availability: String(row.availability) as CatalogAvailability,
    sourceProvider: String(row.source_provider),
    sourceResourceId: String(row.source_resource_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapSkill(row: SqlRow): CatalogSkill {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    name: String(row.name),
    displayName: typeof row.display_name === 'string' ? row.display_name : null,
    description: typeof row.description === 'string' ? row.description : null,
    category: typeof row.category === 'string' ? row.category : null,
    categories: parseStringArray(row.categories),
    emoji: typeof row.emoji === 'string' ? row.emoji : null,
    icon: typeof row.icon === 'string' ? row.icon : null,
    homepage: typeof row.homepage === 'string' ? row.homepage : null,
    applicableScenarios: typeof row.applicable_scenarios === 'string' ? row.applicable_scenarios : null,
    coreFeatures: typeof row.core_features === 'string' ? row.core_features : null,
    sortOrder: Number(row.sort_order) || 0,
    version: typeof row.version === 'string' ? row.version : null,
    authorId: String(row.author_id),
    authorName: typeof row.author_name === 'string' ? row.author_name : null,
    status: String(row.status),
    sourceUrl: typeof row.source_url === 'string' ? row.source_url : null,
    checksum: typeof row.checksum === 'string' ? row.checksum : null,
    filePath: typeof row.file_path === 'string' ? row.file_path : null,
    enabled: Number(row.enabled) === 1,
    visibleTo: parseVisibleTo(row.visible_to),
    supportedModes: String(row.supported_modes) as CatalogSupportedModes,
    availability: String(row.availability) as CatalogAvailability,
    sourceProvider: String(row.source_provider),
    sourceResourceId: String(row.source_resource_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function assertSafeProviderBinding(binding: Record<string, unknown> | null | undefined): void {
  if (!binding) return
  const forbidden = /^(api_?key|access_?token|refresh_?token|secret|password|credential)$/i
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit)
    if (!value || typeof value !== 'object') return false
    return Object.entries(value as Record<string, unknown>).some(([key, child]) => forbidden.test(key) || visit(child))
  }
  if (visit(binding)) {
    throw new CatalogPolicyError('SECRET_MATERIAL_FORBIDDEN', 'Provider binding 只能保存连接引用，不能保存真实密钥')
  }
}
