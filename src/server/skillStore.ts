import {
  createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import type { VisibleTo } from './visibilityFilter.js'
import {
  MANAGED_SKILL_SEARCH_DIRS,
  MOSS_SKILLS_CUSTOM_DIR,
  MOSS_SKILLS_HUB_DIR,
  MOSS_SKILLS_SYSTEM_DIR,
  MOSS_SKILLS_TENANT_DIR,
  SKILL_HUB_META_FILE,
  USER_SKILLS_DIR,
} from '../utils/skills/localSkillDirectories.js'
import { getHubApiBaseUrl, getHubAuthorization, getCosBaseUrl } from './hubConfig.js'

function getHubCategoriesUrl(): string {
  return `${getHubApiBaseUrl()}/categories`
}

function getSkillHubBaseUrl(): string {
  return `${getHubApiBaseUrl()}/skills`
}

function getSkillHubCursorUrl(): string {
  return `${getSkillHubBaseUrl()}/cursor`
}

export type SkillHubVersion = {
  version: string
  source_url: string
  checksum: string
  [key: string]: unknown
}

export type SkillHubSkill = {
  id: string
  name: string
  display_name: string
  description?: string
  icon?: string
  emoji?: string | null
  category?: string
  categories?: string[]
  applicable_scenarios?: unknown
  core_features?: unknown
  homepage?: string | null
  author_id?: string
  star_count?: number
  created_at?: string | number
  updated_at?: string | number
  [key: string]: unknown
}

export type SkillHubDetail = SkillHubSkill & {
  versions?: SkillHubVersion[]
}

export type SkillStoreMeta = {
  id?: string
  name?: string
  display_name?: string
  description?: string
  icon?: string
  emoji?: string | null
  category?: string
  categories?: string[]
  applicable_scenarios?: unknown
  core_features?: unknown
  homepage?: string | null
  author_id?: string
  source_type?: 'hub' | 'upload' | 'tenant'
  is_builtin?: boolean
  enabled?: boolean
  installed_version?: string
  installed_at?: string
  visible_to?: VisibleTo
  [key: string]: unknown
}

export type InstalledSkillInfo = {
  id: string
  name: string
  displayName: string
  description: string
  version: string
  icon: string
  emoji: string
  category: string
  categories: string[]
  isBuiltin: boolean
  isHubInstalled: boolean
  isUploaded: boolean
  enabled: boolean
  source: string
  meta: SkillStoreMeta | null
  visibleTo: VisibleTo
}

export type FetchSkillHubSkillsParams = {
  cursor?: string
  limit?: number
  query?: string
  category?: string
  tenantId?: string
}

export type ImportSkillArchivePayload = {
  fileName: string
  archiveBase64: string
}

export type ImportSkillDirectoryEntry = {
  path: string
  contentBase64: string
}

export type ImportSkillDirectoryPayload = {
  entries: ImportSkillDirectoryEntry[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeSkillVersion(value: unknown): string {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  const lower = normalized.toLowerCase()
  if (lower === 'unknown' || lower === 'unkown') return ''
  return normalized
}

function parseFrontmatter(content: string): Record<string, string> {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/
  const match = content.match(frontmatterRegex)
  if (!match) return {}

  const frontmatter: Record<string, string> = {}
  const lines = match[1].split('\n')
  for (const line of lines) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    let value = line.slice(colonIdx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    frontmatter[key] = value
  }
  return frontmatter
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  if (typeof value !== 'string' || !value.trim()) {
    return []
  }
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return [value.trim()]
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Authorization: getHubAuthorization(),
    },
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

async function downloadFileBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      Authorization: getHubAuthorization(),
      'User-Agent': 'Moss-SkillStore/1.0',
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

function isUnsafeEntryPath(entryPath: string): boolean {
  if (!entryPath || entryPath === '.') return false
  if (/^[a-zA-Z]:[\\/]/.test(entryPath)) return true
  if (entryPath.startsWith('/') || entryPath.startsWith('\\')) return true
  const normalized = entryPath.replace(/\\/g, '/').replace(/^\.\/+/, '')
  return normalized === '..' || normalized.startsWith('../')
}

function isPathInsideDir(rootDir: string, targetPath: string): boolean {
  const relativePath = path.relative(path.resolve(rootDir), targetPath)
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  )
}

function resolveSafeEntryPath(
  targetDir: string,
  entryPath: string,
): string | null {
  if (isUnsafeEntryPath(entryPath)) return null
  const normalized = entryPath.replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (!normalized) return null
  const fullPath = path.resolve(targetDir, normalized)
  return isPathInsideDir(targetDir, fullPath) ? fullPath : null
}

export async function readSkillMeta(skillDir: string): Promise<SkillStoreMeta | null> {
  try {
    const raw = await readFile(path.join(skillDir, SKILL_HUB_META_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? (parsed as SkillStoreMeta) : null
  } catch {
    return null
  }
}

export async function writeSkillMeta(
  skillDir: string,
  meta: SkillStoreMeta,
): Promise<void> {
  await writeFile(
    path.join(skillDir, SKILL_HUB_META_FILE),
    `${JSON.stringify(meta, null, 2)}\n`,
    'utf8',
  )
}

export async function readSkillVersion(skillDir: string): Promise<string> {
  try {
    return normalizeSkillVersion(
      await readFile(path.join(skillDir, 'version.txt'), 'utf8'),
    )
  } catch {
    return ''
  }
}

async function readSkillFrontmatter(
  skillDir: string,
): Promise<Record<string, string> | null> {
  try {
    const content = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')
    return parseFrontmatter(content)
  } catch {
    return null
  }
}

function buildSkillMetaFromFrontmatter(
  skillName: string,
  frontmatter: Record<string, string>,
  defaults: Partial<SkillStoreMeta> = {},
): SkillStoreMeta {
  return {
    id: '',
    name: skillName,
    display_name:
      frontmatter.name || frontmatter.displayName || skillName,
    description: frontmatter.description || '',
    icon: frontmatter.icon || '',
    emoji: frontmatter.emoji || null,
    category: frontmatter.category || '',
    categories: frontmatter.category ? [frontmatter.category] : [],
    enabled: true,
    installed_version: frontmatter.version || '1.0.0',
    installed_at: new Date().toISOString(),
    ...defaults,
  }
}

function inferLocalSkillMetaDefaults(skillDir: string): Partial<SkillStoreMeta> {
  if (isPathInsideDir(MOSS_SKILLS_HUB_DIR, skillDir)) {
    return {
      source_type: 'hub',
      is_builtin: false,
    }
  }

  if (isPathInsideDir(MOSS_SKILLS_CUSTOM_DIR, skillDir)) {
    return {
      source_type: 'upload',
      is_builtin: false,
    }
  }

  if (isPathInsideDir(MOSS_SKILLS_SYSTEM_DIR, skillDir)) {
    return {
      is_builtin: true,
    }
  }

  if (isPathInsideDir(USER_SKILLS_DIR, skillDir)) {
    return {
      is_builtin: false,
    }
  }

  return {}
}

async function ensureToggleableSkillMeta(
  skillDir: string,
  skillName: string,
): Promise<SkillStoreMeta | null> {
  const existingMeta = await readSkillMeta(skillDir)
  if (existingMeta) return existingMeta

  const frontmatter = await readSkillFrontmatter(skillDir)
  if (!frontmatter) return null

  const meta = buildSkillMetaFromFrontmatter(
    skillName,
    frontmatter,
    inferLocalSkillMetaDefaults(skillDir),
  )
  await writeSkillMeta(skillDir, meta)
  return meta
}

function toInstalledSkillInfo(params: {
  skillDir: string
  skillName: string
  meta: SkillStoreMeta | null
  version: string
  frontmatter: Record<string, string> | null
}): InstalledSkillInfo {
  const { skillDir, skillName, meta, version, frontmatter } = params
  // Trim skill name to avoid leading/trailing spaces
  const trimmedSkillName = skillName.trim()
  const displayName =
    meta?.display_name ||
    meta?.name ||
    frontmatter?.name ||
    frontmatter?.displayName ||
    trimmedSkillName
  const categories = parseStringArray(meta?.categories).length
    ? parseStringArray(meta?.categories)
    : frontmatter?.category
      ? [frontmatter.category]
      : []

  return {
    id: typeof meta?.id === 'string' ? meta.id : '',
    name: typeof meta?.name === 'string' && meta.name ? meta.name.trim() : trimmedSkillName,
    displayName,
    description:
      typeof meta?.description === 'string'
        ? meta.description
        : frontmatter?.description || '',
    version:
      normalizeSkillVersion(meta?.installed_version) ||
      normalizeSkillVersion(frontmatter?.version) ||
      version,
    icon: typeof meta?.icon === 'string' ? meta.icon : frontmatter?.icon || '',
    emoji:
      typeof meta?.emoji === 'string'
        ? meta.emoji
        : frontmatter?.emoji || '',
    category:
      typeof meta?.category === 'string'
        ? meta.category
        : frontmatter?.category || '',
    categories,
    isBuiltin: meta?.is_builtin === true,
    isHubInstalled: meta?.source_type === 'hub',
    isUploaded: meta?.source_type === 'upload',
    enabled: meta?.enabled !== false,
    source: skillDir,
    meta,
    visibleTo: meta?.visible_to ?? null,
  }
}

async function collectInstalledSkillsFromDir(
  baseDir: string,
): Promise<InstalledSkillInfo[]> {
  let entries
  try {
    entries = await readdir(baseDir, { withFileTypes: true })
  } catch {
    return []
  }

  const results = await Promise.all(
    entries
      .filter(entry => entry.isDirectory())
      .map(async entry => {
        const skillDir = path.join(baseDir, entry.name)
        const [meta, version, frontmatter] = await Promise.all([
          readSkillMeta(skillDir),
          readSkillVersion(skillDir),
          readSkillFrontmatter(skillDir),
        ])

        if (!meta && !frontmatter) {
          return null
        }

        return toInstalledSkillInfo({
          skillDir,
          skillName: entry.name,
          meta,
          version,
          frontmatter,
        })
      }),
  )

  return results.filter((skill): skill is InstalledSkillInfo => skill !== null)
}

async function findSkillDirWithSkillMd(rootDir: string): Promise<string | null> {
  const directSkillFile = path.join(rootDir, 'SKILL.md')
  try {
    const directStat = await stat(directSkillFile)
    if (directStat.isFile()) {
      return rootDir
    }
  } catch {
    // Ignore and continue scanning.
  }

  let entries
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const nested = await findSkillDirWithSkillMd(path.join(rootDir, entry.name))
    if (nested) return nested
  }

  return null
}

async function extractSkillZip(
  buffer: Buffer,
  targetDir: string,
): Promise<void> {
  const JSZip = await import('jszip')
  const zip = await JSZip.loadAsync(buffer)
  const files = Object.values(zip.files)

  // Find root SKILL.md path
  const skillMdFiles = files.filter(
    f => !f.dir && f.name.toLowerCase().endsWith('skill.md'),
  )

  let stripPrefix = ''
  if (
    skillMdFiles.some(f => {
      const normalized = f.name.replace(/\\/g, '/').replace(/^\.\/+/, '')
      return normalized === 'SKILL.md' || normalized === 'skill.md'
    })
  ) {
    stripPrefix = ''
  } else if (skillMdFiles.length > 0) {
    const rootPaths = [
      ...new Set(
        skillMdFiles.map(f =>
          path.dirname(f.name.replace(/\\/g, '/').replace(/^\.\/+/, '')).split('/')[0],
        ),
      ),
    ].filter(Boolean)

    if (rootPaths.length === 1) {
      stripPrefix = `${rootPaths[0]!}/`
    }
  }

  for (const entry of files) {
    // Skip directory entries (JSZip has entry.dir property)
    if (entry.dir) continue

    let entryName = entry.name.replace(/\\/g, '/').replace(/^\.\/+/, '')
    if (stripPrefix && entryName.startsWith(stripPrefix)) {
      entryName = entryName.slice(stripPrefix.length)
    }

    const fullPath = resolveSafeEntryPath(targetDir, entryName)
    if (!fullPath) continue

    await mkdir(path.dirname(fullPath), { recursive: true })
    const content = await entry.async('nodebuffer')
    await writeFile(fullPath, content)
  }
}

async function writeDirectoryEntries(
  targetDir: string,
  entries: ImportSkillDirectoryEntry[],
): Promise<void> {
  for (const entry of entries) {
    const fullPath = resolveSafeEntryPath(targetDir, entry.path)
    if (!fullPath) continue

    await mkdir(path.dirname(fullPath), { recursive: true })
    await writeFile(fullPath, Buffer.from(entry.contentBase64, 'base64'))
  }
}

async function copyDirectoryRecursive(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  let entries
  try {
    entries = await readdir(sourceDir, { withFileTypes: true })
  } catch {
    return
  }

  await mkdir(targetDir, { recursive: true })
  await Promise.all(
    entries.map(async entry => {
      const sourcePath = path.join(sourceDir, entry.name)
      const targetPath = path.join(targetDir, entry.name)
      if (entry.isDirectory()) {
        await copyDirectoryRecursive(sourcePath, targetPath)
        return
      }
      if (entry.isFile()) {
        await mkdir(path.dirname(targetPath), { recursive: true })
        await writeFile(targetPath, await readFile(sourcePath))
      }
    }),
  )
}

function normalizeImportedSkillName(name: string): string {
  return name
    .trim()
    .replace(/\.[^.]+$/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

async function installImportedSkillFromTemp(
  tempDir: string,
  preferredName?: string,
): Promise<{ skillName: string; installedVersion: string }> {
  const skillDir = await findSkillDirWithSkillMd(tempDir)
  if (!skillDir) {
    throw new Error('未找到 SKILL.md，无法识别技能目录')
  }

  const frontmatter = await readSkillFrontmatter(skillDir)
  if (!frontmatter) {
    throw new Error('SKILL.md 读取失败')
  }

  // Determine skill name with priority: preferredName > frontmatter.name > frontmatter.displayName > directory name
  const normalizedPreferredName = normalizeImportedSkillName(preferredName || '')
  const frontmatterName = typeof frontmatter.name === 'string' && frontmatter.name.trim()
    ? normalizeImportedSkillName(frontmatter.name.trim())
    : ''
  const frontmatterDisplayName = typeof frontmatter.displayName === 'string' && frontmatter.displayName.trim()
    ? normalizeImportedSkillName(frontmatter.displayName.trim())
    : ''

  let skillName: string
  if (normalizedPreferredName) {
    skillName = normalizedPreferredName
  } else if (frontmatterName) {
    skillName = frontmatterName
  } else if (frontmatterDisplayName) {
    skillName = frontmatterDisplayName
  } else if (skillDir !== tempDir) {
    skillName = path.basename(skillDir)
  } else {
    throw new Error('无法确定技能名称，请在 SKILL.md 中指定 name 或 displayName 字段')
  }

  const targetDir = path.join(USER_SKILLS_DIR, skillName)
  await mkdir(USER_SKILLS_DIR, { recursive: true })
  await rm(targetDir, { recursive: true, force: true })
  await copyDirectoryRecursive(skillDir, targetDir)

  const meta = buildSkillMetaFromFrontmatter(skillName, frontmatter, {
    source_type: 'upload',
    is_builtin: false,
  })
  await writeSkillMeta(targetDir, meta)

  return {
    skillName,
    installedVersion: meta.installed_version || '',
  }
}

export async function findInstalledSkillPath(
  skillName: string,
): Promise<string | null> {
  for (const baseDir of MANAGED_SKILL_SEARCH_DIRS) {
    const candidate = path.join(baseDir, skillName)
    try {
      const candidateStat = await stat(candidate)
      if (candidateStat.isDirectory()) {
        return candidate
      }
    } catch {
      // Ignore and continue.
    }
  }

  return null
}

export async function fetchSkillHubSkills(
  params: FetchSkillHubSkillsParams,
): Promise<{ skills: SkillHubSkill[]; next_cursor: string | null; has_more: boolean }> {
  const searchParams = new URLSearchParams()
  if (params.cursor) searchParams.set('cursor', params.cursor)
  if (params.limit) searchParams.set('limit', String(params.limit))
  if (params.query) searchParams.set('query', params.query)
  if (params.category) searchParams.set('categories', params.category)
  if (typeof params.tenantId === 'string' && params.tenantId.trim()) {
    searchParams.set('tenant_id', params.tenantId.trim())
  }

  const result = await fetchJson(`${getSkillHubCursorUrl()}?${searchParams}`)
  const unwrapped = unwrapHubResponse(result)
  const data = isRecord(unwrapped.data) ? unwrapped.data : {}

  return {
    skills: Array.isArray(data.skills)
      ? (data.skills as SkillHubSkill[])
      : [],
    next_cursor:
      typeof data.next_cursor === 'string' && data.next_cursor
        ? data.next_cursor
        : null,
    has_more: data.has_more === true,
  }
}

export async function fetchSkillHubCategories(): Promise<string[]> {
  const result = await fetchJson(getHubCategoriesUrl())
  const categories = unwrapHubResponse(result).data
  return Array.isArray(categories)
    ? categories.filter((item): item is string => typeof item === 'string')
    : []
}

export async function fetchSkillHubSkillDetail(
  skillId: string,
): Promise<SkillHubDetail | null> {
  const result = await fetchJson(`${getSkillHubBaseUrl()}/${encodeURIComponent(skillId)}`)
  const unwrapped = unwrapHubResponse(result)
  if (!isRecord(unwrapped.data)) {
    return null
  }

  // Hub API 返回 { skill: {...}, versions: [...] }
  // 需要将 skill 和 versions 合并
  const skillData = isRecord(unwrapped.data.skill) ? unwrapped.data.skill : null
  const versionsData = Array.isArray(unwrapped.data.versions) ? unwrapped.data.versions : []

  if (!skillData) {
    return null
  }

  return {
    ...skillData,
    versions: versionsData,
  } as SkillHubDetail
}

export async function getInstalledSkills(): Promise<InstalledSkillInfo[]> {
  const groups = await Promise.all(
    MANAGED_SKILL_SEARCH_DIRS.map(dir => collectInstalledSkillsFromDir(dir)),
  )
  return groups.flat()
}

/**
 * Get only hub-installed skills (installed by admin from Hub).
 * Used by /api/v1/skills/installed endpoint for client sync.
 */
export async function getHubInstalledSkills(): Promise<InstalledSkillInfo[]> {
  return collectInstalledSkillsFromDir(MOSS_SKILLS_HUB_DIR)
}

export async function installHubSkill(params: {
  skillName: string
  sourceUrl: string
  version?: string
  checksum?: string
  skillMeta?: SkillHubSkill | null
}): Promise<{ skillName: string; version: string }> {
  if (!params.skillName?.trim()) {
    throw new Error('skillName is required')
  }
  if (!params.sourceUrl?.trim()) {
    throw new Error('sourceUrl is required')
  }

  const zipBuffer = await downloadFileBuffer(params.sourceUrl)
  if (params.checksum?.trim()) {
    const isValid = await verifyChecksum(zipBuffer, params.checksum.trim())
    if (!isValid) {
      console.warn(
        `[SkillStore] Checksum mismatch for ${params.skillName}, continuing with install`,
      )
    }
  }

  await mkdir(MOSS_SKILLS_HUB_DIR, { recursive: true })
  const skillDir = path.join(MOSS_SKILLS_HUB_DIR, params.skillName)
  await rm(skillDir, { recursive: true, force: true })
  await mkdir(skillDir, { recursive: true })
  await extractSkillZip(zipBuffer, skillDir)

  const meta: SkillStoreMeta = {
    id: params.skillMeta?.id || '',
    name: params.skillName,
    display_name:
      params.skillMeta?.display_name || params.skillMeta?.name || params.skillName,
    description:
      typeof params.skillMeta?.description === 'string'
        ? params.skillMeta.description
        : '',
    icon: typeof params.skillMeta?.icon === 'string'
      ? (params.skillMeta.icon.startsWith('http')
          ? params.skillMeta.icon
          : params.skillMeta.icon.includes('skill-hub/')
            ? `${getCosBaseUrl()}/${params.skillMeta.icon.replace(/^\/+/, '')}`
            : params.skillMeta.icon)
      : '',
    emoji:
      typeof params.skillMeta?.emoji === 'string' ? params.skillMeta.emoji : null,
    category:
      typeof params.skillMeta?.category === 'string'
        ? params.skillMeta.category
        : '',
    categories: Array.isArray(params.skillMeta?.categories)
      ? params.skillMeta.categories.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
    applicable_scenarios: params.skillMeta?.applicable_scenarios ?? null,
    core_features: params.skillMeta?.core_features ?? null,
    homepage:
      typeof params.skillMeta?.homepage === 'string'
        ? params.skillMeta.homepage
        : null,
    author_id:
      typeof params.skillMeta?.author_id === 'string'
        ? params.skillMeta.author_id
        : '',
    source_type: 'hub',
    is_builtin: false,
    enabled: true,
    installed_version: params.version || '',
    installed_at: new Date().toISOString(),
  }

  await writeSkillMeta(skillDir, meta)

  // Note: 在新方案中，技能通过工作空间符号链接和首次消息注入，不再需要 bridge 同步

  return {
    skillName: params.skillName,
    version: params.version || '',
  }
}

export async function uninstallSkill(params: {
  skillName: string
  sourcePath?: string
}): Promise<void> {
  const sourcePath = params.sourcePath || (await findInstalledSkillPath(params.skillName))
  if (!sourcePath) {
    throw new Error(`Skill not found: ${params.skillName}`)
  }
  await rm(sourcePath, { recursive: true, force: true })

  // Note: 在新方案中，不再需要 unbridge 操作
}

export async function importLocalSkillArchive(
  payload: ImportSkillArchivePayload,
): Promise<{ skillName: string; installedVersion: string }> {
  if (!payload.archiveBase64?.trim()) {
    throw new Error('archiveBase64 is required')
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), 'moss-skill-import-'))
  try {
    await extractSkillZip(Buffer.from(payload.archiveBase64, 'base64'), tempDir)
    const result = await installImportedSkillFromTemp(tempDir, payload.fileName)

    // Note: 在新方案中，技能通过工作空间符号链接和首次消息注入，不再需要 bridge 同步

    return result
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export async function importLocalSkillDirectory(
  payload: ImportSkillDirectoryPayload,
): Promise<{ skillName: string; installedVersion: string }> {
  if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
    throw new Error('entries is required')
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), 'moss-skill-import-'))
  try {
    await writeDirectoryEntries(tempDir, payload.entries)
    const result = await installImportedSkillFromTemp(tempDir)

    // Note: 在新方案中，技能通过工作空间符号链接和首次消息注入，不再需要 bridge 同步

    return result
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export async function setInstalledSkillEnabled(params: {
  skillName: string
  enabled: boolean
  sourcePath?: string
}): Promise<void> {
  const sourcePath = params.sourcePath || (await findInstalledSkillPath(params.skillName))
  if (!sourcePath) {
    throw new Error(`Skill not found: ${params.skillName}`)
  }

  const meta = await ensureToggleableSkillMeta(sourcePath, params.skillName)
  if (!meta) {
    throw new Error(`Skill metadata not found: ${params.skillName}`)
  }

  meta.enabled = params.enabled
  await writeSkillMeta(sourcePath, meta)

  // Note: 在新方案中，技能通过工作空间符号链接和首次消息注入，不再需要 bridge 同步
}

export async function batchSyncSkills(params?: {
  tenantId?: string
  onProgress?: (processed: number, total: number) => void
}): Promise<{
  installed: Array<{ skillName: string; version: string }>
  updated: Array<{ skillName: string; version: string }>
  skipped: Array<{ skillName: string; reason: string }>
  failed: Array<{ skillName: string; error: string }>
}> {
  const installed: Array<{ skillName: string; version: string }> = []
  const updated: Array<{ skillName: string; version: string }> = []
  const skipped: Array<{ skillName: string; reason: string }> = []
  const failed: Array<{ skillName: string; error: string }> = []

  const installedSkills = await getInstalledSkills()
  const byName = new Map(installedSkills.map(s => [s.name, s]))

  const allHubSkills: SkillHubSkill[] = []
  let cursor: string | undefined
  let hasMore = true
  while (hasMore) {
    const page = await fetchSkillHubSkills({
      cursor,
      limit: 100,
      tenantId: params?.tenantId,
    })
    allHubSkills.push(...page.skills)
    cursor = page.next_cursor ?? undefined
    hasMore = page.has_more
  }

  const total = allHubSkills.length
  let processed = 0

  for (const hubSkill of allHubSkills) {
    try {
      const detail = await fetchSkillHubSkillDetail(hubSkill.id)
      const latest = detail?.versions?.[0]
      if (!latest?.source_url) {
        skipped.push({ skillName: hubSkill.name, reason: 'no download URL' })
        continue
      }
      const existing = byName.get(hubSkill.name)
      if (existing) {
        const curVer = normalizeSkillVersion(existing.version)
        if (curVer && curVer === latest.version) {
          skipped.push({
            skillName: hubSkill.name,
            reason: 'already up to date',
          })
          continue
        }
        await installHubSkill({
          skillName: hubSkill.name,
          sourceUrl: latest.source_url,
          version: latest.version,
          checksum: latest.checksum,
          skillMeta: hubSkill,
        })
        updated.push({ skillName: hubSkill.name, version: latest.version })
      } else {
        await installHubSkill({
          skillName: hubSkill.name,
          sourceUrl: latest.source_url,
          version: latest.version,
          checksum: latest.checksum,
          skillMeta: hubSkill,
        })
        installed.push({ skillName: hubSkill.name, version: latest.version })
      }
    } catch (error) {
      failed.push({
        skillName: hubSkill.name,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    processed++
    params?.onProgress?.(processed, total)
  }

  return { installed, updated, skipped, failed }
}

export async function setInstalledSkillMeta(
  skillName: string,
  updates: Partial<
    Pick<SkillStoreMeta, 'visible_to'>
  >,
): Promise<void> {
  const sourcePath = await findInstalledSkillPath(skillName)
  if (!sourcePath) {
    throw new Error(`Skill not found: ${skillName}`)
  }

  const meta = await readSkillMeta(sourcePath)
  if (!meta) {
    throw new Error(`Skill metadata not found: ${skillName}`)
  }

  if (updates.visible_to !== undefined) {
    meta.visible_to = updates.visible_to
  }

  await writeSkillMeta(sourcePath, meta)
}

/**
 * Upload a custom skill from a zip buffer.
 * The skill will be installed to the custom directory with visibility set to the uploader only.
 */
export async function uploadCustomSkill(params: {
  file: Buffer
  name: string
  displayName: string
  description?: string
  version?: string
  userId: string
}): Promise<{ id: string; name: string; version: string }> {
  const skillName = params.name.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '-')
  if (!skillName) {
    throw new Error('Invalid skill name')
  }

  // Check if skill already exists
  const existingPath = await findInstalledSkillPath(skillName)
  if (existingPath) {
    throw new Error(`Skill already exists: ${skillName}`)
  }

  // Extract to temp directory first
  const tempDir = await mkdtemp(path.join(tmpdir(), 'moss-skill-upload-'))
  try {
    await extractSkillZip(params.file, tempDir)

    // Find the skill directory with SKILL.md
    const skillDir = await findSkillDirWithSkillMd(tempDir)
    if (!skillDir) {
      throw new Error('未找到 SKILL.md，无法识别技能目录')
    }

    // Read frontmatter for metadata
    const frontmatter = await readSkillFrontmatter(skillDir)
    if (!frontmatter) {
      throw new Error('SKILL.md 读取失败')
    }

    // Install to custom directory
    const targetDir = path.join(MOSS_SKILLS_CUSTOM_DIR, skillName)
    await mkdir(MOSS_SKILLS_CUSTOM_DIR, { recursive: true })
    await rm(targetDir, { recursive: true, force: true })
    await copyDirectoryRecursive(skillDir, targetDir)

    // Create metadata with visibility set to uploader only
    const version = params.version || frontmatter.version || '1.0.0'
    const meta: SkillStoreMeta = {
      id: skillName,
      name: skillName,
      display_name: params.displayName || frontmatter.name || frontmatter.displayName || skillName,
      description: params.description || frontmatter.description || '',
      icon: frontmatter.icon || '',
      emoji: frontmatter.emoji || null,
      category: frontmatter.category || '',
      categories: frontmatter.category ? [frontmatter.category] : [],
      source_type: 'upload',
      is_builtin: false,
      enabled: true,
      installed_version: version,
      installed_at: new Date().toISOString(),
      visible_to: {
        user_ids: [params.userId],
        department_ids: null,
      },
    }
    await writeSkillMeta(targetDir, meta)

    return {
      id: skillName,
      name: skillName,
      version,
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

/**
 * Package a skill as a zip buffer for download.
 */
export async function packageSkillZip(skillName: string): Promise<Buffer> {
  const skillPath = await findInstalledSkillPath(skillName)
  if (!skillPath) {
    throw new Error(`Skill not found: ${skillName}`)
  }

  const JSZip = (await import('jszip')).default
  const zip = new JSZip()

  await addDirectoryToZip(zip, skillPath, '')

  return zip.generateAsync({ type: 'nodebuffer' })
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

export type ImportTenantSkillResult = {
  skillName: string
  id: string
  status: string
  version: string
  displayName: string
  description: string
}

export async function importTenantSkillArchive(
  payload: ImportSkillArchivePayload & { userId: string; authorName?: string },
): Promise<ImportTenantSkillResult> {
  if (!payload.archiveBase64?.trim()) {
    throw new Error('archiveBase64 is required')
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), 'moss-tenant-skill-import-'))
  try {
    await extractSkillZip(Buffer.from(payload.archiveBase64, 'base64'), tempDir)
    return await installTenantSkillFromTemp(tempDir, payload.fileName, payload.userId, payload.authorName)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export async function importTenantSkillDirectory(
  payload: ImportSkillDirectoryPayload & { userId: string; authorName?: string },
): Promise<ImportTenantSkillResult> {
  if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
    throw new Error('entries is required')
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), 'moss-tenant-skill-import-'))
  try {
    await writeDirectoryEntries(tempDir, payload.entries)
    return await installTenantSkillFromTemp(tempDir, undefined, payload.userId, payload.authorName)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function installTenantSkillFromTemp(
  tempDir: string,
  preferredName?: string,
  userId?: string,
  authorName?: string,
): Promise<ImportTenantSkillResult> {
  const skillDir = await findSkillDirWithSkillMd(tempDir)
  if (!skillDir) {
    throw new Error('未找到 SKILL.md，无法识别技能目录')
  }

  const frontmatter = await readSkillFrontmatter(skillDir)
  if (!frontmatter) {
    throw new Error('SKILL.md 读取失败')
  }

  // Determine skill name with priority: preferredName > frontmatter.name > frontmatter.displayName > directory name
  const normalizedPreferredName = normalizeImportedSkillName(preferredName || '')
  const frontmatterName = typeof frontmatter.name === 'string' && frontmatter.name.trim()
    ? normalizeImportedSkillName(frontmatter.name.trim())
    : ''
  const frontmatterDisplayName = typeof frontmatter.displayName === 'string' && frontmatter.displayName.trim()
    ? normalizeImportedSkillName(frontmatter.displayName.trim())
    : ''

  let skillName: string
  if (normalizedPreferredName) {
    skillName = normalizedPreferredName
  } else if (frontmatterName) {
    skillName = frontmatterName
  } else if (frontmatterDisplayName) {
    skillName = frontmatterDisplayName
  } else if (skillDir !== tempDir) {
    skillName = path.basename(skillDir)
  } else {
    throw new Error('无法确定技能名称，请在 SKILL.md 中指定 name 或 displayName 字段')
  }

  // Check if skill already exists in tenant directory
  const existingTenantPath = path.join(MOSS_SKILLS_TENANT_DIR, skillName)
  if (existsSync(existingTenantPath)) {
    throw new Error(`专属技能已存在: ${skillName}`)
  }

  // Install to tenant directory
  const targetDir = path.join(MOSS_SKILLS_TENANT_DIR, skillName)
  await mkdir(MOSS_SKILLS_TENANT_DIR, { recursive: true })
  await rm(targetDir, { recursive: true, force: true })
  await copyDirectoryRecursive(skillDir, targetDir)

  // Build metadata with source_type = 'tenant'
  const meta = buildSkillMetaFromFrontmatter(skillName, frontmatter, {
    source_type: 'tenant',
    is_builtin: false,
  })
  await writeSkillMeta(targetDir, meta)

  return {
    skillName,
    id: `tenant-skill-${Date.now()}`,
    status: 'approved',
    version: meta.installed_version || '1.0.0',
    displayName: meta.display_name || skillName,
    description: meta.description || '',
  }
}
