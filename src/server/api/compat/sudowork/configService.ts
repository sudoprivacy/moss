import type { DbDriver, SqlParam, SqlRow } from '../../../db/driver.js'
import type { AuthCenterDb } from '../../../authCenter/db.js'
import type { ConfigItemsApi } from '../../configItems.js'
import { assertTrustedCommandContext, type CommandContext } from '../../../application/commandContext.js'
import type { IdentityRepository } from '../../../identity/identityRepository.js'
import type { IdentityActor } from '../../../identity/organizationIdentityService.js'

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
    db: DbDriver
    configItems: ConfigItemsApi
    identities: IdentityRepository
    authDb: AuthCenterDb
    managedImages?: {
      read(kind: 'enterprise', filename: string): Promise<{ bytes: Buffer; mimeType: string }>
    }
    clientPolicy?: {
      getPublicConfig(orgId?: string): Promise<Record<string, unknown>> | Record<string, unknown>
    }
  }) {}

  async list(input: {
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
    const params: SqlParam[] = []
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
    const total = Number((await this.options.db.get<SqlRow>(`SELECT COUNT(*) AS count FROM config_items ci ${where}`, params))?.count ?? 0)
    const rows = await this.options.db.all<SqlRow>(`
      SELECT ci.*, (
        SELECT COUNT(*) FROM config_item_org_assignments assignment WHERE assignment.config_item_id = ci.id
      ) AS assigned_count
      FROM config_items ci ${where}
      ORDER BY ci.updated_at DESC, ci.id DESC LIMIT ? OFFSET ?
    `, [...params, pageSize, (page - 1) * pageSize])
    return {
      items: await Promise.all(rows.map(row => this.legacyItem(row, input.actor.orgId))), total, page, page_size: pageSize,
    }
  }

  async create(actor: IdentityActor, body: Record<string, unknown>): Promise<{ id: number }> {
    this.assertAdmin(actor)
    const name = text(body.name)
    if (!name) throw new SudoworkConfigError(400, '配置项名称不能为空')
    if (name.length > 20) throw new SudoworkConfigError(400, '配置项名称不超过20个字符')
    let id: number | null = null
    try {
      const result = await this.options.configItems.create(actor.orgId, actor.userId, {
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
      id = Number((item as { id: number }).id)
      const availability = body.visible_to_all === 1 && actor.role === 'super_admin' ? 'all' : 'organization'
      await this.options.db.run('UPDATE config_items SET availability = ? WHERE id = ?', [availability, id])
      return { id: await this.legacyIdFor(id, actor.orgId) }
    } catch (error) {
      if (id !== null) await this.deleteNativeConfigItem(id)
      throw error
    }
  }

  async get(actor: IdentityActor, id: number) {
    const item = await this.requireManageable(actor, id)
    const nativeId = Number(item.id)
    return {
      ...await this.legacyItem(item, actor.orgId),
      entries: await this.entries(nativeId, String(item.org_id ?? actor.orgId)),
      enterprises: await this.enterpriseRows(nativeId, true),
    }
  }

  async update(actor: IdentityActor, id: number, body: Record<string, unknown>): Promise<void> {
    const item = await this.requireManageable(actor, id)
    const nativeId = Number(item.id)
    if (Number(item.status) === 0) throw new SudoworkConfigError(400, '禁用状态的配置项不能编辑')
    let nativeUpdated = false
    try {
      const result = await this.options.configItems.update(
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
      nativeUpdated = true
      if (body.visible_to_all !== undefined) {
        if (actor.role !== 'super_admin' && body.visible_to_all === 1) {
          throw new SudoworkConfigError(403, '权限不足')
        }
        await this.options.db.run('UPDATE config_items SET availability = ? WHERE id = ?', [
          body.visible_to_all === 1 ? 'all' : 'organization', nativeId,
        ])
      }
    } catch (error) {
      if (nativeUpdated) await this.restoreNativeConfigItem(item)
      throw error
    }
  }

  async updateStatus(actor: IdentityActor, id: number, status: number): Promise<void> {
    const item = await this.requireManageable(actor, id)
    const nativeId = Number(item.id)
    if (status !== 0 && status !== 1) throw new SudoworkConfigError(400, '状态值无效')
    if (Number(item.status) === status) throw new SudoworkConfigError(400, '状态未发生变化')
    unwrapNative(await this.options.configItems.updateStatus(String(item.org_id ?? actor.orgId), actor.userId, nativeId, status))
    if (status === 0) await this.options.db.run('DELETE FROM config_item_org_assignments WHERE config_item_id = ?', [nativeId])
  }

  async entriesFor(actor: IdentityActor, id: number) {
    const item = await this.requireManageable(actor, id)
    return this.entries(Number(item.id), String(item.org_id ?? actor.orgId))
  }

  async replaceEntries(actor: IdentityActor, id: number, entries: unknown): Promise<void> {
    const item = await this.requireManageable(actor, id)
    const nativeId = Number(item.id)
    if (Number(item.status) === 0) throw new SudoworkConfigError(400, '禁用状态的配置项不能修改配置列表')
    if (!Array.isArray(entries)) throw new SudoworkConfigError(400, 'entries 必须为数组')
    const previousEntryIds = (await this.options.db.all<{ id: number }>(
      'SELECT id FROM config_entries WHERE config_item_id = ?',
      [nativeId],
    )).map(row => row.id)
    unwrapNative(await this.options.configItems.update(
      String(item.org_id ?? actor.orgId), actor.userId, nativeId,
      { entries: entries as Array<{ config_key: string; name: string; config_desc?: string; required?: boolean }> },
    ))
    for (const entryId of previousEntryIds) {
      await this.options.db.run(
        `DELETE FROM resource_numeric_aliases WHERE namespace = 'config_entry' AND resource_id = ?`,
        [String(entryId)],
      )
    }
    for (const entry of await this.rawEntries(nativeId)) {
      await this.options.identities.allocateNumericAlias(
        'config_entry', String(entry.id), String(item.org_id ?? actor.orgId),
      )
    }
  }

  async listEnterprises(actor: IdentityActor, id: number, page = 1, pageSize = 20) {
    const item = await this.requireManageable(actor, id)
    const items = await this.enterpriseRows(Number(item.id), false)
    const offset = (Math.max(1, page) - 1) * pageSize
    return { items: items.slice(offset, offset + pageSize), total: items.length, page, page_size: pageSize }
  }

  async associate(actor: IdentityActor, id: number, legacyEnterpriseId: number): Promise<void> {
    const item = await this.requireManageable(actor, id)
    const nativeId = Number(item.id)
    if (Number(item.status) === 0) throw new SudoworkConfigError(400, '禁用状态的配置项不能关联企业')
    const org = await this.requireLegacyOrganization(legacyEnterpriseId)
    if (actor.role !== 'super_admin' && org.resourceId !== actor.orgId) throw new SudoworkConfigError(403, '权限不足')
    try {
      await this.options.db.transaction(async () => {
        await this.options.db.run(`
          INSERT INTO config_item_org_assignments (config_item_id, org_id, created_at) VALUES (?, ?, ?)
        `, [nativeId, org.resourceId, Date.now()])
        await this.options.db.run(`UPDATE config_items SET availability = 'assigned', updated_at = ? WHERE id = ?`, [Date.now(), nativeId])
      })
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new SudoworkConfigError(400, '该企业已关联此配置项')
      throw error
    }
  }

  async dissociate(actor: IdentityActor, id: number, legacyEnterpriseId: number): Promise<void> {
    const item = await this.requireManageable(actor, id)
    const nativeId = Number(item.id)
    const org = await this.requireLegacyOrganization(legacyEnterpriseId)
    if (actor.role !== 'super_admin' && org.resourceId !== actor.orgId) throw new SudoworkConfigError(403, '权限不足')
    const changes = await this.options.db.run(`
      DELETE FROM config_item_org_assignments WHERE config_item_id = ? AND org_id = ?
    `, [nativeId, org.resourceId])
    if (changes === 0) throw new SudoworkConfigError(404, '该企业未关联此配置项')
  }

  async listForUser(actor: IdentityActor) {
    const items = await this.options.db.all<SqlRow>(`
      SELECT ci.*
      FROM config_items ci
      WHERE ci.status = 1
        AND (
          ci.org_id = ?
          OR ci.availability = 'all'
          OR EXISTS (
            SELECT 1 FROM config_item_org_assignments assignment
            WHERE assignment.config_item_id = ci.id AND assignment.org_id = ?
          )
        )
      ORDER BY ci.updated_at DESC, ci.id DESC
    `, [actor.orgId, actor.orgId])
    return await Promise.all(items.map(async item => ({
      ...await this.legacyItem(item, String(item.org_id ?? actor.orgId)),
      entries: await this.entries(Number(item.id), String(item.org_id ?? actor.orgId)),
    })))
  }

  async importConfigItem(actor: IdentityActor, input: ImportedConfigItem, context: CommandContext): Promise<{ id: number }> {
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
    if (!(await this.options.identities.getOrganizationProfile(input.ownerOrgId))) {
      throw new SudoworkConfigError(400, `配置项所属组织不存在: ${input.ownerOrgId}`)
    }
    for (const orgId of new Set(input.assignedOrgIds)) {
      if (!(await this.options.identities.getOrganizationProfile(orgId))) {
        throw new SudoworkConfigError(400, `配置项关联组织不存在: ${orgId}`)
      }
    }

    const commandType = 'configuration.import_item'
    const previous = await this.options.identities.getCommandResult<{ id: number }>(commandType, context.idempotencyKey)
    if (previous) return previous

    return await this.options.db.transaction(async () => {
      const repeated = await this.options.identities.getCommandResult<{ id: number }>(commandType, context.idempotencyKey)
      if (repeated) return repeated

      const created = unwrapNative(await this.options.configItems.create(input.ownerOrgId, actor.userId, {
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
      await this.options.db.run(`
        UPDATE config_items
        SET availability = ?, status = ?, pinyin = ?, created_at = ?, updated_at = ?
        WHERE id = ?
      `, [
        availability,
        input.status,
        input.pinyin,
        input.createdAt ?? Date.now(),
        input.updatedAt ?? input.createdAt ?? Date.now(),
        nativeId,
      ])
      const timestamp = Date.now()
      for (const orgId of assignedOrgIds) {
        await this.options.db.run(`
          INSERT INTO config_item_org_assignments (config_item_id, org_id, created_at)
          VALUES (?, ?, ?)
        `, [nativeId, orgId, timestamp])
      }
      await this.options.identities.assignNumericAlias({
        namespace: 'config_item',
        legacyId: input.legacyId,
        resourceId: String(nativeId),
        orgId: input.ownerOrgId,
        migrationRunId: context.migrationRunId ?? null,
      })
      const entriesByKey = new Map((await this.rawEntries(nativeId)).map(entry => [String(entry.config_key), entry]))
      for (const sourceEntry of input.entries) {
        if (!Number.isSafeInteger(sourceEntry.legacyId) || sourceEntry.legacyId <= 0) {
          throw new SudoworkConfigError(400, '旧配置字段 ID 无效')
        }
        const entry = entriesByKey.get(sourceEntry.config_key)
        if (!entry) throw new SudoworkConfigError(500, `配置字段写入失败: ${sourceEntry.config_key}`)
        await this.options.db.run(`UPDATE config_entries SET created_at = ?, updated_at = ? WHERE id = ?`, [
          sourceEntry.createdAt ?? input.createdAt ?? Date.now(),
          sourceEntry.updatedAt ?? input.updatedAt ?? sourceEntry.createdAt ?? input.createdAt ?? Date.now(),
          Number(entry.id),
        ])
        await this.options.identities.assignNumericAlias({
          namespace: 'config_entry',
          legacyId: sourceEntry.legacyId,
          resourceId: String(entry.id),
          orgId: input.ownerOrgId,
          migrationRunId: context.migrationRunId ?? null,
        })
      }
      const result = { id: input.legacyId }
      await this.options.identities.recordCommandResult(commandType, context.idempotencyKey, context.source, result)
      return result
    })
  }

  async getTenantConfig(actor: IdentityActor, code: string) {
    const profile = await this.options.identities.getOrganizationProfileByCode(code)
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
      ...(await this.options.clientPolicy?.getPublicConfig(profile.orgId) ?? {}),
    }
  }

  private async deleteNativeConfigItem(id: number): Promise<void> {
    const entryIds = (await this.options.db.all<{ id: number }>('SELECT id FROM config_entries WHERE config_item_id = ?', [id]))
      .map(row => String(row.id))
    for (const entryId of entryIds) {
      await this.options.db.run(
        'DELETE FROM resource_numeric_aliases WHERE namespace = ? AND resource_id = ?',
        ['config_entry', entryId],
      )
    }
    await this.options.db.run(
      'DELETE FROM resource_numeric_aliases WHERE namespace = ? AND resource_id = ?',
      ['config_item', String(id)],
    )
    await this.options.db.run('DELETE FROM config_item_org_assignments WHERE config_item_id = ?', [id])
    await this.options.db.run('DELETE FROM config_entries WHERE config_item_id = ?', [id])
    await this.options.db.run('DELETE FROM config_items WHERE id = ?', [id])
  }

  private async restoreNativeConfigItem(row: SqlRow): Promise<void> {
    const sqlValue = (value: unknown): SqlParam => {
      if (
        typeof value === 'string'
        || typeof value === 'number'
        || typeof value === 'bigint'
        || value instanceof Uint8Array
      ) return value
      return null
    }
    await this.options.db.run(`
      UPDATE config_items
      SET name = ?, description = ?, icon = ?, pinyin = ?, url_pattern = ?,
          scheme = ?, bearer_prefix = ?, updated_at = ?
      WHERE id = ?
    `, [
      sqlValue(row.name),
      sqlValue(row.description),
      sqlValue(row.icon),
      sqlValue(row.pinyin),
      sqlValue(row.url_pattern),
      sqlValue(row.scheme),
      sqlValue(row.bearer_prefix),
      sqlValue(row.updated_at) ?? Date.now(),
      sqlValue(row.id),
    ])
  }

  private async requireManageable(actor: IdentityActor, id: number): Promise<SqlRow> {
    this.assertAdmin(actor)
    const nativeId = await this.resolveNativeId(id)
    const item = nativeId === null
      ? undefined
      : await this.options.db.get<SqlRow>('SELECT * FROM config_items WHERE id = ?', [nativeId])
    if (!item) throw new SudoworkConfigError(404, '配置项不存在')
    if (actor.role !== 'super_admin' && item.org_id !== actor.orgId) throw new SudoworkConfigError(403, '权限不足')
    return item
  }

  private assertAdmin(actor: IdentityActor): void {
    if (actor.role !== 'admin' && actor.role !== 'super_admin') throw new SudoworkConfigError(403, '权限不足')
  }

  private async entries(id: number, orgId: string): Promise<SqlRow[]> {
    return Promise.all((await this.rawEntries(id)).map(async entry => ({
      ...entry,
      id: await this.entryLegacyIdFor(Number(entry.id), orgId),
    })))
  }

  private rawEntries(id: number): Promise<SqlRow[]> {
    return this.options.db.all<SqlRow>('SELECT * FROM config_entries WHERE config_item_id = ? ORDER BY id', [id])
  }

  private async enterpriseRows(id: number, associatedOnly: boolean): Promise<SqlRow[]> {
    const item = await this.options.db.get<SqlRow>('SELECT * FROM config_items WHERE id = ?', [id])
    if (!item) throw new SudoworkConfigError(404, '配置项不存在')
    const assigned = new Set((await this.options.db.all<{ org_id: string }>(
      'SELECT org_id FROM config_item_org_assignments WHERE config_item_id = ?',
      [id],
    )).map(row => row.org_id))
    const rows = await Promise.all((await this.options.authDb.listOrganizations()).map(async (org) => {
      const legacyId = await this.options.identities.getNumericAlias('enterprise', org.id)
      if (legacyId === null) return []
      const isAssociated = item.availability === 'all'
        || (item.availability === 'organization' && item.org_id === org.id)
        || (item.availability === 'assigned' && assigned.has(org.id))
      if (associatedOnly && !isAssociated) return []
      const profile = await this.options.identities.getOrganizationProfile(org.id)
      return [{ id: legacyId, name: org.name, code: profile?.code ?? `moss-${org.id}`, is_associated: isAssociated ? 1 : 0 }]
    }))
    return rows.flat()
  }

  private async requireLegacyOrganization(legacyId: number) {
    const result = await this.options.identities.resolveNumericAliasGlobal('enterprise', legacyId)
    if (!result) throw new SudoworkConfigError(404, '企业不存在')
    return result
  }

  private async legacyItem(row: SqlRow, fallbackOrgId: string): Promise<SqlRow> {
    const assignedRow = row.assigned_count === undefined
      ? await this.options.db.get<SqlRow>(
          'SELECT COUNT(*) AS count FROM config_item_org_assignments WHERE config_item_id = ?',
          [Number(row.id)],
        )
      : undefined
    const assigned = Number(row.assigned_count ?? assignedRow?.count ?? 0)
    return {
      ...row,
      id: await this.legacyIdFor(Number(row.id), String(row.org_id ?? fallbackOrgId)),
      visible_to_all: row.availability === 'all' ? 1 : 0,
      enterprise_count: row.availability === 'all' ? (await this.options.authDb.listOrganizations()).length : assigned,
    }
  }

  private legacyIdFor(nativeId: number, orgId: string): Promise<number> {
    return this.options.identities.allocateNumericAlias('config_item', String(nativeId), orgId)
  }

  private async resolveNativeId(legacyId: number): Promise<number | null> {
    const alias = await this.options.identities.resolveNumericAliasGlobal('config_item', legacyId)
    if (!alias || !/^\d+$/.test(alias.resourceId)) return null
    const nativeId = Number(alias.resourceId)
    return Number.isSafeInteger(nativeId) && nativeId > 0 ? nativeId : null
  }

  private entryLegacyIdFor(nativeId: number, orgId: string): Promise<number> {
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
