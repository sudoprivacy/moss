import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  fetchSkillHubSkillDetail,
  getInstalledSkills,
  installHubSkill,
  type InstalledSkillInfo,
} from './skillStore.js'
import { getHubApiBaseUrl, getHubAuthorization, getCosBaseUrl } from './hubConfig.js'
import type { VisibleTo } from './visibilityFilter.js'

// Support MOSS_HOME environment variable for Docker/container environments
const MOSS_HOME = process.env.MOSS_HOME || path.join(os.homedir(), '.moss')
const MOSS_ASSISTANTS_DIR = path.join(MOSS_HOME, 'assistants')
const ASSISTANT_HUB_DIR = path.join(MOSS_ASSISTANTS_DIR, 'hub')
const ASSISTANT_SYSTEM_DIR = path.join(MOSS_ASSISTANTS_DIR, 'system')
const ASSISTANT_CUSTOM_DIR = path.join(
  MOSS_ASSISTANTS_DIR,
  'custom',
)
const ASSISTANT_TENANT_DIR = path.join(MOSS_ASSISTANTS_DIR, 'tenant')
// Staging area for non-admin-published tenant agents awaiting approval.
// Deliberately excluded from ASSISTANT_SEARCH_DIRS so pending files stay invisible
// to the runtime scan until approval MOVES them into ASSISTANT_TENANT_DIR.
export const ASSISTANT_TENANT_PENDING_DIR = path.join(MOSS_ASSISTANTS_DIR, 'tenant-pending')
const ASSISTANT_SEARCH_DIRS = [
  ASSISTANT_CUSTOM_DIR,
  ASSISTANT_HUB_DIR,
  ASSISTANT_SYSTEM_DIR,
  ASSISTANT_TENANT_DIR,
]

export const ASSISTANT_META_FILE = '_moss_meta.json'

const COMMON_RULE_FILE_NAMES = [
  'system.md',
  'prompt.md',
  'assistant.md',
  'instructions.md',
  'rules.md',
]

const DOCUMENTATION_MARKDOWN_PATTERNS = [
  /^readme(?:\.[^.]+)?$/i,
  /^changelog(?:\.[^.]+)?$/i,
  /^license(?:\.[^.]+)?$/i,
  /^contributing(?:\.[^.]+)?$/i,
]

function getHubCategoriesUrl(): string {
  return `${getHubApiBaseUrl()}/categories`
}

function getAssistantHubBaseUrl(): string {
  return `${getHubApiBaseUrl()}/assistants`
}

function getAssistantHubCursorUrl(): string {
  return `${getAssistantHubBaseUrl()}/cursor`
}

export type AgentHubAssistant = {
  id: string
  name: string
  display_name: string
  description?: string
  avatar?: string
  emoji?: string | null
  category?: string
  categories?: string[]
  skills?: string[]
  core_features?: unknown
  applicable_scenarios?: unknown
  sourceUrl?: string
  [key: string]: unknown
}

export type AgentHubDetail = AgentHubAssistant & {
  versions?: Array<Record<string, unknown>>
}

export type AssistantStoreMeta = {
  id?: string
  name?: string
  display_name?: string
  description?: string
  avatar?: string
  emoji?: string | null
  defaultInitPrompt?: string
  promptsI18n?: Record<string, string[]>
  category?: string
  categories?: string[]
  source_type?: 'hub' | 'upload' | 'custom' | 'tenant'
  feature?: string
  tag?: string
  is_builtin?: boolean
  enabled?: boolean
  installed_version?: string
  installed_at?: string
  ruleFile?: string
  skills?: string[]
  enabledSkills?: string[]
  /** Document Center: Wiki IDs this agent is authorised to query via wikiCli. */
  enabledWikis?: string[]
  /** 企业应用管理: Corp App instance IDs this agent may use via the corpapp CLI. */
  enabledCorpApps?: string[]
  /** 企业鉴权: when true, this agent may fetch the user's corp OAuth2 provider token via the corpauth CLI. */
  enableCorpAuth?: boolean
  agent_type?: 'chat' | 'workflow'
  memory_mode?: 'session' | 'user'
  visible_to?: VisibleTo
  workflow?: {
    trigger: 'cron' | 'webhook' | 'manual'
    cron?: string
    webhook_path?: string
    output_targets?: string[]
    output_webhook?: string
    timeout_minutes?: number
  } | null
  [key: string]: unknown
}

export type InstalledAssistantInfo = {
  id: string
  name: string
  displayName: string
  description: string
  avatar: string
  emoji: string
  defaultInitPrompt: string
  promptsI18n: Record<string, string[]>
  category: string
  categories: string[]
  version: string
  source: string
  isBuiltin: boolean
  isHubInstalled: boolean
  enabled: boolean
  tag: string
  skills: string[]
  enabledSkills: string[]
  meta: AssistantStoreMeta | null
  agentType: 'chat' | 'workflow'
  memoryMode: 'session' | 'user'
  visibleTo: VisibleTo
  workflow: AssistantStoreMeta['workflow']
}

export type FetchAgentHubAssistantsParams = {
  cursor?: string
  limit?: number
  query?: string
  category?: string
}

type AssistantSearchResult = {
  dir: string
  category: 'custom' | 'hub' | 'system' | 'tenant'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item || '').trim())
      .filter(Boolean)
  }
  if (typeof value !== 'string' || !value.trim()) {
    return []
  }

  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed
          .map(item => String(item || '').trim())
          .filter(Boolean)
      : []
  } catch {
    return [value.trim()]
  }
}

function normalizeVersion(value: unknown): string {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  const lower = normalized.toLowerCase()
  if (lower === 'unknown' || lower === 'unkown') return ''
  return normalized
}

