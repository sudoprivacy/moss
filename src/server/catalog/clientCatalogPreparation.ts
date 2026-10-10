import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import JSZip from 'jszip'
import { packageAssistantZip, fetchAgentHubAssistantDetail } from '../agentStore.js'
import { packageSkillZip, fetchSkillHubSkillDetail } from '../skillStore.js'
import { isVisibleTo, type VisibleTo } from '../visibilityFilter.js'
import { isPublishedPublicItem } from './clientCatalogInstall.js'
import { getOrganizationResourceScope, requireOrganizationResource, type OrganizationResource } from './organizationResources.js'
import { ResourceAccessError } from './resourceError.js'
import { publishDirectory } from './publishDirectory.js'

export interface ClientPreparedResource {
  id: string
  kind: 'agents' | 'skills'
  source: string
  name: string
  version: string
  digest: string
  downloadRef: string
  runtimeRef: string
  dependencies: string[]
  isLocalAllowed: boolean
}
interface Preparation {
  protocolVersion: 1
  preparationId: string
  resources: ClientPreparedResource[]
  snapshot: OrganizationResource[]
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const PREFIX = 'moss-prepared:'

function preparationRoot() {
  const scope = getOrganizationResourceScope()
  if (!scope?.driver || !scope.visibility) throw new ResourceAccessError(403, 'Missing resource identity')
  return join(process.env.MOSS_HOME || join(homedir(), '.moss'), 'client-preparations', hash(JSON.stringify([scope.orgId, scope.userId])))
}

function dependencyIds(resource: OrganizationResource): string[] {
  return [...new Set(['skills', 'enabledSkills'].flatMap(key => Array.isArray(resource.meta[key]) ? (resource.meta[key] as unknown[]).filter((id): id is string => typeof id === 'string') : []))]
}

export function isLocalCatalogResource(meta: Record<string, unknown>): boolean {
  return meta.agent_type !== 'workflow' && meta.agentType !== 'workflow' &&
    !['enabledMcpServers', 'enabled_mcp_servers', 'enabledWikis', 'enabled_wikis', 'enabledCorpApps', 'enabled_corp_apps'].some(key => Array.isArray(meta[key]) && (meta[key] as unknown[]).length > 0)
}

/** Freeze exactly the authorized resource graph; downloads and runners share these bytes. */
export async function prepareClientCatalogResource(kind: 'agents' | 'skills', id: string) {
  const root = preparationRoot()
  const resolved = new Map<string, OrganizationResource>()
  const visit = async (resourceKind: 'agent' | 'skill', reference: string) => {
    const resource = await requireOrganizationResource(resourceKind, reference)
    if (resource.meta.enabled === false) throw new ResourceAccessError(404, 'Resource not available')
    const key = `${resource.kind}:${resource.id}`
    if (resolved.has(key)) return
    resolved.set(key, resource)
    for (const dependency of dependencyIds(resource)) await visit('skill', dependency)
  }
  await visit(kind === 'agents' ? 'agent' : 'skill', id)
  const archives = await Promise.all([...resolved.values()].map(async resource => {
    const bytes = resource.kind === 'agent' ? await packageAssistantZip(resource.id) : await packageSkillZip(resource.id)
    if (bytes.length > 50 * 1024 * 1024) throw new ResourceAccessError(400, 'Resource archive exceeds size limit')
    return { resource, bytes, digest: hash(bytes) }
  }))
  const preparationId = hash(JSON.stringify(archives.map(({ resource, digest }) => [resource.kind, resource.id, digest])))
  const target = join(root, preparationId)
  await mkdir(root, { recursive: true })
  const staging = join(root, `.preparing-${randomUUID()}`)
  await mkdir(staging)
  try {
    const resources: ClientPreparedResource[] = []
    const snapshot: OrganizationResource[] = []
    for (const { resource, bytes, digest } of archives) {
      const resourceKind = resource.kind === 'agent' ? 'agents' : 'skills'
      const key = hash(`${resource.kind}:${resource.id}`)
      const directory = join(staging, key)
      await mkdir(directory)
      const zip = await JSZip.loadAsync(bytes)
      let expanded = 0
      const entries = Object.values(zip.files)
      if (entries.length > 5000) throw new ResourceAccessError(400, 'Resource has too many files')
      for (const entry of entries) {
        const name = (entry.unsafeOriginalName || entry.name).replace(/\\/g, '/')
        const mode = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : 0
        if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..') || (mode & 0o170000) === 0o120000) throw new ResourceAccessError(400, 'Unsafe resource archive')
        if (entry.dir) continue
        const content = await entry.async('nodebuffer')
        expanded += content.length
        if (expanded > 200 * 1024 * 1024) throw new ResourceAccessError(400, 'Expanded resource exceeds size limit')
        const file = join(directory, name)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, content, { mode: mode & 0o100 ? 0o700 : 0o600 })
      }
      const runtimeRef = `${PREFIX}${preparationId}:${resourceKind}:${encodeURIComponent(resource.id)}`
      const dependencies: string[] = []
      for (const dependency of dependencyIds(resource)) dependencies.push((await requireOrganizationResource('skill', dependency)).id)
      resources.push({ id: resource.id, kind: resourceKind, source: resource.sourceType, name: resource.name,
        version: String(resource.meta.catalogVersion ?? resource.meta.installed_version ?? resource.meta.version ?? ''), digest, runtimeRef, dependencies,
        downloadRef: `/api/v1/client/catalog/preparations/${preparationId}/${resourceKind === 'agents' ? 'agent-templates' : 'skills'}/${encodeURIComponent(resource.id)}/download`,
        isLocalAllowed: isLocalCatalogResource(resource.meta) })
      const runtimeName = `${resource.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'resource'}-${hash(resource.id).slice(0, 8)}--${digest.slice(0, 16)}`
      snapshot.push({ ...structuredClone(resource), name: resource.kind === 'skill' ? runtimeName : resource.name, path: join(target, key), meta: { ...structuredClone(resource.meta), catalogRuntimeRef: runtimeRef, catalogDigest: digest } })
      await writeFile(join(staging, `${key}.zip`), bytes, { mode: 0o600 })
    }
    const preparation: Preparation = { protocolVersion: 1, preparationId, resources, snapshot }
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(preparation), { mode: 0o600 })
    await publishDirectory(staging, target)
    return { protocolVersion: 1 as const, preparationId, resources }
  } finally { await rm(staging, { recursive: true, force: true }) }
}

