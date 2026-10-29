import { randomUUID } from 'node:crypto'
import { isPublicationVersion, latestPublicationVersion, nextPublicationVersion, publicationVersionError } from './publicationVersions.js'
import { cp, rm } from 'node:fs/promises'
import type { DbDriver, SqlParam, SqlRow } from '../db/driver.js'
import { ResourceAccessError } from './resourceError.js'
import { newPrivateResourcePath, requireOrganizationResource, type ResourceKind } from './organizationResources.js'

const tableFor = (kind: ResourceKind) => kind === 'agent' ? 'tenant_assistants' : 'tenant_skills'
const metadata = (row: SqlRow): Record<string, unknown> => JSON.parse(String(row.config_json || '{}'))
const keysFor = (row: SqlRow) => Object.keys(row).filter(key => /^[a-z_]+$/.test(key))
const revisionTime = (row: SqlRow) => Math.max(Date.now(), Number(row.updated_at) + 1)

/** Imported metadata must never choose the published asset it will replace. */
export function publicationMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('publication_')))
}

/** A shared expert must reference published skills, never an author's private files. */
async function publicationSkills(driver: DbDriver, kind: ResourceKind, row: SqlRow, orgId: string): Promise<string[] | undefined> {
  if (kind !== 'agent') return undefined
  const config = metadata(row)
  const parse = (value: unknown): unknown[] => { try { const result = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(result) ? result : [] } catch { return [] } }
  const ids = [...new Set([config.skills, config.enabledSkills, row.skills, row.enabled_skills].flatMap(parse).filter((id): id is string => typeof id === 'string'))]
  const published = await driver.all("SELECT * FROM tenant_skills WHERE org_id = ? AND source_type = 'tenant' AND status = 'approved' AND enabled = 1", [orgId])
  return Promise.all(ids.map(async id => {
    const resource = await requireOrganizationResource('skill', id)
    if (resource.meta.enabled === false) throw new ResourceAccessError(409, '关联技能已停用，请重新选择')
    if (resource.sourceType === 'hub') return resource.id
    const release = published.find(skill => resource.sourceType === 'custom' ? metadata(skill).publication_origin_id === resource.id : skill.id === resource.id)
    if (!release) throw new ResourceAccessError(409, `请先发布关联技能：${resource.name}`)
    return String(release.id)
  }))
}

async function publicationContext(driver: DbDriver, kind: ResourceKind, source: SqlRow, orgId: string) {
  const meta = metadata(source)
  const baseId = String(meta.publication_base_id || source.id)
  const originId = String(meta.publication_origin_id || source.id)
  const rows = (await driver.all(`SELECT * FROM ${tableFor(kind)} WHERE org_id = ? AND source_type = 'tenant'`, [orgId])).filter(row => {
    const config = metadata(row)
    return row.id === baseId || config.publication_base_id === baseId || config.publication_asset_id === baseId || config.publication_origin_id === originId
  })
  const released = rows.filter(row => ['approved', 'superseded'].includes(String(row.status))).map(row => String(row.version))
  const reserved = rows.filter(row => row.id !== source.id && ['pending', 'reviewed'].includes(String(row.status))).map(row => String(row.version))
  const currentVersion = latestPublicationVersion(released)
  const ownVersion = String(source.version || meta.installed_version || '')
  const nextVersion = currentVersion ? nextPublicationVersion(currentVersion) : isPublicationVersion(ownVersion) ? ownVersion : '1.0.0'
  return { released, reserved, currentVersion, nextVersion, publishNote: String(source.publish_note || '') }
}

export async function previewResourcePublication(driver: DbDriver, kind: ResourceKind, sourceId: string, orgId: string, userId: string) {
  const source = await driver.get(`SELECT * FROM ${tableFor(kind)} WHERE id = ? AND org_id = ? AND author_id = ?`, [sourceId, orgId, userId])
  if (!source || !(source.source_type === 'custom' || ['draft', 'rejected'].includes(String(source.status)))) throw new ResourceAccessError(403, '只能提交自己的工作稿')
  const { currentVersion, nextVersion, publishNote } = await publicationContext(driver, kind, source, orgId)
  return { currentVersion, nextVersion, publishNote }
}

function submissionNote(note: unknown, explicitVersion: unknown): string | undefined {
  if (note !== undefined && (typeof note !== 'string' || !note.trim() || note.length > 2000)) throw new ResourceAccessError(400, '请填写更新说明（最多 2000 字）')
  if (explicitVersion !== undefined && !note) throw new ResourceAccessError(400, '请填写更新说明')
  return typeof note === 'string' ? note.trim() : undefined
}