function normalizeAssistantRelativePath(filePath: unknown): string {
  if (typeof filePath !== 'string') return ''
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (!normalized) return ''
  if (/^[a-zA-Z]:\//.test(normalized)) return ''
  if (normalized.startsWith('/')) return ''

  const safePath = path.posix.normalize(normalized)
  if (safePath === '.' || safePath === '..' || safePath.startsWith('../')) {
    return ''
  }
  return safePath
}

function isDocumentationMarkdownFile(fileName: string): boolean {
  return DOCUMENTATION_MARKDOWN_PATTERNS.some(pattern => pattern.test(fileName))
}

function normalizeZipEntryPath(entryPath: string): string {
  return path.posix
    .normalize(entryPath.replaceAll('\\', '/').replace(/^\.\/+/, ''))
}

function isUnsafeZipEntryPath(entryPath: string): boolean {
  if (!entryPath || entryPath === '.') return false
  if (/^[a-zA-Z]:[\\/]/.test(entryPath)) return true
  if (entryPath.startsWith('/') || entryPath.startsWith('\\')) return true
  const normalized = entryPath.replace(/\\/g, '/').replace(/^\.\/+/, '')
  return normalized === '..' || normalized.startsWith('../')
}

function buildInstalledSkillLookup(
  installedSkills: InstalledSkillInfo[],
): Map<string, InstalledSkillInfo> {
  const lookup = new Map<string, InstalledSkillInfo>()

  for (const skill of installedSkills) {
    const keys = [skill.id, skill.name, path.basename(skill.source)]
      .map(value => String(value || '').trim())
      .filter(Boolean)

    for (const key of keys) {
      if (!lookup.has(key)) {
        lookup.set(key, skill)
      }
    }
  }

  return lookup
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', getHubAuthorization())
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', 'Moss-AgentHub/1.0')
  }

  const response = await fetch(url, {
    ...init,
    headers,
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  return response.json()
}

function unwrapHubResponse(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) {
    throw new Error('Invalid hub response')
  }
  if (result.success === false) {
    const message =
      typeof result.message === 'string'
        ? result.message
        : typeof result.msg === 'string'
          ? result.msg
          : 'Hub request failed'
    throw new Error(message)
  }
  return result
}

function normalizeAgentHubAssistant(rawValue: unknown): AgentHubAssistant | null {
  if (!isRecord(rawValue)) {
    return null
  }

  const categories = parseStringArray(rawValue.categories)
  const category =
    typeof rawValue.category === 'string' && rawValue.category.trim()
      ? rawValue.category.trim()
      : categories[0] || ''
  const name =
    typeof rawValue.name === 'string' && rawValue.name.trim()
      ? rawValue.name.trim()
      : ''
  const id =
    typeof rawValue.id === 'string' && rawValue.id.trim()
      ? rawValue.id.trim()
      : name

  if (!id || !name) {
    return null
  }

  const displayNameSource =
    typeof rawValue.display_name === 'string'
      ? rawValue.display_name
      : typeof rawValue.profession === 'string'
        ? rawValue.profession
        : name

  return {
    ...rawValue,
    id,
    name,
    display_name: displayNameSource.trim() || name,
    description:
      typeof rawValue.description === 'string' ? rawValue.description : '',
    avatar: typeof rawValue.avatar === 'string' ? rawValue.avatar : '',
    emoji:
      typeof rawValue.emoji === 'string'
        ? rawValue.emoji
        : rawValue.emoji === null
          ? null
          : null,
    category,
    categories,
    skills: parseStringArray(rawValue.skills),
    sourceUrl:
      typeof rawValue.sourceUrl === 'string'
        ? rawValue.sourceUrl
        : typeof rawValue.source_url === 'string'
          ? rawValue.source_url
          : '',
    core_features: rawValue.core_features,
    applicable_scenarios: rawValue.applicable_scenarios,
    versions: Array.isArray(rawValue.versions)
      ? rawValue.versions.filter(isRecord)
      : undefined,
  }
}

async function downloadFileBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      Authorization: getHubAuthorization(),
      'User-Agent': 'Moss-AgentHub/1.0',
    },
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

async function verifyChecksum(
  buffer: Buffer,
  expectedChecksum: string,
): Promise<boolean> {
  const actualChecksum = createHash('sha256').update(buffer).digest('hex')
  return actualChecksum === expectedChecksum
}

function resolveZipStripPrefix(entryNames: string[]): string {
  const fileEntries = entryNames
    .map(normalizeZipEntryPath)
    .filter(entryPath => !entryPath.endsWith('/'))
    .filter(
      entryPath =>
        !entryPath.includes('__MACOSX') && !entryPath.endsWith('.DS_Store'),
    )
    .filter(Boolean)

  for (const entryPath of fileEntries) {
    if (isUnsafeZipEntryPath(entryPath)) {
      throw new Error(`Unsafe zip entry path: ${entryPath}`)
    }
  }

  const topLevelParts = fileEntries.map(entryPath => entryPath.split('/')[0])
  const uniqueTopLevel = Array.from(new Set(topLevelParts)).filter(Boolean)

  if (uniqueTopLevel.length === 1 && fileEntries.every(entry => entry.includes('/'))) {
    return `${uniqueTopLevel[0]!}/`
  }

  return ''
}

async function extractAssistantZip(
  buffer: Buffer,
  targetDir: string,
): Promise<void> {
  const { unzipSync } = await import('fflate')
  const zipEntries = unzipSync(new Uint8Array(buffer))
  const stripPrefix = resolveZipStripPrefix(Object.keys(zipEntries))

  await mkdir(targetDir, { recursive: true })

  for (const [rawEntryName, content] of Object.entries(zipEntries)) {
    if (rawEntryName.endsWith('/')) continue
    if (isUnsafeZipEntryPath(rawEntryName)) {
      throw new Error(`Unsafe zip entry path: ${rawEntryName}`)
    }

    let entryName = normalizeZipEntryPath(rawEntryName)
    if (!entryName) continue
    if (entryName.includes('__MACOSX') || entryName.endsWith('.DS_Store')) {
      continue
    }
    if (stripPrefix) {
      if (!entryName.startsWith(stripPrefix)) {
        continue
      }
      entryName = entryName.slice(stripPrefix.length)
      if (!entryName) continue
    }

    const fullPath = path.join(targetDir, entryName)
    await mkdir(path.dirname(fullPath), { recursive: true })
    await writeFile(fullPath, Buffer.from(content))
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath)
    return fileStat.isFile()
  } catch {
    return false
  }
}

