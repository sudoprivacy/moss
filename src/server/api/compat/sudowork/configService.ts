import type { DatabaseSync } from 'node:sqlite'
import type { AuthCenterDb } from '../../../authCenter/db.js'
import type { ConfigItemsApi } from '../../configItems.js'
import { assertTrustedCommandContext, type CommandContext } from '../../../application/commandContext.js'
import type { IdentityRepository } from '../../../identity/identityRepository.js'
import type { IdentityActor } from '../../../identity/organizationIdentityService.js'
import { runInTransaction } from '../../../storage/sqliteUnitOfWork.js'

type SqlRow = Record<string, unknown>

export interface ImportedConfigItem {
  legacyId: number
  ownerOrgId: string
  assignedOrgIds: string[]
  name: string
  description?: string | null
  icon?: string | null
  pinyin: string | null
  urlPattern?: string | null
  scheme?: string | null
  bearerPrefix?: string | null
  visibleToAll: boolean
  status: number
  createdAt?: number
  updatedAt?: number
  entries: Array<{
    legacyId: number
    config_key: string
    name: string
    config_desc?: string
    required?: boolean
    createdAt?: number
    updatedAt?: number
  }>
}

export class SudoworkConfigError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
    this.name = 'SudoworkConfigError'
  }
}

export class SudoworkConfigService {
  constructor(private readonly options: {
    db: DatabaseSync
    configItems: ConfigItemsApi
    identities: IdentityRepository
    authDb: AuthCenterDb
    managedImages?: {
      read(kind: 'enterprise', filename: string): Promise<{ bytes: Buffer; mimeType: string }>
    }
  }) {}