/** Submitting the same owned working copy advances one published asset. */
export async function submitResourcePublication(driver: DbDriver, kind: ResourceKind, sourceId: string, orgId: string, userId: string, visibility: unknown, note?: string, requestedVersion?: unknown): Promise<string> {
  note = submissionNote(note, requestedVersion)
  const table = tableFor(kind)
  let copiedPath: string | undefined
  try {
    return await driver.transaction(async () => {
      const working = await driver.get(`SELECT * FROM ${table} WHERE id = ? AND org_id = ? AND author_id = ? AND source_type = 'tenant'${driver.kind === 'postgres' ? ' FOR UPDATE' : ''}`, [sourceId, orgId, userId])
      if (working) {
        if (!['draft', 'rejected'].includes(String(working.status))) throw new ResourceAccessError(409, '仅草稿或被驳回的版本可以提交审核')
        const baseId = metadata(working).publication_base_id
        if (typeof baseId === 'string' && driver.kind === 'postgres') await driver.get(`SELECT id FROM ${table} WHERE id = ? AND org_id = ? FOR UPDATE`, [baseId, orgId])
        const context = await publicationContext(driver, kind, working, orgId)
        const version = requestedVersion === undefined ? context.nextVersion : requestedVersion
        const error = publicationVersionError(version, context.released, context.reserved)
        if (error) throw new ResourceAccessError(409, error)
        working.version = version as string
        working.config_json = JSON.stringify({ ...metadata(working), installed_version: version })
        const dependencies = await publicationSkills(driver, kind, working, orgId)
        if (dependencies) await driver.run(`UPDATE ${table} SET skills = ?, enabled_skills = ?, config_json = ? WHERE id = ? AND org_id = ?`, [JSON.stringify(dependencies), JSON.stringify(dependencies), JSON.stringify({ ...metadata(working), skills: dependencies, enabledSkills: dependencies }), sourceId, orgId])
        await driver.run(`UPDATE ${table} SET version = ?, publish_note = ?, config_json = ? WHERE id = ? AND org_id = ?`, [String(working.version), note || String(working.publish_note || `发布版本 ${working.version}`), JSON.stringify({ ...metadata(working), ...(dependencies ? { skills: dependencies, enabledSkills: dependencies } : {}) }), sourceId, orgId])
        await driver.run(`UPDATE ${table} SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL, updated_at = ? WHERE id = ? AND org_id = ?`, [revisionTime(working), sourceId, orgId])
        return sourceId
      }
      const source = await driver.get(`SELECT * FROM ${table} WHERE id = ? AND org_id = ? AND author_id = ? AND source_type = 'custom'${driver.kind === 'postgres' ? ' FOR UPDATE' : ''}`, [sourceId, orgId, userId])
      if (!source) throw new ResourceAccessError(403, '只能提交自己创建或导入的资产')
      const dependencies = await publicationSkills(driver, kind, source, orgId)
      const readPrior = async () => (await driver.all(`SELECT * FROM ${table} WHERE org_id = ? AND source_type = 'tenant'`, [orgId]))
        .filter(row => metadata(row).publication_origin_id === sourceId)
      let prior = await readPrior()
      const initialBase = prior.find(row => row.status === 'approved')
      if (initialBase && driver.kind === 'postgres') {
        await driver.get(`SELECT id FROM ${table} WHERE id = ? AND org_id = ? FOR UPDATE`, [String(initialBase.id), orgId])
        prior = await readPrior()
      }
      if (prior.some(row => ['pending', 'reviewed'].includes(String(row.status)))) throw new ResourceAccessError(409, '该资产已有待审核版本，请先处理已有提交')
      const base = prior.find(row => row.status === 'approved')
      const id = randomUUID()
      copiedPath = newPrivateResourcePath(kind, id)
      await cp(String(source.file_path), copiedPath, { recursive: true })
      const now = Date.now()
      const context = await publicationContext(driver, kind, source, orgId)
      const nextVersion = requestedVersion === undefined ? context.nextVersion : requestedVersion
      const error = publicationVersionError(nextVersion, context.released, context.reserved)
      if (error) throw new ResourceAccessError(409, error)
      const config = { ...publicationMetadata(metadata(source)), id, installed_version: nextVersion, publication_origin_id: sourceId,
        ...(dependencies ? { skills: dependencies, enabledSkills: dependencies } : {}),
        ...(base ? { publication_base_id: base.id, publication_base_revision: base.updated_at } : {}) }
      const draft: SqlRow = { ...source, ...(dependencies ? { skills: JSON.stringify(dependencies), enabled_skills: JSON.stringify(dependencies) } : {}), id, file_path: copiedPath, source_type: 'tenant', source_resource_id: id, version: nextVersion,
        status: 'pending', checksum: null, reviewed_by: null, reviewed_at: null, review_note: null,
        publish_note: note || `发布版本 ${nextVersion}`, visible_to: visibility == null ? null : JSON.stringify(visibility),
        config_json: JSON.stringify(config), created_at: now, updated_at: now }
      const columns = keysFor(source)
      await driver.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map(key => draft[key] as SqlParam))
      return id
    })
  } catch (error) {
    if (copiedPath) await rm(copiedPath, { recursive: true, force: true })
    throw error
  }
}