export async function readAssistantMeta(
  assistantDir: string,
): Promise<AssistantStoreMeta | null> {
  try {
    const metaContent = await readFile(
      path.join(assistantDir, ASSISTANT_META_FILE),
      'utf-8',
    )
    const parsed = JSON.parse(metaContent)
    return isRecord(parsed) ? (parsed as AssistantStoreMeta) : null
  } catch {
    return null
  }
}

export async function writeAssistantMeta(
  assistantDir: string,
  meta: AssistantStoreMeta,
): Promise<void> {
  await writeFile(
    path.join(assistantDir, ASSISTANT_META_FILE),
    `${JSON.stringify(meta, null, 2)}\n`,
    'utf8',
  )
}

async function resolveAssistantRuleFile(
  assistantDir: string,
  assistantName: string,
  preferredRuleFile?: unknown,
): Promise<string | undefined> {
  const candidateFiles: string[] = []
  const seenCandidates = new Set<string>()

  const addCandidate = (candidate: unknown) => {
    const normalized = normalizeAssistantRelativePath(candidate)
    if (!normalized) return
    const lookupKey = normalized.toLowerCase()
    if (seenCandidates.has(lookupKey)) return
    seenCandidates.add(lookupKey)
    candidateFiles.push(normalized)
  }

  addCandidate(preferredRuleFile)
  if (assistantName) {
    addCandidate(`${assistantName}.md`)
  }
  for (const candidate of COMMON_RULE_FILE_NAMES) {
    addCandidate(candidate)
  }

  for (const candidate of candidateFiles) {
    if (!candidate.toLowerCase().endsWith('.md')) continue
    const fullPath = path.resolve(assistantDir, candidate)
    if (await fileExists(fullPath)) {
      return candidate
    }
  }

  let markdownFiles: string[] = []
  try {
    const entries = await readdir(assistantDir, { withFileTypes: true })
    markdownFiles = entries
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map(entry => entry.name)
  } catch {
    return undefined
  }

  const nonDocumentationMarkdownFiles = markdownFiles.filter(
    fileName => !isDocumentationMarkdownFile(fileName),
  )

  if (nonDocumentationMarkdownFiles.length === 1) {
    return nonDocumentationMarkdownFiles[0]
  }

  return undefined
}

async function scanAssistantDirs(baseDir: string): Promise<string[]> {
  try {
    const entries = await readdir(baseDir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
      .map(entry => path.join(baseDir, entry.name))
  } catch {
    return []
  }
}

export async function findAssistantDir(
  assistantName: string,
): Promise<AssistantSearchResult | null> {
  const normalizedAssistantName = String(assistantName || '').trim()
  if (!normalizedAssistantName) {
    return null
  }

  const searchDirs: Array<{
    dir: string
    category: AssistantSearchResult['category']
  }> = [
    { dir: ASSISTANT_CUSTOM_DIR, category: 'custom' },
    { dir: ASSISTANT_HUB_DIR, category: 'hub' },
    { dir: ASSISTANT_SYSTEM_DIR, category: 'system' },
    { dir: ASSISTANT_TENANT_DIR, category: 'tenant' },
  ]

  const candidateNames = [normalizedAssistantName]
  if (normalizedAssistantName.startsWith('builtin-')) {
    candidateNames.push(normalizedAssistantName.slice('builtin-'.length))
  }
  // Also try with leading space for legacy data compatibility
  candidateNames.push(` ${normalizedAssistantName}`)

  for (const { dir, category } of searchDirs) {
    for (const candidateName of candidateNames) {
      const assistantDir = path.join(dir, candidateName)
      try {
        const entryStat = await stat(assistantDir)
        if (entryStat.isDirectory()) {
          return { dir: assistantDir, category }
        }
      } catch {
        // Continue searching.
      }
    }
  }

  // Accept "moss:<assistantId>" form used by SudoWork desktop when the
  // user picks an agent from the dropdown — strip the prefix and
  // match against meta.id below.
  const idCandidate = normalizedAssistantName.startsWith('moss:')
    ? normalizedAssistantName.slice('moss:'.length)
    : normalizedAssistantName

  for (const { dir, category } of searchDirs) {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue
        const candidateDir = path.join(dir, entry.name)
        const meta = await readAssistantMeta(candidateDir)
        if (
          meta?.name === normalizedAssistantName ||
          (typeof meta?.display_name === 'string' &&
            meta.display_name === normalizedAssistantName) ||
          (typeof meta?.id === 'string' && meta.id === idCandidate)
        ) {
          return { dir: candidateDir, category }
        }
      }
    } catch {
      // Ignore missing directory and continue searching.
    }
  }

  return null
}

function normalizePromptsI18n(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { 'zh-CN': [] }
  return { 'zh-CN': parseStringArray((value as Record<string, unknown>)['zh-CN']) }
}

