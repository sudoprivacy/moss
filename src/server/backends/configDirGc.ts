/**
 * configDir 兜底清理
 *
 * 用于清理异常退出遗留的 session configDir
 */

import { readdir, stat, rm } from 'fs/promises'
import path from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

/**
 * 清理超过 maxAgeDays 天未访问的 session configDir
 */
export async function gcSessionConfigDirs(maxAgeDays = 7): Promise<{
  cleaned: string[]
  errors: Array<{ dir: string; error: string }>
}> {
  const sessionsRoot = path.join(
    getClaudeConfigHomeDir(),
    'direct-connect-runtime',
    'sessions'
  )

  const cleaned: string[] = []
  const errors: Array<{ dir: string; error: string }> = []

  let entries
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return { cleaned, errors }
  }

  const now = Date.now()
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const sessionDir = path.join(sessionsRoot, entry.name)

    try {
      const stats = await stat(sessionDir)
      const ageMs = now - stats.atimeMs

      if (ageMs > maxAgeMs) {
        await rm(sessionDir, { recursive: true, force: true })
        cleaned.push(entry.name)
      }
    } catch (e: any) {
      errors.push({ dir: entry.name, error: e.message })
    }
  }

  return { cleaned, errors }
}