  list(input: {
    actor: IdentityActor
    name?: string
    status?: string
    page?: number
    pageSize?: number
  }) {
    this.assertAdmin(input.actor)
    const page = Math.max(1, input.page ?? 1)
    const pageSize = Math.max(1, Math.min(input.pageSize ?? 20, 100))
    const conditions: string[] = []
    const params: unknown[] = []
    if (input.actor.role !== 'super_admin') {
      conditions.push('ci.org_id = ?')
      params.push(input.actor.orgId)
    }
    if (input.name) {
      conditions.push('ci.name LIKE ?')
      params.push(`%${input.name}%`)
    }
    if (input.status !== undefined && input.status !== '') {
      conditions.push('ci.status = ?')
      params.push(Number(input.status))
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = Number((this.options.db.prepare(`SELECT COUNT(*) AS count FROM config_items ci ${where}`).get(...params) as SqlRow).count)
    const rows = this.options.db.prepare(`
      SELECT ci.*, (
        SELECT COUNT(*) FROM config_item_org_assignments assignment WHERE assignment.config_item_id = ci.id
      ) AS assigned_count
      FROM config_items ci ${where}
      ORDER BY ci.updated_at DESC, ci.id DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize) as SqlRow[]
    return {
      items: rows.map(row => this.legacyItem(row, input.actor.orgId)), total, page, page_size: pageSize,
    }
  }

  create(actor: IdentityActor, body: Record<string, unknown>): { id: number } {
    this.assertAdmin(actor)
    const name = text(body.name)
    if (!name) throw new SudoworkConfigError(400, '配置项名称不能为空')
    if (name.length > 20) throw new SudoworkConfigError(400, '配置项名称不超过20个字符')
    return runInTransaction(this.options.db, () => {
      const result = this.options.configItems.create(actor.orgId, actor.userId, {
        name,
        description: nullableText(body.description) ?? undefined,
        icon: nullableText(body.icon) ?? undefined,
        scope: 'system',
        url_pattern: nullableText(body.url_pattern) ?? undefined,
        scheme: nullableText(body.scheme) ?? undefined,
        bearer_prefix: nullableText(body.bearer_prefix) ?? undefined,
        entries: [],
      })
      const item = unwrapNative(result)
      const id = Number((item as { id: number }).id)
      const availability = body.visible_to_all === 1 && actor.role === 'super_admin' ? 'all' : 'organization'
      this.options.db.prepare('UPDATE config_items SET availability = ? WHERE id = ?').run(availability, id)
      return { id: this.legacyIdFor(id, actor.orgId) }
    })
  }

  get(actor: IdentityActor, id: number) {
    const item = this.requireManageable(actor, id)
    const nativeId = Number(item.id)
    return {
      ...this.legacyItem(item, actor.orgId),
      entries: this.entries(nativeId, String(item.org_id ?? actor.orgId)),
      enterprises: this.enterpriseRows(nativeId, true),
    }
  }

  update(actor: IdentityActor, id: number, body: Record<string, unknown>): void {
    const item = this.requireManageable(actor, id)
    const nativeId = Number(item.id)
    if (Number(item.status) === 0) throw new SudoworkConfigError(400, '禁用状态的配置项不能编辑')
    runInTransaction(this.options.db, () => {
      const result = this.options.configItems.update(
        String(item.org_id ?? actor.orgId),
        actor.userId,
        nativeId,
        {
          name: optionalText(body, 'name'),
          description: optionalText(body, 'description'),
          icon: optionalText(body, 'icon'),
          pinyin: optionalText(body, 'pinyin'),
          url_pattern: optionalText(body, 'url_pattern'),
          scheme: optionalText(body, 'scheme'),
          bearer_prefix: optionalText(body, 'bearer_prefix'),
        },
      )
      unwrapNative(result)
      if (body.visible_to_all !== undefined) {
        if (actor.role !== 'super_admin' && body.visible_to_all === 1) {
          throw new SudoworkConfigError(403, '权限不足')
        }
        this.options.db.prepare('UPDATE config_items SET availability = ? WHERE id = ?')
          .run(body.visible_to_all === 1 ? 'all' : 'organization', nativeId)
      }
    })
  }

  updateStatus(actor: IdentityActor, id: number, status: number): void {
    const item = this.requireManageable(actor, id)
    const nativeId = Number(item.id)
    if (status !== 0 && status !== 1) throw new SudoworkConfigError(400, '状态值无效')
    if (Number(item.status) === status) throw new SudoworkConfigError(400, '状态未发生变化')
    runInTransaction(this.options.db, () => {
      unwrapNative(this.options.configItems.updateStatus(String(item.org_id ?? actor.orgId), actor.userId, nativeId, status))
      if (status === 0) this.options.db.prepare('DELETE FROM config_item_org_assignments WHERE config_item_id = ?').run(nativeId)
    })
  }

  entriesFor(actor: IdentityActor, id: number) {
    const item = this.requireManageable(actor, id)
    return this.entries(Number(item.id), String(item.org_id ?? actor.orgId))
  }

  replaceEntries(actor: IdentityActor, id: number, entries: unknown): void {
    const item = this.requireManageable(actor, id)
    const nativeId = Number(item.id)
    if (Number(item.status) === 0) throw new SudoworkConfigError(400, '禁用状态的配置项不能修改配置列表')
    if (!Array.isArray(entries)) throw new SudoworkConfigError(400, 'entries 必须为数组')
    runInTransaction(this.options.db, () => {
      const previousEntryIds = (this.options.db.prepare(
        'SELECT id FROM config_entries WHERE config_item_id = ?',
      ).all(nativeId) as Array<{ id: number }>).map(row => row.id)
      unwrapNative(this.options.configItems.update(
        String(item.org_id ?? actor.orgId), actor.userId, nativeId,
        { entries: entries as Array<{ config_key: string; name: string; config_desc?: string; required?: boolean }> },
      ))
      const removeAlias = this.options.db.prepare(
        `DELETE FROM resource_numeric_aliases WHERE namespace = 'config_entry' AND resource_id = ?`,
      )
      for (const entryId of previousEntryIds) removeAlias.run(String(entryId))
      for (const entry of this.rawEntries(nativeId)) {
        this.options.identities.allocateNumericAlias(
          'config_entry', String(entry.id), String(item.org_id ?? actor.orgId),
        )
      }
    })
  }

  listEnterprises(actor: IdentityActor, id: number, page = 1, pageSize = 20) {
    const item = this.requireManageable(actor, id)
    const items = this.enterpriseRows(Number(item.id), false)
    const offset = (Math.max(1, page) - 1) * pageSize
    return { items: items.slice(offset, offset + pageSize), total: items.length, page, page_size: pageSize }
  }

  associate(actor: IdentityActor, id: number, legacyEnterpriseId: number): void {
    const item = this.requireManageable(actor, id)
    const nativeId = Number(item.id)
    if (Number(item.status) === 0) throw new SudoworkConfigError(400, '禁用状态的配置项不能关联企业')
    const org = this.requireLegacyOrganization(legacyEnterpriseId)
    if (actor.role !== 'super_admin' && org.resourceId !== actor.orgId) throw new SudoworkConfigError(403, '权限不足')
    try {
      runInTransaction(this.options.db, () => {
        this.options.db.prepare(`
          INSERT INTO config_item_org_assignments (config_item_id, org_id, created_at) VALUES (?, ?, ?)
        `).run(nativeId, org.resourceId, Date.now())
        this.options.db.prepare(`UPDATE config_items SET availability = 'assigned', updated_at = ? WHERE id = ?`).run(Date.now(), nativeId)
      })
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new SudoworkConfigError(400, '该企业已关联此配置项')
      throw error
    }
  }

  dissociate(actor: IdentityActor, id: number, legacyEnterpriseId: number): void {
    const item = this.requireManageable(actor, id)
    const nativeId = Number(item.id)
    const org = this.requireLegacyOrganization(legacyEnterpriseId)
    if (actor.role !== 'super_admin' && org.resourceId !== actor.orgId) throw new SudoworkConfigError(403, '权限不足')
    const result = this.options.db.prepare(`
      DELETE FROM config_item_org_assignments WHERE config_item_id = ? AND org_id = ?
    `).run(nativeId, org.resourceId)
    if (result.changes === 0) throw new SudoworkConfigError(404, '该企业未关联此配置项')
  }

  listForUser(actor: IdentityActor) {
    const items = this.options.configItems.listPublic(
      {
        role: actor.role,
        scopes: actor.role === 'admin' || actor.role === 'super_admin' ? ['*'] : [],
        userId: actor.userId,
        orgId: actor.orgId,
      },
      userId => this.options.authDb.getUserByIdAndOrg(userId, actor.orgId),
    ).data
    return items.map(item => ({
      ...item,
      id: this.legacyIdFor(Number(item.id), actor.orgId),
      entries: Array.isArray(item.entries)
        ? item.entries.map(entry => ({
          ...entry,
          id: this.entryLegacyIdFor(Number(entry.id), actor.orgId),
        }))
        : [],
    }))
  }

  importConfigItem(actor: IdentityActor, input: ImportedConfigItem, context: CommandContext): { id: number } {
    this.assertAdmin(actor)
    if (actor.role !== 'super_admin') throw new SudoworkConfigError(403, '权限不足')
    assertTrustedCommandContext(context)
    if (context.source !== 'migration' && context.source !== 'replay') {
      throw new SudoworkConfigError(400, '配置项迁移导入命令仅允许迁移或回放上下文')
    }
    if (!Number.isSafeInteger(input.legacyId) || input.legacyId <= 0) {
      throw new SudoworkConfigError(400, '旧配置项 ID 无效')
    }
    if (input.status !== 0 && input.status !== 1) {
      throw new SudoworkConfigError(400, '状态值无效')
    }
    if (!this.options.identities.getOrganizationProfile(input.ownerOrgId)) {
      throw new SudoworkConfigError(400, `配置项所属组织不存在: ${input.ownerOrgId}`)
    }
    for (const orgId of new Set(input.assignedOrgIds)) {
      if (!this.options.identities.getOrganizationProfile(orgId)) {
        throw new SudoworkConfigError(400, `配置项关联组织不存在: ${orgId}`)
      }
    }

    const commandType = 'configuration.import_item'
    const previous = this.options.identities.getCommandResult<{ id: number }>(commandType, context.idempotencyKey)
    if (previous) return previous

    return runInTransaction(this.options.db, () => {
      const repeated = this.options.identities.getCommandResult<{ id: number }>(commandType, context.idempotencyKey)
      if (repeated) return repeated

      const created = unwrapNative(this.options.configItems.create(input.ownerOrgId, actor.userId, {
        name: input.name,
        description: input.description ?? undefined,
        icon: input.icon ?? undefined,
        pinyin: input.pinyin ?? `legacy_config_${input.legacyId}`,
        scope: 'system',
        url_pattern: input.urlPattern ?? undefined,
        scheme: input.scheme ?? undefined,
        bearer_prefix: input.bearerPrefix ?? undefined,
        entries: input.entries.map(({ legacyId: _legacyId, createdAt: _createdAt, updatedAt: _updatedAt, ...entry }) => entry),
      })) as { id: number }
      const nativeId = Number(created.id)
      const assignedOrgIds = [...new Set(input.assignedOrgIds)]
      const availability = input.visibleToAll ? 'all' : assignedOrgIds.length > 0 ? 'assigned' : 'organization'
      this.options.db.prepare(`
        UPDATE config_items
        SET availability = ?, status = ?, pinyin = ?, created_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        availability,
        input.status,
        input.pinyin,
        input.createdAt ?? Date.now(),
        input.updatedAt ?? input.createdAt ?? Date.now(),
        nativeId,
      )
      const insertAssignment = this.options.db.prepare(`
        INSERT INTO config_item_org_assignments (config_item_id, org_id, created_at)
        VALUES (?, ?, ?)
      `)
      const timestamp = Date.now()
      for (const orgId of assignedOrgIds) insertAssignment.run(nativeId, orgId, timestamp)
      this.options.identities.assignNumericAlias({
        namespace: 'config_item',
        legacyId: input.legacyId,
        resourceId: String(nativeId),
        orgId: input.ownerOrgId,
        migrationRunId: context.migrationRunId ?? null,
      })
      const entriesByKey = new Map(this.rawEntries(nativeId).map(entry => [String(entry.config_key), entry]))
      for (const sourceEntry of input.entries) {
        if (!Number.isSafeInteger(sourceEntry.legacyId) || sourceEntry.legacyId <= 0) {
          throw new SudoworkConfigError(400, '旧配置字段 ID 无效')
        }
        const entry = entriesByKey.get(sourceEntry.config_key)
        if (!entry) throw new SudoworkConfigError(500, `配置字段写入失败: ${sourceEntry.config_key}`)
        this.options.db.prepare(`UPDATE config_entries SET created_at = ?, updated_at = ? WHERE id = ?`).run(
          sourceEntry.createdAt ?? input.createdAt ?? Date.now(),
          sourceEntry.updatedAt ?? input.updatedAt ?? sourceEntry.createdAt ?? input.createdAt ?? Date.now(),
          entry.id,
        )
        this.options.identities.assignNumericAlias({
          namespace: 'config_entry',
          legacyId: sourceEntry.legacyId,
          resourceId: String(entry.id),
          orgId: input.ownerOrgId,
          migrationRunId: context.migrationRunId ?? null,
        })
      }
      const result = { id: input.legacyId }
      this.options.identities.recordCommandResult(commandType, context.idempotencyKey, context.source, result)
      return result
    })
  }

  async getTenantConfig(actor: IdentityActor, code: string) {
    const profile = this.options.identities.getOrganizationProfileByCode(code)
    if (!profile) throw new SudoworkConfigError(404, '租户不存在')
    if (actor.role !== 'super_admin' && actor.orgId !== profile.orgId) {
      throw new SudoworkConfigError(403, '权限不足')
    }
    let logo: string | null = null
    if (profile.logo?.startsWith('data:')) {
      logo = profile.logo
    } else if (profile.logo && this.options.managedImages) {
      try {
        const image = await this.options.managedImages.read('enterprise', profile.logo)
        logo = `data:${image.mimeType};base64,${image.bytes.toString('base64')}`
      } catch {
        logo = null
      }
    }
    return {
      logo,
      app_name: profile.appName,
      top_name: profile.topName,
      about_name: profile.aboutName,
      app_company_name: profile.appCompanyName,
      login_desp: profile.loginDescription,
    }
  }

  private requireManageable(actor: IdentityActor, id: number): SqlRow {
    this.assertAdmin(actor)
    const nativeId = this.resolveNativeId(id)
    const item = nativeId === null
      ? undefined
      : this.options.db.prepare('SELECT * FROM config_items WHERE id = ?').get(nativeId) as SqlRow | undefined
    if (!item) throw new SudoworkConfigError(404, '配置项不存在')
    if (actor.role !== 'super_admin' && item.org_id !== actor.orgId) throw new SudoworkConfigError(403, '权限不足')
    return item
  }

  private assertAdmin(actor: IdentityActor): void {
    if (actor.role !== 'admin' && actor.role !== 'super_admin') throw new SudoworkConfigError(403, '权限不足')
  }

  private entries(id: number, orgId: string): SqlRow[] {
    return this.rawEntries(id).map(entry => ({
      ...entry,
      id: this.entryLegacyIdFor(Number(entry.id), orgId),
    }))
  }

  private rawEntries(id: number): SqlRow[] {
    return this.options.db.prepare('SELECT * FROM config_entries WHERE config_item_id = ? ORDER BY id').all(id) as SqlRow[]
  }

  private enterpriseRows(id: number, associatedOnly: boolean): SqlRow[] {
    const item = this.options.db.prepare('SELECT * FROM config_items WHERE id = ?').get(id) as SqlRow
    const assigned = new Set((this.options.db.prepare(
      'SELECT org_id FROM config_item_org_assignments WHERE config_item_id = ?',
    ).all(id) as Array<{ org_id: string }>).map(row => row.org_id))
    return this.options.authDb.listOrganizations().flatMap(org => {
      const legacyId = this.options.identities.getNumericAlias('enterprise', org.id)
      if (legacyId === null) return []
      const isAssociated = item.availability === 'all'
        || (item.availability === 'organization' && item.org_id === org.id)
        || (item.availability === 'assigned' && assigned.has(org.id))
      if (associatedOnly && !isAssociated) return []
      const profile = this.options.identities.getOrganizationProfile(org.id)
      return [{ id: legacyId, name: org.name, code: profile?.code ?? `moss-${org.id}`, is_associated: isAssociated ? 1 : 0 }]
    })
  }

  private requireLegacyOrganization(legacyId: number) {
    const result = this.options.identities.resolveNumericAliasGlobal('enterprise', legacyId)
    if (!result) throw new SudoworkConfigError(404, '企业不存在')
    return result
  }

  private legacyItem(row: SqlRow, fallbackOrgId: string): SqlRow {
    const assigned = Number(row.assigned_count ?? (this.options.db.prepare(
      'SELECT COUNT(*) AS count FROM config_item_org_assignments WHERE config_item_id = ?',
    ).get(row.id) as SqlRow).count)
    return {
      ...row,
      id: this.legacyIdFor(Number(row.id), String(row.org_id ?? fallbackOrgId)),
      visible_to_all: row.availability === 'all' ? 1 : 0,
      enterprise_count: row.availability === 'all' ? this.options.authDb.listOrganizations().length : assigned,
    }
  }

  private legacyIdFor(nativeId: number, orgId: string): number {
    return this.options.identities.allocateNumericAlias('config_item', String(nativeId), orgId)
  }

  private resolveNativeId(legacyId: number): number | null {
    const alias = this.options.identities.resolveNumericAliasGlobal('config_item', legacyId)
    if (!alias || !/^\d+$/.test(alias.resourceId)) return null
    const nativeId = Number(alias.resourceId)
    return Number.isSafeInteger(nativeId) && nativeId > 0 ? nativeId : null
  }

  private entryLegacyIdFor(nativeId: number, orgId: string): number {
    return this.options.identities.allocateNumericAlias('config_entry', String(nativeId), orgId)
  }
}

function unwrapNative<T>(result: { success: boolean; data?: T; error?: { code: string; message: string } }): T {
  if (result.success && result.data !== undefined) return result.data
  const status = result.error?.code === 'not_found' ? 404 : result.error?.code === 'conflict' ? 409 : 400
  throw new SudoworkConfigError(status, result.error?.message ?? '配置项操作失败')
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function optionalText(body: Record<string, unknown>, key: string): string | undefined {
  return key in body ? (typeof body[key] === 'string' ? body[key].trim() : '') : undefined
}