function toInstalledAssistantInfo(params: {
  assistantDir: string
  dirName: string
  meta: AssistantStoreMeta | null
  category: AssistantSearchResult['category']
}): InstalledAssistantInfo {
  const { assistantDir, dirName, meta, category } = params
  // Trim directory name to avoid leading/trailing spaces
  const trimmedDirName = dirName.trim()
  const categories = parseStringArray(meta?.categories)
  const promptsI18n = normalizePromptsI18n(meta?.promptsI18n)
  const normalizedCategory =
    typeof meta?.category === 'string' ? meta.category : categories[0] || ''

  return {
    id: typeof meta?.id === 'string' ? meta.id : '',
    name:
      typeof meta?.name === 'string' && meta.name.trim()
        ? meta.name.trim()
        : trimmedDirName,
    displayName:
      typeof meta?.display_name === 'string' && meta.display_name.trim()
        ? meta.display_name
        : typeof meta?.name === 'string' && meta.name.trim()
          ? meta.name.trim()
          : trimmedDirName,
    description: typeof meta?.description === 'string' ? meta.description : '',
    avatar: typeof meta?.avatar === 'string' ? meta.avatar : '',
    emoji: typeof meta?.emoji === 'string' ? meta.emoji : '',
    defaultInitPrompt: typeof meta?.defaultInitPrompt === 'string' ? meta.defaultInitPrompt : '',
    promptsI18n,
    category: normalizedCategory,
    categories,
    version: normalizeVersion(meta?.installed_version),
    source: assistantDir,
    isBuiltin: meta?.is_builtin === true || category === 'system',
    isHubInstalled: meta?.source_type === 'hub' || category === 'hub',
    enabled: meta?.enabled !== false,
    tag:
      typeof meta?.tag === 'string' && meta.tag.trim()
        ? meta.tag
        : category,
    skills: parseStringArray(meta?.skills),
    enabledSkills: parseStringArray(meta?.enabledSkills),
    meta,
    agentType: meta?.agent_type ?? 'chat',
    memoryMode: meta?.memory_mode ?? 'session',
    visibleTo: meta?.visible_to ?? null,
    workflow: meta?.workflow ?? null,
  }
}

export async function fetchAgentHubAssistants(
  params: FetchAgentHubAssistantsParams,
): Promise<{
  assistants: AgentHubAssistant[]
  next_cursor: string | null
  has_more: boolean
}> {
  const searchParams = new URLSearchParams()
  if (params.cursor) searchParams.set('cursor', params.cursor)
  if (params.limit) searchParams.set('limit', String(params.limit))
  if (params.query) searchParams.set('query', params.query)
  if (params.category) searchParams.set('category', params.category)

  const result = await fetchJson(`${getAssistantHubCursorUrl()}?${searchParams}`)
  const unwrapped = unwrapHubResponse(result)
  const data = isRecord(unwrapped.data) ? unwrapped.data : unwrapped
  const rawAssistants = Array.isArray(data.assistants) ? data.assistants : []

  return {
    assistants: rawAssistants
      .map(normalizeAgentHubAssistant)
      .filter((assistant): assistant is AgentHubAssistant => assistant !== null),
    next_cursor:
      typeof data.next_cursor === 'string' && data.next_cursor
        ? data.next_cursor
        : null,
    has_more: data.has_more === true,
  }
}

export async function fetchAgentHubCategories(): Promise<string[]> {
  const result = await fetchJson(`${getHubCategoriesUrl()}?type=1`)
  if (Array.isArray(result)) {
    return result.filter(
      (item): item is string =>
        typeof item === 'string' && item.trim().length > 0,
    )
  }

  const unwrapped = unwrapHubResponse(result)
  const categories = Array.isArray(unwrapped.data) ? unwrapped.data : []

  return categories.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  )
}

export async function fetchAgentHubAssistantDetail(
  assistantId: string,
): Promise<AgentHubDetail | null> {
  const result = await fetchJson(
    `${getAssistantHubBaseUrl()}/${encodeURIComponent(assistantId)}`,
  )
  const unwrapped = unwrapHubResponse(result)
  const rawDetail = isRecord(unwrapped.data)
    ? unwrapped.data
    : isRecord(unwrapped.assistant)
      ? unwrapped.assistant
      : unwrapped

  const normalized = normalizeAgentHubAssistant(rawDetail)
  return normalized ? (normalized as AgentHubDetail) : null
}

export async function getInstalledAssistants(): Promise<InstalledAssistantInfo[]> {
  const results: InstalledAssistantInfo[] = []

  for (const baseDir of [ASSISTANT_SYSTEM_DIR, ASSISTANT_HUB_DIR, ASSISTANT_CUSTOM_DIR, ASSISTANT_TENANT_DIR]) {
    const assistantDirs = await scanAssistantDirs(baseDir)
    for (const assistantDir of assistantDirs) {
      const dirName = path.basename(assistantDir)
      const category: AssistantSearchResult['category'] = assistantDir.startsWith(
        ASSISTANT_SYSTEM_DIR,
      )
        ? 'system'
        : assistantDir.startsWith(ASSISTANT_HUB_DIR)
          ? 'hub'
          : assistantDir.startsWith(ASSISTANT_TENANT_DIR)
            ? 'tenant'  // Tenant assistants are managed like hub assistants
            : 'custom'

      const meta = await readAssistantMeta(assistantDir)
      results.push(
        toInstalledAssistantInfo({
          assistantDir,
          dirName,
          meta,
          category,
        }),
      )
    }
  }

  return results
}

/**
 * Resolve an incoming `assistant_name` (which may be a UUID `id`, a directory
 * `name`, or already a display name) to the agent's display name.
 *
 * The runtime injects this string verbatim as the agent's identity
 * (buildIdentityBlock / MOSS_ASSISTANT_NAME), so callers must pass the display
 * name — not a UUID — or the agent will announce itself as the raw id. Both the
 * interactive `POST /sessions` handler and the cron executor funnel through here
 * so the two paths cannot drift. Falls back to the input unchanged when no
 * match is found (e.g. lookup failure), preserving prior behavior.
 */
export async function resolveAssistantDisplayName(
  assistantName: string,
): Promise<string> {
  try {
    const installed = await getInstalledAssistants()
    const match =
      installed.find(a => a.id === assistantName) ||
      installed.find(a => a.name === assistantName)
    if (match?.displayName) {
      return match.displayName
    }
  } catch {
    // Fall back to the raw name on any lookup failure.
  }
  return assistantName
}

/**
 * Get only hub-installed agents (installed by admin from Hub).
 * Used by /api/v1/agents/installed endpoint for client sync.
 */
