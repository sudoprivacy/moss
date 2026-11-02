/**
 * Collect the files a session produced and copy them into the agent home, so
 * later sessions (any employee) and other agents can reach the agent's
 * finished work after the session workspace is gone.
 *
 * Deliverables stay in the workspace root by convention and intermediates are
 * moved to `.drafts/` (see draftsCleanup.ts); both are kept, labelled.
 */
import { readdir, readFile, stat } from 'fs/promises'
import path from 'path'
import type { AgentHomeStore } from './agentHome.js'
import { artifactDir, safeRelative } from './agentHome.js'

export interface ArtifactEntry {
  /** Path relative to the session workspace. */
  path: string
  role: 'output' | 'intermediate'
  size: number
  modifiedAt: number
  /** Where the copy lives in the agent home; null when too large to copy. */
  homePath: string | null
}

export interface ArtifactLimits {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
}

export const DEFAULT_ARTIFACT_LIMITS: ArtifactLimits = {
  maxFiles: Number(process.env.MOSS_AGENTIFY_ARTIFACT_MAX_FILES) || 60,
  maxFileBytes: Number(process.env.MOSS_AGENTIFY_ARTIFACT_MAX_FILE_BYTES) || 20 * 1024 * 1024,
  maxTotalBytes: Number(process.env.MOSS_AGENTIFY_ARTIFACT_MAX_TOTAL_BYTES) || 100 * 1024 * 1024,
}

/** Workspace entries that are runtime plumbing, not work. */
const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', '.venv', 'venv'])
const SKIP_FILES = new Set(['AGENTS.md', 'CLAUDE.md', '.DS_Store'])

async function walk(root: string, rel: string, out: Array<{ rel: string; abs: string; size: number; mtime: number }>, budget: { files: number }): Promise<void> {
  if (budget.files <= 0) return
  let entries
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (budget.files <= 0) return
    const childRel = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      // Hidden directories are runtime state, except the drafts folder.
      if (e.name.startsWith('.') && !(rel === '' && e.name === '.drafts')) continue
      await walk(root, childRel, out, budget)
    } else if (e.isFile()) {
      if (SKIP_FILES.has(e.name) || e.name.startsWith('.')) continue
      try {
        const st = await stat(path.join(root, childRel))
        out.push({ rel: childRel, abs: path.join(root, childRel), size: st.size, mtime: st.mtimeMs })
        budget.files -= 1
      } catch {
        // vanished
      }
    }
  }
}

/**
 * Files modified during the session window. A cron workspace is reused across
 * runs, so the window (not the folder) decides what belongs to this session.
 */
export async function collectArtifacts(input: {
  home: AgentHomeStore
  orgId: string
  agentId: string
  sessionId: string
  workspace: string
  windowStartMs: number
  windowEndMs: number
  limits?: ArtifactLimits
}): Promise<ArtifactEntry[]> {
  const limits = input.limits ?? DEFAULT_ARTIFACT_LIMITS
  const found: Array<{ rel: string; abs: string; size: number; mtime: number }> = []
  await walk(input.workspace, '', found, { files: limits.maxFiles * 20 })
  const inWindow = found
    .filter(f => f.mtime >= input.windowStartMs - 60_000 && f.mtime <= input.windowEndMs + 5 * 60_000)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limits.maxFiles)

  const destRoot = artifactDir(input.orgId, input.agentId, input.sessionId)
  const entries: ArtifactEntry[] = []
  let total = 0
  for (const f of inWindow) {
    const role: ArtifactEntry['role'] = f.rel.startsWith('.drafts/') ? 'intermediate' : 'output'
    let homePath: string | null = null
    if (f.size <= limits.maxFileBytes && total + f.size <= limits.maxTotalBytes) {
      const dest = `${destRoot}/${safeRelative(f.rel)}`
      try {
        // Skip the copy when an identical-size file is already there (re-digest).
        if ((await input.home.size(dest)) !== f.size) {
          await input.home.write(dest, await readFile(f.abs))
        }
        homePath = dest
        total += f.size
      } catch (err) {
        console.warn(`[agentify] could not copy artifact ${f.rel}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    entries.push({ path: f.rel, role, size: f.size, modifiedAt: Math.round(f.mtime), homePath })
  }
  return entries
}

/** Readable list for summaries and the history index. */
export function describeArtifacts(entries: ArtifactEntry[]): string[] {
  return entries.map(e => {
    const kb = e.size < 1024 ? `${e.size} B` : e.size < 1024 * 1024 ? `${(e.size / 1024).toFixed(1)} KB` : `${(e.size / 1024 / 1024).toFixed(1)} MB`
    const role = e.role === 'output' ? '产出' : '中间文件'
    return `${e.path}（${role}，${kb}${e.homePath ? '' : '，过大未保存副本'}）`
  })
}
