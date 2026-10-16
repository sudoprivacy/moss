import type { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { MAX_RESOURCE_ENTRIES, ownerFileMode } from '@sudo/resource-files'
import { assertCohostWorkspaceNoLinks, cohostWorkspacePath, writeCohostWorkspaceFiles } from './cohostWorkspace.js'

const MANAGED_SKILLS = '.nexus/sudocode/skills'

/** Reconcile the derived skill catalog before an engine discovers its project context. */
export async function syncCohostSkills(
  client: NexusVfsClient, token: string, project: string,
  assets: Array<{ path: string; content: Buffer; mode: number }>, signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const directory = cohostWorkspacePath(project, MANAGED_SKILLS)
  if (assets.length > MAX_RESOURCE_ENTRIES) throw new Error('Managed skill catalog exceeds entry limits')
  const paths = new Set<string>()
  for (const asset of assets) {
    if (!asset.path.startsWith(`${MANAGED_SKILLS}/`) || ownerFileMode(asset.mode) !== asset.mode) throw new Error('Invalid managed skill asset')
    const path = cohostWorkspacePath(directory, asset.path.slice(MANAGED_SKILLS.length + 1))
    if (paths.has(path)) throw new Error('Duplicate managed skill asset')
    paths.add(path)
  }
  await assertCohostWorkspaceNoLinks(client, token, project, directory)
  signal?.throwIfAborted()
  await client.delete(directory, token, { recursive: true })
  await writeCohostWorkspaceFiles(client, token, project, assets, signal)
}