export async function getHubInstalledAssistants(): Promise<InstalledAssistantInfo[]> {
  const results: InstalledAssistantInfo[] = []

  const assistantDirs = await scanAssistantDirs(ASSISTANT_HUB_DIR)
  for (const assistantDir of assistantDirs) {
    const dirName = path.basename(assistantDir)
    const meta = await readAssistantMeta(assistantDir)
    results.push(
      toInstalledAssistantInfo({
        assistantDir,
        dirName,
        meta,
        category: 'hub',
      }),
    )
  }

  return results
}

export async function fetchAgentHubSkillDetailsByIds(
  skillIds: string[],
): Promise<Array<Record<string, unknown>>> {
  const normalizedIds = skillIds
    .map(skillId => String(skillId || '').trim())
    .filter(Boolean)

  if (normalizedIds.length === 0) {
    return []
  }

  const details = await Promise.all(
    normalizedIds.map(async skillId => {
      try {
        const detail = await fetchSkillHubSkillDetail(skillId)
        if (!detail) return null
        const iconUrl = typeof detail.icon === 'string' && detail.icon
          ? (detail.icon.startsWith('http')
              ? detail.icon
              : detail.icon.includes('skill-hub/')
                ? `${getCosBaseUrl()}/${detail.icon.replace(/^\/+/, '')}`
                : detail.icon)
          : null
        return {
          id: detail.id,
          name: detail.name,
          display_name: detail.display_name,
          description: detail.description,
          icon: iconUrl,
          emoji: detail.emoji ?? null,
          category: detail.category,
          categories: detail.categories,
        }
      } catch {
        return null
      }
    }),
  )

  return details.filter((detail): detail is NonNullable<typeof detail> => detail !== null) as Array<Record<string, unknown>>
}

/**
 * Remove existing hub-assistant install dirs whose meta id matches `assistantId`,
 * except the dir named `keepName` (the target of the current install). Lets a
 * re-install under a different name spelling upsert in place instead of leaving
 * a stale orphan dir, and clears legacy empty-id dirs that share the id (none,
 * since empty ids never match a real catalog id).
 */
async function removeHubAssistantDirsById(
  assistantId: string,
  keepName: string,
): Promise<void> {
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(ASSISTANT_HUB_DIR, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue
    if (entry.name === keepName) continue
    const candidateDir = path.join(ASSISTANT_HUB_DIR, entry.name)
    const meta = await readAssistantMeta(candidateDir)
    if (typeof meta?.id === 'string' && meta.id.trim() && meta.id.trim() === assistantId) {
      await rm(candidateDir, { recursive: true, force: true })
    }
  }
}

