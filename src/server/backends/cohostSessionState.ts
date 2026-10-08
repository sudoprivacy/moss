import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface CohostSessionState {
  sessionId: string
  durableSessionId: string
}

/** The host-side session locator contains no credentials. */
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
  for (const id of [value.sessionId, value.durableSessionId]) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new Error('Invalid cohost session state')
    }
  }
  return value as CohostSessionState
}

/** Atomic replacement preserves the durable ID across process and host restarts. */
export async function writeCohostSessionState(cwd: string, state: CohostSessionState): Promise<void> {
  const path = cohostSessionStatePath(cwd)
  await mkdir(join(cwd, '.moss'), { recursive: true })
  const pending = `${path}.${randomUUID()}.pending`
  await writeFile(pending, JSON.stringify(state), { mode: 0o600 })
  await rename(pending, path)
}
