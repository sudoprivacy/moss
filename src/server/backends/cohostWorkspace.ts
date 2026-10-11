import type { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { posix } from 'node:path'
import { cohostRepositoryPath } from './cohostSessionState.js'
import type { WorkspaceFileAccess, WorkspaceRemoteEntry } from './podWorkspace.js'
import { ManagedAgentClient } from '../nexus/managedAgentClient.js'
import { resolveCohostNexusConfig } from '../nexus/nexusEnvConfig.js'
import { connectSessionRuntime } from '../nexus/sessionConnection.js'
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

/** Use the owned execution daemon's workspace, including its authorization and hooks. */
export function createCohostWorkspaceAccess(
  session: SessionRecord,
  runtime: Pick<RuntimeService, 'connectInternalChannel'>,
  connect = connectCohostWorkspace,
): WorkspaceFileAccess {
  const withWorkspace = async <T>(operation: (client: NexusVfsClient, token: string, root: string) => Promise<T>): Promise<T> => {
    const channel = await runtime.connectInternalChannel(session.sessionId)
    const { processId, binding } = await readLiveManagedExecution(channel, session.sessionId)
    const { client, authToken } = await connect(session.userId)
    try {
      const descriptor = await new ManagedAgentClient(client, authToken).getSession(processId)
      const expectedAgent = session.assistantName ? sessionAgentName(session.userId, session.assistantName) : undefined
      if (!expectedAgent || binding.ownerId !== session.userId || binding.agentId !== expectedAgent || descriptor.owner_id !== session.userId || descriptor.agent_id !== expectedAgent ||
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
          // The VFS client returns absolute entry paths; older clients return basenames.
          const name = child.name.startsWith(`${directory}/`)
            ? child.name.slice(directory.length + 1) : child.name
          if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
            throw new ResourceAccessError(503, 'Invalid cohost workspace entry')
          }
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
      await rejectWorkspaceLinks(client, token, root, path)
      return client.read(path, token)
    }),
    writeFile: (relativePath, content, mode) => withWorkspace(async (client, token, root) => {
      if (mode !== undefined) throw new ResourceAccessError(400, 'Cohost workspace file mode is managed by Nexus')
      const path = cohostWorkspacePath(root, relativePath)
      await rejectWorkspaceLinks(client, token, root, path)
      await client.mkdir(posix.dirname(path), token, { parents: true, existOk: true })
      await client.write(path, content, token)
    }),
  }
}

async function connectCohostWorkspace(ownerId: string): Promise<{ client: NexusVfsClient; authToken: string }> {
  return connectSessionRuntime(resolveCohostNexusConfig(), ownerId)
}

async function rejectWorkspaceLinks(client: NexusVfsClient, token: string, root: string, path: string): Promise<void> {
  let current = root
  for (const component of posix.relative(root, path).split('/').filter(Boolean)) {
    current = posix.join(current, component)
    const info = await client.stat(current, token)
    if (info?.entryType === 6) throw new ResourceAccessError(400, 'Workspace files must not be symbolic links')
  }
}