export async function installHubAssistant(params: {
  assistantName: string
  sourceUrl: string
  version?: string
  checksum?: string
  assistantMeta?: AgentHubAssistant | null
  selectedSkillIds?: string[]
}): Promise<{
  assistantName: string
  version: string
  installedSkills: string[]
  failedSkills: string[]
}> {
  const assistantName = String(params.assistantName || '').trim()
  const sourceUrl = String(params.sourceUrl || '').trim()
  if (!assistantName) {
    throw new Error('assistantName is required')
  }
  if (!sourceUrl) {
    throw new Error('sourceUrl is required')
  }

  // The catalog id is the stable identity of a hub assistant. Require it so the
  // install is always reconcilable against the catalog — installs without an id
  // produce empty-id, name-keyed dirs that can never be matched/deduped and
  // linger as orphans (see the legacy "Test-Assistant" dir).
  const assistantId = String(params.assistantMeta?.id || '').trim()
  if (!assistantId) {
    throw new Error('assistantMeta.id is required to install a hub assistant')
  }

  const zipBuffer = await downloadFileBuffer(sourceUrl)
  if (params.checksum?.trim()) {
    const isValid = await verifyChecksum(zipBuffer, params.checksum.trim())
    if (!isValid) {
      console.warn(
        `[AgentHub] Checksum mismatch for ${assistantName}, continuing with install`,
      )
    }
  }

  await mkdir(ASSISTANT_HUB_DIR, { recursive: true })
  // Remove any existing hub install of the same catalog id, even under a
  // different dir name (e.g. an earlier install with a different name spelling),
  // so a re-install upserts instead of leaving a stale orphan dir behind.
  await removeHubAssistantDirsById(assistantId, assistantName)
  const assistantDir = path.join(ASSISTANT_HUB_DIR, assistantName)
  await rm(assistantDir, { recursive: true, force: true })
  await mkdir(assistantDir, { recursive: true })
  await extractAssistantZip(zipBuffer, assistantDir)

  const normalizedAssistant =
    params.assistantMeta && isRecord(params.assistantMeta)
      ? normalizeAgentHubAssistant(params.assistantMeta)
      : null
  const ruleFile = await resolveAssistantRuleFile(
    assistantDir,
    assistantName,
    normalizedAssistant?.ruleFile,
  )

  const installedSkills = await getInstalledSkills()
  const installedSkillLookup = buildInstalledSkillLookup(installedSkills)
  const selectedSkillIds = Array.from(
    new Set(
      (
    params.selectedSkillIds?.length
      ? params.selectedSkillIds
      : normalizedAssistant?.skills || []
      )
        .map(skillId => String(skillId || '').trim())
        .filter(Boolean),
    ),
  )

  const installedSkillNames: string[] = []
  const failedSkillIds: string[] = []
  const enabledSkillNames = new Set<string>()

  for (const skillId of selectedSkillIds) {
    const detail = await fetchSkillHubSkillDetail(skillId).catch(() => null)
    if (!detail) {
      failedSkillIds.push(skillId)
      continue
    }

    const existingSkill =
      installedSkillLookup.get(skillId) || installedSkillLookup.get(detail.name)
    if (existingSkill) {
      enabledSkillNames.add(existingSkill.name || detail.name)
      continue
    }

    const latestVersion = detail.versions?.[0]
    if (!latestVersion?.source_url) {
      failedSkillIds.push(skillId)
      continue
    }

    try {
      await installHubSkill({
        skillName: detail.name,
        sourceUrl: latestVersion.source_url,
        version:
          typeof latestVersion.version === 'string'
            ? latestVersion.version
            : undefined,
        checksum:
          typeof latestVersion.checksum === 'string'
            ? latestVersion.checksum
            : undefined,
        skillMeta: detail,
      })
      installedSkillNames.push(detail.name)
      enabledSkillNames.add(detail.name)
      installedSkillLookup.set(skillId, {
        id: detail.id,
        name: detail.name,
        displayName: detail.display_name,
        description: detail.description || '',
        version:
          typeof latestVersion.version === 'string'
            ? latestVersion.version
            : '',
        icon: detail.icon?.startsWith('http')
          ? detail.icon
          : detail.icon?.includes('skill-hub/')
            ? `${getCosBaseUrl()}/${detail.icon?.replace(/^\/+/, '') || ''}`
            : detail.icon || '',
        emoji: detail.emoji || '',
        category: detail.category || '',
        categories: detail.categories || [],
        isBuiltin: false,
        isHubInstalled: true,
        isUploaded: false,
        enabled: true,
        source: path.join(MOSS_HOME, 'skills', 'hub', detail.name),
        meta: null,
      })
      installedSkillLookup.set(detail.name, installedSkillLookup.get(skillId)!)
    } catch {
      failedSkillIds.push(skillId)
    }
  }

  const installedVersion =
    normalizeVersion(params.version) || '1.0.0'
  const meta: AssistantStoreMeta = {
    id: normalizedAssistant?.id || '',
    name: assistantName,
    display_name:
      normalizedAssistant?.display_name || normalizedAssistant?.name || assistantName,
    description: normalizedAssistant?.description || '',
    avatar: normalizedAssistant?.avatar || '',
    emoji: normalizedAssistant?.emoji || null,
    category: normalizedAssistant?.category || '',
    categories: normalizedAssistant?.categories || [],
    source_type: 'hub',
    tag: 'hub',
    is_builtin: false,
    enabled: true,
    installed_version: installedVersion,
    installed_at: new Date().toISOString(),
    ruleFile,
    skills: selectedSkillIds,
    enabledSkills: Array.from(enabledSkillNames),
    agent_type:
      normalizedAssistant?.agent_type === 'chat' || normalizedAssistant?.agent_type === 'workflow'
        ? normalizedAssistant.agent_type
        : 'chat',
    memory_mode:
      normalizedAssistant?.memory_mode === 'session' || normalizedAssistant?.memory_mode === 'user'
        ? normalizedAssistant.memory_mode
        : 'session',
    visible_to:
      normalizedAssistant?.visible_to &&
      typeof normalizedAssistant.visible_to === 'object' &&
      'department_ids' in (normalizedAssistant.visible_to as object)
        ? (normalizedAssistant.visible_to as AssistantStoreMeta['visible_to'])
        : null,
    workflow:
      normalizedAssistant?.workflow &&
      typeof normalizedAssistant.workflow === 'object' &&
      'trigger' in (normalizedAssistant.workflow as object)
        ? (normalizedAssistant.workflow as AssistantStoreMeta['workflow'])
        : null,
  }
  await writeAssistantMeta(assistantDir, meta)

  // Note: 在新方案中，智能体信息通过首次消息注入，不再需要 bridge 同步

  return {
    assistantName,
    version: installedVersion,
    installedSkills: installedSkillNames,
    failedSkills: failedSkillIds,
  }
}

export async function createCustomAssistant(params: {
  name: string
  displayName: string
  description?: string
  avatar?: string
  emoji?: string | null
  rules: string
  skills?: string[]
  enabledWikis?: string[]
  enabledCorpApps?: string[]
  enableCorpAuth?: boolean
  agent_type?: 'chat' | 'workflow'
  memory_mode?: 'session' | 'user'
  visible_to?: VisibleTo
  workflow?: AssistantStoreMeta['workflow']
}): Promise<{ assistantName: string }> {
  const assistantName = params.name.trim().replace(/\s+/g, '-')
  if (!assistantName) throw new Error('Name is required')

  // 1. Check if already exists
  const existing = await findAssistantDir(assistantName)
  if (existing) throw new Error(`Assistant already exists: ${assistantName}`)

  // 2. Prepare directory
  await mkdir(ASSISTANT_CUSTOM_DIR, { recursive: true })
  const assistantDir = path.join(ASSISTANT_CUSTOM_DIR, assistantName)
  await mkdir(assistantDir, { recursive: true })

  // 3. Write instructions file
  const ruleFile = 'instructions.md'
  await writeFile(path.join(assistantDir, ruleFile), params.rules.trim(), 'utf8')

  // 4. Write metadata
  const meta: AssistantStoreMeta = {
    id: assistantName,
    name: assistantName,
    display_name: params.displayName,
    description: params.description || '',
    avatar: params.avatar || '',
    emoji: params.emoji || null,
    source_type: 'custom',
    tag: 'custom',
    is_builtin: false,
    enabled: true,
    installed_version: '1.0.0',
    installed_at: new Date().toISOString(),
    ruleFile,
    skills: params.skills || [],
    enabledSkills: params.skills || [],
    enabledWikis: params.enabledWikis || [],
    enabledCorpApps: params.enabledCorpApps || [],
    enableCorpAuth: params.enableCorpAuth ?? false,
    agent_type: params.agent_type,
    memory_mode: params.memory_mode,
    visible_to: params.visible_to,
    workflow: params.workflow,
  }
  await writeAssistantMeta(assistantDir, meta)

  // Note: 在新方案中，智能体信息通过首次消息注入，不再需要 bridge 同步

  return { assistantName }
}

