import type { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { posix } from 'node:path'
import pMap from 'p-map'
import { cohostRepositoryPath } from './cohostSessionState.js'
import type { WorkspaceFileAccess, WorkspaceRemoteEntry } from './podWorkspace.js'
import { ManagedAgentClient } from '../nexus/managedAgentClient.js'
import { sessionAgentName } from '../agentIdentity.js'
import type { RuntimeService } from '../runtimeService.js'
import type { SessionRecord } from '../types.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import { readLiveManagedExecution } from './liveManagedExecution.js'

/** Validate both HTTP paths and daemon dirents before constructing an RPC path. */
export function cohostWorkspacePath(root: string, relativePath: string): string {
  const path = relativePath.replace(/\\/g, '/')
  if (path.includes('\0') || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    throw new ResourceAccessError(400, 'Path must be relative')
  }
  const normalized = posix.normalize(path)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new ResourceAccessError(400, 'Path escapes workspace root')
  }
  return posix.join(root, normalized)
}

/** Accept one direct daemon entry, including the absolute paths returned by the official client. */
export function cohostWorkspaceEntryName(directory: string, value: string): string {
  const name = value.startsWith(`${directory}/`) ? value.slice(directory.length + 1) : value
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw new ResourceAccessError(503, 'Invalid cohost workspace entry')
  }
  return name
}

/** Use the owned execution daemon's workspace, including its authorization and hooks. */
export function createCohostWorkspaceAccess(
  session: SessionRecord,
  runtime: Pick<RuntimeService, 'connectInternalChannel' | 'connectCohostRuntime'>,
): WorkspaceFileAccess {
  const withWorkspace = async <T>(operation: (client: NexusVfsClient, token: string, root: string) => Promise<T>): Promise<T> => {
    const channel = await runtime.connectInternalChannel(session.sessionId)
    const { processId, binding } = await readLiveManagedExecution(channel, session.sessionId)
    const expectedAgent = session.assistantName ? sessionAgentName(session.userId, session.assistantName) : undefined
    if (!expectedAgent || binding.ownerId !== session.userId || binding.agentId !== expectedAgent) {
      throw new ResourceAccessError(403, 'Cohost workspace owner does not match the session')
    }
    const { client, authToken } = await runtime.connectCohostRuntime(session.userId, expectedAgent)
    try {
      const descriptor = await new ManagedAgentClient(client, authToken).getSession(processId)
      if (descriptor.owner_id !== session.userId || descriptor.agent_id !== expectedAgent ||
          descriptor.session_id !== processId || descriptor.durable_session_id !== binding.durableSessionId) {
        throw new ResourceAccessError(403, 'Cohost workspace owner does not match the session')
      }
      const processRoot = `/proc/${processId}/workspace`
      if (descriptor.workspace_path.replace(/\/+$/, '') !== processRoot) {
        throw new ResourceAccessError(503, 'Invalid cohost workspace descriptor')
      }
      const expectedRepository = cohostRepositoryPath(expectedAgent, session.sessionId)
      if (binding.repositoryPath !== expectedRepository && binding.repositoryPath !== session.cwd) {
        throw new ResourceAccessError(403, 'Cohost repository does not belong to this session')
      }
      const root = binding.repositoryPath === expectedRepository ? expectedRepository : processRoot
      return await operation(client, authToken, root)
    } finally { client.close() }
  }
  return {
    listTree: maxDepth => withWorkspace(async (client, token, root) => {
      const entries: WorkspaceRemoteEntry[] = []
      const walk = async (relativePath: string, depth: number): Promise<void> => {
        if (depth >= maxDepth || entries.length >= 5000) return
        const directory = cohostWorkspacePath(root, relativePath)
        const children = await client.readdir(directory, token)
        for (const child of children.slice(0, 500)) {
          if (entries.length >= 5000) break
          const name = cohostWorkspaceEntryName(directory, child.name)
          const path = posix.join(relativePath, name)
          const info = await client.stat(cohostWorkspacePath(root, path), token)
          if (!info) continue
          const isSymbolicLink = child.entryType === 6
          const isDir = info.isDirectory && !isSymbolicLink
          entries.push({ relativePath: path, isDir, isSymbolicLink, size: info.size })
          if (isDir && !['.git', 'node_modules'].includes(name)) await walk(path, depth + 1)
        }
      }
      await walk('', 0)
      return entries
    }),
    readFile: relativePath => withWorkspace(async (client, token, root) => {
      const path = cohostWorkspacePath(root, relativePath)
      await assertCohostWorkspaceNoLinks(client, token, root, path)
      return client.read(path, token)
    }),
    writeFile: (relativePath, content, mode) => withWorkspace((client, token, root) =>
      writeCohostWorkspaceFile(client, token, root, relativePath, content, mode)),
  }
}