async function readPreparation(id: string): Promise<Preparation> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new ResourceAccessError(404, 'Preparation not found')
  let preparation: Preparation
  try { preparation = JSON.parse(await readFile(join(preparationRoot(), id, 'manifest.json'), 'utf8')) as Preparation }
  catch { throw new ResourceAccessError(404, 'Preparation not found') }
  for (const resource of preparation.snapshot) {
    const current = await requireOrganizationResource(resource.kind, resource.id)
    if (current.meta.enabled === false || current.sourceType !== resource.sourceType) throw new ResourceAccessError(404, 'Resource access has been revoked')
    if (resource.sourceType === 'hub') {
      const detail = resource.kind === 'agent' ? await fetchAgentHubAssistantDetail(resource.id) : await fetchSkillHubSkillDetail(resource.id)
      if (!detail || detail.id !== resource.id || !isPublishedPublicItem(detail) || !isVisibleTo(detail.visible_to as VisibleTo, getOrganizationResourceScope()!.visibility!)) throw new ResourceAccessError(404, 'Resource access has been revoked')
    }
  }
  return preparation
}

/** Authorize every download again, including all required dependencies. */
export async function downloadClientPreparation(id: string, kind: 'agents' | 'skills', resourceId: string) {
  const preparation = await readPreparation(id)
  const resource = preparation.resources.find(item => item.kind === kind && item.id === resourceId)
  if (!resource) throw new ResourceAccessError(404, 'Resource not found')
  const bytes = await readFile(join(preparationRoot(), id, `${hash(`${kind === 'agents' ? 'agent' : 'skill'}:${resourceId}`)}.zip`))
  if (hash(bytes) !== resource.digest) throw new ResourceAccessError(409, 'Prepared resource is incomplete')
  return { bytes, digest: resource.digest }
}