export async function uninstallAssistant(params: {
  assistantName: string
  sourcePath?: string
}): Promise<void> {
  const sourcePath =
    params.sourcePath || (await findAssistantDir(params.assistantName))?.dir
  if (!sourcePath) {
    throw new Error('Assistant not found')
  }

  const meta = await readAssistantMeta(sourcePath)
  if (meta?.is_builtin === true) {
    throw new Error('Builtin assistants cannot be uninstalled')
  }

  await rm(sourcePath, { recursive: true, force: true })

  // Note: 在新方案中，不再需要 unbridge 操作
}

export async function updateInstalledAssistantMeta(params: {
  assistantName: string
  updates: Partial<
    Pick<
      AssistantStoreMeta,
      'display_name' | 'description' | 'avatar' | 'emoji' | 'ruleFile' | 'agent_type' | 'memory_mode' | 'visible_to' | 'workflow' | 'enabledSkills' | 'enabledWikis' | 'enabledCorpApps' | 'enableCorpAuth' | 'skills'
    >
  > & { rules?: string }
}): Promise<void> {
  const result = await findAssistantDir(params.assistantName)
  if (!result) {
    throw new Error('Assistant not found')
  }

  const existingMeta = (await readAssistantMeta(result.dir)) || {}
  const nextMeta: AssistantStoreMeta = {
    ...existingMeta,
  }

  if (typeof params.updates.display_name === 'string') {
    nextMeta.display_name = params.updates.display_name.trim()
  }
  if (typeof params.updates.description === 'string') {
    nextMeta.description = params.updates.description.trim()
  }
  if (typeof params.updates.avatar === 'string') {
    nextMeta.avatar = params.updates.avatar.trim()
  }
  if (typeof params.updates.emoji === 'string') {
    nextMeta.emoji = params.updates.emoji.trim()
  }
  if (typeof params.updates.rules === 'string') {
    const ruleFile = await resolveAssistantRuleFile(result.dir, params.assistantName, existingMeta.ruleFile)
    const nextRuleFile = ruleFile || normalizeAssistantRelativePath(existingMeta.ruleFile) || 'instructions.md'
    await writeFile(path.join(result.dir, nextRuleFile), params.updates.rules, 'utf8')
    nextMeta.ruleFile = nextRuleFile
  }
  if (params.updates.agent_type === 'chat' || params.updates.agent_type === 'workflow') {
    nextMeta.agent_type = params.updates.agent_type
  }
  if (params.updates.memory_mode === 'session' || params.updates.memory_mode === 'user') {
    nextMeta.memory_mode = params.updates.memory_mode
  }
  if (params.updates.visible_to !== undefined) {
    // Custom agents are created from the SudoWork client and are creator-only by
    // design (visible_to defaults to the uploader). Never let a visibility update
    // widen or change that — ignore visible_to for custom items regardless of who
    // asks, so the creator-only invariant holds even against a crafted request.
    if (existingMeta.source_type !== 'custom') {
      nextMeta.visible_to = params.updates.visible_to
    }
  }
  if (params.updates.workflow !== undefined) {
    nextMeta.workflow = params.updates.workflow
  }
  if (Array.isArray(params.updates.enabledSkills)) {
    nextMeta.enabledSkills = params.updates.enabledSkills
  }
  if (Array.isArray(params.updates.enabledWikis)) {
    nextMeta.enabledWikis = params.updates.enabledWikis
  }
  if (Array.isArray(params.updates.enabledCorpApps)) {
    nextMeta.enabledCorpApps = params.updates.enabledCorpApps
  }
  if (typeof params.updates.enableCorpAuth === 'boolean') {
    nextMeta.enableCorpAuth = params.updates.enableCorpAuth
  }
  if (Array.isArray(params.updates.skills)) {
    nextMeta.skills = params.updates.skills
  }

  await writeAssistantMeta(result.dir, nextMeta)

  // Note: 在新方案中，智能体信息通过首次消息注入，不再需要 bridge 同步
}

export async function getAssistantContextSummary(
  assistantName: string,
): Promise<{ ruleFile?: string; skills: string[] } | null> {
  const result = await findAssistantDir(assistantName)
  if (!result) {
    return null
  }

  const meta = await readAssistantMeta(result.dir)
  const ruleFile = await resolveAssistantRuleFile(
    result.dir,
    assistantName,
    meta?.ruleFile,
  )
  return {
    ruleFile,
    skills: parseStringArray(meta?.skills),
  }
}

/**
 * Get agent system prompt content for MOSS_ASSISTANT_NAME env var handling.
 * Reads the rule file content from the agent directory.
 */
export async function getAssistantSystemPrompt(
  assistantName: string,
): Promise<string | null> {
  const result = await findAssistantDir(assistantName)
  if (!result) {
    return null
  }

  const meta = await readAssistantMeta(result.dir)
  const ruleFile = await resolveAssistantRuleFile(
    result.dir,
    assistantName,
    meta?.ruleFile,
  )

  if (!ruleFile) {
    return null
  }

  const fullPath = path.resolve(result.dir, ruleFile)
  try {
    const content = await readFile(fullPath, 'utf-8')
    return content.trim() || null
  } catch {
    return null
  }
}

export { ASSISTANT_HUB_DIR, ASSISTANT_SEARCH_DIRS }

