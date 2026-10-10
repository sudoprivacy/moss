import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export interface CohostSessionState {
  durableSessionId: string
  repositoryPath?: string
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