/** Use one authorized write path for uploads, catalog resources and startup skills. */
export async function writeCohostWorkspaceFile(
  client: NexusVfsClient, token: string, root: string,
  relativePath: string, content: Buffer, mode?: number,
): Promise<void> {
  await writeCohostWorkspaceFiles(client, token, root, [{ path: relativePath, content, mode }])
}

/** Share directory preparation within one bounded write operation; drain writes before failure. */
export async function writeCohostWorkspaceFiles(
  client: NexusVfsClient, token: string, root: string,
  files: Array<{ path: string; content: Buffer; mode?: number }>, signal?: AbortSignal,
): Promise<void> {
  const normalizedRoot = posix.normalize(root).replace(/\/+$/, '') || '/'
  const entries = files.map(file => {
    if (file.mode !== undefined && (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777)) {
      throw new ResourceAccessError(400, 'Invalid workspace file mode')
    }
    const path = cohostWorkspacePath(normalizedRoot, file.path)
    if (path === normalizedRoot) throw new ResourceAccessError(400, 'Path must name a workspace file')
    return { ...file, path }
  })
  const directories = new Map<string, Promise<void>>()
  const prepareDirectory = (path: string): Promise<void> => {
    if (path === normalizedRoot) return Promise.resolve()
    const existing = directories.get(path)
    if (existing) return existing
    const prepared = (async () => {
      await prepareDirectory(posix.dirname(path))
      signal?.throwIfAborted()
      const info = await client.stat(path, token)
      assertNotLink(info?.entryType)
      if (!info) await client.mkdir(path, token, { parents: false, existOk: true })
      else if (!info.isDirectory) throw new ResourceAccessError(400, 'Workspace parent must be a directory')
    })()
    directories.set(path, prepared)
    return prepared
  }
  let isFailed = false
  let firstError: unknown
  await pMap(entries, async file => {
    if (isFailed) return
    try {
      signal?.throwIfAborted()
      await prepareDirectory(posix.dirname(file.path))
      signal?.throwIfAborted()
      assertNotLink((await client.stat(file.path, token))?.entryType)
      await client.write(file.path, file.content, token)
      if (file.mode !== undefined) await client.chmod(file.path, file.mode, token)
    } catch (error) {
      if (!isFailed) { isFailed = true; firstError = error }
    }
  }, { concurrency: 8 })
  if (isFailed) throw firstError
}

/** Refuse native links in any path component below the verified project root. */
export async function assertCohostWorkspaceNoLinks(client: NexusVfsClient, token: string, root: string, path: string): Promise<void> {
  let current = root
  for (const component of posix.relative(root, path).split('/').filter(Boolean)) {
    current = posix.join(current, component)
    const info = await client.stat(current, token)
    assertNotLink(info?.entryType)
    if (!info) return
  }
}

function assertNotLink(entryType: number | undefined): void {
  if (entryType === 6) throw new ResourceAccessError(400, 'Workspace files must not be symbolic links')
}
