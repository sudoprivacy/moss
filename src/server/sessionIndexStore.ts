import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import type { SessionSummary } from './sessionManager.js'
import type { SessionIndex, SessionIndexEntry } from './types.js'

export function getSessionIndexPath(): string {
  return join(getClaudeConfigHomeDir(), 'direct-connect', 'sessions.json')
}

export async function readSessionIndex(
  filePath = getSessionIndexPath(),
): Promise<SessionIndex> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as SessionIndex
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export async function writeSessionIndex(
  sessions: SessionSummary[],
  filePath = getSessionIndexPath(),
): Promise<void> {
  const existing = await readSessionIndex(filePath)
  const active: SessionIndex = Object.fromEntries(
    sessions.map(session => {
      const entry: SessionIndexEntry = {
        sessionId: session.sessionId,
        transcriptSessionId: session.sessionId,
        cwd: session.workDir,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
        userId: session.userId,
        orgId: session.orgId,
        role: session.role,
        scopes: session.scopes,
        runtime: session.runtime,
      }
      return [session.sessionId, entry]
    }),
  )
  const index: SessionIndex = {
    ...existing,
    ...active,
  }

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}

export async function removeSessionIndexEntry(
  sessionId: string,
  filePath = getSessionIndexPath(),
): Promise<void> {
  const index = await readSessionIndex(filePath)
  if (!(sessionId in index)) {
    return
  }
  delete index[sessionId]
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}
