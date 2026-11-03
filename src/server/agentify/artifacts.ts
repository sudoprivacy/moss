/**
 * Collect the files of a session — what the employee gave it (inputs) and
 * what it produced (outputs, intermediates) — and copy them into the agent
 * home, so later sessions (any employee) and other agents can reach the work
 * after the session workspace is gone.
 *
 * Deliverables stay in the workspace root by convention and intermediates are
 * moved to `.drafts/` (see draftsCleanup.ts). A file is an input when it was
 * uploaded through the workspace API, when a user message names it (usually
 * `@文件名`) before the agent changed it, or when it was already there before
 * the agent first acted in the session.
 */
import { createHash } from 'crypto'
import { readdir, readFile, stat } from 'fs/promises'
import path from 'path'
import type { AgentHomeStore } from './agentHome.js'
import { artifactDir, inputDir, safeRelative } from './agentHome.js'

export interface ArtifactEntry {
  /** Path relative to the session workspace. */
  path: string
  role: 'input' | 'output' | 'intermediate'
  size: number
  modifiedAt: number
  /** Where the copy lives in the agent home; null when too large to copy. */
  homePath: string | null
  /** sha256 of the content (null when not read: too large). */
  sha256?: string | null
  /** Same content as this earlier entry (re-uploads); not copied again. */
  duplicateOf?: string
}

/** What tells inputs apart from outputs. */
export interface InputHints {
  /** Workspace-relative paths uploaded through the workspace API. */
  uploaded: string[]
  /** User messages with their time (ms), to find files they name. */
  userTurns: Array<{ text: string; at: number | null }>
  /** When the agent first replied or used a tool (ms); null if never. */
  agentStartedAt: number | null
}

const CLIENT_UPLOAD = /_nexus_\d{10,}(\.[^.]+)?$/

/** File names as people say them: `报表_nexus_1791447625115.xls` → `报表.xls`. */
export function displayName(rel: string): string {
  const base = rel.split('/').pop() ?? rel
  return base.replace(/_nexus_\d{10,}(?=\.[^.]+$|$)/, '')
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

/** Decide a file's role; null = not part of this session. */
export function classifyFile(
  f: { rel: string; mtime: number },
  window: { start: number; end: number },
  hints: InputHints | undefined,
): ArtifactEntry['role'] | null {
  const inWindow = f.mtime >= window.start - 60_000 && f.mtime <= window.end + 5 * 60_000
  if (hints) {
    if (hints.uploaded.includes(f.rel)) return 'input'
    // The moss client names the files it uploads `<name>_nexus_<timestamp>.<ext>`.
    if (CLIENT_UPLOAD.test(f.rel.split('/').pop()!) && !f.rel.startsWith('.drafts/') && !f.rel.startsWith('output/')) return 'input'
    const base = f.rel.split('/').pop()!
    const shown = displayName(f.rel)
    for (const t of hints.userTurns) {
      if (!t.text.includes(base) && !(shown.length >= 4 && t.text.includes(shown))) continue
      // Named by the employee and not rewritten by the agent afterwards.
      if (t.at === null || f.mtime <= t.at + 5_000) return 'input'
    }
    if (inWindow && hints.agentStartedAt !== null && f.mtime < hints.agentStartedAt && !f.rel.startsWith('.drafts/') && !f.rel.startsWith('output/')) {
      return 'input'
    }
  }
  if (!inWindow) return null
  return f.rel.startsWith('.drafts/') ? 'intermediate' : 'output'
}

/**
 * Files of this session. A cron workspace is reused across runs, so the
 * session's time window (not the folder) decides which outputs belong to it;
 * inputs named in the conversation are kept even when older.
 */
export async function collectArtifacts(input: {
  home: AgentHomeStore
  orgId: string
  agentId: string
  sessionId: string
  workspace: string
  windowStartMs: number
  windowEndMs: number
  hints?: InputHints
  limits?: ArtifactLimits
}): Promise<ArtifactEntry[]> {
  const limits = input.limits ?? DEFAULT_ARTIFACT_LIMITS
  const found: Array<{ rel: string; abs: string; size: number; mtime: number }> = []
  await walk(input.workspace, '', found, { files: limits.maxFiles * 20 })
  const roleOrder = { input: 0, output: 1, intermediate: 2 } as const
  const picked = found
    .map(f => ({ ...f, role: classifyFile(f, { start: input.windowStartMs, end: input.windowEndMs }, input.hints) }))
    .filter((f): f is typeof f & { role: ArtifactEntry['role'] } => f.role !== null)
    .sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || b.mtime - a.mtime)
    .slice(0, limits.maxFiles)

  const entries: ArtifactEntry[] = []
  const byHash = new Map<string, string>()
  let total = 0
  for (const f of picked) {
    const destRoot = f.role === 'input' ? inputDir(input.orgId, input.agentId, input.sessionId) : artifactDir(input.orgId, input.agentId, input.sessionId)
    let homePath: string | null = null
    let sha256: string | null = null
    let duplicateOf: string | undefined
    if (f.size <= limits.maxFileBytes) {
      try {
        const content = await readFile(f.abs)
        sha256 = createHash('sha256').update(content).digest('hex')
        duplicateOf = byHash.get(sha256)
        // Same content as an input: a re-upload of it, so an input too.
        if (duplicateOf && entries.find(e => e.path === duplicateOf)?.role === 'input') f.role = 'input'
        if (!duplicateOf && total + f.size <= limits.maxTotalBytes) {
          const dest = `${destRoot}/${safeRelative(f.rel)}`
          // Skip the copy when an identical-size file is already there (re-digest).
          if ((await input.home.size(dest)) !== f.size) await input.home.write(dest, content)
          homePath = dest
          total += f.size
          byHash.set(sha256, f.rel)
        }
      } catch (err) {
        console.warn(`[agentify] could not copy session file ${f.rel}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    entries.push({ path: f.rel, role: f.role, size: f.size, modifiedAt: Math.round(f.mtime), homePath, sha256, ...(duplicateOf ? { duplicateOf } : {}) })
  }
  return entries
}

/** Readable list for summaries and the history index. */
export function describeArtifacts(entries: ArtifactEntry[]): string[] {
  return entries.map(e => {
    const kb = e.size < 1024 ? `${e.size} B` : e.size < 1024 * 1024 ? `${(e.size / 1024).toFixed(1)} KB` : `${(e.size / 1024 / 1024).toFixed(1)} MB`
    const role = e.role === 'input' ? '输入' : e.role === 'output' ? '产出' : '中间文件'
    const note = e.duplicateOf ? `，与 ${e.duplicateOf} 内容相同` : e.homePath ? '' : '，过大未保存副本'
    return `${e.path}（${role}，${kb}${note}）`
  })
}
