import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DbDriver, SqlRow } from '../db/driver.js'
import { ResourceAccessError as HttpError } from './resourceError.js'
import { isVisibleTo, type VisibilityFilter, type VisibleTo } from '../visibilityFilter.js'

export type ResourceKind = 'agent' | 'skill'
export type ResourceMetadata = Record<string, unknown>
export type OrganizationResource = {
  kind: ResourceKind
  id: string
  name: string
  path: string
  sourceType: string
  installationId?: string
  meta: ResourceMetadata
}
export type OrganizationResourceSnapshot = { orgId: string; resources: OrganizationResource[] }
export type OrganizationResourceScope = {
  orgId: string
  userId: string
  driver?: DbDriver
  visibility?: VisibilityFilter
  snapshot?: OrganizationResourceSnapshot
}

// An explicit request/session boundary creates the scope. No process-global
// current organization: concurrent requests and detached jobs keep their owner.
const scopes = new AsyncLocalStorage<OrganizationResourceScope>()
export const getOrganizationResourceScope = () => scopes.getStore()
export function withOrganizationResources<T>(scope: OrganizationResourceScope, work: () => T): T {
  if (!scope.orgId || (scope.snapshot && scope.snapshot.orgId !== scope.orgId)) throw new HttpError(403, 'Invalid resource organization')
  return scopes.run(scope, work)
}
function writableScope(): OrganizationResourceScope & { driver: DbDriver } {
  const scope = scopes.getStore()
  if (!scope?.driver || scope.snapshot) throw new HttpError(403, 'Resource scope is read only')
  return scope as OrganizationResourceScope & { driver: DbDriver }
}
function json(value: unknown): ResourceMetadata {
  if (typeof value !== 'string') return {}
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} } catch { return {} }
}
function parsed(value: unknown, fallback: unknown): unknown {
  if (typeof value !== 'string') return value ?? fallback
  try { return JSON.parse(value) } catch { return fallback }
}
const tableFor = (kind: ResourceKind) => kind === 'agent' ? 'tenant_assistants' : 'tenant_skills'

async function privateResource(kind: ResourceKind, row: SqlRow): Promise<OrganizationResource | null> {
  // Missing ownership/path is not public. Legacy migration must resolve it.
  if (!row.file_path) return null
  const path = String(row.file_path)
  const raw = await readFile(join(path, '_moss_meta.json'), 'utf8').catch(() => '{}')
  const meta: ResourceMetadata = { ...json(raw), ...json(row.config_json), id: String(row.id), name: String(row.name),
    source_type: row.source_type || 'tenant', enabled: Number(row.enabled) === 1, visible_to: parsed(row.visible_to, null) }
  for (const key of ['display_name', 'description', 'avatar', 'emoji', 'memory_mode', 'agent_type']) {
    if (row[key] != null) meta[key] = row[key]
  }
  for (const [column, key] of [['enabled_skills', 'enabledSkills'], ['enabled_wikis', 'enabledWikis'], ['enabled_corp_apps', 'enabledCorpApps'], ['skills', 'skills'], ['workflow', 'workflow'], ['categories', 'categories']]) {
    if (row[column!] != null) meta[key!] = parsed(row[column!], [])
  }
  Object.assign(meta, json(row.config_json), { id: String(row.id), name: String(row.name), source_type: row.source_type || 'tenant', enabled: Number(row.enabled) === 1, visible_to: parsed(row.visible_to, null) })
  return { kind, id: String(row.id), name: String(row.name), path, sourceType: String(meta.source_type), meta }
}

export async function listOrganizationResources(kind: ResourceKind): Promise<OrganizationResource[] | null> {
  const scope = scopes.getStore()
  if (!scope) return null // Explicitly unscoped offline/legacy file tooling only.
  let resources: OrganizationResource[]
  if (scope.snapshot) {
    resources = scope.snapshot.resources.filter(r => r.kind === kind)
  } else {
    if (!scope.driver) throw new HttpError(403, 'Missing organization resource repository')
    const [installed, owned] = await Promise.all([
      scope.driver.all(`SELECT * FROM org_resource_installations WHERE org_id = ? AND resource_type = ?`, [scope.orgId, kind]),
      scope.driver.all(`SELECT * FROM ${tableFor(kind)} WHERE org_id = ? AND status = 'approved' AND source_type IN ('tenant', 'custom')`, [scope.orgId]),
    ])
    resources = installed.map(row => {
      const meta = { ...json(row.manifest_json), ...json(row.config_json), id: String(row.source_resource_id), name: String(row.name), source_type: 'hub', installation_id: String(row.id) }
      return { kind, id: String(row.source_resource_id), name: String(row.name), path: String(row.artifact_ref), sourceType: 'hub', installationId: String(row.id), meta }
    })
    resources.push(...(await Promise.all(owned.map(row => privateResource(kind, row)))).filter((r): r is OrganizationResource => r !== null))
  }
  return resources.filter(r => !scope.visibility || isVisibleTo(r.meta.visible_to as VisibleTo, scope.visibility))
}