/** Keep the published ID and files untouched while a separate revision is reviewed. */
export async function forkResourceRevision(driver: DbDriver, kind: ResourceKind, original: SqlRow, owner?: { id: string; name?: string }): Promise<SqlRow> {
  const id = randomUUID()
  const path = newPrivateResourcePath(kind, id)
  const version = String(original.version || '1.0.0')
  const nextVersion = nextPublicationVersion(version)
  const row = {
    ...original, id, author_id: owner?.id || original.author_id, author_name: owner?.name || original.author_name, file_path: path, version: nextVersion, status: 'draft',
    source_resource_id: id, checksum: null, reviewed_by: null, reviewed_at: null, review_note: null,
    publish_note: `基于 ${version} 的新版本`, created_at: revisionTime(original), updated_at: revisionTime(original),
    config_json: JSON.stringify({ ...metadata(original), id, installed_version: nextVersion,
      publication_base_id: original.id, publication_base_revision: original.updated_at }),
  }
  // Match the physical schema of the source row, including compatibility columns.
  const columns = keysFor(original)
  await cp(String(original.file_path), path, { recursive: true })
  try {
    await driver.run(`INSERT INTO ${tableFor(kind)} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map(key => row[key as keyof typeof row] as SqlParam))
  } catch (error) {
    await rm(path, { recursive: true, force: true })
    throw error
  }
  return row
}

/** Atomically advance the stable catalog ID and preserve the previous version. */
export async function publishResourceRevision(driver: DbDriver, kind: ResourceKind, id: string, orgId: string, reviewer: string, note?: string): Promise<string> {
  const table = tableFor(kind)
  const lock = driver.kind === 'postgres' ? ' FOR UPDATE' : ''
  return driver.transaction(async () => {
    const draft = await driver.get(`SELECT * FROM ${table} WHERE id = ? AND org_id = ? AND source_type = 'tenant'${lock}`, [id, orgId])
    if (!draft || !['pending', 'reviewed'].includes(String(draft.status))) throw new ResourceAccessError(409, '当前版本不可发布，请刷新后重试')
    await publicationSkills(driver, kind, draft, orgId)
    const context = await publicationContext(driver, kind, draft, orgId)
    const error = publicationVersionError(draft.version, context.released, context.reserved)
    if (error) throw new ResourceAccessError(409, error)
    const config = metadata(draft)
    const baseId = typeof config.publication_base_id === 'string' ? config.publication_base_id : null
    const now = revisionTime(draft)
    if (!baseId) {
      await driver.run(`UPDATE ${table} SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ? AND org_id = ?`, [reviewer, now, note || null, now, id, orgId])
      return id
    }
    const base = await driver.get(`SELECT * FROM ${table} WHERE id = ? AND org_id = ?${lock}`, [baseId, orgId])
    if (!base || base.status !== 'approved' || String(base.updated_at) !== String(config.publication_base_revision)) {
      throw new ResourceAccessError(409, '已发布版本已发生变化，请基于最新版本重新编辑提交')
    }
    delete config.publication_base_id
    delete config.publication_base_revision
    const published = { ...draft, config_json: JSON.stringify({ ...config, id: baseId }), status: 'approved', reviewed_by: reviewer, reviewed_at: now, review_note: note || null, updated_at: now, created_at: base.created_at }
    const history = { ...base, config_json: JSON.stringify({ ...metadata(base), publication_asset_id: baseId }), status: 'superseded' }
    // IDs remain fixed: references and client caches follow baseId; the review row becomes history.
    const columns = keysFor(base).filter(key => !['id', 'org_id', 'source_resource_id'].includes(key))
    for (const [target, values] of [[id, history], [baseId, published]] as const) {
      await driver.run(`UPDATE ${table} SET ${columns.map(key => `${key} = ?`).join(', ')} WHERE id = ? AND org_id = ?`, [...columns.map(key => (values as SqlRow)[key] as SqlParam), target, orgId])
    }
    return baseId
  })
}