export async function batchSyncAssistants(params?: {
  onProgress?: (processed: number, total: number) => void
}): Promise<{
  installed: Array<{ assistantName: string; version: string }>
  updated: Array<{ assistantName: string; version: string }>
  skipped: Array<{ assistantName: string; reason: string }>
  failed: Array<{ assistantName: string; error: string }>
}> {
  const installed: Array<{ assistantName: string; version: string }> = []
  const updated: Array<{ assistantName: string; version: string }> = []
  const skipped: Array<{ assistantName: string; reason: string }> = []
  const failed: Array<{ assistantName: string; error: string }> = []

  const installedAssistants = await getInstalledAssistants()
  const byName = new Map(installedAssistants.map(a => [a.name, a]))

  const allHubAssistants: AgentHubAssistant[] = []
  let cursor: string | undefined
  let hasMore = true
  while (hasMore) {
    const page = await fetchAgentHubAssistants({ cursor, limit: 100 })
    allHubAssistants.push(...page.assistants)
    cursor = page.next_cursor ?? undefined
    hasMore = page.has_more
  }

  const total = allHubAssistants.length
  let processed = 0

  for (const hubAsst of allHubAssistants) {
    const sourceUrl = hubAsst.sourceUrl?.trim()
    if (!sourceUrl) {
      skipped.push({ assistantName: hubAsst.name, reason: 'no download URL' })
      processed++
      params?.onProgress?.(processed, total)
      continue
    }
    const existing = byName.get(hubAsst.name)
    if (existing) {
      skipped.push({
        assistantName: hubAsst.name,
        reason: 'already installed',
      })
      processed++
      params?.onProgress?.(processed, total)
      continue
    }
    try {
      const detail = await fetchAgentHubAssistantDetail(hubAsst.id)
      const ver = detail?.versions?.[0]
      const result = await installHubAssistant({
        assistantName: hubAsst.name,
        sourceUrl,
        version:
          typeof ver?.version === 'string' ? ver.version : undefined,
        checksum:
          typeof ver?.checksum === 'string' ? ver.checksum : undefined,
        assistantMeta: hubAsst,
      })
      installed.push({
        assistantName: result.assistantName,
        version: result.version,
      })
    } catch (error) {
      failed.push({
        assistantName: hubAsst.name,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    processed++
    params?.onProgress?.(processed, total)
  }

  return { installed, updated, skipped, failed }
}

/**
 * Upload a custom agent from a zip buffer.
 * The agent will be installed to the custom directory with visibility set to the uploader only.
 */
export async function uploadCustomAssistant(params: {
  file: Buffer
  name: string // User-visible agent name (e.g., "微信公众号运营助手")
  id?: string // UUID from client (e.g., "fb11954c-a848-41a2-967f-e1ef5e711fe6")
  displayName: string
  description?: string
  version?: string
  enabledSkills?: string[]
  memoryMode?: 'session' | 'user'
  userId: string
}): Promise<{ id: string; name: string; version: string }> {
  // Use provided id (UUID) as directory name, fallback to sanitized name
  const assistantId = params.id || params.name.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '-')
  if (!assistantId) {
    throw new Error('Invalid assistant id')
  }

  // Check if agent already exists by id (directory name)
  const existing = await findAssistantDir(assistantId)
  if (existing) {
    throw new Error(`Assistant already exists: ${assistantId}`)
  }

  // Extract to temp directory first
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'moss-assistant-upload-'))
  try {
    await extractAssistantZip(params.file, tempDir)

    // Install to custom directory using UUID as directory name
    const targetDir = path.join(ASSISTANT_CUSTOM_DIR, assistantId)
    await mkdir(ASSISTANT_CUSTOM_DIR, { recursive: true })
    await rm(targetDir, { recursive: true, force: true })

    // Find the agent directory (might be nested)
    let assistantDir = tempDir
    const entries = await readdir(tempDir, { withFileTypes: true })
    if (entries.length === 1 && entries[0].isDirectory()) {
      assistantDir = path.join(tempDir, entries[0].name)
    }

    // Copy to target directory
    await copyDirectoryRecursive(assistantDir, targetDir)

    // Create or update metadata with visibility set to uploader only
    const existingMeta = await readAssistantMeta(targetDir)
    const version = params.version || '1.0.0'
    // Use displayName as the actual name, assistantId (UUID) as directory name/id
    const actualName = params.displayName || params.name || existingMeta?.display_name || assistantId
    const meta: AssistantStoreMeta = {
      ...existingMeta,
      id: assistantId,
      name: actualName,
      display_name: params.displayName || existingMeta?.display_name || actualName,
      description: params.description || existingMeta?.description || '',
      source_type: 'custom',
      is_builtin: false,
      enabled: true,
      installed_version: version,
      installed_at: new Date().toISOString(),
      skills: params.enabledSkills || existingMeta?.skills || [],
      enabledSkills: params.enabledSkills || existingMeta?.enabledSkills || [],
      agent_type: existingMeta?.agent_type || 'chat',
      memory_mode: params.memoryMode || existingMeta?.memory_mode || 'session',
      visible_to: {
        user_ids: [params.userId],
        department_ids: null,
      },
    }
    await writeAssistantMeta(targetDir, meta)

    return {
      id: assistantId,
      name: actualName,
      version,
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

/**
 * Package an agent as a zip buffer for download.
 */
export async function packageAssistantZip(assistantName: string): Promise<Buffer> {
  const result = await findAssistantDir(assistantName)
  if (!result) {
    throw new Error(`Assistant not found: ${assistantName}`)
  }

  const JSZip = (await import('jszip')).default
  const zip = new JSZip()

  await addDirectoryToZip(zip, result.dir, '')

  return zip.generateAsync({ type: 'nodebuffer' })
}

/**
 * Package an agent as a zip buffer from a specific directory path.
 */
export async function packageAssistantZipByDir(assistantDir: string): Promise<Buffer> {
  if (!existsSync(assistantDir)) {
    throw new Error(`Assistant directory not found: ${assistantDir}`)
  }

  const JSZip = (await import('jszip')).default
  const zip = new JSZip()

  await addDirectoryToZip(zip, assistantDir, '')

  return zip.generateAsync({ type: 'nodebuffer' })
}

async function copyDirectoryRecursive(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  await mkdir(targetDir, { recursive: true })
  const entries = await readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(sourcePath, targetPath)
    } else if (entry.isFile()) {
      await mkdir(path.dirname(targetPath), { recursive: true })
      await writeFile(targetPath, await readFile(sourcePath))
    }
  }
}

async function addDirectoryToZip(
  zip: import('jszip'),
  dirPath: string,
  zipPath: string,
): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      await addDirectoryToZip(zip, fullPath, entryZipPath)
    } else if (entry.isFile()) {
      const content = await readFile(fullPath)
      zip.file(entryZipPath, content)
    }
  }
}