/** Resolve an opaque, account-bound version reference before creating a runner snapshot. */
export async function resolveClientPreparedResource(kind: 'agent' | 'skill', reference: string): Promise<OrganizationResource | null> {
  if (!reference.startsWith(PREFIX)) return null
  const match = /^moss-prepared:([a-f0-9]{64}):(agents|skills):(.+)$/.exec(reference)
  if (!match || match[2] !== (kind === 'agent' ? 'agents' : 'skills')) throw new ResourceAccessError(404, 'Invalid prepared resource')
  const preparation = await readPreparation(match[1]!)
  const resource = preparation.snapshot.find(item => item.kind === kind && item.id === decodeURIComponent(match[3]!))
  if (!resource) throw new ResourceAccessError(404, 'Prepared resource not found')
  const scope = getOrganizationResourceScope()!
  scope.preparedResources ??= new Map()
  for (const item of preparation.snapshot) {
    const key = `${item.kind}:${item.id}`
    const existing = scope.preparedResources.get(key)
    if (existing && existing.meta.catalogDigest !== item.meta.catalogDigest) throw new ResourceAccessError(409, 'Conflicting resource versions')
    if (!existing) scope.preparedResources.set(key, item)
    else existing.meta.catalogRuntimeRefs = [...new Set([existing.meta.catalogRuntimeRef, ...(Array.isArray(existing.meta.catalogRuntimeRefs) ? existing.meta.catalogRuntimeRefs : []), item.meta.catalogRuntimeRef])]
  }
  return resource
}

export async function getClientPreparation(id: string) {
  const { protocolVersion, preparationId, resources } = await readPreparation(id)
  return { protocolVersion, preparationId, resources }
}

/** Materialize explicitly selected skills for a running session without replacing its runner or transcript. */
export async function materializeClientSkills(
  references: string[],
  assistantReference: string | undefined,
  write: (path: string, bytes: Buffer, mode: number) => Promise<void>,
) {
  if (assistantReference) await resolveClientPreparedResource('agent', assistantReference)
  for (const reference of references) {
    if (!reference.startsWith(PREFIX)) throw new ResourceAccessError(400, 'A prepared skill reference is required')
    await resolveClientPreparedResource('skill', reference)
  }
  const skills = [...(getOrganizationResourceScope()?.preparedResources?.values() ?? [])].filter(item => item.kind === 'skill')
  const result: { id: string; path: string; name: string }[] = []
  // Validate the complete graph before writing anything or submitting the user turn.
  for (const resource of skills) {
    const reference = String(resource.meta.catalogRuntimeRef)
    const preparationId = reference.split(':')[1]!
    const { bytes } = await downloadClientPreparation(preparationId, 'skills', resource.id)
    const zip = await JSZip.loadAsync(bytes)
    const directory = `.nexus/catalog-skills/${hash(reference)}`
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || entry.name === '_moss_meta.json') continue
      const name = (entry.unsafeOriginalName || entry.name).replace(/\\/g, '/')
      if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) throw new ResourceAccessError(400, 'Unsafe resource archive')
      const mode = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : 0
      await write(`${directory}/${name}`, await entry.async('nodebuffer'), mode & 0o100 ? 0o700 : 0o600)
    }
    result.push({ id: resource.id, name: resource.name, path: `${directory}/SKILL.md` })
  }
  return result
}