export async function findOrganizationResource(kind: ResourceKind, reference: string): Promise<OrganizationResource | null> {
  const resources = await listOrganizationResources(kind)
  if (!resources) return null
  const ref = reference.startsWith('moss:') ? reference.slice(5) : reference
  const exact = resources.filter(r => r.id === ref || r.installationId === ref)
  const matches = exact.length ? exact : resources.filter(r => r.name === ref || r.meta.display_name === ref)
  if (matches.length > 1) throw new HttpError(409, 'Ambiguous resource name; use its ID')
  return matches[0] ?? null
}
export async function requireOrganizationResource(kind: ResourceKind, reference: string): Promise<OrganizationResource> {
  const resource = await findOrganizationResource(kind, reference)
  if (!resource) throw new HttpError(404, 'Resource not found')
  return resource
}
export async function scopedResourceMetadata(kind: ResourceKind, path: string): Promise<ResourceMetadata | undefined> {
  const resources = await listOrganizationResources(kind)
  return resources?.find(r => resolve(r.path) === resolve(path))?.meta
}

export async function saveOrganizationInstallation(kind: ResourceKind, path: string, meta: ResourceMetadata, provider = 'hub'): Promise<void> {
  const scope = writableScope()
  if (typeof meta.id !== 'string' || !meta.id.trim()) throw new HttpError(400, 'A stable Hub resource ID is required')
  const now = Date.now()
  await scope.driver.run(`INSERT INTO org_resource_installations
    (id, org_id, resource_type, source_provider, source_resource_id, name, artifact_ref, manifest_json, installed_by, installed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id, resource_type, source_provider, source_resource_id) DO UPDATE SET
      name = excluded.name, artifact_ref = excluded.artifact_ref, manifest_json = excluded.manifest_json, updated_at = excluded.updated_at`,
  [randomUUID(), scope.orgId, kind, provider, meta.id, String(meta.name), path, JSON.stringify(meta), scope.userId, now, now])
}

export async function registerOrganizationCustom(kind: ResourceKind, path: string, meta: ResourceMetadata): Promise<void> {
  const scope = writableScope()
  const now = Date.now()
  await scope.driver.run(`INSERT INTO ${tableFor(kind)}
    (id, org_id, name, display_name, description, author_id, status, file_path, source_type, config_json, visible_to, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, 'custom', ?, ?, ?, ?, ?)`,
  [String(meta.id), scope.orgId, String(meta.name), String(meta.display_name ?? meta.name), String(meta.description ?? ''), scope.userId, path,
    JSON.stringify(meta), meta.visible_to == null ? null : JSON.stringify(meta.visible_to), meta.enabled === false ? 0 : 1, now, now])
}

