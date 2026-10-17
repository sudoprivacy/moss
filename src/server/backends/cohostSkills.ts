import type { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { MAX_RESOURCE_ENTRIES, MAX_RESOURCE_FILE_BYTES, ownerFileMode } from '@sudo/resource-files'
import { posix } from 'node:path'
import { WORKSPACE_SKILLS_DIRECTORY } from '../../utils/skills/localSkillDirectories.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import { assertCohostWorkspaceNoLinks, cohostWorkspaceEntryName, cohostWorkspacePath, writeCohostWorkspaceFile, writeCohostWorkspaceFiles } from './cohostWorkspace.js'

const OWNERSHIP_PATH = '.nexus/sudocode/.moss-skills.json'
const OWNERSHIP_FORMAT = 'moss-workspace-skills/1'

function skillName(directory: string, name: unknown): string {
  if (typeof name !== 'string' || !name || /[\\/\0]/.test(name) || ['.', '..'].includes(name)) {
    throw new ResourceAccessError(409, 'Invalid managed skill ownership')
  }
  cohostWorkspacePath(directory, name)
  return name
}

/** Ownership is a durable provenance fact, not a copy of the catalog or live runner state. */
async function readOwnership(client: NexusVfsClient, token: string, project: string, directory: string): Promise<string[]> {
  const path = cohostWorkspacePath(project, OWNERSHIP_PATH)
  await assertCohostWorkspaceNoLinks(client, token, project, path)
  const info = await client.stat(path, token)
  if (!info) return []
  if (info.isDirectory || !Number.isSafeInteger(info.size) || info.size > MAX_RESOURCE_FILE_BYTES) {
    throw new ResourceAccessError(409, 'Invalid managed skill ownership')
  }
  const raw = await client.read(path, token)
  if (raw.length > MAX_RESOURCE_FILE_BYTES) throw new ResourceAccessError(409, 'Invalid managed skill ownership')
  let value: unknown
  try { value = JSON.parse(raw.toString()) }
  catch { throw new ResourceAccessError(409, 'Invalid managed skill ownership') }
  if (!value || typeof value !== 'object' || !('format' in value) || value.format !== OWNERSHIP_FORMAT ||
      !('skills' in value) || !Array.isArray(value.skills) || value.skills.length > MAX_RESOURCE_ENTRIES) {
    throw new ResourceAccessError(409, 'Invalid managed skill ownership')
  }
  const names = value.skills.map(name => skillName(directory, name))
  if (new Set(names).size !== names.length) throw new ResourceAccessError(409, 'Invalid managed skill ownership')
  return names
}

/** Older cohosts copied only assets. Adopt only byte-identical assets without user instructions. */
async function verifyLegacyAssets(client: NexusVfsClient, token: string, directory: string,
  expected: Map<string, Buffer>, signal?: AbortSignal): Promise<void> {
  let entries = 0
  const conflict = () => new ResourceAccessError(409, 'Catalog skill conflicts with user-owned project files')
  const visit = async (path: string, depth: number): Promise<void> => {
    signal?.throwIfAborted()
    if (depth > 32) throw conflict()
    const children = await client.readdir(path, token)
    entries += children.length
    if (entries > MAX_RESOURCE_ENTRIES) throw conflict()
    for (const child of children) {
      const name = cohostWorkspaceEntryName(path, child.name)
      const target = cohostWorkspacePath(path, name)
      const info = await client.stat(target, token)
      if (!info || info.entryType === 6) throw conflict()
      if (info.isDirectory) await visit(target, depth + 1)
      else {
        const bytes = expected.get(target)
        if ((depth === 0 && name === 'SKILL.md') || !bytes || info.size !== bytes.length || !(await client.read(target, token)).equals(bytes)) throw conflict()
      }
    }
  }
  await visit(directory, 0)
}

/** Reconcile the derived skill catalog before an engine discovers its project context. */
export async function syncCohostSkills(
  client: NexusVfsClient, token: string, project: string,
  assets: Array<{ path: string; content: Buffer; mode: number }>, signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const directory = cohostWorkspacePath(project, WORKSPACE_SKILLS_DIRECTORY)
  if (assets.length > MAX_RESOURCE_ENTRIES) throw new Error('Managed skill catalog exceeds entry limits')
  const paths = new Set<string>()
  const skills = new Map<string, Map<string, Buffer>>()
  for (const asset of assets) {
    if (!asset.path.startsWith(`${WORKSPACE_SKILLS_DIRECTORY}/`) || ownerFileMode(asset.mode) !== asset.mode) throw new Error('Invalid managed skill asset')
    const path = cohostWorkspacePath(directory, asset.path.slice(WORKSPACE_SKILLS_DIRECTORY.length + 1))
    const relative = posix.relative(directory, path).split('/')
    if (relative.length < 2) throw new Error('Invalid managed skill asset')
    const name = skillName(directory, relative[0])
    if (paths.has(path)) throw new Error('Duplicate managed skill asset')
    paths.add(path)
    if (!skills.has(name)) skills.set(name, new Map())
    skills.get(name)!.set(path, asset.content)
  }
  await assertCohostWorkspaceNoLinks(client, token, project, directory)
  const owned = await readOwnership(client, token, project, directory)
  const ownedNames = new Set(owned)
  const claimed = [...new Set([...owned, ...skills.keys()])].sort()
  if (claimed.length > MAX_RESOURCE_ENTRIES) throw new Error('Managed skill ownership exceeds entry limits')
  for (const name of claimed) {
    const path = cohostWorkspacePath(directory, name)
    await assertCohostWorkspaceNoLinks(client, token, project, path)
    const info = await client.stat(path, token)
    if (info && !info.isDirectory) throw new ResourceAccessError(409, 'Catalog skill conflicts with user-owned project files')
    if (info && !ownedNames.has(name)) await verifyLegacyAssets(client, token, path, skills.get(name)!, signal)
  }
  const writeOwnership = async (names: string[]) => writeCohostWorkspaceFile(client, token, project, OWNERSHIP_PATH,
    Buffer.from(JSON.stringify({ format: OWNERSHIP_FORMAT, skills: names })), 0o600)
  signal?.throwIfAborted()
  // Claim before copying so another controller can remove a partial installation after a crash.
  if (claimed.length > owned.length) await writeOwnership(claimed)
  for (const name of claimed) {
    signal?.throwIfAborted()
    await client.delete(cohostWorkspacePath(directory, name), token, { recursive: true })
  }
  await writeCohostWorkspaceFiles(client, token, project, assets, signal)
  if (claimed.length > skills.size) await writeOwnership([...skills.keys()].sort())
}
