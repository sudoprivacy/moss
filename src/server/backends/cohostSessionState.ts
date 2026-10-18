import { readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { DirectConnectStore } from '../db.js'
import type { SessionRecord } from '../types.js'

export interface CohostSessionState {
  durableSessionId: string
  repositoryPath?: string
}

/**
 * Provisioning can fail before a runner ever starts. Binding is committed before
 * the runner accepts input; completed startup and the UI transcript independently
 * rule out treating an existing conversation as an uninitialized one.
 */
export async function isUninitializedCohostSession(
  store: Pick<DirectConnectStore, 'cohostSessions' | 'latestEvent'>,
  session: Pick<SessionRecord, 'sessionId' | 'transcriptPath'>,
): Promise<boolean> {
  if (!session.transcriptPath) return false
  if (await store.cohostSessions.get(session.sessionId) ||
      await store.latestEvent(session.sessionId, 'attempt_spawned')) return false
  try {
    const metadata = await stat(session.transcriptPath)
    return metadata.isFile() && metadata.size === 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

/** A session's repository outlives the ManagedAgentService process ID. */
export function cohostRepositoryPath(agentId: string, sessionId: string): string {
  if (!agentId || /[\\/\0]/.test(agentId) || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    throw new Error('Invalid cohost repository identity')
  }
  return `/agents/${agentId}/workspaces/${sessionId}`
}

/** Locator written by earlier cohost deployments, read only during migration. */
export function cohostSessionStatePath(cwd: string): string {
  return join(cwd, '.moss', 'cohost-session.json')
}

/** Missing state denotes an older deployment; malformed state must never reset history. */
export async function readCohostSessionState(cwd: string): Promise<CohostSessionState | undefined> {
  let raw: string
  try { raw = await readFile(cohostSessionStatePath(cwd), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const value = JSON.parse(raw) as Partial<CohostSessionState>
  if (typeof value.durableSessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.durableSessionId)) {
    throw new Error('Invalid cohost session state')
  }
  if (value.repositoryPath !== undefined &&
      (typeof value.repositoryPath !== 'string' ||
       !/^\/agents\/[^/\\\0]+\/workspaces\/[A-Za-z0-9_-]{1,128}$/.test(value.repositoryPath))) {
    throw new Error('Invalid cohost repository path')
  }
  return {
    durableSessionId: value.durableSessionId,
    ...(value.repositoryPath ? { repositoryPath: value.repositoryPath } : {}),
  }
}

/** Remove the old locator only after its identity is committed to the shared store. */
export async function removeCohostSessionState(cwd: string): Promise<void> {
  try { await unlink(cohostSessionStatePath(cwd)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
