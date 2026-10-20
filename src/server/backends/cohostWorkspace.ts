import type { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { posix } from 'node:path'
import { cohostRepositoryPath } from './cohostSessionState.js'
import type { WorkspaceFileAccess, WorkspaceRemoteEntry } from './podWorkspace.js'
import { ManagedAgentClient } from '../nexus/managedAgentClient.js'
import { sessionAgentName } from '../agentIdentity.js'
import type { RuntimeService } from '../runtimeService.js'
import type { SessionRecord } from '../types.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import { readLiveManagedExecution } from './liveManagedExecution.js'

import { assertCohostWorkspaceNoLinks, cohostWorkspaceEntryName, cohostWorkspacePath, writeCohostWorkspaceFile } from './cohostWorkspaceFiles.js'

/** Use the owned execution daemon's workspace, including its authorization and hooks. */
export function createCohostWorkspaceAccess(
  session: SessionRecord,
  runtime: Pick<RuntimeService, 'connectInternalChannel' | 'connectCohostRuntime'>,
): WorkspaceFileAccess {
  const withWorkspace = async <T>(operation: (client: NexusVfsClient, token: string, root: string) => Promise<T>): Promise<T> => {
    if (session.desiredState === 'terminated') {
      throw new ResourceAccessError(409, 'Session was terminated')
    }
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
