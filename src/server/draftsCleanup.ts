import { mkdir } from 'fs/promises'
import path from 'path'

export const DRAFTS_DIR_NAME = '.drafts'

const FILE_INTENT_MARKERS = {
  final: ['@final', '@output', '@deliverable', '@result'],
  draft: ['@draft', '@intermediate', '@temp', '@scratch'],
}

const DRAFT_FILE_PATTERNS = {
  prefixes: [
    'temp_',
    'temp-',
    'tmp_',
    'tmp-',
    'temporary_',
    'temporary-',
    'draft_',
    'draft-',
    'wip_',
    'wip-',
    'scratch_',
    'scratch-',
    'proto_',
    'proto-',
    'poc_',
    'poc-',
    'step_',
    'step-',
    'step1',
    'step2',
    'step3',
    'step4',
    'step5',
    'phase_',
    'phase-',
    'phase1',
    'phase2',
    'phase3',
  ],
  suffixes: [
    '_draft',
    '-draft',
    '_wip',
    '-wip',
    '_temp',
    '-temp',
    '_tmp',
    '-tmp',
    '_backup',
    '-backup',
    '_bak',
    '-bak',
    '_old',
    '-old',
  ],
}

const DRAFT_EXTENSIONS = ['.tmp', '.temp', '.bak', '.backup', '.log', '.cache']

const COMMENT_SYNTAX_MAP: Record<string, string> = {
  '.py': '#',
  '.pyw': '#',
  '.sh': '#',
  '.bash': '#',
  '.zsh': '#',
  '.rb': '#',
  '.pl': '#',
  '.pm': '#',
  '.lua': '--',
  '.r': '#',
  '.rscript': '#',
  '.js': '//',
  '.jsx': '//',
  '.ts': '//',
  '.tsx': '//',
  '.mjs': '//',
  '.cjs': '//',
  '.es6': '//',
  '.c': '//',
  '.cpp': '//',
  '.cc': '//',
  '.cxx': '//',
  '.h': '//',
  '.hpp': '//',
  '.java': '//',
  '.cs': '//',
  '.go': '//',
  '.rs': '//',
  '.swift': '//',
  '.kt': '//',
  '.kts': '//',
  '.yaml': '#',
  '.yml': '#',
  '.toml': '#',
  '.ini': '#',
  '.conf': '#',
  '.cfg': '#',
  '.html': '<!--',
  '.htm': '<!--',
  '.xml': '<!--',
  '.svg': '<!--',
  '.md': '<!--',
  '.markdown': '<!--',
  default: '#',
}

type FileIntentResult = {
  intent: 'final' | 'draft' | 'unknown'
  reason: string
  marker?: string
  line?: number
}

export function matchesDraftPattern(fileName: string): boolean {
  const lower = fileName.toLowerCase()

  for (const prefix of DRAFT_FILE_PATTERNS.prefixes) {
    if (lower.startsWith(prefix)) return true
  }

  const ext = path.extname(lower)
  const baseName = lower.slice(0, lower.length - ext.length)
  for (const suffix of DRAFT_FILE_PATTERNS.suffixes) {
    if (baseName.endsWith(suffix)) return true
  }

  return DRAFT_EXTENSIONS.includes(ext)
}

export function detectFileIntent(filePath: string, content: string): FileIntentResult {
  if (filePath.split(/[\\/]/).includes(DRAFTS_DIR_NAME)) return { intent: 'draft', reason: 'Draft directory' }
  const ext = path.extname(filePath).toLowerCase()
  if (['.json', '.csv'].includes(ext)) return { intent: 'unknown', reason: 'Format does not support comments' }
  const commentPrefix = COMMENT_SYNTAX_MAP[ext] || COMMENT_SYNTAX_MAP.default
  const lines = content.split('\n').slice(0, 10)

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim()
    let commentContent: string | null = null

    if (commentPrefix === '<!--') {
      if (line.startsWith('<!--') && line.endsWith('-->')) {
        commentContent = line.slice(4, -3).trim()
      }
    } else if (line.startsWith(commentPrefix)) {
      commentContent = line.slice(commentPrefix.length).trim()
    }

    if (!commentContent) continue

    for (const marker of FILE_INTENT_MARKERS.final) {
      if (commentContent.includes(marker)) {
        return {
          intent: 'final',
          reason: `Detected ${marker} marker at line ${index + 1}`,
          marker,
          line: index + 1,
        }
      }
    }

    for (const marker of FILE_INTENT_MARKERS.draft) {
      if (commentContent.includes(marker)) {
        return {
          intent: 'draft',
          reason: `Detected ${marker} marker at line ${index + 1}`,
          marker,
          line: index + 1,
        }
      }
    }
  }

  return { intent: 'unknown', reason: 'No marker found' }
}

export async function ensureDraftsDirectory(workspace: string): Promise<string> {
  const draftsDir = path.join(workspace, DRAFTS_DIR_NAME)
  await mkdir(draftsDir, { recursive: true })
  return draftsDir
}

/** Retained for older callers; never sweep input files or relocate live dependencies. */
export async function cleanupIntermediateFiles(workspace: string): Promise<void> {
  await ensureDraftsDirectory(workspace)
}

export function buildDraftsInstruction(workspace: string): string {
  return `[Workspace files]
Workspace: ${workspace}
Drafts (草稿箱): ${workspace}/.drafts

Create temporary scripts, intermediate data and dependencies directly in .drafts/.
Keep final deliverables at the user-requested workspace path. Scripts in .drafts must
use explicit workspace output paths, not derive outputs from the script directory.
Keep file contents valid: never add @final/@draft markers to JSON, CSV or binary
files. No intent comments are required in any format. Preserve shebangs, encoding
and XML declarations, uploaded inputs, and existing workspace files.
Keep reusable drafts after a turn or cancellation. Do not delete dependencies or
move files still needed by another step. Use .drafts/ for the 草稿箱 UI name.
Before finishing, use moss_declare_artifacts when available to declare each newly
generated final or draft file. Mark release=true only for drafts that no later step
needs at the current path; this allows safe physical archival. Declare final files
only after validating their contents; JSON must parse with a standard JSON parser.
If validation fails, repair once and revalidate, otherwise report the failure.
[End workspace files]`
}
