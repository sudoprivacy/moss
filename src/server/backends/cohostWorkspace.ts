import { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { posix } from 'node:path'
import { readCohostSessionState } from './cohostSessionState.js'
import type { WorkspaceFileAccess, WorkspaceRemoteEntry } from './podWorkspace.js'
import { ManagedAgentClient } from '../nexus/managedAgentClient.js'
import { resolveCohostNexusConfig } from '../nexus/nexusEnvConfig.js'
import { mintSessionIdentity } from '../nexus/sessionIdentity.js'
import { sessionAgentName } from '../agentIdentity.js'
import type { RuntimeService } from '../runtimeService.js'
import type { SessionRecord } from '../types.js'
import { ResourceAccessError } from '../catalog/resourceError.js'

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
  runtime: Pick<RuntimeService, 'ensureSessionReady'>,
  connect = connectCohostWorkspace,
): WorkspaceFileAccess {
  const withWorkspace = async <T>(operation: (client: NexusVfsClient, token: string, root: string) => Promise<T>): Promise<T> => {
    await runtime.ensureSessionReady(session.sessionId)
    const state = await readCohostSessionState(session.cwd)
    if (!state) throw new ResourceAccessError(503, 'Cohost workspace is not ready')
    const { client, authToken } = await connect(session.userId)
    try {
      const descriptor = await new ManagedAgentClient(client, authToken).getSession(state.sessionId)
      const expectedAgent = session.assistantName ? sessionAgentName(session.userId, session.assistantName) : undefined
      if (!expectedAgent || descriptor.owner_id !== session.userId || descriptor.agent_id !== expectedAgent ||
          descriptor.session_id !== state.sessionId || descriptor.durable_session_id !== state.durableSessionId) {
        throw new ResourceAccessError(403, 'Cohost workspace owner does not match the session')
      }
      const root = `/proc/${state.sessionId}/workspace`
      if (descriptor.workspace_path.replace(/\/+$/, '') !== root) {
        throw new ResourceAccessError(503, 'Invalid cohost workspace descriptor')
      }
      return await operation(client, authToken, root)
    } finally { client.close() }
  }
  return {
    listTree: maxDepth => withWorkspace(async (client, token, root) => {
      const entries: WorkspaceRemoteEntry[] = []
      const walk = async (relativePath: string, depth: number): Promise<void> => {
        if (depth >= maxDepth || entries.length >= 5000) return
        const children = await client.readdir(cohostWorkspacePath(root, relativePath), token)
        for (const child of children.slice(0, 500)) {
          if (entries.length >= 5000) break
          if (!child.name || child.name === '.' || child.name === '..' || /[\\/\0]/.test(child.name)) {
            throw new ResourceAccessError(503, 'Invalid cohost workspace entry')
          }
          const path = posix.join(relativePath, child.name)
          const info = await client.stat(cohostWorkspacePath(root, path), token)
          if (!info) continue
          const isSymbolicLink = child.entryType === 6
          const isDir = info.isDirectory && !isSymbolicLink
          entries.push({ relativePath: path, isDir, isSymbolicLink, size: info.size })
          if (isDir && !['.git', 'node_modules'].includes(child.name)) await walk(path, depth + 1)
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
  const config = resolveCohostNexusConfig()
  const identity = await mintSessionIdentity(config.endpoint, config.tls, ownerId)
  const tls = identity?.tls ?? config.tls
  return {
    client: tls ? NexusVfsClient.withMtls(config.endpoint, tls) : new NexusVfsClient(config.endpoint),
    authToken: config.authToken,
  }
}

async function rejectWorkspaceLinks(client: NexusVfsClient, token: string, root: string, path: string): Promise<void> {
  let current = root
  for (const component of posix.relative(root, path).split('/').filter(Boolean)) {
    current = posix.join(current, component)
    const info = await client.stat(current, token)
    if (info?.entryType === 6) throw new ResourceAccessError(400, 'Workspace files must not be symbolic links')
  }
}