export async function updateOrganizationResource(kind: ResourceKind, reference: string, patch: ResourceMetadata): Promise<void> {
  const scope = writableScope()
  const resource = await requireOrganizationResource(kind, reference)
  const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
  if (resource.sourceType === 'custom') {
    const owners = (resource.meta.visible_to as VisibleTo)?.user_ids
    if (!owners?.includes(scope.userId)) throw new HttpError(403, 'Only the creator can edit this custom resource')
    delete changes.visible_to
  }
  if (kind === 'agent') {
    for (const key of ['skills', 'enabledSkills']) {
      if (Array.isArray(changes[key])) changes[key] = await resolveOrganizationSkillIds(changes[key] as string[])
    }
  }
  // Serialize read/merge/write so concurrent edits to different fields survive.
  await scope.driver.transaction(async () => {
    const table = resource.installationId ? 'org_resource_installations' : tableFor(kind)
    const id = resource.installationId ?? resource.id
    const row = await scope.driver.get(`SELECT config_json FROM ${table} WHERE id = ? AND org_id = ?${scope.driver.kind === 'postgres' ? ' FOR UPDATE' : ''}`, [id, scope.orgId])
    if (!row) throw new HttpError(404, 'Resource not found')
    const config = { ...json(row.config_json), ...changes }
    await scope.driver.run(`UPDATE ${table} SET config_json = ?, updated_at = ? WHERE id = ? AND org_id = ?`, [JSON.stringify(config), Date.now(), id, scope.orgId])
    if (!resource.installationId) {
      if (changes.enabled !== undefined) await scope.driver.run(`UPDATE ${table} SET enabled = ? WHERE id = ? AND org_id = ?`, [changes.enabled ? 1 : 0, id, scope.orgId])
      if (changes.visible_to !== undefined) await scope.driver.run(`UPDATE ${table} SET visible_to = ? WHERE id = ? AND org_id = ?`, [changes.visible_to === null ? null : JSON.stringify(changes.visible_to), id, scope.orgId])
    }
  })
}
export async function resolveOrganizationSkillIds(references: string[]): Promise<string[]> {
  return Promise.all(references.map(async ref => (await requireOrganizationResource('skill', ref)).id))
}
// The native tenant routes authorize creator/department management before this
// call. Pending submissions also need overlays, without becoming installed.
export async function updateOrganizationPrivateMetadata(kind: ResourceKind, id: string, patch: ResourceMetadata): Promise<void> {
  const scope = writableScope()
  const table = tableFor(kind)
  await scope.driver.transaction(async () => {
    const row = await scope.driver.get(`SELECT config_json FROM ${table} WHERE id = ? AND org_id = ? AND source_type = 'tenant'${scope.driver.kind === 'postgres' ? ' FOR UPDATE' : ''}`, [id, scope.orgId])
    if (!row) throw new HttpError(404, 'Resource not found')
    await scope.driver.run(`UPDATE ${table} SET config_json = ?, updated_at = ? WHERE id = ? AND org_id = ?`, [JSON.stringify({ ...json(row.config_json), ...patch }), Date.now(), id, scope.orgId])
  })
}
export async function removeOrganizationResource(kind: ResourceKind, reference: string): Promise<void> {
  const scope = writableScope()
  const resource = await requireOrganizationResource(kind, reference)
  if (resource.sourceType === 'custom' && !(resource.meta.visible_to as VisibleTo)?.user_ids?.includes(scope.userId)) throw new HttpError(403, 'Only the creator can remove this custom resource')
  if (kind === 'skill') await assertOrganizationSkillUnused(resource.id, resource.name)
  const table = resource.installationId ? 'org_resource_installations' : tableFor(kind)
  await scope.driver.run(`DELETE FROM ${table} WHERE id = ? AND org_id = ?`, [resource.installationId ?? resource.id, scope.orgId])
  // Artifacts may be used by another organization or a live session. Retain them.
}
export async function assertOrganizationSkillUnused(id: string, name: string): Promise<void> {
  const scope = writableScope()
  // Dependencies include pending/disabled agents and agents hidden from the
  // caller's department. Only the owning organization participates.
  const agents = await withOrganizationResources({ ...scope, visibility: undefined }, () => listOrganizationResources('agent')) ?? []
  const pending = await scope.driver.all("SELECT * FROM tenant_assistants WHERE org_id = ? AND status != 'approved'", [scope.orgId])
  agents.push(...(await Promise.all(pending.map(row => privateResource('agent', row)))).filter((r): r is OrganizationResource => r !== null))
  if (agents.some(a => ['skills', 'enabledSkills'].some(key => Array.isArray(a.meta[key]) && (a.meta[key] as string[]).some(ref => ref === id || ref === name)))) {
    throw new HttpError(409, 'Remove this skill from this organization’s agents before uninstalling it')
  }
}
export async function snapshotOrganizationResources(): Promise<OrganizationResourceSnapshot> {
  const scope = scopes.getStore()
  if (!scope) throw new HttpError(403, 'Missing resource scope')
  const groups = await Promise.all([listOrganizationResources('agent'), listOrganizationResources('skill')])
  const resources = structuredClone(groups.flatMap(group => group ?? []).filter(r => r.meta.enabled !== false))
  for (const resource of resources.filter(r => r.kind === 'agent')) {
    if (typeof resource.meta.rules === 'string' || typeof resource.meta.ruleFile !== 'string') continue
    const file = resolve(resource.path, resource.meta.ruleFile)
    const relativeFile = relative(resolve(resource.path), file)
    if (isAbsolute(relativeFile) || relativeFile === '..' || relativeFile.startsWith(`..${sep}`)) throw new HttpError(400, 'Invalid assistant rule path')
    resource.meta.rules = await readFile(file, 'utf8')
  }
  return { orgId: scope.orgId, resources }
}

export async function pinSessionResourceSnapshot(directory: string, current: OrganizationResourceSnapshot, enabledSkills?: string[]) {
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'resources.json')
  const temp = join(directory, `.resources-${randomUUID()}.json`)
  try {
    await writeFile(temp, JSON.stringify({ snapshot: current, enabledSkills }), { flag: 'wx', mode: 0o600 })
    try { await link(temp, file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  } finally { await rm(temp, { force: true }) }
  const pinned = JSON.parse(await readFile(file, 'utf8')) as { snapshot: OrganizationResourceSnapshot; enabledSkills?: string[] }
  if (pinned.snapshot.orgId !== current.orgId) throw new HttpError(403, 'Invalid session resource organization')
  // Keep the original version/configuration, but revocation and visibility
  // changes still take effect before resuming a session.
  pinned.snapshot.resources = pinned.snapshot.resources.filter(resource => current.resources.some(r => r.kind === resource.kind && r.id === resource.id))
  return pinned
}

export async function stageOrganizationArtifact(kind: ResourceKind, bytes: Buffer, identity: string): Promise<{ dir: string; publish: () => Promise<string> }> {
  const root = join(process.env.MOSS_HOME || join(homedir(), '.moss'), 'artifacts', kind)
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, '.staging-'))
  const target = join(root, createHash('sha256').update(identity).update(bytes).digest('hex'))
  return { dir, publish: async () => {
    try { await rename(dir, target) } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
      await rm(dir, { recursive: true, force: true })
    }
    return target
  } }
}
export function newPrivateResourcePath(kind: ResourceKind, id: string): string {
  return join(process.env.MOSS_HOME || join(homedir(), '.moss'), kind === 'agent' ? 'assistants' : 'skills', 'objects', createHash('sha256').update(id).digest('hex'))
}
