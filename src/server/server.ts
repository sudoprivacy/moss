import http from 'http'
import { randomUUID } from 'crypto'
import net from 'net'
import { existsSync, cpSync, rmSync, readFileSync, renameSync } from 'fs'
import { lstat, readFile, realpath, stat, mkdir, writeFile, readdir } from 'fs/promises'
import os from 'os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import type { ServerConfig, SessionRecord } from './types.js'
import { saveUploadedIcon } from './utils/iconUpload.js'
import { createServerLogger, type ServerLogger } from './serverLog.js'
import { hasScope, canReadDepartmentSecrets, canWriteUserSecrets, canReadSecretAudit, isStoreAdmin, type AuthContext } from './auth/token.js'
import { deptSecretNamespace } from './secrets/secretSubject.js'
import { AuthService, AuthServiceError } from './auth/service.js'
import { isUserActive, invalidateUserStatusCache } from './auth/userStatusCache.js'
import { RuntimeService } from './runtimeService.js'
import { DRAFTS_DIR_NAME, ensureDraftsDirectory } from './draftsCleanup.js'
import { getSystemSettings, updateSystemSettings } from './systemSettings.js'
import {
  createCustomAssistant,
  fetchAgentHubAssistantDetail,
  fetchAgentHubAssistants,
  fetchAgentHubCategories,
  fetchAgentHubSkillDetailsByIds,
  getInstalledAssistants,
  resolveAssistantDisplayName,
  getHubInstalledAssistants,
  installHubAssistant,
  type AgentHubAssistant,
  uninstallAssistant,
  updateInstalledAssistantMeta,
  batchSyncAssistants,
  type AssistantStoreMeta,
  uploadCustomAssistant,
  packageAssistantZip,
  packageAssistantZipByDir,
  readAssistantMeta,
  findAssistantDir,
  writeAssistantMeta,
  getAssistantSystemPrompt,
} from './agentStore.js'
import {
  fetchSkillHubCategories,
  fetchSkillHubSkillDetail,
  fetchSkillHubSkills,
  getInstalledSkills,
  getHubInstalledSkills,
  importLocalSkillArchive,
  importLocalSkillDirectory,
  importTenantSkillArchive,
  importTenantSkillDirectory,
  installHubSkill,
  setInstalledSkillEnabled,
  setInstalledSkillMeta,
  type SkillHubSkill,
  type SkillStoreMeta,
  uninstallSkill,
  batchSyncSkills,
  uploadCustomSkill,
  packageSkillZip,
  findInstalledSkillPath,
  readSkillMeta,
  readSkillVersion,
  writeSkillMeta,
} from './skillStore.js'
import { createAdaptersApi } from './api/adapters.js'
import {
  getSkillSyncProgress,
  getAgentSyncProgress,
  updateSkillSyncProgress,
  updateAgentSyncProgress,
  resetSkillSyncProgress,
  resetAgentSyncProgress,
} from './syncProgress.js'
import { createEnterpriseApi } from './api/enterprise.js'
import { createChannelsApi } from './api/channels.js'
import { getChannelManager } from '../channels/core/ChannelManager.js'
import { getPairingService } from '../channels/pairing/PairingService.js'
import { MossActionExecutor } from '../channels/gateway/MossActionExecutor.js'
import { WikiJobExecutor } from '../channels/gateway/WikiJobExecutor.js'
import { loadIndex, vectorSearch, rrfFuse, createQuerySemaphore, runWikiGrep } from './wikiIndex/query.js'
import { ensureEmbedder } from './wikiIndex/embedder.js'
import { MOSS_MODELS_DIR } from '../utils/wikis/localWikiDirectories.js'
import { decodeResourceToken } from './wikiResourceToken.js'
import { rewriteWikiImageRefs, isMarkdownPath, RESOURCE_PREFIX } from './wikiImageRefs.js'
import { SourceSyncWorker } from './sources/syncWorker.js'
import { storeSecret, deleteSecret } from './sources/secrets.js'
// Connector implementations register themselves on import.
import './sources/filesystem.js'
import './sources/wecomDrive.js'
// Corp-app connectors register themselves on import.
import './corpapps/wecomApp.js'
import { getUserProfile } from './api/userProfile.js'
import { createConfigItemsApi } from './api/configItems.js'
import { configItemToRule } from './authProxy/authProxyServer.js'
import { createSecretsApi } from './api/secrets.js'
import { createCronApi } from './api/cron.js'
import { CronService } from './services/cron/CronService.js'
import { createMcpAdminApi } from './api/mcpAdmin.js'
import { createMcpUserApi } from './api/mcpUser.js'
import { createMcpUserConfigApi, type McpUserConfigApi } from './api/mcpUserConfig.js'
import { handleMcpSseConnection, broadcastMcpEvent } from './api/mcpEvents.js'
import { McpStore } from './mcp/db.js'
import type { McpTemplateListFilter } from './mcp/types.js'
import type { NexusClient } from './nexus/nexusClient.js'
import { loadBudgetStats } from './budgetStats.js'
import { loadDashboardStats } from './dashboardStats.js'
import { loadSessionContextFromTranscript } from './transcript.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { isVisibleTo, type VisibleTo } from './visibilityFilter.js'
import { MOSS_SKILLS_CUSTOM_DIR, MOSS_SKILLS_HUB_DIR, MOSS_SKILLS_TENANT_DIR, MOSS_SKILLS_TENANT_PENDING_DIR } from '../utils/skills/localSkillDirectories.js'
import { DocumentStore } from './documentStore.js'
import {
  getUserModelPreference,
  setUserModelPreference,
  initUserModelPreferenceStore,
} from './userModelPreference.js'
import { getAvailableModels, getCacheStatus, refreshModelCache } from './modelListCache.js'
import { createCabinApi } from './cabin/api.js'
import { CabinStore } from './cabin/store.js'
import { CabinFlightAutomation } from './cabin/automation.js'
import { CabinHealthReportService } from './cabin/healthReports.js'
import { CabinLogger } from './cabin/logger.js'

type JsonBody = Record<string, unknown>

type MossWorkspaceNode = {
  name: string
  relativePath: string
  fullPath: string
  isFile: boolean
  isDir: boolean
  size?: number
  mtime?: number
  children?: MossWorkspaceNode[]
}

type MossWorkspaceFilePreview =
  | {
      kind: 'text'
      name: string
      relativePath: string
      mime: string
      encoding: 'utf8'
      content: string
      size: number
      truncated: boolean
    }
  | {
      kind: 'base64'
      name: string
      relativePath: string
      mime: string
      contentBase64: string
      size: number
    }

type MossSessionAvailableSkill = {
  name: string
  displayName?: string
  description: string
  icon?: string
  iconUrl?: string
  color?: string
  emoji?: string | null
  source?: string
  path?: string
}

const WORKSPACE_TREE_MAX_DEPTH = 10
const WORKSPACE_TREE_MAX_ENTRIES_PER_DIR = 500
const WORKSPACE_TEXT_PREVIEW_LIMIT_BYTES = 2 * 1024 * 1024
const WORKSPACE_BINARY_PREVIEW_LIMIT_BYTES = 20 * 1024 * 1024
const WORKSPACE_TREE_SKIP_DIRS = new Set(['.git', 'node_modules'])

// Cap concurrent wiki vector queries per process. onnxruntime-node is
// single-session and benefits more from low contention than fan-out.
const wikiVectorQuerySemaphore = createQuerySemaphore(2)

const WORKSPACE_TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.conf', '.cpp', '.css', '.csv', '.go', '.h', '.hpp', '.html',
  '.java', '.js', '.json', '.jsx', '.log', '.md', '.mjs', '.py', '.rs', '.sh',
  '.sql', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
])

const WORKSPACE_PREVIEW_MIME_TYPES: Record<string, string> = {
  '.aac': 'audio/aac',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ts': 'text/typescript; charset=utf-8',
  '.tsx': 'text/tsx; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
}

const MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

function isJsonBody(value: unknown): value is JsonBody {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function serializeSession(session: {
  sessionId: string
  transcriptSessionId: string
  cwd: string
  userId: string
  orgId: string
  role: string
  scopes: string[]
  runtime: SessionRecord['runtime']
  status: string
  desiredState: string
  assistantName?: string | null
  title?: string | null
  source?: string
  channelChatId?: string
  createdAt: number
  lastActiveAt: number
  endedAt: number | null
}) {
  return {
    sessionId: session.sessionId,
    transcriptSessionId: session.transcriptSessionId,
    workDir: session.cwd,
    userId: session.userId,
    orgId: session.orgId,
    role: session.role,
    scopes: session.scopes,
    runtime: session.runtime,
    status: session.status,
    desiredState: session.desiredState,
    assistantName: session.assistantName,
    title: session.title,
    source: session.source,
    channelChatId: session.channelChatId,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    endedAt: session.endedAt,
  }
}

/**
 * Build a per-request, memoized user-id -> display-name resolver. Resolution is
 * org-agnostic (via authService.getUserName), so owners outside the caller's
 * org roster — e.g. a super_admin who created the resource while switched into
 * this org — resolve by name instead of a raw id. Memoizing per request
 * collapses repeated owners in a list to a single DB lookup each (avoids N+1).
 */
function makeUserNameResolver(
  getUserName: (userId: string) => string | undefined,
): (userId: string) => string | undefined {
  const cache = new Map<string, string | undefined>()
  return (userId: string) => {
    if (cache.has(userId)) return cache.get(userId)
    const name = getUserName(userId)
    cache.set(userId, name)
    return name
  }
}

function serializeExternalSource(row: Record<string, unknown>) {
  let configParsed: Record<string, unknown> = {}
  try {
    configParsed = JSON.parse(String(row.config_json ?? '{}')) as Record<string, unknown>
  } catch {
    configParsed = {}
  }
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    type: String(row.type),
    name: String(row.name),
    config: configParsed,
    // Never return the credential blob — just whether one is set.
    hasCredentials: typeof row.credentials_secret_key === 'string' && row.credentials_secret_key.length > 0,
    syncIntervalSec: Number(row.sync_interval_sec ?? 3600),
    autoBuildEnabled: Number(row.auto_build_enabled ?? 0) === 1,
    enabled: Number(row.enabled ?? 0) === 1,
    lastSyncAt: row.last_sync_at == null ? null : Number(row.last_sync_at),
    lastSyncStatus: typeof row.last_sync_status === 'string' ? row.last_sync_status : null,
    lastSyncError: typeof row.last_sync_error === 'string' ? row.last_sync_error : null,
    createdBy: String(row.created_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function serializeCorpApp(row: Record<string, unknown>) {
  let configParsed: Record<string, unknown> = {}
  try {
    configParsed = JSON.parse(String(row.config_json ?? '{}')) as Record<string, unknown>
  } catch {
    configParsed = {}
  }
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    type: String(row.type),
    name: String(row.name),
    appKey: String(row.app_key ?? ''),
    config: configParsed,
    // Never return the credential blob — just whether one is set.
    hasCredentials: typeof row.credentials_secret_key === 'string' && row.credentials_secret_key.length > 0,
    enabled: Number(row.enabled ?? 0) === 1,
    createdBy: String(row.created_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function parseOptionalTimestampQuery(
  value: string | null,
  paramName: string,
): number | null {
  if (value === null || value.trim() === '') {
    return null
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new HttpError(400, `Invalid ${paramName} query parameter`)
  }

  return parsed
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      data += chunk
    })
    req.on('end', () => resolveBody(data))
    req.on('error', reject)
  })
}

function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => {
      chunks.push(Buffer.from(chunk))
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req: http.IncomingMessage): Promise<JsonBody> {
  const rawBody = await readBody(req)
  if (!rawBody.trim()) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    throw new HttpError(400, 'Invalid JSON body')
  }
  if (!isJsonBody(parsed)) {
    throw new HttpError(400, 'JSON body must be an object')
  }
  return parsed
}

async function copySkillToTenantDir(skillName: string, sourcePathOverride?: string): Promise<void> {
  // Prefer the record's stored file_path (a pending skill is staged in the
  // tenant-pending dir); fall back to the custom dir by name for legacy
  // publish-from-custom records.
  const sourceDir = sourcePathOverride && existsSync(sourcePathOverride)
    ? sourcePathOverride
    : join(MOSS_SKILLS_CUSTOM_DIR, skillName)
  const targetDir = join(MOSS_SKILLS_TENANT_DIR, skillName)

  if (!existsSync(sourceDir)) {
    throw new HttpError(404, `Skill directory not found: ${skillName}`)
  }

  // Ensure tenant directory exists
  await mkdir(MOSS_SKILLS_TENANT_DIR, { recursive: true })

  // Copy the skill directory
  cpSync(sourceDir, targetDir, { recursive: true })

  // Update metadata to set source_type to 'tenant'
  const meta = await readSkillMeta(targetDir)
  if (meta) {
    meta.source_type = 'tenant'
    await writeSkillMeta(targetDir, meta)
  }
}

async function copyAssistantToTenantDir(assistantName: string): Promise<void> {
  const MOSS_HOME = process.env.MOSS_HOME || join(os.homedir(), '.moss')
  const MOSS_ASSISTANTS_DIR = join(MOSS_HOME, 'assistants')
  const ASSISTANT_CUSTOM_DIR = join(MOSS_ASSISTANTS_DIR, 'custom')
  const ASSISTANT_TENANT_DIR = join(MOSS_ASSISTANTS_DIR, 'tenant')

  const sourceDir = join(ASSISTANT_CUSTOM_DIR, assistantName)
  const targetDir = join(ASSISTANT_TENANT_DIR, assistantName)

  if (!existsSync(sourceDir)) {
    throw new HttpError(404, `Assistant directory not found: ${assistantName}`)
  }

  // Ensure tenant directory exists
  await mkdir(ASSISTANT_TENANT_DIR, { recursive: true })

  // Copy the agent directory
  cpSync(sourceDir, targetDir, { recursive: true })

  // Update metadata to set source_type to 'tenant'
  const meta = await readAssistantMeta(targetDir)
  if (meta) {
    meta.source_type = 'tenant'
    await writeAssistantMeta(targetDir, meta)
  }
}

/**
 * Copy agent to tenant directory by source path
 * Used when file_path is stored in tenant_assistants table
 */
async function copyAssistantToTenantDirByPath(sourceDir: string): Promise<void> {
  const MOSS_HOME = process.env.MOSS_HOME || join(os.homedir(), '.moss')
  const MOSS_ASSISTANTS_DIR = join(MOSS_HOME, 'assistants')
  const ASSISTANT_TENANT_DIR = join(MOSS_ASSISTANTS_DIR, 'tenant')

  // Use directory name from source path
  const dirName = basename(sourceDir)
  const targetDir = join(ASSISTANT_TENANT_DIR, dirName)

  if (!existsSync(sourceDir)) {
    throw new HttpError(404, `Assistant directory not found: ${sourceDir}`)
  }

  // Ensure tenant directory exists
  await mkdir(ASSISTANT_TENANT_DIR, { recursive: true })

  // Copy the agent directory
  cpSync(sourceDir, targetDir, { recursive: true })

  // Update metadata to set source_type to 'tenant'
  const meta = await readAssistantMeta(targetDir)
  if (meta) {
    meta.source_type = 'tenant'
    await writeAssistantMeta(targetDir, meta)
  }
}

/**
 * Seed builtin system assistants from the repo (`assistants/<name>/`) to
 * `$MOSS_HOME/assistants/system/<name>/` on server boot.
 *
 * Behavior:
 *   - First install (target dir absent): copy it.
 *   - Already present: compare the bundled `installed_version` in
 *     `_moss_meta.json` against the on-disk copy's. If the bundled version is
 *     NEWER, re-seed: move the existing dir aside to
 *     `<name>.bak-<oldVersion>-<ts>` (so client edits are recoverable, never
 *     auto-merged) and copy the new files in. If versions are equal/older or
 *     either lacks a version, skip (preserves client edits across restarts).
 *     This applies to all bundled builtins (wiki-builder, app-builder, …);
 *     a prompt change ships by bumping `installed_version` in that
 *     assistant's bundled `_moss_meta.json`.
 *   - Source dir search order: cwd/assistants → server-bundle-relative
 *     ../assistants → ../../assistants. Allows both dev (cwd in repo root)
 *     and packaged (`bin/moss-server.mjs` + `assistants/` next to it)
 *     deployments to find the source.
 *   - Best-effort: failures log a warning but never abort startup.
 */
async function seedBuiltinSystemAssistants(options: { cabinEnabled?: boolean } = {}): Promise<void> {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(process.cwd(), 'assistants'),
    resolve(currentDir, '..', 'assistants'),
    resolve(currentDir, '..', '..', 'assistants'),
  ]
  let sourceRoot: string | null = null
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      sourceRoot = candidate
      break
    }
  }
  if (!sourceRoot) {
    console.log('[seedBuiltinSystemAssistants] no assistants/ source dir found, skipping')
    return
  }

  const mossHome = process.env.MOSS_HOME || join(os.homedir(), '.moss')
  const systemDir = join(mossHome, 'assistants', 'system')
  await mkdir(systemDir, { recursive: true })

  let entries
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true })
  } catch (err) {
    console.warn('[seedBuiltinSystemAssistants] readdir failed:', err)
    return
  }

  let seeded = 0
  let upgraded = 0
  let skipped = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sourceDir = join(sourceRoot, entry.name)
    const targetDir = join(systemDir, entry.name)
    if (entry.name === 'cabin-ai-flight-attendant' && options.cabinEnabled !== true) {
      skipped++
      continue
    }

    // First install: just copy.
    if (!existsSync(targetDir)) {
      try {
        cpSync(sourceDir, targetDir, { recursive: true })
        seeded++
      } catch (err) {
        console.warn(`[seedBuiltinSystemAssistants] copy failed for ${entry.name}:`, err)
      }
      continue
    }

    // Already present: re-seed only when the bundled version is strictly
    // newer than what's on disk. Unknown versions on either side → skip
    // (don't risk clobbering client edits without a clear upgrade signal).
    const bundledVer = readAssistantInstalledVersion(join(sourceDir, '_moss_meta.json'))
    const installedVer = readAssistantInstalledVersion(join(targetDir, '_moss_meta.json'))
    if (
      bundledVer === null ||
      installedVer === null ||
      compareSemver(bundledVer, installedVer) <= 0
    ) {
      skipped++
      continue
    }

    // Upgrade: back up the existing dir (preserves any client edits, which
    // we never auto-merge), then copy the new files in. The backup name is
    // prefixed with `_` so assistant discovery (scanAssistantDirs /
    // findAssistantDir, which skip `_`-prefixed dirs) never surfaces the
    // backup as a live assistant.
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = join(systemDir, `_${entry.name}.bak-${installedVer}-${ts}`)
    try {
      renameSync(targetDir, backupDir)
      cpSync(sourceDir, targetDir, { recursive: true })
      upgraded++
      console.log(
        `[seedBuiltinSystemAssistants] upgraded ${entry.name} ${installedVer} → ${bundledVer} ` +
          `(previous version backed up to ${backupDir})`,
      )
    } catch (err) {
      console.warn(`[seedBuiltinSystemAssistants] upgrade failed for ${entry.name}:`, err)
      // Best-effort restore so we never leave the agent missing.
      if (!existsSync(targetDir) && existsSync(backupDir)) {
        try {
          renameSync(backupDir, targetDir)
        } catch (restoreErr) {
          console.error(
            `[seedBuiltinSystemAssistants] CRITICAL: failed to restore ${entry.name} from ${backupDir}:`,
            restoreErr,
          )
        }
      }
    }
  }
  if (seeded > 0 || upgraded > 0 || skipped > 0) {
    console.log(
      `[seedBuiltinSystemAssistants] seeded ${seeded} new, upgraded ${upgraded}, ` +
        `${skipped} already present at ${systemDir}`,
    )
  }
}

/**
 * Seed bundled hub skills from repo `skills/hub/<name>/` into
 * `$MOSS_HOME/skills/hub/<name>/`. Assistant skill binding resolves through
 * MOSS_HOME, so bundled skills must be present there before scode sessions are
 * created.
 */
async function seedBundledHubSkills(options: { cabinEnabled?: boolean } = {}): Promise<void> {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(process.cwd(), 'skills', 'hub'),
    resolve(currentDir, '..', 'skills', 'hub'),
    resolve(currentDir, '..', '..', 'skills', 'hub'),
  ]
  let sourceRoot: string | null = null
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      sourceRoot = candidate
      break
    }
  }
  if (!sourceRoot) {
    return
  }

  await mkdir(MOSS_SKILLS_HUB_DIR, { recursive: true })

  let entries
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true })
  } catch (err) {
    console.warn('[seedBundledHubSkills] readdir failed:', err)
    return
  }

  let seeded = 0
  let upgraded = 0
  let skipped = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'cabin-hardware-control' && options.cabinEnabled !== true) {
      skipped++
      continue
    }

    const sourceDir = join(sourceRoot, entry.name)
    const targetDir = join(MOSS_SKILLS_HUB_DIR, entry.name)
    if (!existsSync(targetDir)) {
      try {
        cpSync(sourceDir, targetDir, { recursive: true })
        seeded++
      } catch (err) {
        console.warn(`[seedBundledHubSkills] copy failed for ${entry.name}:`, err)
      }
      continue
    }

    const bundledVer = readSkillInstalledVersion(join(sourceDir, 'SKILL.md'))
    const installedVer = readSkillInstalledVersion(join(targetDir, 'SKILL.md'))
    if (
      bundledVer === null ||
      installedVer === null ||
      compareSemver(bundledVer, installedVer) <= 0
    ) {
      skipped++
      continue
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = join(MOSS_SKILLS_HUB_DIR, `_${entry.name}.bak-${installedVer}-${ts}`)
    try {
      renameSync(targetDir, backupDir)
      cpSync(sourceDir, targetDir, { recursive: true })
      upgraded++
      console.log(
        `[seedBundledHubSkills] upgraded ${entry.name} ${installedVer} → ${bundledVer} ` +
          `(previous version backed up to ${backupDir})`,
      )
    } catch (err) {
      console.warn(`[seedBundledHubSkills] upgrade failed for ${entry.name}:`, err)
      if (!existsSync(targetDir) && existsSync(backupDir)) {
        try {
          renameSync(backupDir, targetDir)
        } catch (restoreErr) {
          console.error(
            `[seedBundledHubSkills] CRITICAL: failed to restore ${entry.name} from ${backupDir}:`,
            restoreErr,
          )
        }
      }
    }
  }

  if (seeded > 0 || upgraded > 0 || skipped > 0) {
    console.log(
      `[seedBundledHubSkills] seeded ${seeded} new, upgraded ${upgraded}, ` +
        `${skipped} already present at ${MOSS_SKILLS_HUB_DIR}`,
    )
  }
}

function readSkillInstalledVersion(skillMdPath: string): string | null {
  try {
    const content = readFileSync(skillMdPath, 'utf-8')
    const match = content.match(/^---\n([\s\S]*?)\n---/)
    if (!match) return null
    for (const line of match[1].split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      if (key !== 'version') continue
      const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '')
      return value || null
    }
    return null
  } catch {
    return null
  }
}

/**
 * Read `installed_version` from an assistant's `_moss_meta.json`. Returns
 * null if the file is missing, unparseable, or has no string version.
 */
function readAssistantInstalledVersion(metaPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf-8')) as { installed_version?: unknown }
    return typeof parsed.installed_version === 'string' && parsed.installed_version.trim()
      ? parsed.installed_version.trim()
      : null
  } catch {
    return null
  }
}

/**
 * Compare two dotted numeric version strings (e.g. "1.2.0" vs "1.10.0").
 * Returns >0 if a>b, <0 if a<b, 0 if equal. Missing components count as 0;
 * non-numeric components compare as 0 (best-effort — builtin versions are
 * plain numeric semver).
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Boot-time sanity check on `$MOSS_HOME/settings.json`.
 *
 * settings.json drives the model / API URL / API key the build worker
 * uses to talk to the LLM provider. If it's missing / empty / has no
 * model or apiKey, wiki builds will hang silently in "Agent 正在阅读
 * 文档" with no obvious error — past experience: 2 hours debugged once.
 *
 * This warns loudly on boot so the operator sees the problem immediately.
 * Non-fatal — server still starts, since (a) settings can be set later
 * via AdminHub, (b) non-build features don't depend on these fields.
 */
function checkSettingsOnBoot(): void {
  const settings = getSystemSettings()
  const banner = '━'.repeat(60)
  if (!settings.settingsExists) {
    console.warn(banner)
    console.warn('[settings] ⚠  $MOSS_HOME/settings.json does NOT exist.')
    console.warn('[settings]    Open AdminHub → 系统设置 and click 保存 to create one,')
    console.warn('[settings]    otherwise wiki build sessions will not have a model/API key configured.')
    console.warn(banner)
    return
  }
  if (!settings.settingsLoaded) {
    console.warn(banner)
    console.warn(`[settings] ⚠  $MOSS_HOME/settings.json failed to parse: ${settings.settingsParseError || 'unknown error'}`)
    console.warn('[settings]    File is being treated as empty. Wiki builds will silently fail.')
    console.warn('[settings]    Open AdminHub → 系统设置 and click 保存 to rewrite it.')
    console.warn(banner)
    return
  }
  const missing: string[] = []
  if (!settings.model || !settings.model.trim()) missing.push('model')
  if (!settings.url || !settings.url.trim()) missing.push('url')
  if (!settings.apiKey || !settings.apiKey.trim()) missing.push('apiKey')
  if (missing.length > 0) {
    console.warn(banner)
    console.warn(`[settings] ⚠  $MOSS_HOME/settings.json is missing critical fields: ${missing.join(', ')}`)
    console.warn('[settings]    Wiki build sessions will hang silently when invoked.')
    console.warn('[settings]    Set them in AdminHub → 系统设置.')
    console.warn(banner)
  }
}

function getBearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization
  if (typeof header !== 'string') {
    return null
  }
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

function authenticateRequest(
  req: http.IncomingMessage,
  authService: AuthService,
): AuthContext | null {
  const token = getBearerToken(req)
  const auth = token ? authService.verifyAccessToken(token) : null
  if (token && !auth) {
    process.stderr.write(`[authenticateRequest] Verification failed for token: ${token.slice(0, 10)}...\n`)
  }
  if (auth && !isUserActive(auth.userId, authService)) return null
  return auth
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Attach sudocode.json fields (sudorouter_key, model_service_url, models)
 * to the login response only when the user has local authorization.
 * Format matches sudowork-server for sudowork code reuse.
 */
function attachSudocodeFields<T extends Record<string, unknown>>(
  tokenResult: T,
): T {
  const user = tokenResult.user as { localAuth?: boolean } | undefined
  if (!user?.localAuth) return tokenResult
  const settings = getSystemSettings()
  return {
    ...tokenResult,
    sudorouter_key: settings.apiKey || null,
    model_service_url: settings.url || 'https://hk.sudorouter.ai/v1',
    models: [settings.model],
  }
}

function redirect(
  res: http.ServerResponse,
  location: string,
): void {
  res.writeHead(302, { location })
  res.end()
}

/**
 * Redirect URI the provider sends the user back to after authentication.
 * This is the sudowork desktop deep link — the provider redirects straight to
 * the app, which validates `state` and forwards the token to moss for login.
 * Register this exact value as an allowed redirect URI at the IdP.
 */
const OAUTH2_DEEP_LINK_REDIRECT_URI = 'sudowork://oauth2-callback'

/**
 * Substitute {placeholder} tokens in the admin-configured authorize URL
 * template. Leaves {state} for the client to fill. Each substituted value is
 * URL-encoded.
 */
function substituteOAuth2Template(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (key === 'state') return match // client fills this
    const value = values[key]
    return value === undefined ? match : encodeURIComponent(value)
  })
}

/**
 * Extract the OAuth2 param dictionary from a login/token request body. Returns
 * a {string:string} map of the non-empty string entries in `body.params`, or
 * null when absent/empty. moss stays provider-agnostic — the credential script
 * validates that the dict contains what it needs (code / access_token / …).
 */
function readOAuth2Params(body: JsonBody): Record<string, string> | null {
  const raw = body.params
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0) {
      params[key] = value
    }
  }
  return Object.keys(params).length > 0 ? params : null
}

function parseRuntimeOptions(body: JsonBody) {
  if (typeof body.runtime_type === 'string') {
    return {
      type: body.runtime_type === 'docker' ? 'docker' : 'host',
      dockerImage:
        typeof body.docker_image === 'string' ? body.docker_image : undefined,
      dockerMode:
        body.docker_mode === 'user'
          ? 'user'
          : body.docker_mode === 'session'
            ? 'session'
            : undefined,
      hostMode:
        body.host_mode === 'user'
          ? 'user'
          : body.host_mode === 'session'
            ? 'session'
            : undefined,
    }
  }
  if (!isJsonBody(body.runtime)) {
    return undefined
  }
  const runtime = body.runtime
  const type =
    runtime.type === 'docker'
      ? 'docker'
      : runtime.type === 'host'
        ? 'host'
        : undefined
  if (!type) {
    return undefined
  }
  return {
    type,
    dockerImage:
      typeof runtime.dockerImage === 'string'
        ? runtime.dockerImage
        : undefined,
    dockerMode:
      runtime.dockerMode === 'user'
        ? 'user'
        : runtime.dockerMode === 'session'
          ? 'session'
          : undefined,
    hostMode:
      runtime.hostMode === 'user' || runtime.host_mode === 'user'
        ? 'user'
        : runtime.hostMode === 'session' || runtime.host_mode === 'session'
          ? 'session'
          : undefined,
  }
}

function buildWsUrl(server: http.Server, config: ServerConfig, sessionId: string): string {
  const address = server.address()
  const actualPort =
    typeof address === 'object' && address ? address.port : config.port

  // Use advertisedHost if configured, otherwise derive from bind host
  let host: string
  if (config.advertisedHost) {
    host = config.advertisedHost
  } else if (config.host === '0.0.0.0' || config.host === '::') {
    host = '127.0.0.1'
  } else {
    host = config.host
  }

  return `ws://${host}:${actualPort}/ws/sessions/${sessionId}`
}

function canAccessSession(
  auth: AuthContext,
  session: { orgId: string; userId: string },
  anyScope: string,
): boolean {
  return (
    session.orgId === auth.orgId &&
    (session.userId === auth.userId || hasScope(auth.scopes, anyScope))
  )
}

function normalizeWorkspaceRelativePath(value: string | null): string {
  if (!value) return ''
  if (value.includes('\0')) throw new HttpError(400, 'Invalid path')
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/')) {
    throw new HttpError(400, 'Path must be relative')
  }
  return normalized
}

function isInsideDir(rootDir: string, targetPath: string): boolean {
  const relativePath = relative(rootDir, targetPath)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

async function realpathOrHttpNotFound(filePath: string, message: string): Promise<string> {
  try {
    return await realpath(filePath)
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new HttpError(404, message)
    }
    throw error
  }
}

async function resolveWorkspaceEntry(rootDir: string, relativePath: string): Promise<{
  rootRealPath: string
  fullPath: string
}> {
  const rootRealPath = await realpathOrHttpNotFound(rootDir, 'Workspace root not found')
  const candidate = resolve(rootRealPath, relativePath)
  if (!isInsideDir(rootRealPath, candidate)) {
    throw new HttpError(403, 'Path escapes workspace root')
  }
  const resolvedTarget = await realpathOrHttpNotFound(candidate, 'Path not found')
  if (!isInsideDir(rootRealPath, resolvedTarget)) {
    throw new HttpError(403, 'Path escapes workspace root')
  }
  return { rootRealPath, fullPath: resolvedTarget }
}

function toWorkspaceRelativePath(rootDir: string, fullPath: string): string {
  return fullPath === rootDir ? '' : fullPath.slice(rootDir.length + 1).split(sep).join('/')
}

function workspacePreviewMime(filePath: string): string {
  return WORKSPACE_PREVIEW_MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

function isWorkspaceTextFile(filePath: string, mime: string): boolean {
  return mime.startsWith('text/') || WORKSPACE_TEXT_EXTENSIONS.has(extname(filePath).toLowerCase())
}

async function buildWorkspaceNode(
  rootDir: string,
  fullPath: string,
  depth: number,
  search: string,
): Promise<MossWorkspaceNode | null> {
  const info = await lstat(fullPath)
  if (info.isSymbolicLink()) return null

  const name = fullPath === rootDir ? basename(rootDir) || rootDir : basename(fullPath)
  const relativePath = toWorkspaceRelativePath(rootDir, fullPath)
  const isDir = info.isDirectory()
  const node: MossWorkspaceNode = {
    name,
    relativePath,
    fullPath,
    isFile: info.isFile(),
    isDir,
    size: info.size,
    mtime: info.mtimeMs,
  }

  if (!isDir || depth <= 0) {
    const matches = !search || name.toLowerCase().includes(search) || relativePath.toLowerCase().includes(search)
    return matches ? node : null
  }

  const entries = (await readdir(fullPath, { withFileTypes: true }))
    .filter(entry => !WORKSPACE_TREE_SKIP_DIRS.has(entry.name))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    .slice(0, WORKSPACE_TREE_MAX_ENTRIES_PER_DIR)

  const children: MossWorkspaceNode[] = []
  for (const entry of entries) {
    const child = await buildWorkspaceNode(rootDir, join(fullPath, entry.name), depth - 1, search)
    if (child) children.push(child)
  }
  node.children = children

  const matches = !search || name.toLowerCase().includes(search) || relativePath.toLowerCase().includes(search)
  return matches || children.length > 0 ? node : null
}

async function readWorkspaceTree(
  session: SessionRecord,
  params: { path?: string | null; search?: string | null },
): Promise<MossWorkspaceNode> {
  const relativePath = normalizeWorkspaceRelativePath(params.path ?? '')
  if (relativePath === '' || relativePath === DRAFTS_DIR_NAME) {
    await ensureDraftsDirectory(session.cwd)
  }
  const { rootRealPath, fullPath } = await resolveWorkspaceEntry(session.cwd, relativePath)
  const info = await lstat(fullPath)
  if (!info.isDirectory()) throw new HttpError(400, 'Path is not a directory')
  const search = (params.search ?? '').trim().toLowerCase()
  const node = await buildWorkspaceNode(rootRealPath, fullPath, WORKSPACE_TREE_MAX_DEPTH, search)
  return node ?? {
    name: basename(fullPath) || fullPath,
    relativePath: toWorkspaceRelativePath(rootRealPath, fullPath),
    fullPath,
    isFile: false,
    isDir: true,
    children: [],
  }
}

async function readWorkspaceFilePreview(
  session: SessionRecord,
  pathParam: string | null,
): Promise<MossWorkspaceFilePreview> {
  const relativePath = normalizeWorkspaceRelativePath(pathParam)
  if (!relativePath) throw new HttpError(400, 'Missing path')
  const { rootRealPath, fullPath } = await resolveWorkspaceEntry(session.cwd, relativePath)
  const info = await lstat(fullPath)
  if (!info.isFile()) throw new HttpError(400, 'Path is not a file')

  const mime = workspacePreviewMime(fullPath)
  const name = basename(fullPath)
  const responseRelativePath = toWorkspaceRelativePath(rootRealPath, fullPath)
  if (isWorkspaceTextFile(fullPath, mime)) {
    if (info.size > WORKSPACE_TEXT_PREVIEW_LIMIT_BYTES) {
      throw new HttpError(413, 'Text file exceeds preview limit')
    }
    return {
      kind: 'text',
      name,
      relativePath: responseRelativePath,
      mime,
      encoding: 'utf8',
      content: await readFile(fullPath, 'utf8'),
      size: info.size,
      truncated: false,
    }
  }

  if (info.size > WORKSPACE_BINARY_PREVIEW_LIMIT_BYTES) {
    throw new HttpError(413, 'Binary file exceeds preview limit')
  }
  return {
    kind: 'base64',
    name,
    relativePath: responseRelativePath,
    mime,
    contentBase64: (await readFile(fullPath)).toString('base64'),
    size: info.size,
  }
}

async function writeWorkspaceFile(
  session: SessionRecord,
  params: { path: string | null; contentBase64: string | null },
): Promise<{ relativePath: string; size: number }> {
  const relativePath = normalizeWorkspaceRelativePath(params.path ?? '')
  if (!relativePath) throw new HttpError(400, 'Missing path')
  if (typeof params.contentBase64 !== 'string') {
    throw new HttpError(400, 'Missing content_base64')
  }

  let buffer: Buffer
  try {
    buffer = Buffer.from(params.contentBase64, 'base64')
  } catch {
    throw new HttpError(400, 'Invalid base64 content')
  }
  // Admin-configurable cap (settings.json: workspaceUploadLimitBytes), read per
  // request so changes take effect without a restart. Falls back to 20MB if the
  // setting is missing/invalid.
  const configuredLimit = getSystemSettings().workspaceUploadLimitBytes
  const uploadLimit =
    Number.isFinite(configuredLimit) && configuredLimit > 0
      ? configuredLimit
      : 20 * 1024 * 1024
  if (buffer.length > uploadLimit) {
    const limitMb = Math.round(uploadLimit / (1024 * 1024))
    throw new HttpError(413, `Uploaded file exceeds size limit (${limitMb}MB)`)
  }

  // Ensure the workspace root exists; for remote sessions it may not be
  // materialized until the runtime spawns, and we want upload-before-first-
  // message to work.
  await mkdir(session.cwd, { recursive: true })
  const rootRealPath = await realpathOrHttpNotFound(session.cwd, 'Workspace root not found')

  // resolveWorkspaceEntry realpaths the target and 404s if it does not exist
  // yet, so for a not-yet-existing destination we mirror its guard logic
  // manually against the resolved root.
  const candidate = resolve(rootRealPath, relativePath)
  if (!isInsideDir(rootRealPath, candidate)) {
    throw new HttpError(403, 'Path escapes workspace root')
  }

  await mkdir(dirname(candidate), { recursive: true })
  await writeFile(candidate, buffer)
  return {
    relativePath: toWorkspaceRelativePath(rootRealPath, candidate),
    size: buffer.length,
  }
}

function normalizeAvailableSkills(value: unknown): MossSessionAvailableSkill[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!isJsonBody(item) || typeof item.name !== 'string' || !item.name.trim()) return []
    const icon = typeof item.icon === 'string' ? item.icon : undefined
    return [{
      name: item.name.trim(),
      displayName: typeof item.displayName === 'string' ? item.displayName : undefined,
      description: typeof item.description === 'string' ? item.description : '',
      ...(icon ? { icon } : {}),
      ...(typeof item.iconUrl === 'string' ? { iconUrl: item.iconUrl } : {}),
      ...(typeof item.color === 'string' ? { color: item.color } : {}),
      emoji: typeof item.emoji === 'string' ? item.emoji : item.emoji === null ? null : undefined,
      ...(typeof item.source === 'string' ? { source: item.source } : {}),
      ...(typeof item.path === 'string' ? { path: item.path } : {}),
    }]
  })
}

function getSessionAvailableSkills(runtime: RuntimeService, sessionId: string): MossSessionAvailableSkill[] {
  const event = runtime.store.latestEvent(sessionId, 'available_skills_snapshot')
  return normalizeAvailableSkills(event?.payload.skills)
}


function resolveAdminDistDir(): string | null {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(process.cwd(), 'admin', 'dist'),
    resolve(currentDir, '..', 'admin', 'dist'),
    resolve(currentDir, '..', '..', 'admin', 'dist'),
    resolve(currentDir, 'admin', 'dist'),
  ]

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) {
      return candidate
    }
  }
  return null
}

function contentTypeForPath(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

async function writeFileResponse(
  res: http.ServerResponse,
  filePath: string,
  headOnly = false,
): Promise<void> {
  const data = headOnly ? null : await readFile(filePath)
  res.writeHead(200, {
    'content-type': contentTypeForPath(filePath),
    'content-length': headOnly
      ? String((await stat(filePath)).size)
      : String(data?.byteLength ?? 0),
  })
  if (headOnly) {
    res.end()
    return
  }
  res.end(data)
}

async function serveAdminRequest(
  res: http.ServerResponse,
  pathname: string,
  adminDistDir: string | null,
  headOnly = false,
): Promise<void> {
  if (!adminDistDir) {
    throw new HttpError(503, 'Admin UI is not built. Run `pnpm --dir admin run build`.')
  }

  const relativePath =
    pathname === '/admin' || pathname === '/admin/'
      ? 'index.html'
      : decodeURIComponent(pathname.replace(/^\/admin\/?/, ''))
  const requestedPath = relativePath || 'index.html'
  const resolvedPath = resolve(adminDistDir, requestedPath)
  const insideAdminRoot =
    resolvedPath === adminDistDir || resolvedPath.startsWith(`${adminDistDir}${sep}`)

  if (!insideAdminRoot) {
    throw new HttpError(403, 'Forbidden')
  }

  try {
    const info = await stat(resolvedPath)
    if (info.isFile()) {
      await writeFileResponse(res, resolvedPath, headOnly)
      return
    }
  } catch {}

  if (requestedPath.includes('.')) {
    throw new HttpError(404, 'Not found')
  }

  await writeFileResponse(res, join(adminDistDir, 'index.html'), headOnly)
}

function writeError(
  logger: ServerLogger,
  res: http.ServerResponse,
  error: unknown,
): void {
  if (error instanceof AuthServiceError || error instanceof HttpError) {
    writeJson(res, error.statusCode, { error: error.message })
    return
  }

  logger.error(error instanceof Error ? error.message : String(error))
  writeJson(res, 500, {
    error: error instanceof Error ? error.message : String(error),
  })
}

function setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const origin = req.headers.origin
  if (!origin) return false

  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id, X-Cabin-Tablet-Token, X-Cabin-Tablet-Id')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Max-Age', '86400')
  return true
}

function handleCorsPreflight(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (req.method === 'OPTIONS' && req.headers.origin) {
    setCorsHeaders(req, res)
    res.writeHead(204)
    res.end()
    return true
  }
  return false
}

export function startServer(
  config: ServerConfig,
  runtime: RuntimeService,
  authService: AuthService,
  logger: ServerLogger = createServerLogger(),
  nexusClient?: NexusClient,
): {
  port: number | null
  ready: Promise<number | null>
  stop: () => Promise<void>
} {
  const adminDistDir = resolveAdminDistDir()
  const wss = new WebSocketServer({ noServer: true })
  const enterpriseApi = createEnterpriseApi(runtime.store, config.runtimeDir, {
    cabinEnabled: config.cabin.enabled,
  })
  const configItemsApi = createConfigItemsApi(runtime.store)
  const secretsApi = nexusClient ? createSecretsApi(runtime.store, nexusClient, (userId: string) => {
    try {
      return authService.getUserName(userId)
    } catch { return undefined }
  }) : null

  // Cron Service - scheduled task execution engine
  const cronService = new CronService(runtime.store.db, {
    runtimeService: runtime,
    runtimeDir: config.runtimeDir,
    defaultRuntime: config.defaultRuntime,
    dockerContainerMode: config.docker?.containerMode ?? 'session',
    workspace: config.workspace,
    getUserAuth: async (userId: string, orgId: string) => {
      try {
        const user = authService.getUserOrNull(userId, orgId)
        if (!user) return null
        return {
          role: user.role,
          scopes: user.scopes || [],
        }
      } catch {
        return null
      }
    },
  })

  // Org-agnostic user-id -> display-name resolver, shared by the API modules
  // below (cron, mcp admin/user) that surface resource-owner names.
  const resolveUserName = (userId: string): string | undefined => {
    try { return authService.getUserName(userId) } catch { return undefined }
  }

  // Cron API - for scheduled tasks management
  const cronApi = createCronApi(runtime.store.db, {
    cronService,
    getUserName: resolveUserName,
    // A user may be a co-owner/executor only if they belong to the job's org.
    // getUserOrNull (no auth arg) resolves org membership without a viewer check.
    isOrgUser: (userId: string, orgId: string) => authService.getUserOrNull(userId, orgId) != null,
  })

  const mcpStore = new McpStore(runtime.store.db)
  const mcpUserConfigApi = nexusClient ? createMcpUserConfigApi({
    nexusClient,
    mcpStore,
    getUserByIdAndOrg: (userId: string, _orgId: string) => {
      try {
        const u = authService.getUserById(userId)
        if (!u) return null
        return { role: 'user', departmentId: u.departmentId }
      } catch { return null }
    },
    listDepartmentsByOrg: (orgId: string) => {
      try { return authService.listDepartments(orgId).departments } catch { return [] }
    },
  }) : null
  const mcpAdminApi = createMcpAdminApi({
    mcpStore,
    authService,
    getUserName: resolveUserName,
    getUserDepartmentId: (userId: string) => {
      try { const u = authService.getUserById(userId); return u?.departmentId ?? null } catch { return null }
    },
  })
  const mcpUserApi = createMcpUserApi({
    mcpStore,
    authService,
    getUserName: resolveUserName,
    getUserDepartmentId: (userId: string) => {
      try { const u = authService.getUserById(userId); return u?.departmentId ?? null } catch { return null }
    },
    getUserByIdAndOrg: (userId: string, _orgId: string) => {
      try {
        const u = authService.getUserById(userId)
        if (!u) return null
        // For visibility filter we need role; use auth.role if querying self
        return { role: 'user', departmentId: u.departmentId }
      } catch { return null }
    },
    listDepartmentsByOrg: (orgId: string) => {
      try { return authService.listDepartments(orgId).departments } catch { return [] }
    },
    nexusClient: nexusClient ?? undefined,
  })


  function refreshAuthProxyRules() {
    const ap = runtime.authProxy
    if (!ap) return
    const items = runtime.store.getAllActiveConfigItems()
    ap.updateRules(items.map(item => configItemToRule(item, id => runtime.store.getConfigEntries(id))))
  }

  const documentStore = new DocumentStore(runtime.store)

  // Initialize user model preference store with the database
  initUserModelPreferenceStore(runtime.store.db)

  // Document Center v2: seed builtin system assistants (wiki-builder etc.)
  // from the repo into $MOSS_HOME/assistants/system/ if not already present.
  // Customers can override by editing files in place — subsequent boots
  // skip existing dirs. Fire-and-forget (best-effort) — boot must not
  // block on this, and failures don't affect server health.
  const seedBuiltinsReady = Promise.all([
    seedBuiltinSystemAssistants({ cabinEnabled: config.cabin.enabled }),
    seedBundledHubSkills({ cabinEnabled: config.cabin.enabled }),
  ]).catch((err) => {
    console.warn('[seedBuiltins] background seed failed:', err)
  })

  // Boot-time settings.json sanity check — warns if model/url/apiKey
  // are missing so the operator doesn't discover it the hard way
  // (wiki builds hanging silently for minutes).
  checkSettingsOnBoot()

  // Document Center: start the wiki build worker. Polls wiki_build_jobs
  // and runs each queued job through RuntimeService with the system
  // `wiki-builder` assistant.
  const wikiJobExecutor = new WikiJobExecutor(runtime, documentStore, runtime.store, {
    enabled: config.wikiIndex.enabled,
    modelId: config.wikiIndex.modelId,
    modelMirror: config.wikiIndex.modelMirror,
    maxPassagesPerWiki: config.wikiIndex.maxPassagesPerWiki,
  })
  wikiJobExecutor.start()

  // Document Center v2: start the external source sync worker. Polls
  // enabled external_sources at their configured interval and mirrors
  // their trees into document_tree_nodes + documents. Marks wikis as
  // needs_rebuild when source content changes. See sources/syncWorker.ts.
  const sourceSyncWorker = new SourceSyncWorker(
    runtime.store,
    documentStore,
    (wikiId, _orgId, _sourceId) => {
      // Auto-build path: enqueue a build job. The WikiJobExecutor will
      // pick it up on its next tick. The sync worker only calls this hook
      // when the affected wiki's own `auto_rebuild` toggle is on.
      try {
        const wiki = documentStore.getWikiById(wikiId)
        if (!wiki) return
        runtime.store.createWikiBuildJob({
          id: randomUUID(),
          wiki_id: wikiId,
          triggered_by: 'source-sync',
        })
      } catch (err) {
        console.error('[server] failed to enqueue auto-build:', err)
      }
    },
  )
  sourceSyncWorker.start()

  // Start cron service for scheduled task execution
  cronService.start().catch(err => {
    console.error('[server] Failed to start cron service:', err)
  })

  // Startup integrity check: approved tenant skills must have their files on
  // disk. The DB row is the source of truth for "this skill exists", but the
  // runtime loads the actual skill from file_path; if the on-disk dir was wiped
  // (e.g. a manual ~/.moss/skills cleanup) the skill silently stops working.
  // Warn loudly so the drift is visible rather than failing at use time. Rows
  // with a null file_path are legacy (created before file_path was persisted)
  // and are reported separately since their location can't be verified.
  try {
    const approvedTenantSkills = runtime.store.listTenantSkills('approved')
    const missing: string[] = []
    const unknownPath: string[] = []
    for (const row of approvedTenantSkills) {
      const filePath = typeof row.file_path === 'string' ? row.file_path.trim() : ''
      const name = typeof row.name === 'string' ? row.name : String(row.id)
      if (!filePath) {
        unknownPath.push(name)
      } else if (!existsSync(filePath)) {
        missing.push(`${name} (${filePath})`)
      }
    }
    if (missing.length) {
      console.warn(
        `[server] ${missing.length} approved tenant skill(s) have a file_path that no longer exists on disk; ` +
          `they will not load until re-uploaded: ${missing.join(', ')}`,
      )
    }
    if (unknownPath.length) {
      console.warn(
        `[server] ${unknownPath.length} approved tenant skill(s) have no recorded file_path (legacy rows); ` +
          `disk presence can't be verified: ${unknownPath.join(', ')}`,
      )
    }
  } catch (err) {
    console.error('[server] tenant skill disk reconcile failed:', err)
  }

  // Initialize ChannelManager and PairingService with database
  // 初始化 ChannelManager 和 PairingService
  const channelManager = getChannelManager()
  channelManager.initialize(runtime.store)
  getPairingService().initialize(runtime.store)

  // Wire up message routing: incoming channel messages -> AI processing -> response
  const pluginManager = channelManager.getPluginManager()
  const sessionManager = channelManager.getSessionManager()
  if (pluginManager && sessionManager) {
    const mossActionExecutor = new MossActionExecutor(
      pluginManager,
      sessionManager,
      getPairingService(),
      runtime,
      runtime.store,
    )
    channelManager.setMessageHandler(mossActionExecutor.getMessageHandler())
    console.log('[Server] MossActionExecutor wired up for channel message routing')
  }


  // Start enabled plugins (for enterprise mode)
  // 启动已启用的插件（企业模式）
  channelManager.startEnabledPlugins().catch((error) => {
    console.error('[Server] Failed to start enabled plugins:', error)
  })

  const cabinAdminStore = config.cabin.enabled ? new CabinStore(runtime.store.db) : null
  const cabinLogger = config.cabin.enabled ? new CabinLogger(config) : undefined
  const cabinHealthReports = config.cabin.enabled && config.cabin.healthReportEnabled && cabinAdminStore
    ? new CabinHealthReportService({ config: config.cabin, store: cabinAdminStore, logger: cabinLogger })
    : undefined
  const channelsApi = createChannelsApi(runtime.store)
  const cabinApi = config.cabin.enabled ? createCabinApi({ config, runtime, healthReports: cabinHealthReports }) : null
  const cabinFlightAutomation = config.cabin.enabled && cabinAdminStore
    ? new CabinFlightAutomation(config, cabinAdminStore, cabinHealthReports)
    : null
  cabinFlightAutomation?.start()

  const server = http.createServer(async (req, res) => {
    try {
      await seedBuiltinsReady
      const url = new URL(req.url || '/', 'http://localhost')
      const pathname = url.pathname
      const isHead = req.method === 'HEAD'

      // Handle CORS preflight for all API routes
      if ((pathname.startsWith('/api/') || pathname.startsWith('/v1/')) && handleCorsPreflight(req, res)) {
        return
      }

      // Set CORS headers for all API routes (non-preflight)
      if (pathname.startsWith('/api/') || pathname.startsWith('/v1/')) {
        setCorsHeaders(req, res)
      }

      if (cabinApi && await cabinApi.handle(req, res, pathname)) {
        return
      }

      if ((req.method === 'GET' || isHead) && pathname === '/') {
        redirect(res, '/admin')
        return
      }

      if ((req.method === 'GET' || isHead) && pathname === '/healthz') {
        writeJson(res, 200, {
          ok: true,
          ready: true,
          sessions: runtime.countActiveSessions(),
          auth_mode: config.authMode,
        })
        return
      }

      if ((req.method === 'GET' || isHead) && pathname === '/readyz') {
        writeJson(res, 200, {
          ok: true,
          ready: true,
        })
        return
      }

      if (
        (req.method === 'GET' || isHead) &&
        (pathname === '/admin' || pathname.startsWith('/admin/'))
      ) {
        await serveAdminRequest(res, pathname, adminDistDir, isHead)
        return
      }

      if (
        req.method === 'POST' &&
        (pathname === '/api/v1/auth/token' || pathname === '/api/v1/auth/login')
      ) {
        const body = await readJsonBody(req)
        const grantType =
          typeof body.grant_type === 'string'
            ? body.grant_type.trim()
            : typeof body.api_key === 'string'
              ? 'api_key'
              : 'password'
        if (grantType === 'api_key') {
          const result = authService.issueTokenFromApiKey(
            typeof body.api_key === 'string' ? body.api_key : '',
          )
          writeJson(res, 200, attachSudocodeFields(result))
          return
        }

        if (grantType === 'password') {
          const result = authService.issueTokenFromPassword({
            username: typeof body.username === 'string' ? body.username : '',
            email: typeof body.email === 'string' ? body.email : '',
            password: typeof body.password === 'string' ? body.password : '',
          })
          writeJson(res, 200, attachSudocodeFields(result))
          return
        }

        if (grantType === 'refresh_token') {
          const refreshToken =
            typeof body.refresh_token === 'string'
              ? body.refresh_token.trim()
              : ''
          if (!refreshToken) {
            throw new HttpError(400, 'Missing refresh_token')
          }
          const result = authService.refreshToken(refreshToken)
          writeJson(res, 200, attachSudocodeFields(result))
          return
        }

        if (grantType === 'oauth2') {
          const params = readOAuth2Params(body)
          if (!params) {
            throw new HttpError(400, 'Missing oauth2 params')
          }
          const result = await authService.issueTokenFromOAuth2({ params })
          writeJson(res, 200, attachSudocodeFields(result))
          return
        }

        if (grantType === 'oauth2_refresh_token') {
          const params = readOAuth2Params(body)
          if (!params) {
            throw new HttpError(400, 'Missing oauth2 params')
          }
          const result = await authService.refreshOAuth2Token({ params })
          writeJson(res, 200, attachSudocodeFields(result))
          return
        }

        throw new HttpError(400, `Unsupported grant_type: ${grantType}`)
      }

      if (req.method === 'POST' && pathname === '/api/v1/auth/logout') {
        const auth = authenticateRequest(req, authService)
        if (!auth) {
          throw new HttpError(401, 'Unauthorized')
        }
        const accessToken = getBearerToken(req)!
        const body = await readJsonBody(req).catch(() => ({}))
        const refreshToken =
          typeof body.refresh_token === 'string'
            ? body.refresh_token.trim()
            : undefined
        authService.logout(accessToken, refreshToken)
        writeJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/auth/oauth2/config') {
        const oauth2 = getSystemSettings().oauth2
        if (!oauth2.enabled || !oauth2.authorizeUrlTemplate || !oauth2.scriptPath) {
          writeJson(res, 200, { enabled: false })
          return
        }
        // The provider redirects straight back to the desktop app via the
        // sudowork deep link — no server-side callback page in this flow.
        // moss only injects {redirect_uri}; sudowork fills {state}. All other
        // provider params (client_id, scope, response_type, …) are written
        // literally into the admin-configured template.
        const authorizeUrl = substituteOAuth2Template(oauth2.authorizeUrlTemplate, {
          redirect_uri: OAUTH2_DEEP_LINK_REDIRECT_URI,
        })
        writeJson(res, 200, {
          enabled: true,
          authorize_url: authorizeUrl,
          require_state: oauth2.requireState,
        })
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/auth/me') {
        const token = getBearerToken(req)
        if (!token) {
          throw new HttpError(401, 'Missing bearer token')
        }
        const auth = authService.verifyAccessToken(token)
        if (!auth) {
          throw new HttpError(401, 'Invalid access token')
        }
        if (!isUserActive(auth.userId, authService)) {
          throw new HttpError(401, 'User account is disabled')
        }
        writeJson(res, 200, authService.getMe(auth))
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/auth/switch-org') {
        const auth = authenticateRequest(req, authService)
        if (!auth) {
          throw new HttpError(401, 'Unauthorized')
        }
        const body = await readJsonBody(req).catch(() => ({}))
        const targetOrgId =
          typeof body.org_id === 'string' ? body.org_id.trim() : ''
        if (!targetOrgId) {
          throw new HttpError(400, 'Missing org_id')
        }
        // switchOrg self-gates on super_admin and validates the target org.
        writeJson(res, 200, authService.switchOrg(auth, targetOrgId))
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/user/profile') {
        const auth = authenticateRequest(req, authService)
        if (!auth) {
          throw new HttpError(401, 'Unauthorized')
        }
        const result = await getUserProfile(auth, authService, runtime.store)
        writeJson(res, 200, result)
        return
      }

      if (pathname.startsWith('/api/v1/channels/')) {
        const auth = authenticateRequest(req, authService)
        if (!auth) {
          throw new HttpError(401, 'Unauthorized')
        }

        // GET /api/v1/channels/plugins
        if (req.method === 'GET' && pathname === '/api/v1/channels/plugins') {
          writeJson(res, 200, await channelsApi.getPlugins(auth.orgId, auth.userId))
          return
        }

        // POST /api/v1/channels/plugins/:id/enable
        const enableMatch = pathname.match(/^\/api\/v1\/channels\/plugins\/([^/]+)\/enable$/)
        if (req.method === 'POST' && enableMatch) {
          const pluginId = enableMatch[1] || ''
          const body = await readJsonBody(req)
          writeJson(res, 200, await channelsApi.enablePlugin(auth.orgId, auth.userId, pluginId, body))
          return
        }

        // POST /api/v1/channels/plugins/:id/disable
        const disableMatch = pathname.match(/^\/api\/v1\/channels\/plugins\/([^/]+)\/disable$/)
        if (req.method === 'POST' && disableMatch) {
          const pluginId = disableMatch[1] || ''
          writeJson(res, 200, await channelsApi.disablePlugin(auth.orgId, auth.userId, pluginId))
          return
        }

        // POST /api/v1/channels/plugins/:id/test
        const testMatch = pathname.match(/^\/api\/v1\/channels\/plugins\/([^/]+)\/test$/)
        if (req.method === 'POST' && testMatch) {
          const pluginId = testMatch[1] || ''
          const body = await readJsonBody(req)
          writeJson(res, 200, await channelsApi.testPlugin(auth.orgId, auth.userId, pluginId, body))
          return
        }

        // POST /api/v1/channels/plugins/:id/delete
        const deleteMatch = pathname.match(/^\/api\/v1\/channels\/plugins\/([^/]+)\/delete$/)
        if (req.method === 'POST' && deleteMatch) {
          const pluginId = deleteMatch[1] || ''
          writeJson(res, 200, await channelsApi.disablePlugin(auth.orgId, auth.userId, pluginId))
          return
        }

        // GET /api/v1/channels/pairings/pending
        if (req.method === 'GET' && pathname === '/api/v1/channels/pairings/pending') {
          writeJson(res, 200, await channelsApi.getPendingPairings(auth.orgId, auth.userId))
          return
        }

        // POST /api/v1/channels/pairings/:code/approve
        const approveMatch = pathname.match(/^\/api\/v1\/channels\/pairings\/([^/]+)\/approve$/)
        if (req.method === 'POST' && approveMatch) {
          const code = approveMatch[1] || ''
          writeJson(res, 200, await channelsApi.approvePairing(auth.orgId, auth.userId, code))
          return
        }

        // POST /api/v1/channels/pairings/:code/reject
        const rejectMatch = pathname.match(/^\/api\/v1\/channels\/pairings\/([^/]+)\/reject$/)
        if (req.method === 'POST' && rejectMatch) {
          const code = rejectMatch[1] || ''
          writeJson(res, 200, await channelsApi.rejectPairing(auth.orgId, auth.userId, code))
          return
        }

        // GET /api/v1/channels/plugins/:id
        const pluginMatch = pathname.match(/^\/api\/v1\/channels\/plugins\/([^/]+)$/)
        if (req.method === 'GET' && pluginMatch) {
          const pluginId = pluginMatch[1] || ''
          const result = await channelsApi.getPlugin(auth.orgId, auth.userId, pluginId)
          if (!result) {
            throw new HttpError(404, 'Plugin not found')
          }
          writeJson(res, 200, result)
          return
        }

        // GET /api/v1/channels/plugins/:id/credentials
        const credMatch = pathname.match(/^\/api\/v1\/channels\/plugins\/([^/]+)\/credentials$/)
        if (req.method === 'GET' && credMatch) {
          const pluginId = credMatch[1] || ''
          const result = await channelsApi.getPluginCredentials(auth.orgId, auth.userId, pluginId)
          if (!result) {
            throw new HttpError(404, 'Plugin not found')
          }
          writeJson(res, 200, result)
          return
        }

        // POST /api/v1/channels/settings/sync
        if (req.method === 'POST' && pathname === '/api/v1/channels/settings/sync') {
          const body = await readJsonBody(req)
          writeJson(res, 200, await channelsApi.syncChannelSettings(auth.orgId, auth.userId, body))
          return
        }

        // GET /api/v1/channels/users
        if (req.method === 'GET' && pathname === '/api/v1/channels/users') {
          writeJson(res, 200, await channelsApi.getUsers(auth.orgId, auth.userId))
          return
        }

        // DELETE /api/v1/channels/users/:id
        const userDelMatch = pathname.match(/^\/api\/v1\/channels\/users\/([^/]+)$/)
        if (req.method === 'DELETE' && userDelMatch) {
          const targetId = userDelMatch[1] || ''
          writeJson(res, 200, await channelsApi.deleteUser(auth.orgId, auth.userId, targetId))
          return
        }

        // DELETE /api/v1/channels/users?platform=xxx
        if (req.method === 'DELETE' && pathname === '/api/v1/channels/users') {
          const urlObj = new URL(req.url as string, `http://${req.headers.host}`)
          const platformType = urlObj.searchParams.get('platform') || ''
          if (!platformType) {
            throw new HttpError(400, 'Missing platform parameter')
          }
          writeJson(res, 200, await channelsApi.deleteUsersByPlatform(auth.orgId, auth.userId, platformType))
          return
        }

        // GET /api/v1/channels/sessions
        if (req.method === 'GET' && pathname === '/api/v1/channels/sessions') {
          writeJson(res, 200, await channelsApi.getSessions(auth.orgId, auth.userId))
          return
        }

        // DELETE /api/v1/channels/sessions/:id
        const sessionDelMatch = pathname.match(/^\/api\/v1\/channels\/sessions\/([^/]+)$/)
        if (req.method === 'DELETE' && sessionDelMatch) {
          const sessionId = sessionDelMatch[1] || ''
          writeJson(res, 200, await channelsApi.deleteSession(auth.orgId, auth.userId, sessionId))
          return
        }

        // POST /api/v1/channels/wechat/qr-start
        if (req.method === 'POST' && pathname === '/api/v1/channels/wechat/qr-start') {
          writeJson(res, 200, await channelsApi.startWechatQrLogin())
          return
        }

        // GET /api/v1/channels/wechat/qr-poll?qrcode=xxx
        if (req.method === 'GET' && pathname === '/api/v1/channels/wechat/qr-poll') {
          const urlObj = new URL(req.url as string, `http://${req.headers.host}`)
          const qrcode = urlObj.searchParams.get('qrcode') || ''
          if (!qrcode) {
            throw new HttpError(400, 'Missing qrcode parameter')
          }
          writeJson(res, 200, await channelsApi.pollWechatQrStatus(qrcode))
          return
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/auth/introspect') {
        const body = await readJsonBody(req)
        const token = typeof body.token === 'string' ? body.token.trim() : ''
        if (!token) {
          throw new HttpError(400, 'Missing token')
        }
        writeJson(res, 200, authService.introspect(token))
        return
      }

      if ((req.method === 'GET' || isHead) && pathname === '/api/v1/tenant/config') {
        writeJson(res, 200, await enterpriseApi.getConfig())
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/cabin/conversations') {
        if (!cabinAdminStore) throw new HttpError(404, 'Cabin is disabled')
        const auth = authenticateRequest(req, authService)
        if (!auth) throw new HttpError(401, 'Unauthorized')
        authService.requireScope(auth, 'admin:settings')
        const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10)
        const offset = Number.parseInt(url.searchParams.get('offset') || '0', 10)
        const statusParam = url.searchParams.get('status') || undefined
        const result = cabinAdminStore.listConversations({
          flightId: url.searchParams.get('flight_id') || undefined,
          flightDate: url.searchParams.get('flight_date') || undefined,
          seatId: url.searchParams.get('seat_id') || undefined,
          passenger: url.searchParams.get('passenger') || undefined,
          status: statusParam === 'active' || statusParam === 'reset' ? statusParam : undefined,
          limit: Number.isFinite(limit) ? limit : 50,
          offset: Number.isFinite(offset) ? offset : 0,
        })
        writeJson(res, 200, {
          conversations: result.conversations.map(conversation => ({
            id: conversation.id,
            passenger_id: conversation.passengerId,
            passenger_ref: conversation.passengerRef,
            passenger_name: conversation.passengerName,
            flight_id: conversation.flightId,
            flight_date: conversation.flightDate,
            seat_id: conversation.seatId,
            tablet_id: conversation.tabletId,
            moss_session_id: conversation.mossSessionId,
            status: conversation.status,
            summary: conversation.summary,
            created_at: conversation.createdAt,
            updated_at: conversation.updatedAt,
          })),
          total: result.total,
          limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50,
          offset: Number.isFinite(offset) ? Math.max(0, offset) : 0,
        })
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/cabin/alerts') {
        if (!cabinAdminStore) throw new HttpError(404, 'Cabin is disabled')
        const auth = authenticateRequest(req, authService)
        if (!auth) throw new HttpError(401, 'Unauthorized')
        authService.requireScope(auth, 'admin:settings')
        const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10)
        const offset = Number.parseInt(url.searchParams.get('offset') || '0', 10)
        const statusParam = url.searchParams.get('status') || undefined
        const result = cabinAdminStore.listAlerts({
          flightId: url.searchParams.get('flight_id') || undefined,
          flightDate: url.searchParams.get('flight_date') || undefined,
          seatNo: url.searchParams.get('seat_no') || undefined,
          status: statusParam === 'active' || statusParam === 'resolved' ? statusParam : undefined,
          limit: Number.isFinite(limit) ? limit : 50,
          offset: Number.isFinite(offset) ? offset : 0,
        })
        writeJson(res, 200, {
          alerts: result.alerts.map(alert => ({
            id: alert.id,
            aircraft_no: alert.aircraftNo,
            flight_id: alert.flightId,
            flight_date: alert.flightDate,
            phase_code: alert.phaseCode,
            phase_name: alert.phaseName,
            seat_no: alert.seatNo,
            alert_type: alert.alertType,
            severity: alert.severity,
            message: alert.message,
            status: alert.status,
            source_event_id: alert.sourceEventId,
            details: alert.details,
            created_at: alert.createdAt,
            resolved_at: alert.resolvedAt,
          })),
          total: result.total,
          limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50,
          offset: Number.isFinite(offset) ? Math.max(0, offset) : 0,
        })
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/cabin/managed-seats') {
        if (!cabinAdminStore) throw new HttpError(404, 'Cabin is disabled')
        const auth = authenticateRequest(req, authService)
        if (!auth) throw new HttpError(401, 'Unauthorized')
        authService.requireScope(auth, 'admin:settings')
        const seats = cabinAdminStore.listManagedSeats({
          aircraftNo: url.searchParams.get('aircraft_no') || undefined,
          flightId: url.searchParams.get('flight_id') || undefined,
          flightDate: url.searchParams.get('flight_date') || undefined,
          activeOnly: url.searchParams.get('active') !== 'false',
        })
        writeJson(res, 200, {
          seats: seats.map(seat => ({
            id: seat.id,
            aircraft_no: seat.aircraftNo,
            flight_id: seat.flightId,
            flight_date: seat.flightDate,
            seat_no: seat.seatNo,
            column_no: seat.columnNo,
            flight_seat_id: seat.flightSeatId,
            aircraft_seat_id: seat.aircraftSeatId,
            tablet_id: seat.tabletId,
            tablet_type: seat.tabletType,
            status: seat.status,
            last_seen_at: seat.lastSeenAt,
            created_at: seat.createdAt,
            updated_at: seat.updatedAt,
          })),
        })
        return
      }

      const cabinConversationMatch = pathname.match(/^\/api\/v1\/cabin\/conversations\/([^/]+)$/)
      if (req.method === 'GET' && cabinConversationMatch) {
        if (!cabinAdminStore) throw new HttpError(404, 'Cabin is disabled')
        const auth = authenticateRequest(req, authService)
        if (!auth) throw new HttpError(401, 'Unauthorized')
        authService.requireScope(auth, 'admin:settings')
        const conversationId = decodeURIComponent(cabinConversationMatch[1] || '')
        const conversation = cabinAdminStore.getConversationById(conversationId)
        if (!conversation) throw new HttpError(404, 'Cabin conversation not found')
        const messages = cabinAdminStore.listMessages(conversation.id, 200)
        writeJson(res, 200, {
          conversation: {
            id: conversation.id,
            passenger_id: conversation.passengerId,
            passenger_ref: conversation.passengerRef,
            passenger_name: conversation.passengerName,
            flight_id: conversation.flightId,
            flight_date: conversation.flightDate,
            seat_id: conversation.seatId,
            tablet_id: conversation.tabletId,
            moss_session_id: conversation.mossSessionId,
            status: conversation.status,
            summary: conversation.summary,
            created_at: conversation.createdAt,
            updated_at: conversation.updatedAt,
          },
          messages: messages.map(message => ({
            id: message.id,
            role: message.role,
            source: message.source,
            content: message.content,
            intent: message.intent,
            slots: message.slots,
            tool_calls: message.toolCalls,
            created_at: message.createdAt,
          })),
        })
        return
      }

      // ---- Static file serving: /uploads/config-items/* (no auth required) ----
      const configIconMatch = pathname.match(/^\/uploads\/config-items\/(.+)$/)
      if (configIconMatch && req.method === 'GET') {
        const filename = basename(configIconMatch[1])
        const filePath = join(config.runtimeDir, 'uploads', 'config-items', filename)
        try {
          const fileContent = await readFile(filePath)
          const ext = extname(filename).slice(1).toLowerCase()
          const contentTypeMap: Record<string, string> = {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            webp: 'image/webp',
            svg: 'image/svg+xml',
          }
          const ct = contentTypeMap[ext] || 'image/png'
          res.writeHead(200, {
            'content-type': ct,
            'cache-control': 'public, max-age=31536000',
          })
          res.end(fileContent)
          return
        } catch {
          throw new HttpError(404, 'File not found')
        }
      }

      // ---- Static file serving: /uploads/mcp-icons/* (no auth required) ----
      const uploadMatch = pathname.match(/^\/uploads\/mcp-icons\/(.+)$/)
      if (uploadMatch && req.method === 'GET') {
        const filename = basename(uploadMatch[1])
        const filePath = join(config.runtimeDir, 'uploads', 'mcp-icons', filename)
        try {
          const fileContent = await readFile(filePath)
          const ext = extname(filename).slice(1).toLowerCase()
          const contentTypeMap: Record<string, string> = {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            webp: 'image/webp',
            svg: 'image/svg+xml',
          }
          const contentType = contentTypeMap[ext] || 'image/png'
          res.writeHead(200, {
            'content-type': contentType,
            'cache-control': 'public, max-age=31536000',
          })
          res.end(fileContent)
          return
        } catch {
          throw new HttpError(404, 'File not found')
        }
      }

      // ---- Public wiki-asset serving: /api/v1/resources/:token/* (no auth) ----
      //
      // Serves wiki images (and other binary assets) by opaque token. The token
      // (see wikiResourceToken.ts) carries `(wikiId, relPath)` plus an integrity
      // tag; the trailing path segment is a cosmetic filename only and is
      // ignored for lookup. Intentionally PUBLIC — the unguessable, unforgeable
      // token is the only gate, so a client rendering agent-relayed markdown can
      // load images without an auth header. MUST stay above the auth boundary
      // below. Path traversal is independently blocked by the containment check.
      const resourceMatch = pathname.match(
        new RegExp(`^${RESOURCE_PREFIX}/([^/]+)(?:/.*)?$`),
      )
      if (resourceMatch && req.method === 'GET') {
        // decodeURIComponent throws URIError on a malformed %-escape; a crafted
        // URL must 404, not 500. base64url tokens never contain %, so decoding
        // is only defensive.
        let rawToken: string
        try {
          rawToken = decodeURIComponent(resourceMatch[1]!)
        } catch {
          throw new HttpError(404, 'Not found')
        }
        const decoded = decodeResourceToken(rawToken, config.wikiIndex.resourceTokenSecret)
        if (!decoded) throw new HttpError(404, 'Not found')

        // Cross-org getter: the token is the gate, not org membership.
        const wiki = documentStore.getWikiById(decoded.wikiId)
        if (!wiki) throw new HttpError(404, 'Not found')

        const root = resolve(wiki.storagePath)
        const target = resolve(root, decoded.relPath.replace(/^\/+/, ''))
        if (target !== root && !target.startsWith(root + sep)) {
          throw new HttpError(400, 'Invalid path')
        }

        let fileContent: Buffer
        try {
          const info = await stat(target)
          if (!info.isFile()) throw new HttpError(404, 'Not found')
          fileContent = await readFile(target)
        } catch (err) {
          if (err instanceof HttpError) throw err
          throw new HttpError(404, 'Not found')
        }

        res.writeHead(200, {
          'content-type': contentTypeForPath(target),
          // Token encodes the path, so a given URL always maps to the same
          // asset; cache aggressively. (In-place wiki edits are an operational
          // rebuild event, not a per-request concern.)
          'cache-control': 'public, max-age=86400',
        })
        res.end(fileContent)
        return
      }

      // Public: Config Items (JWT auth, no admin scope)
      if (req.method === 'GET' && pathname === '/api/v1/config/items') {
        const auth = authenticateRequest(req, authService)
        if (!auth) throw new HttpError(401, 'Unauthorized')
        const result = configItemsApi.listPublic(auth, (userId) => authService.getUserById(userId))
        if (result.success && nexusClient) {
          try {
            const configuredNs = nexusClient.listConfiguredNamespaces()
            const orgPrefix = `org:${auth.orgId}:`
            result.data = result.data.filter((item: { scope: string; pinyin: string }) => {
              // User-scope items are populated per-user *from the client*, so they
              // must be returned even when no value exists yet — otherwise the end
              // user has no field to fill in (chicken-and-egg). Only enterprise
              // (system) and department (role) items are admin-configured
              // server-side and hidden until a value is stored.
              if (item.scope === 'user') return true
              // Enterprise (system) / department (role) namespaces are org-scoped
              // in Nexus. Match each scope explicitly; any unknown future scope is
              // hidden until it has an explicit handler (safe default).
              const ns = item.scope === 'system' ? `${orgPrefix}system:${item.pinyin}`
                : item.scope === 'department' ? `${orgPrefix}role:${item.pinyin}`
                : null
              return ns !== null && configuredNs.has(ns)
            })
          } catch { /* nexus unavailable — return unfiltered */ }
        }
        writeJson(res, 200, result)
        return
      }

      // Document Center v2: SSE build-events route accepts ?token=xxx as
      // a fallback because browser EventSource can't send custom headers.
      // Scope: only this single route; getBearerToken stays header-only
      // everywhere else.
      let auth = authenticateRequest(req, authService)
      if (!auth && req.method === 'GET') {
        const isSseBuildEvents = /^\/api\/v1\/wikis\/[^/]+\/build-events$/.test(pathname)
        const isSseMcpEvents = pathname === '/api/v1/mcp/events'
        if (isSseBuildEvents || isSseMcpEvents) {
          const queryToken = url.searchParams.get('token')
          if (queryToken) {
            try {
              auth = authService.verifyAccessToken(queryToken)
            } catch {
              // fall through to 401 below
            }
          }
        }
      }
      if (!auth) {
        throw new HttpError(401, 'Unauthorized')
      }

      const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket?.remoteAddress || undefined

      if (req.method === 'GET' && pathname === '/api/v1/roles') {
        authService.requireScope(auth, 'admin:users')
        writeJson(res, 200, authService.listRoles())
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/departments') {
        authService.requireScope(auth, 'admin:users')
        writeJson(res, 200, authService.listDepartments(auth.orgId, auth))
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/departments') {
        authService.requireScope(auth, 'admin:users')
        const body = await readJsonBody(req)
        // Org pinned to caller's current org (no cross-org via body.org_id).
        writeJson(
          res,
          200,
          authService.createDepartment({
            orgId: auth.orgId,
            name: typeof body.name === 'string' ? body.name : '',
            parentId:
              body.parent_id === null || typeof body.parent_id === 'string'
                ? body.parent_id
                : undefined,
            extDeptId:
              body.ext_dept_id === null || typeof body.ext_dept_id === 'string'
                ? body.ext_dept_id
                : undefined,
          }, auth),
        )
        return
      }

      const departmentMatch = pathname.match(/^\/api\/v1\/departments\/([^/]+)$/)
      if (req.method === 'PATCH' && departmentMatch) {
        authService.requireScope(auth, 'admin:users')
        const departmentId = departmentMatch[1] || ''
        const body = await readJsonBody(req)
        writeJson(
          res,
          200,
          authService.updateDepartment({
            orgId: auth.orgId,
            departmentId,
            name: typeof body.name === 'string' ? body.name : undefined,
            parentId:
              body.parent_id === null || typeof body.parent_id === 'string'
                ? body.parent_id
                : undefined,
            extDeptId:
              body.ext_dept_id === null || typeof body.ext_dept_id === 'string'
                ? body.ext_dept_id
                : undefined,
          }, auth),
        )
        return
      }

      if (req.method === 'DELETE' && departmentMatch) {
        authService.requireScope(auth, 'admin:users')
        const departmentId = departmentMatch[1] || ''
        writeJson(
          res,
          200,
          authService.deleteDepartment({
            orgId: auth.orgId,
            departmentId,
          }, auth),
        )
        return
      }

      // ============================================================
      // Organizations CRUD: /api/v1/organizations/*
      // Surfaces the already-multi-tenant schema. scope: admin:settings.
      // Delete relies on the FK constraint to reject non-empty orgs
      // (translated to HTTP 409 by the service).
      // ============================================================

      if (req.method === 'GET' && pathname === '/api/v1/organizations') {
        // Cross-org: only super_admin may enumerate all organizations (powers
        // the org switcher). A normal admin is confined to its own org.
        authService.requireSuperAdmin(auth)
        writeJson(res, 200, authService.listAllOrganizations())
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/organizations') {
        authService.requireSuperAdmin(auth)
        const body = await readJsonBody(req)
        writeJson(
          res,
          200,
          authService.createOrganization({
            name: typeof body.name === 'string' ? body.name : '',
            extOrgId:
              body.ext_org_id === null || typeof body.ext_org_id === 'string'
                ? body.ext_org_id
                : undefined,
          }),
        )
        return
      }

      const organizationMatch = pathname.match(/^\/api\/v1\/organizations\/([^/]+)$/)
      if (req.method === 'PATCH' && organizationMatch) {
        authService.requireSuperAdmin(auth)
        const orgId = organizationMatch[1] || ''
        const body = await readJsonBody(req)
        writeJson(
          res,
          200,
          authService.updateOrganization({
            orgId,
            name: typeof body.name === 'string' ? body.name : undefined,
            extOrgId:
              body.ext_org_id === null || typeof body.ext_org_id === 'string'
                ? body.ext_org_id
                : undefined,
          }),
        )
        return
      }

      if (req.method === 'DELETE' && organizationMatch) {
        authService.requireSuperAdmin(auth)
        const orgId = organizationMatch[1] || ''
        writeJson(res, 200, authService.deleteOrganization({ orgId }))
        return
      }

      // ============================================================
      // Document Center (P0): /api/v1/documents/* + /api/v1/wikis/*
      // ============================================================

      // ---- Tree nodes ----
      if (req.method === 'GET' && pathname === '/api/v1/documents/tree') {
        authService.requireScope(auth, 'admin:documents')
        writeJson(res, 200, { nodes: documentStore.listTree(auth.orgId) })
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/documents/tree/nodes') {
        authService.requireScope(auth, 'admin:documents')
        const body = await readJsonBody(req)
        // Can't add manual children under a source-managed node — the whole
        // synced subtree is owned by the external source.
        if (typeof body.parent_id === 'string' && body.parent_id) {
          const parent = documentStore.getNode(body.parent_id, auth.orgId)
          if (parent?.autoManaged) {
            writeJson(res, 400, {
              error: { code: 'auto_managed', message: '该节点由外部数据源管理,无法在其下新建子节点。' },
            })
            return
          }
        }
        try {
          const node = documentStore.createNode({
            orgId: auth.orgId,
            parentId:
              body.parent_id === null
                ? null
                : typeof body.parent_id === 'string'
                  ? body.parent_id
                  : null,
            name: typeof body.name === 'string' ? body.name.trim() : '',
            description: typeof body.description === 'string' ? body.description : undefined,
            sortOrder: typeof body.sort_order === 'number' ? body.sort_order : undefined,
          })
          if (!node.name) {
            writeJson(res, 400, { error: { code: 'invalid_payload', message: 'name is required' } })
            return
          }
          writeJson(res, 200, node)
        } catch (err) {
          writeJson(res, 400, { error: { code: 'create_failed', message: err instanceof Error ? err.message : String(err) } })
        }
        return
      }

      const documentNodeMatch = pathname.match(/^\/api\/v1\/documents\/tree\/nodes\/([^/]+)$/)
      if (req.method === 'PATCH' && documentNodeMatch) {
        authService.requireScope(auth, 'admin:documents')
        const nodeId = documentNodeMatch[1] || ''
        const body = await readJsonBody(req)
        // v2: auto_managed nodes cannot be renamed/moved/described by admins —
        // only their alias (via /alias endpoint below). Sync worker owns name.
        const existingNode = documentStore.getNode(nodeId, auth.orgId)
        if (existingNode?.autoManaged) {
          writeJson(res, 400, {
            error: {
              code: 'auto_managed',
              message: '该节点由外部数据源管理,无法直接修改。请使用「设置别名」或修改源后等待同步。',
            },
          })
          return
        }
        try {
          const updated = documentStore.updateNode(nodeId, auth.orgId, {
            parentId:
              body.parent_id === undefined
                ? undefined
                : body.parent_id === null
                  ? null
                  : typeof body.parent_id === 'string'
                    ? body.parent_id
                    : undefined,
            name: typeof body.name === 'string' ? body.name : undefined,
            description:
              body.description === null
                ? null
                : typeof body.description === 'string'
                  ? body.description
                  : undefined,
            sortOrder: typeof body.sort_order === 'number' ? body.sort_order : undefined,
          })
          writeJson(res, 200, updated)
        } catch (err) {
          writeJson(res, 400, { error: { code: 'update_failed', message: err instanceof Error ? err.message : String(err) } })
        }
        return
      }

      if (req.method === 'DELETE' && documentNodeMatch) {
        authService.requireScope(auth, 'admin:documents')
        const nodeId = documentNodeMatch[1] || ''
        // v2: while its source still exists, an auto_managed node is mirror state —
        // it can only be removed by deleting the source or by sync's reverse-sweep,
        // so admins delete the SOURCE, not individual mirrored nodes. But once the
        // source is gone (deleted), the node is an orphaned tree with no owner and
        // no future sync to sweep it; allow deleting it directly so admins can clean
        // up stale trees left behind by pre-cascade source deletions.
        const existing = documentStore.getNode(nodeId, auth.orgId)
        if (existing?.autoManaged) {
          const sourceStillExists =
            !!existing.sourceId && !!runtime.store.getExternalSource(existing.sourceId, auth.orgId)
          if (sourceStillExists) {
            writeJson(res, 400, {
              error: {
                code: 'auto_managed',
                message: '该节点由外部数据源管理,无法直接删除。请在「外部数据源」中删除整个源,或在源系统中删除原文件后等待同步。',
              },
            })
            return
          }
        }
        await documentStore.deleteNode(nodeId, auth.orgId)
        writeJson(res, 200, { ok: true })
        return
      }

      // v2: PATCH alias on auto_managed nodes. (No-op on non-auto_managed
      // since rename is the regular path for those.)
      const aliasMatch = pathname.match(/^\/api\/v1\/documents\/tree\/nodes\/([^/]+)\/alias$/)
      if (req.method === 'PATCH' && aliasMatch) {
        authService.requireScope(auth, 'admin:documents')
        const nodeId = aliasMatch[1] || ''
        const body = await readJsonBody(req)
        const alias = typeof body.alias === 'string'
          ? (body.alias.trim() || null)
          : body.alias === null
            ? null
            : null
        runtime.store.setTreeNodeAlias(nodeId, auth.orgId, alias)
        const updated = documentStore.getNode(nodeId, auth.orgId)
        writeJson(res, 200, updated ?? { ok: true })
        return
      }

      // ---- Documents (uploads) ----
      const documentsByNodeMatch = pathname.match(/^\/api\/v1\/documents\/tree\/nodes\/([^/]+)\/documents$/)
      if (req.method === 'GET' && documentsByNodeMatch) {
        authService.requireScope(auth, 'admin:documents')
        const nodeId = documentsByNodeMatch[1] || ''
        // ?recursive=1 lists the whole subtree (used by the wiki external-source
        // files picker); default lists this node's direct documents.
        const recursive = new URL(req.url ?? '', 'http://localhost').searchParams.get('recursive') === '1'
        const docs = recursive
          ? documentStore.listDocumentsUnderNode(nodeId, auth.orgId)
          : documentStore.listDocumentsForNode(nodeId, auth.orgId)
        writeJson(res, 200, { documents: docs })
        return
      }

      if (req.method === 'POST' && documentsByNodeMatch) {
        authService.requireScope(auth, 'admin:documents')
        const nodeId = documentsByNodeMatch[1] || ''
        // Can't upload into a source-managed node — content there is owned by
        // the external source (synced only).
        const targetNode = documentStore.getNode(nodeId, auth.orgId)
        if (targetNode?.autoManaged) {
          writeJson(res, 400, {
            error: { code: 'auto_managed', message: '该节点由外部数据源管理,无法手动上传文档。' },
          })
          return
        }
        const body = await readJsonBody(req)
        const fileName = typeof body.file_name === 'string' ? body.file_name : ''
        const mimeType = typeof body.mime_type === 'string' ? body.mime_type : 'application/octet-stream'
        const contentB64 = typeof body.content_base64 === 'string' ? body.content_base64 : ''
        if (!fileName || !contentB64) {
          writeJson(res, 400, { error: { code: 'invalid_payload', message: 'file_name and content_base64 are required' } })
          return
        }
        let content: Buffer
        try {
          content = Buffer.from(contentB64, 'base64')
        } catch {
          writeJson(res, 400, { error: { code: 'invalid_payload', message: 'content_base64 is not valid base64' } })
          return
        }
        // Size limit: 50MB per file
        const MAX_DOC_SIZE = 50 * 1024 * 1024
        if (content.byteLength > MAX_DOC_SIZE) {
          writeJson(res, 413, { error: { code: 'payload_too_large', message: `document exceeds 50MB limit` } })
          return
        }
        try {
          const doc = await documentStore.uploadDocument({
            orgId: auth.orgId,
            nodeId,
            fileName,
            mimeType,
            content,
            uploadedBy: auth.userId,
          })
          writeJson(res, 200, doc)
        } catch (err) {
          writeJson(res, 400, { error: { code: 'upload_failed', message: err instanceof Error ? err.message : String(err) } })
        }
        return
      }

      const documentItemMatch = pathname.match(/^\/api\/v1\/documents\/([^/]+)$/)
      if (req.method === 'DELETE' && documentItemMatch) {
        authService.requireScope(auth, 'admin:documents')
        const docId = documentItemMatch[1] || ''
        await documentStore.deleteDocument(docId, auth.orgId)
        writeJson(res, 200, { ok: true })
        return
      }

      // ---- Wikis ----
      if (req.method === 'GET' && pathname === '/api/v1/wikis') {
        authService.requireScope(auth, 'admin:documents')
        const url = new URL(req.url ?? '', 'http://localhost')
        const nodeId = url.searchParams.get('node_id') ?? undefined
        const buildStatus = url.searchParams.get('build_status') ?? undefined
        writeJson(res, 200, {
          // Enriched: recomputes Track 2 (files-mode) staleness against
          // _moss_meta.json so 已构建 / 需重新构建 tags are accurate.
          wikis: await documentStore.listWikisEnriched(auth.orgId, {
            nodeId,
            buildStatus: buildStatus as any,
          }),
        })
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/wikis') {
        authService.requireScope(auth, 'admin:documents')
        const body = await readJsonBody(req)
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (!name) {
          writeJson(res, 400, { error: { code: 'invalid_payload', message: 'name is required' } })
          return
        }
        const strArr = (v: unknown): string[] =>
          Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === 'string') : []
        const sourceDocumentIds = strArr(body.source_document_ids)
        const sourceMode = body.source_mode === 'dir' ? 'dir' : 'files'
        // Multi-dir: source_node_ids[]; back-compat: fold single source_node_id.
        const sourceNodeIds = strArr(body.source_node_ids)
        if (sourceNodeIds.length === 0 && typeof body.source_node_id === 'string') {
          sourceNodeIds.push(body.source_node_id)
        }
        const sourceExcludeNodeIds = strArr(body.source_exclude_node_ids)
        // Validate per mode: dir needs >=1 dir node; files needs >=1 doc.
        if (sourceMode === 'dir' && sourceNodeIds.length === 0) {
          writeJson(res, 400, { error: { code: 'invalid_payload', message: 'source_node_ids must be non-empty for dir mode' } })
          return
        }
        if (sourceMode === 'files' && sourceDocumentIds.length === 0) {
          writeJson(res, 400, { error: { code: 'invalid_payload', message: 'source_document_ids must be non-empty for files mode' } })
          return
        }
        try {
          const wiki = await documentStore.createWiki({
            orgId: auth.orgId,
            nodeId:
              body.node_id === null
                ? null
                : typeof body.node_id === 'string'
                  ? body.node_id
                  : null,
            name,
            description: typeof body.description === 'string' ? body.description : undefined,
            sourceDocumentIds,
            sourceMode,
            sourceNodeIds,
            sourceExcludeNodeIds,
            autoRebuild: body.auto_rebuild === true,
            createdBy: auth.userId,
          })
          writeJson(res, 200, wiki)
        } catch (err) {
          writeJson(res, 400, { error: { code: 'create_failed', message: err instanceof Error ? err.message : String(err) } })
        }
        return
      }

      const wikiItemMatch = pathname.match(/^\/api\/v1\/wikis\/([^/]+)$/)
      if (req.method === 'GET' && wikiItemMatch) {
        authService.requireScope(auth, 'admin:documents')
        const wikiId = wikiItemMatch[1] || ''
        const wiki = await documentStore.getWikiEnriched(wikiId, auth.orgId)
        if (!wiki) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'wiki not found' } })
          return
        }
        writeJson(res, 200, wiki)
        return
      }

      if (req.method === 'PATCH' && wikiItemMatch) {
        authService.requireScope(auth, 'admin:documents')
        const wikiId = wikiItemMatch[1] || ''
        const body = await readJsonBody(req)
        const strArr = (v: unknown): string[] =>
          Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === 'string') : []
        const sourceMode =
          body.source_mode === 'dir' ? 'dir' : body.source_mode === 'files' ? 'files' : undefined
        const sourceDocumentIds =
          body.source_document_ids !== undefined ? strArr(body.source_document_ids) : undefined
        const sourceNodeIds =
          body.source_node_ids !== undefined ? strArr(body.source_node_ids) : undefined
        const sourceExcludeNodeIds =
          body.source_exclude_node_ids !== undefined ? strArr(body.source_exclude_node_ids) : undefined
        // Switching to files → require picks; switching to dir → require dir nodes.
        if (sourceMode === 'files' && sourceDocumentIds !== undefined && sourceDocumentIds.length === 0) {
          writeJson(res, 400, { error: { code: 'invalid_payload', message: 'source_document_ids must be non-empty for files mode' } })
          return
        }
        if (sourceMode === 'dir' && sourceNodeIds !== undefined && sourceNodeIds.length === 0) {
          writeJson(res, 400, { error: { code: 'invalid_payload', message: 'source_node_ids must be non-empty for dir mode' } })
          return
        }
        try {
          const wiki = documentStore.updateWiki(wikiId, auth.orgId, {
            name: typeof body.name === 'string' ? body.name : undefined,
            description:
              body.description === null
                ? null
                : typeof body.description === 'string'
                  ? body.description
                  : undefined,
            nodeId:
              body.node_id === undefined
                ? undefined
                : body.node_id === null
                  ? null
                  : typeof body.node_id === 'string'
                    ? body.node_id
                    : undefined,
            sourceDocumentIds,
            sourceMode,
            sourceNodeIds,
            sourceExcludeNodeIds,
            autoRebuild: body.auto_rebuild === undefined ? undefined : body.auto_rebuild === true,
          })
          writeJson(res, 200, wiki)
        } catch (err) {
          writeJson(res, 400, { error: { code: 'update_failed', message: err instanceof Error ? err.message : String(err) } })
        }
        return
      }

      if (req.method === 'DELETE' && wikiItemMatch) {
        authService.requireScope(auth, 'admin:documents')
        const wikiId = wikiItemMatch[1] || ''
        await documentStore.deleteWiki(wikiId, auth.orgId)
        writeJson(res, 200, { ok: true })
        return
      }

      // ---- Wiki Build ----
      if (req.method === 'GET' && pathname === '/api/v1/wiki-build-jobs') {
        authService.requireScope(auth, 'admin:documents')
        const url = new URL(req.url ?? '', 'http://localhost')
        const rawStatus = url.searchParams.get('status')
        const status = rawStatus && ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(rawStatus)
          ? rawStatus as 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
          : undefined
        const wikiId = url.searchParams.get('wiki_id') ?? undefined
        const limitParam = Number(url.searchParams.get('limit') ?? '50')
        const offsetParam = Number(url.searchParams.get('offset') ?? '0')
        const result = documentStore.listBuildJobsForOrg(auth.orgId, {
          status,
          wikiId,
          limit: Number.isFinite(limitParam) ? limitParam : 50,
          offset: Number.isFinite(offsetParam) ? offsetParam : 0,
        })
        writeJson(res, 200, result)
        return
      }

      const wikiBuildJobItemMatch = pathname.match(/^\/api\/v1\/wiki-build-jobs\/([^/]+)$/)
      if (req.method === 'GET' && wikiBuildJobItemMatch) {
        authService.requireScope(auth, 'admin:documents')
        const jobId = wikiBuildJobItemMatch[1] || ''
        const job = documentStore.getBuildJobForOrg(jobId, auth.orgId)
        if (!job) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'build job not found' } })
          return
        }
        writeJson(res, 200, job)
        return
      }

      const wikiBuildJobRetryMatch = pathname.match(/^\/api\/v1\/wiki-build-jobs\/([^/]+)\/retry$/)
      if (req.method === 'POST' && wikiBuildJobRetryMatch) {
        authService.requireScope(auth, 'admin:documents')
        const jobId = wikiBuildJobRetryMatch[1] || ''
        const job = documentStore.getBuildJobForOrg(jobId, auth.orgId)
        if (!job) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'build job not found' } })
          return
        }
        const newJob = documentStore.createBuildJob({ wikiId: job.wikiId, triggeredBy: auth.userId })
        documentStore.setWikiBuildResult(job.wikiId, { status: 'pending' })
        writeJson(res, 200, { job_id: newJob.id, wiki_id: job.wikiId })
        return
      }

      const wikiBuildJobCancelMatch = pathname.match(/^\/api\/v1\/wiki-build-jobs\/([^/]+)\/cancel$/)
      if (req.method === 'POST' && wikiBuildJobCancelMatch) {
        authService.requireScope(auth, 'admin:documents')
        const jobId = wikiBuildJobCancelMatch[1] || ''
        const job = documentStore.getBuildJobForOrg(jobId, auth.orgId)
        if (!job) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'build job not found' } })
          return
        }
        if (job.status !== 'running' && job.status !== 'queued') {
          writeJson(res, 409, {
            error: { code: 'not_cancellable', message: 'job is not in progress' },
          })
          return
        }
        // Running job: signal the executor to terminate its session and unwind.
        // Not in the running set (queued, or owned by another instance): mark
        // it cancelled directly so the executor skips it when a slot frees.
        const signalled = await wikiJobExecutor.cancelJob(jobId)
        if (!signalled) {
          documentStore.updateBuildJob(jobId, {
            status: 'cancelled',
            currentStep: '已终止',
            finishedAt: Date.now(),
          })
        }
        writeJson(res, 200, { job_id: jobId, status: 'cancelling' })
        return
      }

      const wikiBuildJobsByWikiMatch = pathname.match(/^\/api\/v1\/wikis\/([^/]+)\/build-jobs$/)
      if (req.method === 'GET' && wikiBuildJobsByWikiMatch) {
        authService.requireScope(auth, 'admin:documents')
        const wikiId = wikiBuildJobsByWikiMatch[1] || ''
        const wiki = documentStore.getWiki(wikiId, auth.orgId)
        if (!wiki) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'wiki not found' } })
          return
        }
        const url = new URL(req.url ?? '', 'http://localhost')
        const limitParam = Number(url.searchParams.get('limit') ?? '20')
        writeJson(res, 200, {
          jobs: documentStore.listBuildJobs(wikiId, Number.isFinite(limitParam) ? limitParam : 20),
        })
        return
      }

      const wikiBuildMatch = pathname.match(/^\/api\/v1\/wikis\/([^/]+)\/build$/)
      if (req.method === 'POST' && wikiBuildMatch) {
        authService.requireScope(auth, 'admin:documents')
        const wikiId = wikiBuildMatch[1] || ''
        const wiki = documentStore.getWiki(wikiId, auth.orgId)
        if (!wiki) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'wiki not found' } })
          return
        }
        // P0: queue a build job. The actual worker (D5) will pick it up
        // and call RuntimeService.createSession. For now we just persist
        // the job; the placeholder build worker will be wired in next step.
        const job = documentStore.createBuildJob({
          wikiId,
          triggeredBy: auth.userId,
        })
        documentStore.setWikiBuildResult(wikiId, { status: 'pending' })
        writeJson(res, 200, { job_id: job.id, wiki_id: wikiId })
        return
      }

      const wikiBuildStatusMatch = pathname.match(/^\/api\/v1\/wikis\/([^/]+)\/build-status$/)
      if (req.method === 'GET' && wikiBuildStatusMatch) {
        authService.requireScope(auth, 'admin:documents')
        const wikiId = wikiBuildStatusMatch[1] || ''
        const wiki = documentStore.getWiki(wikiId, auth.orgId)
        if (!wiki) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'wiki not found' } })
          return
        }
        const latestJob = documentStore.getLatestBuildJob(wikiId)
        writeJson(res, 200, {
          wiki_build_status: wiki.buildStatus,
          last_built_at: wiki.lastBuiltAt,
          last_build_error: wiki.lastBuildError,
          latest_job: latestJob,
        })
        return
      }

      // SSE: stream wiki build progress.
      // Simple poll-based implementation — checks the latest job row every
      // 2s and pushes a `progress` event whenever the snapshot changes.
      // Stops on terminal status (succeeded/failed/cancelled) or client
      // disconnect.
      const wikiBuildEventsMatch = pathname.match(/^\/api\/v1\/wikis\/([^/]+)\/build-events$/)
      if (req.method === 'GET' && wikiBuildEventsMatch) {
        authService.requireScope(auth, 'admin:documents')
        const wikiId = wikiBuildEventsMatch[1] || ''
        const wiki = documentStore.getWiki(wikiId, auth.orgId)
        if (!wiki) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'wiki not found' } })
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.flushHeaders?.()
        // Initial event: current snapshot
        let lastSnapshot = ''
        const push = (event: string, data: unknown) => {
          try {
            res.write(`event: ${event}\n`)
            res.write(`data: ${JSON.stringify(data)}\n\n`)
          } catch {
            // socket gone
          }
        }
        const tick = () => {
          const w = documentStore.getWiki(wikiId, auth.orgId)
          const latestJob = documentStore.getLatestBuildJob(wikiId)
          const payload = {
            wiki_build_status: w?.buildStatus ?? 'unknown',
            last_built_at: w?.lastBuiltAt ?? null,
            last_build_error: w?.lastBuildError ?? null,
            latest_job: latestJob,
          }
          const snapshot = JSON.stringify(payload)
          if (snapshot !== lastSnapshot) {
            lastSnapshot = snapshot
            push('progress', payload)
          }
          if (
            payload.wiki_build_status === 'succeeded' ||
            payload.wiki_build_status === 'failed' ||
            (latestJob &&
              (latestJob.status === 'succeeded' ||
                latestJob.status === 'failed' ||
                latestJob.status === 'cancelled'))
          ) {
            push('done', payload)
            clearInterval(timer)
            res.end()
          }
        }
        tick()
        const timer = setInterval(tick, 2_000)
        req.on('close', () => {
          clearInterval(timer)
        })
        return
      }


      // ============================================================
      // Document Center v2: /api/v1/external-sources/*
      // ============================================================

      if (req.method === 'GET' && pathname === '/api/v1/external-sources') {
        authService.requireScope(auth, 'admin:documents')
        const rows = runtime.store.listExternalSources(auth.orgId)
        writeJson(res, 200, { sources: rows.map(serializeExternalSource) })
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/external-sources/connector-types') {
        authService.requireScope(auth, 'admin:documents')
        const { listConnectorTypes } = await import('./sources/types.js')
        writeJson(res, 200, { types: listConnectorTypes() })
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/external-sources') {
        authService.requireScope(auth, 'admin:documents')
        const body = await readJsonBody(req)
        const type = typeof body.type === 'string' ? body.type : ''
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        const config = body.config && typeof body.config === 'object' ? body.config as Record<string, unknown> : {}
        const credentials = body.credentials && typeof body.credentials === 'object'
          ? body.credentials as Record<string, unknown>
          : {}
        const syncIntervalSec = typeof body.sync_interval_sec === 'number'
          ? Math.max(60, Math.floor(body.sync_interval_sec))
          : 3600
        const autoBuildEnabled = body.auto_build_enabled === true ? 1 : 0

        if (!type || !name) {
          writeJson(res, 400, { error: { code: 'invalid_payload', message: 'type and name are required' } })
          return
        }

        let secretKey: string | null = null
        if (Object.keys(credentials).length > 0) {
          const stringOnly: Record<string, string> = {}
          for (const [k, v] of Object.entries(credentials)) {
            if (typeof v === 'string') stringOnly[k] = v
          }
          secretKey = await storeSecret(stringOnly)
        }

        const id = randomUUID()
        try {
          runtime.store.createExternalSource({
            id,
            org_id: auth.orgId,
            type,
            name,
            config_json: JSON.stringify(config),
            credentials_secret_key: secretKey,
            sync_interval_sec: syncIntervalSec,
            auto_build_enabled: autoBuildEnabled,
            created_by: auth.userId,
          })
          const row = runtime.store.getExternalSource(id, auth.orgId)
          writeJson(res, 200, row ? serializeExternalSource(row) : { id })
        } catch (err) {
          if (secretKey) await deleteSecret(secretKey).catch(() => {})
          writeJson(res, 400, {
            error: { code: 'create_failed', message: err instanceof Error ? err.message : String(err) },
          })
        }
        return
      }

      const externalSourceItemMatch = pathname.match(/^\/api\/v1\/external-sources\/([^/]+)$/)
      if (req.method === 'GET' && externalSourceItemMatch) {
        authService.requireScope(auth, 'admin:documents')
        const id = externalSourceItemMatch[1] || ''
        const row = runtime.store.getExternalSource(id, auth.orgId)
        if (!row) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'external source not found' } })
          return
        }
        writeJson(res, 200, serializeExternalSource(row))
        return
      }

      if (req.method === 'PATCH' && externalSourceItemMatch) {
        authService.requireScope(auth, 'admin:documents')
        const id = externalSourceItemMatch[1] || ''
        const existing = runtime.store.getExternalSource(id, auth.orgId)
        if (!existing) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'external source not found' } })
          return
        }
        const body = await readJsonBody(req)
        const updates: {
          name?: string
          config_json?: string
          credentials_secret_key?: string | null
          sync_interval_sec?: number
          auto_build_enabled?: number
          enabled?: number
        } = {}
        if (typeof body.name === 'string') updates.name = body.name.trim()
        if (body.config && typeof body.config === 'object') {
          updates.config_json = JSON.stringify(body.config)
        }
        if (typeof body.sync_interval_sec === 'number') {
          updates.sync_interval_sec = Math.max(60, Math.floor(body.sync_interval_sec))
        }
        if (body.auto_build_enabled !== undefined) {
          updates.auto_build_enabled = body.auto_build_enabled === true ? 1 : 0
        }
        if (body.enabled !== undefined) {
          updates.enabled = body.enabled === true ? 1 : 0
        }
        // Credential rotation: if `credentials` provided, store new secret and replace.
        if (body.credentials && typeof body.credentials === 'object') {
          const stringOnly: Record<string, string> = {}
          for (const [k, v] of Object.entries(body.credentials as Record<string, unknown>)) {
            if (typeof v === 'string') stringOnly[k] = v
          }
          if (Object.keys(stringOnly).length > 0) {
            const newKey = await storeSecret(stringOnly)
            const oldKey = (existing as Record<string, unknown>).credentials_secret_key
            updates.credentials_secret_key = newKey
            if (typeof oldKey === 'string' && oldKey) {
              await deleteSecret(oldKey).catch(() => {})
            }
          }
        }
        runtime.store.updateExternalSource(id, auth.orgId, updates)
        const row = runtime.store.getExternalSource(id, auth.orgId)
        writeJson(res, 200, row ? serializeExternalSource(row) : { id })
        return
      }

      if (req.method === 'DELETE' && externalSourceItemMatch) {
        authService.requireScope(auth, 'admin:documents')
        const id = externalSourceItemMatch[1] || ''
        // cascade_tree=true also deletes the auto-managed knowledge tree this source
        // created; otherwise the tree is kept (orphaned, but manually deletable).
        // Default is keep — the non-destructive choice for callers that omit it.
        const cascadeTree = url.searchParams.get('cascade_tree') === 'true'
        const existing = runtime.store.getExternalSource(id, auth.orgId)
        if (existing) {
          const oldKey = (existing as Record<string, unknown>).credentials_secret_key
          if (typeof oldKey === 'string' && oldKey) {
            await deleteSecret(oldKey).catch(() => {})
          }
          runtime.store.deleteExternalSource(id, auth.orgId, { cascadeTree })
        }
        writeJson(res, 200, { ok: true })
        return
      }

      const externalSourceTestMatch = pathname.match(/^\/api\/v1\/external-sources\/([^/]+)\/test$/)
      if (req.method === 'POST' && externalSourceTestMatch) {
        authService.requireScope(auth, 'admin:documents')
        const id = externalSourceTestMatch[1] || ''
        const row = runtime.store.getExternalSource(id, auth.orgId)
        if (!row) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'external source not found' } })
          return
        }
        try {
          const { createConnector } = await import('./sources/types.js')
          const { readSecret } = await import('./sources/secrets.js')
          const r = row as Record<string, unknown>
          const config = JSON.parse(String(r.config_json)) as Record<string, unknown>
          const credentials = typeof r.credentials_secret_key === 'string' && r.credentials_secret_key
            ? await readSecret(r.credentials_secret_key)
            : {}
          const connector = createConnector(String(r.type))
          await connector.init(config as { rootPath: string }, credentials)
          const result = await connector.testConnection()
          writeJson(res, 200, result)
        } catch (err) {
          writeJson(res, 200, {
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          })
        }
        return
      }

      const externalSourceSyncMatch = pathname.match(/^\/api\/v1\/external-sources\/([^/]+)\/sync$/)
      if (req.method === 'POST' && externalSourceSyncMatch) {
        authService.requireScope(auth, 'admin:documents')
        const id = externalSourceSyncMatch[1] || ''
        const row = runtime.store.getExternalSource(id, auth.orgId)
        if (!row) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'external source not found' } })
          return
        }
        sourceSyncWorker
          .syncSourceNow(id)
          .catch((err) => console.error('[server] manual sync failed:', err))
        writeJson(res, 202, { ok: true, message: 'sync started' })
        return
      }

      // ============================================================
      // 企业应用管理 (Corp App Management): /api/v1/corp-apps/*
      // Admin-facing CRUD. Multiple named instances per type.
      // ============================================================

      if (req.method === 'GET' && pathname === '/api/v1/corp-apps') {
        authService.requireScope(auth, 'admin:settings')
        const rows = runtime.store.listCorpApps(auth.orgId)
        const { getCorpAppCapabilities } = await import('./corpapps/types.js')
        writeJson(res, 200, {
          apps: rows.map((r) => ({
            ...serializeCorpApp(r),
            capabilities: getCorpAppCapabilities(String((r as Record<string, unknown>).type)),
          })),
        })
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/corp-apps/types') {
        authService.requireScope(auth, 'admin:settings')
        const { listCorpAppTypes, getCorpAppCapabilities } = await import('./corpapps/types.js')
        writeJson(res, 200, {
          types: listCorpAppTypes().map((t) => ({ type: t, capabilities: getCorpAppCapabilities(t) })),
        })
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/corp-apps') {
        authService.requireScope(auth, 'admin:settings')
        const body = await readJsonBody(req)
        const type = typeof body.type === 'string' ? body.type : ''
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        const config = body.config && typeof body.config === 'object' ? (body.config as Record<string, unknown>) : {}
        const credentials =
          body.credentials && typeof body.credentials === 'object'
            ? (body.credentials as Record<string, unknown>)
            : {}
        if (!type || !name) {
          writeJson(res, 400, { error: { code: 'invalid_payload', message: 'type and name are required' } })
          return
        }

        const { createCorpApp } = await import('./corpapps/types.js')
        let appKey: string
        try {
          appKey = createCorpApp(type).keyOf(config)
        } catch (err) {
          writeJson(res, 400, { error: { code: 'invalid_type', message: err instanceof Error ? err.message : String(err) } })
          return
        }

        let secretKey: string | null = null
        if (Object.keys(credentials).length > 0) {
          const stringOnly: Record<string, string> = {}
          for (const [k, v] of Object.entries(credentials)) {
            if (typeof v === 'string' && v.length > 0) stringOnly[k] = v
          }
          if (Object.keys(stringOnly).length > 0) secretKey = await storeSecret(stringOnly)
        }

        const id = randomUUID()
        try {
          runtime.store.createCorpApp({
            id,
            org_id: auth.orgId,
            type,
            name,
            app_key: appKey,
            config_json: JSON.stringify(config),
            credentials_secret_key: secretKey,
            created_by: auth.userId,
          })
          const row = runtime.store.getCorpApp(id, auth.orgId)
          writeJson(res, 200, row ? serializeCorpApp(row) : { id })
        } catch (err) {
          if (secretKey) await deleteSecret(secretKey).catch(() => {})
          const msg = err instanceof Error ? err.message : String(err)
          if (/UNIQUE constraint/i.test(msg)) {
            const code = /app_key/.test(msg) ? 'key_taken' : 'name_taken'
            writeJson(res, 400, { error: { code, message: code === 'key_taken' ? '该 corpId+agentId 已存在' : '名称已存在' } })
          } else {
            writeJson(res, 400, { error: { code: 'create_failed', message: msg } })
          }
        }
        return
      }

      const corpAppItemMatch = pathname.match(/^\/api\/v1\/corp-apps\/([^/]+)$/)
      if (req.method === 'GET' && corpAppItemMatch) {
        authService.requireScope(auth, 'admin:settings')
        const id = corpAppItemMatch[1] || ''
        const row = runtime.store.getCorpApp(id, auth.orgId)
        if (!row) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'corp app not found' } })
          return
        }
        const { getCorpAppCapabilities } = await import('./corpapps/types.js')
        writeJson(res, 200, { ...serializeCorpApp(row), capabilities: getCorpAppCapabilities(String((row as Record<string, unknown>).type)) })
        return
      }

      if (req.method === 'PATCH' && corpAppItemMatch) {
        authService.requireScope(auth, 'admin:settings')
        const id = corpAppItemMatch[1] || ''
        const existing = runtime.store.getCorpApp(id, auth.orgId)
        if (!existing) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'corp app not found' } })
          return
        }
        const body = await readJsonBody(req)
        const updates: {
          name?: string
          app_key?: string
          config_json?: string
          credentials_secret_key?: string | null
          enabled?: number
        } = {}
        if (typeof body.name === 'string') updates.name = body.name.trim()
        if (body.config && typeof body.config === 'object') {
          const config = body.config as Record<string, unknown>
          updates.config_json = JSON.stringify(config)
          // Recompute the key whenever config changes (corpId/agentId may move).
          try {
            const { createCorpApp } = await import('./corpapps/types.js')
            updates.app_key = createCorpApp(String((existing as Record<string, unknown>).type)).keyOf(config)
          } catch {
            // leave app_key unchanged on connector error
          }
        }
        if (body.enabled !== undefined) updates.enabled = body.enabled === true ? 1 : 0
        // Credential rotation.
        if (body.credentials && typeof body.credentials === 'object') {
          const stringOnly: Record<string, string> = {}
          for (const [k, v] of Object.entries(body.credentials as Record<string, unknown>)) {
            if (typeof v === 'string' && v.length > 0) stringOnly[k] = v
          }
          if (Object.keys(stringOnly).length > 0) {
            const newKey = await storeSecret(stringOnly)
            const oldKey = (existing as Record<string, unknown>).credentials_secret_key
            updates.credentials_secret_key = newKey
            if (typeof oldKey === 'string' && oldKey) await deleteSecret(oldKey).catch(() => {})
          }
        }
        try {
          runtime.store.updateCorpApp(id, auth.orgId, updates)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (/UNIQUE constraint/i.test(msg)) {
            const code = /app_key/.test(msg) ? 'key_taken' : 'name_taken'
            writeJson(res, 400, { error: { code, message: code === 'key_taken' ? '该 corpId+agentId 已存在' : '名称已存在' } })
            return
          }
          throw err
        }
        const row = runtime.store.getCorpApp(id, auth.orgId)
        writeJson(res, 200, row ? serializeCorpApp(row) : { id })
        return
      }

      if (req.method === 'DELETE' && corpAppItemMatch) {
        authService.requireScope(auth, 'admin:settings')
        const id = corpAppItemMatch[1] || ''
        const existing = runtime.store.getCorpApp(id, auth.orgId)
        if (existing) {
          const oldKey = (existing as Record<string, unknown>).credentials_secret_key
          if (typeof oldKey === 'string' && oldKey) await deleteSecret(oldKey).catch(() => {})
          runtime.store.deleteCorpApp(id, auth.orgId)
        }
        writeJson(res, 200, { ok: true })
        return
      }

      const corpAppTestMatch = pathname.match(/^\/api\/v1\/corp-apps\/([^/]+)\/test$/)
      if (req.method === 'POST' && corpAppTestMatch) {
        authService.requireScope(auth, 'admin:settings')
        const id = corpAppTestMatch[1] || ''
        const row = runtime.store.getCorpApp(id, auth.orgId)
        if (!row) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'corp app not found' } })
          return
        }
        try {
          const { createCorpApp } = await import('./corpapps/types.js')
          const { readSecret } = await import('./sources/secrets.js')
          const r = row as Record<string, unknown>
          const config = JSON.parse(String(r.config_json)) as Record<string, unknown>
          const credentials =
            typeof r.credentials_secret_key === 'string' && r.credentials_secret_key
              ? await readSecret(r.credentials_secret_key)
              : {}
          const connector = createCorpApp(String(r.type))
          await connector.init(config, credentials)
          const result = await connector.testConnection()
          writeJson(res, 200, result)
        } catch (err) {
          writeJson(res, 200, { ok: false, message: err instanceof Error ? err.message : String(err) })
        }
        return
      }


      // ---- Agent-facing wiki endpoints (called by wikiCli from inside scode container) ----
      // Auth model:
      //   1. If the token was issued for an in-container scode session
      //      (auth.assistantId is set), filter by that assistant's
      //      `enabledWikis` from its `_moss_meta.json`.
      //   2. Otherwise require admin:documents scope (used by admins
      //      poking at the endpoint and by the AdminHub during dev).
      //
      // Helper that resolves which wiki IDs the current caller is
      // authorised to access. Returns:
      //   - Set<string> with wiki IDs → "filter to this set"
      //   - null                       → "no restriction" (admin path)
      //   - undefined                  → "denied" (caller should 403)
      const resolveAgentWikiAccess = async (): Promise<Set<string> | null | undefined> => {
        if (typeof auth.assistantId === 'string' && auth.assistantId.length > 0) {
          try {
            const dir = await findAssistantDir(auth.assistantId)
            if (!dir) return new Set()
            const meta = await readAssistantMeta(dir.dir)
            const ids = Array.isArray((meta as { enabledWikis?: unknown } | null)?.enabledWikis)
              ? ((meta as { enabledWikis: unknown[] }).enabledWikis.filter(
                  (v): v is string => typeof v === 'string',
                ))
              : []
            return new Set(ids)
          } catch {
            return new Set()
          }
        }
        if (hasScope(auth.scopes, 'admin:documents')) {
          return null
        }
        return undefined
      }

      if (req.method === 'GET' && pathname === '/api/v1/agent/wikis') {
        const access = await resolveAgentWikiAccess()
        if (access === undefined) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'insufficient scope' } })
          return
        }
        const all = documentStore.listWikis(auth.orgId)
        const filtered = access === null ? all : all.filter(w => access.has(w.id))
        writeJson(res, 200, { wikis: filtered })
        return
      }

      const agentWikiFilesMatch = pathname.match(/^\/api\/v1\/agent\/wikis\/([^/]+)\/files$/)
      if (req.method === 'GET' && agentWikiFilesMatch) {
        const access = await resolveAgentWikiAccess()
        if (access === undefined) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'insufficient scope' } })
          return
        }
        const wikiId = agentWikiFilesMatch[1] || ''
        if (access !== null && !access.has(wikiId)) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'wiki not authorised for this assistant' } })
          return
        }
        const wiki = documentStore.getWiki(wikiId, auth.orgId)
        if (!wiki) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'wiki not found' } })
          return
        }
        // List files in the wiki directory (P0: shallow only)
        try {
          const entries = await readdir(wiki.storagePath, { withFileTypes: true })
          const files = entries
            .filter(e => e.isFile() && (e.name.endsWith('.md') || e.name === '_moss_meta.json'))
            .map(e => e.name)
          writeJson(res, 200, { wiki_id: wikiId, files })
        } catch (err) {
          writeJson(res, 200, { wiki_id: wikiId, files: [] })
        }
        return
      }

      const agentWikiFileMatch = pathname.match(/^\/api\/v1\/agent\/wikis\/([^/]+)\/files\/(.+)$/)
      if (req.method === 'GET' && agentWikiFileMatch) {
        const access = await resolveAgentWikiAccess()
        if (access === undefined) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'insufficient scope' } })
          return
        }
        const wikiId = agentWikiFileMatch[1] || ''
        if (access !== null && !access.has(wikiId)) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'wiki not authorised for this assistant' } })
          return
        }
        const filePath = agentWikiFileMatch[2] || ''
        const wiki = documentStore.getWiki(wikiId, auth.orgId)
        if (!wiki) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'wiki not found' } })
          return
        }
        // Path traversal guard
        const resolved = resolve(wiki.storagePath, filePath)
        if (!resolved.startsWith(resolve(wiki.storagePath) + sep) && resolved !== resolve(wiki.storagePath)) {
          writeJson(res, 400, { error: { code: 'invalid_path', message: 'path escapes wiki dir' } })
          return
        }
        try {
          const raw = await readFile(resolved, 'utf-8')
          // Rewrite relative image refs to public, tokenized resource URLs so the
          // agent relays markdown that already points at browser-loadable images.
          const content = isMarkdownPath(filePath)
            ? rewriteWikiImageRefs(
                raw,
                wikiId,
                filePath,
                config.publicBaseUrl,
                config.wikiIndex.resourceTokenSecret,
              )
            : raw
          writeJson(res, 200, { wiki_id: wikiId, path: filePath, content })
        } catch {
          writeJson(res, 404, { error: { code: 'not_found', message: 'file not found' } })
        }
        return
      }

      const agentWikiSearchMatch = pathname.match(/^\/api\/v1\/agent\/wikis\/([^/]+)\/search$/)
      if (req.method === 'GET' && agentWikiSearchMatch) {
        const access = await resolveAgentWikiAccess()
        if (access === undefined) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'insufficient scope' } })
          return
        }
        const wikiId = agentWikiSearchMatch[1] || ''
        if (access !== null && !access.has(wikiId)) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'wiki not authorised for this assistant' } })
          return
        }
        const url = new URL(req.url ?? '', 'http://localhost')
        const query = url.searchParams.get('q') ?? ''
        if (!query) {
          writeJson(res, 400, { error: { code: 'invalid_payload', message: 'q is required' } })
          return
        }
        const wiki = documentStore.getWiki(wikiId, auth.orgId)
        if (!wiki) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'wiki not found' } })
          return
        }
        // Hybrid retrieval: literal grep + (best-effort) semantic vector
        // search, fused with RRF. The vector path is opt-in via
        // `config.wikiIndex.enabled`; missing index files or model failure
        // silently degrade to grep-only — old wikis built before the
        // sidecar existed work unchanged.
        try {
          const grepHits = await runWikiGrep(wiki.storagePath, query)

          let vecHits: ReturnType<typeof vectorSearch> = []
          if (config.wikiIndex.enabled) {
            const idx = await loadIndex(wiki.storagePath)
            if (idx) {
              const emb = await ensureEmbedder({
                modelId: config.wikiIndex.modelId,
                cacheDir: MOSS_MODELS_DIR,
                mirror: config.wikiIndex.modelMirror,
              })
              if (emb) {
                try {
                  vecHits = await wikiVectorQuerySemaphore(async () => {
                    const qVec = await emb.query(query)
                    return vectorSearch(idx, qVec, config.wikiIndex.topKVector)
                  })
                } catch (err) {
                  console.warn('[wikiIndex] query embed failed, grep-only:', err)
                }
              }
            }
          }

          const fused = vecHits.length === 0
            ? grepHits.slice(0, 100)
            : rrfFuse(grepHits, vecHits).slice(0, 100)
          const matches = fused.map((h) => ({
            file: h.file,
            line_no: h.line_no,
            // A matched line can carry an inline image ref (`![](images/x.png)`).
            // Rewrite per match using the match's own file as the base for
            // relative-path resolution, so snippets contain loadable URLs.
            line: rewriteWikiImageRefs(
              h.line,
              wikiId,
              h.file,
              config.publicBaseUrl,
              config.wikiIndex.resourceTokenSecret,
            ),
          }))
          writeJson(res, 200, { wiki_id: wikiId, query, matches })
        } catch (err) {
          writeJson(res, 200, { wiki_id: wikiId, query, matches: [] })
        }
        return
      }

      const agentWikiMetaMatch = pathname.match(/^\/api\/v1\/agent\/wikis\/([^/]+)\/metadata$/)
      if (req.method === 'GET' && agentWikiMetaMatch) {
        const access = await resolveAgentWikiAccess()
        if (access === undefined) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'insufficient scope' } })
          return
        }
        const wikiId = agentWikiMetaMatch[1] || ''
        if (access !== null && !access.has(wikiId)) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'wiki not authorised for this assistant' } })
          return
        }
        const wiki = documentStore.getWiki(wikiId, auth.orgId)
        if (!wiki) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'wiki not found' } })
          return
        }
        // Count chunk files
        let chunkCount = 0
        try {
          const entries = await readdir(wiki.storagePath, { withFileTypes: true })
          chunkCount = entries.filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== 'WIKI.md').length
        } catch {
          // dir not built yet
        }
        writeJson(res, 200, {
          wiki_id: wikiId,
          name: wiki.name,
          description: wiki.description,
          build_status: wiki.buildStatus,
          last_built_at: wiki.lastBuiltAt,
          source_document_count: wiki.sourceDocumentIds.length,
          chunk_count: chunkCount,
        })
        return
      }

      // ---- Agent-facing corp-auth endpoint (called by the `corpauth` CLI inside scode) ----
      // Returns the current user's corp OAuth2 provider access_token so an
      // assistant can authenticate calls to internal corp services. Gated
      // per-assistant: an in-container session (auth.assistantId set) is allowed
      // only if its `_moss_meta.json` has `enableCorpAuth === true`; admins
      // (admin:settings) are allowed; everyone else is denied (403). A gated-in
      // caller with no/expired provider token gets 200 `{ access_token: null }`
      // (e.g. password-login users) so the skill can decide to ask for re-login.
      const resolveAgentCorpAuthAccess = async (): Promise<boolean | undefined> => {
        if (typeof auth.assistantId === 'string' && auth.assistantId.length > 0) {
          try {
            const dir = await findAssistantDir(auth.assistantId)
            if (!dir) return false
            const meta = await readAssistantMeta(dir.dir)
            return (meta as { enableCorpAuth?: unknown } | null)?.enableCorpAuth === true
          } catch {
            return false
          }
        }
        if (hasScope(auth.scopes, 'admin:settings')) {
          return true
        }
        return undefined
      }

      if (req.method === 'GET' && pathname === '/api/v1/agent/corp-auth/token') {
        const allowed = await resolveAgentCorpAuthAccess()
        if (allowed === undefined || allowed === false) {
          writeJson(res, 403, {
            error: { code: 'forbidden', message: 'corp auth not enabled for this assistant' },
          })
          return
        }
        const tok = authService.getProviderTokenForUser(auth.userId)
        if (!tok) {
          writeJson(res, 200, { access_token: null })
          return
        }
        writeJson(res, 200, { access_token: tok.token, expires_at: tok.expiresAt })
        return
      }

      // ---- Agent-facing corp-app endpoints (called by the `corpapp` CLI inside scode) ----
      // Auth model mirrors wikis: an in-container session token (auth.assistantId
      // set) is restricted to that assistant's `enabledCorpApps` from its
      // `_moss_meta.json`; admins (admin:settings) are unrestricted; everyone
      // else is denied.
      const resolveAgentCorpAppAccess = async (): Promise<Set<string> | null | undefined> => {
        if (typeof auth.assistantId === 'string' && auth.assistantId.length > 0) {
          try {
            const dir = await findAssistantDir(auth.assistantId)
            if (!dir) return new Set()
            const meta = await readAssistantMeta(dir.dir)
            const ids = Array.isArray((meta as { enabledCorpApps?: unknown } | null)?.enabledCorpApps)
              ? (meta as { enabledCorpApps: unknown[] }).enabledCorpApps.filter(
                  (v): v is string => typeof v === 'string',
                )
              : []
            return new Set(ids)
          } catch {
            return new Set()
          }
        }
        if (hasScope(auth.scopes, 'admin:settings')) {
          return null
        }
        return undefined
      }

      // Build an agent-facing view of a corp app row (no secrets).
      const agentCorpAppView = async (row: Record<string, unknown>) => {
        const { getCorpAppCapabilities } = await import('./corpapps/types.js')
        return {
          id: String(row.id),
          name: String(row.name),
          type: String(row.type),
          key: String(row.app_key ?? ''),
          capabilities: getCorpAppCapabilities(String(row.type)),
        }
      }

      // Construct + init the connector for a stored corp app instance.
      const initCorpAppConnector = async (row: Record<string, unknown>) => {
        const { createCorpApp } = await import('./corpapps/types.js')
        const { readSecret } = await import('./sources/secrets.js')
        const config = JSON.parse(String(row.config_json ?? '{}')) as Record<string, unknown>
        const credentials =
          typeof row.credentials_secret_key === 'string' && row.credentials_secret_key
            ? await readSecret(row.credentials_secret_key)
            : {}
        const connector = createCorpApp(String(row.type))
        await connector.init(config, credentials)
        return connector
      }

      if (req.method === 'GET' && pathname === '/api/v1/agent/corp-apps') {
        const access = await resolveAgentCorpAppAccess()
        if (access === undefined) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'insufficient scope' } })
          return
        }
        const all = runtime.store.listCorpApps(auth.orgId, { enabledOnly: true })
        const filtered = access === null ? all : all.filter((r) => access.has(String((r as Record<string, unknown>).id)))
        const apps = await Promise.all(filtered.map((r) => agentCorpAppView(r as Record<string, unknown>)))
        writeJson(res, 200, { apps })
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/agent/corp-apps/resolve') {
        const access = await resolveAgentCorpAppAccess()
        if (access === undefined) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'insufficient scope' } })
          return
        }
        const name = url.searchParams.get('name')
        const key = url.searchParams.get('key')
        const type = url.searchParams.get('type') ?? 'wecomapp'
        let row: Record<string, unknown> | null = null
        if (name) {
          row = runtime.store.getCorpAppByName(auth.orgId, name) as Record<string, unknown> | null
        } else if (key) {
          row = runtime.store.getCorpAppByKey(auth.orgId, type, key) as Record<string, unknown> | null
        } else {
          writeJson(res, 400, { error: { code: 'invalid_payload', message: 'name or key is required' } })
          return
        }
        if (!row) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'corp app not found' } })
          return
        }
        if (access !== null && !access.has(String(row.id))) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'corp app not authorised for this assistant' } })
          return
        }
        writeJson(res, 200, await agentCorpAppView(row))
        return
      }

      const agentCorpAppMsgMatch = pathname.match(/^\/api\/v1\/agent\/corp-apps\/([^/]+)\/messages$/)
      if (req.method === 'POST' && agentCorpAppMsgMatch) {
        const access = await resolveAgentCorpAppAccess()
        if (access === undefined) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'insufficient scope' } })
          return
        }
        const id = agentCorpAppMsgMatch[1] || ''
        if (access !== null && !access.has(id)) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'corp app not authorised for this assistant' } })
          return
        }
        const row = runtime.store.getCorpApp(id, auth.orgId) as Record<string, unknown> | null
        if (!row) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'corp app not found' } })
          return
        }
        const body = await readJsonBody(req)
        const to = typeof body.to === 'string' ? body.to : ''
        const text = typeof body.text === 'string' ? body.text : ''
        const format = body.format === 'markdown' ? 'markdown' : 'text'
        if (!to || !text) {
          writeJson(res, 400, { error: { code: 'invalid_payload', message: 'to and text are required' } })
          return
        }
        try {
          const connector = await initCorpAppConnector(row)
          if (!connector.sendMessage) {
            writeJson(res, 501, { error: { code: 'unsupported', message: 'this corp app type cannot send messages' } })
            return
          }
          const result = await connector.sendMessage(to, text, format)
          writeJson(res, 200, result)
        } catch (err) {
          writeJson(res, 502, { error: { code: 'send_failed', message: err instanceof Error ? err.message : String(err) } })
        }
        return
      }

      const agentCorpAppFileMatch = pathname.match(/^\/api\/v1\/agent\/corp-apps\/([^/]+)\/files$/)
      if (req.method === 'POST' && agentCorpAppFileMatch) {
        const access = await resolveAgentCorpAppAccess()
        if (access === undefined) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'insufficient scope' } })
          return
        }
        const id = agentCorpAppFileMatch[1] || ''
        if (access !== null && !access.has(id)) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'corp app not authorised for this assistant' } })
          return
        }
        const row = runtime.store.getCorpApp(id, auth.orgId) as Record<string, unknown> | null
        if (!row) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'corp app not found' } })
          return
        }
        const to = url.searchParams.get('to') ?? ''
        const fileName = url.searchParams.get('fileName') ?? 'file'
        if (!to) {
          writeJson(res, 400, { error: { code: 'invalid_payload', message: 'to query param is required' } })
          return
        }
        const bytes = await readRawBody(req)
        if (bytes.length === 0) {
          writeJson(res, 400, { error: { code: 'invalid_payload', message: 'empty file body' } })
          return
        }
        try {
          const connector = await initCorpAppConnector(row)
          if (!connector.sendFile) {
            writeJson(res, 501, { error: { code: 'unsupported', message: 'this corp app type cannot send files' } })
            return
          }
          const result = await connector.sendFile(to, fileName, bytes)
          writeJson(res, 200, result)
        } catch (err) {
          writeJson(res, 502, { error: { code: 'send_failed', message: err instanceof Error ? err.message : String(err) } })
        }
        return
      }

      const agentCorpAppInboundMatch = pathname.match(/^\/api\/v1\/agent\/corp-apps\/([^/]+)\/inbound$/)
      if (req.method === 'GET' && agentCorpAppInboundMatch) {
        const access = await resolveAgentCorpAppAccess()
        if (access === undefined) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'insufficient scope' } })
          return
        }
        const id = agentCorpAppInboundMatch[1] || ''
        if (access !== null && !access.has(id)) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'corp app not authorised for this assistant' } })
          return
        }
        const row = runtime.store.getCorpApp(id, auth.orgId)
        if (!row) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'corp app not found' } })
          return
        }
        const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50
        const rows = runtime.store.listCorpAppInbound(id, since, limit)
        let nextCursor = since
        const messages = rows.map((r) => {
          const m = r as Record<string, unknown>
          if (Number(m.seq) > nextCursor) nextCursor = Number(m.seq)
          return {
            id: String(m.id),
            seq: Number(m.seq),
            from: String(m.from_user ?? ''),
            type: String(m.msg_type ?? 'other'),
            text: typeof m.text === 'string' ? m.text : '',
            mediaId: typeof m.media_id === 'string' ? m.media_id : '',
            fileName: typeof m.file_name === 'string' ? m.file_name : '',
            receivedAt: Number(m.received_at ?? 0),
          }
        })
        writeJson(res, 200, { messages, nextCursor })
        return
      }

      const agentCorpAppMediaMatch = pathname.match(/^\/api\/v1\/agent\/corp-apps\/([^/]+)\/media$/)
      if (req.method === 'GET' && agentCorpAppMediaMatch) {
        const access = await resolveAgentCorpAppAccess()
        if (access === undefined) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'insufficient scope' } })
          return
        }
        const id = agentCorpAppMediaMatch[1] || ''
        if (access !== null && !access.has(id)) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'corp app not authorised for this assistant' } })
          return
        }
        const row = runtime.store.getCorpApp(id, auth.orgId) as Record<string, unknown> | null
        if (!row) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'corp app not found' } })
          return
        }
        const mediaId = url.searchParams.get('mediaId') ?? ''
        if (!mediaId) {
          writeJson(res, 400, { error: { code: 'invalid_payload', message: 'mediaId is required' } })
          return
        }
        try {
          const connector = await initCorpAppConnector(row)
          if (!connector.downloadMedia) {
            writeJson(res, 501, { error: { code: 'unsupported', message: 'this corp app type cannot download media' } })
            return
          }
          const { bytes, fileName, contentType } = await connector.downloadMedia(mediaId)
          // Stream raw bytes back; CLI writes them to disk. Surface the
          // provider filename so the caller can name the local file.
          res.writeHead(200, {
            'Content-Type': contentType || 'application/octet-stream',
            'Content-Length': String(bytes.length),
            ...(fileName ? { 'X-Corp-App-Filename': encodeURIComponent(fileName) } : {}),
          })
          res.end(bytes)
        } catch (err) {
          writeJson(res, 502, { error: { code: 'download_failed', message: err instanceof Error ? err.message : String(err) } })
        }
        return
      }

      // List approval (审批) instance ids in a time window. Read-only,
      // same auth model as the other agent-facing corp-app routes. The
      // raw provider response is passed straight through to the caller.
      const agentCorpAppApprovalsMatch = pathname.match(
        /^\/api\/v1\/agent\/corp-apps\/([^/]+)\/approvals$/,
      )
      if (req.method === 'GET' && agentCorpAppApprovalsMatch) {
        const access = await resolveAgentCorpAppAccess()
        if (access === undefined) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'insufficient scope' } })
          return
        }
        const id = agentCorpAppApprovalsMatch[1] || ''
        if (access !== null && !access.has(id)) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'corp app not authorised for this assistant' } })
          return
        }
        const row = runtime.store.getCorpApp(id, auth.orgId) as Record<string, unknown> | null
        if (!row) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'corp app not found' } })
          return
        }
        const starttime = Number.parseInt(url.searchParams.get('starttime') ?? '', 10)
        const endtime = Number.parseInt(url.searchParams.get('endtime') ?? '', 10)
        if (!Number.isFinite(starttime) || !Number.isFinite(endtime)) {
          writeJson(res, 400, { error: { code: 'invalid_payload', message: 'starttime and endtime (unix seconds) are required' } })
          return
        }
        const cursor = url.searchParams.get('cursor') ?? ''
        const sizeRaw = Number.parseInt(url.searchParams.get('size') ?? '', 10)
        const size = Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : undefined
        // Filters are opaque key/value pairs passed through to WeCom.
        // Accepted as repeatable `filter=key:value` query params.
        const filters = url.searchParams
          .getAll('filter')
          .map((f) => {
            const idx = f.indexOf(':')
            return idx > 0 ? { key: f.slice(0, idx), value: f.slice(idx + 1) } : null
          })
          .filter((f): f is { key: string; value: string } => f !== null)
        try {
          const connector = await initCorpAppConnector(row)
          if (!connector.listApprovals) {
            writeJson(res, 501, { error: { code: 'unsupported', message: 'this corp app type cannot list approvals' } })
            return
          }
          const result = await connector.listApprovals({
            starttime,
            endtime,
            cursor,
            size,
            filters: filters.length > 0 ? filters : undefined,
          })
          writeJson(res, 200, result)
        } catch (err) {
          writeJson(res, 502, { error: { code: 'approval_failed', message: err instanceof Error ? err.message : String(err) } })
        }
        return
      }

      // Fetch full detail of a single approval by its provider id (sp_no).
      const agentCorpAppApprovalMatch = pathname.match(
        /^\/api\/v1\/agent\/corp-apps\/([^/]+)\/approvals\/([^/]+)$/,
      )
      if (req.method === 'GET' && agentCorpAppApprovalMatch) {
        const access = await resolveAgentCorpAppAccess()
        if (access === undefined) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'insufficient scope' } })
          return
        }
        const id = agentCorpAppApprovalMatch[1] || ''
        if (access !== null && !access.has(id)) {
          writeJson(res, 403, { error: { code: 'forbidden', message: 'corp app not authorised for this assistant' } })
          return
        }
        const row = runtime.store.getCorpApp(id, auth.orgId) as Record<string, unknown> | null
        if (!row) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'corp app not found' } })
          return
        }
        const spNo = decodeURIComponent(agentCorpAppApprovalMatch[2] || '')
        if (!spNo) {
          writeJson(res, 400, { error: { code: 'invalid_payload', message: 'sp_no is required' } })
          return
        }
        try {
          const connector = await initCorpAppConnector(row)
          if (!connector.getApproval) {
            writeJson(res, 501, { error: { code: 'unsupported', message: 'this corp app type cannot fetch approvals' } })
            return
          }
          const result = await connector.getApproval(spNo)
          writeJson(res, 200, result)
        } catch (err) {
          writeJson(res, 502, { error: { code: 'approval_failed', message: err instanceof Error ? err.message : String(err) } })
        }
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/users') {
        authService.requireScope(auth, 'admin:users')
        writeJson(res, 200, authService.listUsers(auth.orgId, auth))
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/users') {
        authService.requireScope(auth, 'admin:users')
        const body = await readJsonBody(req)
        // Org is pinned to the caller's current org — never trust body.org_id.
        // A super_admin targets another org by switching into it (switchOrg),
        // which makes auth.orgId that org; this blocks cross-org user creation.
        writeJson(
          res,
          200,
          authService.createUser({
            orgId: auth.orgId,
            email: typeof body.email === 'string' ? body.email : '',
            name: typeof body.name === 'string' ? body.name : '',
            displayName:
              body.display_name === null || typeof body.display_name === 'string'
                ? body.display_name
                : undefined,
            departmentId:
              body.department_id === null || typeof body.department_id === 'string'
                ? body.department_id
                : undefined,
            role: typeof body.role === 'string' ? body.role : 'user',
            password: typeof body.password === 'string' ? body.password : '',
            extUserId:
              body.ext_user_id === null || typeof body.ext_user_id === 'string'
                ? body.ext_user_id
                : undefined,
          }, auth),
        )
        return
      }

      const userMatch = pathname.match(/^\/api\/v1\/users\/([^/]+)$/)
      if (req.method === 'PATCH' && userMatch) {
        authService.requireScope(auth, 'admin:users')
        const userId = userMatch[1] || ''
        const body = await readJsonBody(req)
        const result = authService.updateUser({
          orgId: auth.orgId,
          userId,
          name: typeof body.name === 'string' ? body.name : undefined,
          displayName:
            body.display_name === null || typeof body.display_name === 'string'
              ? body.display_name
              : undefined,
          departmentId:
            body.department_id === null || typeof body.department_id === 'string'
              ? body.department_id
              : undefined,
          role: typeof body.role === 'string' ? body.role : undefined,
          status:
            typeof body.status === 'string' ? body.status : undefined,
          // Organization is immutable (req 3): never forward an org move.
          extUserId:
            body.ext_user_id === null || typeof body.ext_user_id === 'string'
              ? body.ext_user_id
              : undefined,
        }, auth)

        // User disable cascade: disable Nexus secrets + terminate sessions + revoke Auth Proxy tokens
        if (typeof body.status === 'string' && body.status === 'disabled') {
          invalidateUserStatusCache(userId)
          // Disable all user.* secrets in Nexus
          if (nexusClient) {
            try {
              const userSecrets = await nexusClient.listSecrets(`user.${userId}`)
              for (const secret of userSecrets) {
                try { await nexusClient.disableSecret(secret.namespace, secret.key, `user:${userId}`) } catch { /* best effort */ }
              }
            } catch { /* best effort */ }
          }
          // Terminate all active sessions for this user
          try {
            const sessions = runtime.listSessionRecords({ orgId: auth.orgId, userId, activeOnly: true })
            for (const session of sessions) {
              try { await runtime.terminateSession(session.sessionId) } catch { /* best effort */ }
            }
          } catch { /* best effort */ }
        }
        // Invalidate cache on any status change
        if (typeof body.status === 'string') {
          invalidateUserStatusCache(userId)
        }

        writeJson(res, 200, result)
        return
      }

      const userPasswordMatch = pathname.match(/^\/api\/v1\/users\/([^/]+)\/password$/)
      if (req.method === 'POST' && userPasswordMatch) {
        authService.requireScope(auth, 'admin:users')
        const userId = userPasswordMatch[1] || ''
        const body = await readJsonBody(req)
        writeJson(
          res,
          200,
          authService.setUserPassword({
            orgId: auth.orgId,
            userId,
            password: typeof body.password === 'string' ? body.password : '',
          }, auth),
        )
        return
      }

      const userTokenLimitMatch = pathname.match(/^\/api\/v1\/users\/([^/]+)\/token-limit$/)
      if (req.method === 'PATCH' && userTokenLimitMatch) {
        authService.requireScope(auth, 'admin:users')
        const userId = userTokenLimitMatch[1] || ''
        const body = await readJsonBody(req)
        const tokenLimit = body.tokenLimit === null ? null : Number(body.tokenLimit)
        writeJson(
          res,
          200,
          authService.setUserTokenLimit({
            orgId: auth.orgId,
            userId,
            tokenLimit: tokenLimit !== null && Number.isFinite(tokenLimit) ? tokenLimit : null,
          }, auth),
        )
        return
      }

      const userLocalAuthMatch = pathname.match(/^\/api\/v1\/users\/([^/]+)\/local-auth$/)
      if (req.method === 'PUT' && userLocalAuthMatch) {
        authService.requireScope(auth, 'admin:users')
        const userId = userLocalAuthMatch[1] || ''
        const body = await readJsonBody(req)
        const localAuth = body.local_auth === true
        writeJson(
          res,
          200,
          authService.setLocalAuth({
            orgId: auth.orgId,
            userId,
            localAuth,
          }, auth),
        )
        return
      }

      const departmentTokenLimitMatch = pathname.match(/^\/api\/v1\/departments\/([^/]+)\/token-limit$/)
      if (req.method === 'PATCH' && departmentTokenLimitMatch) {
        authService.requireScope(auth, 'admin:users')
        const departmentId = departmentTokenLimitMatch[1] || ''
        const body = await readJsonBody(req)
        const tokenLimit = body.tokenLimit === null ? null : Number(body.tokenLimit)
        writeJson(
          res,
          200,
          authService.setDepartmentTokenLimit({
            orgId: auth.orgId,
            departmentId,
            tokenLimit: tokenLimit !== null && Number.isFinite(tokenLimit) ? tokenLimit : null,
          }, auth),
        )
        return
      }

      const userSessionsMatch = pathname.match(/^\/api\/v1\/users\/([^/]+)\/sessions$/)
      if (req.method === 'GET' && userSessionsMatch) {
        authService.requireScope(auth, 'admin:users')
        const userId = userSessionsMatch[1] || ''
        const user = authService.getUserOrNull(userId, auth.orgId, auth)
        if (!user) {
          throw new HttpError(404, 'Unknown user_id')
        }
        writeJson(res, 200, {
          user,
          sessions: runtime.store
            .listUserSessions(auth.orgId, userId)
            .map(session => serializeSession(session)),
        })
        return
      }

      // User model preference endpoints
      const userModelMatch = pathname.match(/^\/api\/v1\/users\/([^/]+)\/model$/)
      if (userModelMatch) {
        // Replace 'me' with actual user ID
        let userId = userModelMatch[1] || ''
        if (userId === 'me') {
          userId = auth.userId
        }
        // Users can only get/set their own preference unless they have admin scope
        if (userId !== auth.userId && !hasScope(auth.scopes, 'admin:users')) {
          throw new HttpError(403, 'Forbidden')
        }

        if (req.method === 'GET') {
          const preference = getUserModelPreference(userId)
          const systemSettings = getSystemSettings()
          console.log(`[ModelPreference] GET /api/v1/users/${userId}/model - userPref: ${JSON.stringify(preference)}, systemDefault: ${systemSettings.model}`)
          writeJson(res, 200, {
            success: true,
            data: preference,
            // Include system default model for frontend to display when user has no preference
            systemDefaultModel: systemSettings.model || process.env.MOSS_DEFAULT_MODEL || 'gemini-3-flash-preview',
          })
          return
        }

        if (req.method === 'PUT') {
          const body = await readJsonBody(req)
          const modelId = typeof body.modelId === 'string' ? body.modelId : ''
          console.log(`[ModelPreference] PUT /api/v1/users/${userId}/model - modelId: ${modelId}`)
          if (!modelId) {
            throw new HttpError(400, 'modelId is required')
          }
          setUserModelPreference(userId, modelId)
          console.log(`[ModelPreference] Saved preference for user ${userId}: ${modelId}`)
          writeJson(res, 200, {
            success: true,
            data: { modelId, updatedAt: Date.now() },
          })
          return
        }
      }

      // Available models endpoint
      if (req.method === 'GET' && pathname === '/api/v1/models/available') {
        const models = await getAvailableModels()
        writeJson(res, 200, {
          success: true,
          data: models,
        })
        return
      }

      // Model cache status endpoint (admin only)
      if (req.method === 'GET' && pathname === '/api/v1/models/cache-status') {
        authService.requireScope(auth, 'admin:settings')
        const status = getCacheStatus()
        writeJson(res, 200, {
          success: true,
          data: status,
        })
        return
      }

      // Model cache refresh endpoint (admin only)
      if (req.method === 'POST' && pathname === '/api/v1/models/refresh-cache') {
        authService.requireScope(auth, 'admin:settings')
        const models = await refreshModelCache()
        writeJson(res, 200, {
          success: true,
          data: models,
        })
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/api-keys') {
        authService.requireScope(auth, 'admin:api_keys')
        writeJson(res, 200, authService.listApiKeys(auth.orgId, auth))
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/api-keys') {
        authService.requireScope(auth, 'admin:api_keys')
        const body = await readJsonBody(req)
        writeJson(
          res,
          200,
          authService.createApiKey({
            orgId: auth.orgId,
            userId: typeof body.user_id === 'string' ? body.user_id : '',
            name: typeof body.name === 'string' ? body.name : '',
            scopes: Array.isArray(body.scopes)
              ? body.scopes.filter((scope): scope is string => typeof scope === 'string')
              : [],
          }, auth),
        )
        return
      }

      const apiKeyMatch = pathname.match(/^\/api\/v1\/api-keys\/([^/]+)$/)
      if (req.method === 'DELETE' && apiKeyMatch) {
        authService.requireScope(auth, 'admin:api_keys')
        const keyId = apiKeyMatch[1] || ''
        writeJson(res, 200, authService.revokeApiKey({ orgId: auth.orgId, keyId }, auth))
        return
      }

      // ==================== Config Items (Secrets Management) ====================

      if (req.method === 'GET' && pathname === '/api/v1/config-items') {
        authService.requireScope(auth, 'admin:secrets')
        const urlObj = new URL(req.url as string, `http://${req.headers.host}`)
        writeJson(res, 200, configItemsApi.list(auth.orgId, auth.userId, {
          page: Number(urlObj.searchParams.get('page')) || undefined,
          page_size: Number(urlObj.searchParams.get('page_size')) || undefined,
          name: urlObj.searchParams.get('name') || undefined,
          scope: urlObj.searchParams.get('scope') || undefined,
          status: urlObj.searchParams.get('status') || undefined,
        }))
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/config-items') {
        authService.requireScope(auth, 'admin:secrets:write')
        const body = await readJsonBody(req)
        const result = configItemsApi.create(auth.orgId, auth.userId, body)
        if (result.success) refreshAuthProxyRules()
        writeJson(res, result.success ? 201 : 400, result)
        return
      }

      const configItemMatch = pathname.match(/^\/api\/v1\/config-items\/(\d+)$/)
      if (configItemMatch) {
        const itemId = Number(configItemMatch[1])
        if (req.method === 'GET') {
          authService.requireScope(auth, 'admin:secrets')
          writeJson(res, 200, configItemsApi.get(auth.orgId, auth.userId, itemId))
          return
        }
        if (req.method === 'PUT') {
          authService.requireScope(auth, 'admin:secrets:write')
          const body = await readJsonBody(req)
          const result = configItemsApi.update(auth.orgId, auth.userId, itemId, body)
          refreshAuthProxyRules()
          writeJson(res, 200, result)
          return
        }
        if (req.method === 'DELETE') {
          authService.requireScope(auth, 'admin:secrets:write')
          const result = configItemsApi.delete(auth.orgId, auth.userId, itemId)
          refreshAuthProxyRules()
          writeJson(res, 200, result)
          return
        }
      }

      const configItemStatusMatch = pathname.match(/^\/api\/v1\/config-items\/(\d+)\/status$/)
      if (req.method === 'PUT' && configItemStatusMatch) {
        authService.requireScope(auth, 'admin:secrets:write')
        const itemId = Number(configItemStatusMatch[1])
        const body = await readJsonBody(req)
        const result = configItemsApi.updateStatus(auth.orgId, auth.userId, itemId, Number(body.status))
        refreshAuthProxyRules()
        writeJson(res, 200, result)
        return
      }

      const configItemEntriesMatch = pathname.match(/^\/api\/v1\/config-items\/(\d+)\/entries$/)
      if (req.method === 'PUT' && configItemEntriesMatch) {
        authService.requireScope(auth, 'admin:secrets:write')
        const itemId = Number(configItemEntriesMatch[1])
        const body = await readJsonBody(req)
        writeJson(res, 200, configItemsApi.update(auth.orgId, auth.userId, itemId, { entries: body.entries }))
        return
      }

      // Config item authorized departments (for department-scope items)
      const configItemDeptsMatch = pathname.match(/^\/api\/v1\/config-items\/(\d+)\/authorized-departments$/)
      if (configItemDeptsMatch) {
        const itemId = Number(configItemDeptsMatch[1])
        if (req.method === 'GET') {
          authService.requireScope(auth, 'admin:secrets')
          const rows = runtime.store.getConfigItemAuthorizedDepartments(itemId)
          const deptIds = rows.map((r: Record<string, unknown>) => r.department_id as string)
          writeJson(res, 200, { success: true, data: deptIds })
          return
        }
        if (req.method === 'PUT') {
          authService.requireScope(auth, 'admin:secrets:write')
          const body = await readJsonBody(req)
          runtime.store.replaceConfigItemDepartments(itemId, body.department_ids ?? [], auth.orgId)
          writeJson(res, 200, { success: true })
          return
        }
      }

      // Config item icon upload
      if (req.method === 'POST' && pathname === '/api/v1/config-items/icon') {
        authService.requireScope(auth, 'admin:secrets:write')
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        const raw = Buffer.concat(chunks)
        const url = await saveUploadedIcon(config.runtimeDir, raw, req.headers['content-type'], 'config-items')
        writeJson(res, 200, { success: true, url })
        return
      }

      // ==================== Secrets (requires Nexus) ====================
      if (secretsApi) {
        // Enterprise secrets: list
        if (req.method === 'GET' && pathname === '/api/v1/secrets') {
          authService.requireScope(auth, 'admin:secrets')
          writeJson(res, 200, await secretsApi.listEnterpriseSecrets(auth.orgId, auth.userId))
          return
        }

        // Department secrets: list. A dept_admin may view all department-scope
        // credentials (admin:secrets stays the admin gate; secrets:department:read
        // is the dept_admin gate).
        if (req.method === 'GET' && pathname === '/api/v1/department-secrets') {
          if (!canReadDepartmentSecrets(auth)) {
            authService.requireScope(auth, 'admin:secrets')
          }
          writeJson(res, 200, await secretsApi.listDepartmentSecrets(auth.orgId, auth.userId))
          return
        }

        // Per-department credential values: view/set a value specific to one
        // department (in the caller's subtree) for a department-scope config
        // item. requireDepartmentInScope confines a dept_admin to their subtree;
        // admins are unrestricted in-org.
        const deptSecretListMatch = pathname.match(/^\/api\/v1\/department-secrets\/([^/]+)$/)
        if (req.method === 'GET' && deptSecretListMatch) {
          if (!canReadDepartmentSecrets(auth)) {
            authService.requireScope(auth, 'admin:secrets')
          }
          const deptId = decodeURIComponent(deptSecretListMatch[1] || '')
          authService.requireDepartmentInScope(auth.orgId, deptId, auth)
          writeJson(res, 200, await secretsApi.listDepartmentSecretsForDept(auth.orgId, auth.userId, deptId))
          return
        }
        const deptSecretMatch = pathname.match(/^\/api\/v1\/department-secrets\/([^/]+)\/([^/]+)\/([^/]+)$/)
        if (deptSecretMatch) {
          const deptId = decodeURIComponent(deptSecretMatch[1] || '')
          const pinyin = decodeURIComponent(deptSecretMatch[2] || '')
          const key = decodeURIComponent(deptSecretMatch[3] || '')
          if (!canReadDepartmentSecrets(auth)) {
            authService.requireScope(auth, 'admin:secrets')
          }
          authService.requireDepartmentInScope(auth.orgId, deptId, auth)
          if (req.method === 'GET') {
            const ancestorChain = authService.getDepartmentAncestorChain(auth.orgId, deptId)
            writeJson(res, 200, await secretsApi.getDepartmentSecret(auth.orgId, auth.userId, deptId, pinyin, key, clientIp, ancestorChain))
            return
          }
          if (req.method === 'PUT') {
            const body = await readJsonBody(req)
            writeJson(res, 200, await secretsApi.putDepartmentSecret(auth.orgId, auth.userId, deptId, pinyin, key, body.value ?? '', clientIp))
            return
          }
          if (req.method === 'DELETE') {
            writeJson(res, 200, await secretsApi.deleteDepartmentSecret(auth.orgId, auth.userId, deptId, pinyin, key, clientIp))
            return
          }
        }

        // Secret metadata: list + update. The list only exposes config_item_id +
        // expiry (no secret values), so any credential-capable role may read it
        // to render expiry in their own credential UI.
        if (req.method === 'GET' && pathname === '/api/v1/secret-metadata') {
          if (!canReadSecretAudit(auth)) {
            authService.requireScope(auth, 'admin:secrets')
          }
          writeJson(res, 200, secretsApi.listMetadata(auth.orgId, auth.userId))
          return
        }
        const metadataMatch = pathname.match(/^\/api\/v1\/secret-metadata\/(\d+)$/)
        if (req.method === 'PUT' && metadataMatch) {
          const itemId = Number(metadataMatch[1])
          // Admins may set expiry on any config item. A user-credential writer
          // (dept_admin/user) may set expiry only on user-scope config items —
          // the same items whose values they own.
          if (!hasScope(auth.scopes, 'admin:secrets:write') && !hasScope(auth.scopes, '*')) {
            const item = runtime.store.getConfigItem(itemId, auth.orgId)
            if (!item || (item.scope as string) !== 'user' || !canWriteUserSecrets(auth)) {
              throw new HttpError(403, 'Missing scope: admin:secrets:write')
            }
          }
          const body = await readJsonBody(req)
          writeJson(res, 200, secretsApi.updateMetadata(auth.orgId, auth.userId, itemId, body.expires_at ?? null))
          return
        }

        // Department policies
        const deptPolicyMatch = pathname.match(/^\/api\/v1\/departments\/([^/]+)\/secret-policies$/)
        if (deptPolicyMatch) {
          const deptId = deptPolicyMatch[1] || ''
          if (req.method === 'GET') {
            authService.requireScope(auth, 'admin:secrets')
            // A dept_admin may only read policies for departments in their
            // subtree; admins are unrestricted within the org.
            authService.requireDepartmentInScope(auth.orgId, deptId, auth)
            writeJson(res, 200, secretsApi.getDepartmentPolicies(auth.orgId, auth.userId, deptId))
            return
          }
          if (req.method === 'PUT') {
            authService.requireScope(auth, 'admin:secrets:write')
            authService.requireDepartmentInScope(auth.orgId, deptId, auth)
            const body = await readJsonBody(req)
            writeJson(res, 200, secretsApi.updateDepartmentPolicies(auth.orgId, auth.userId, deptId, body.config_item_ids ?? []))
            return
          }
        }

        // Audit log. Admins see the whole org; a dept_admin sees only actions by
        // users in their department subtree; a normal user sees only their own.
        // The actor restriction is computed server-side from the caller's
        // capability (never from a query param) so it can't be widened.
        if (req.method === 'GET' && pathname === '/api/v1/secrets-audit') {
          if (!canReadSecretAudit(auth)) {
            authService.requireScope(auth, 'admin:secrets')
          }
          const actorIds = canReadDepartmentSecrets(auth)
            ? authService.listSubtreeUserIds(auth.orgId, auth) ?? undefined
            : new Set<string>([auth.userId])
          // Config-item scope gate: admins see every scope; a dept_admin sees
          // department + user credential audit rows; a normal user only user.
          const isSecretsAdmin = hasScope(auth.scopes, 'admin:secrets') || hasScope(auth.scopes, '*')
          const scopes = isSecretsAdmin
            ? undefined
            : canReadDepartmentSecrets(auth)
              ? ['department', 'user']
              : ['user']
          const urlObj = new URL(req.url as string, `http://${req.headers.host}`)
          writeJson(res, 200, secretsApi.listAuditLog(auth.orgId, auth.userId, {
            actorIds: actorIds ? Array.from(actorIds) : undefined,
            scopes,
            actor_id: urlObj.searchParams.get('actor_id') || undefined,
            config_item_id: urlObj.searchParams.get('config_item_id') ? Number(urlObj.searchParams.get('config_item_id')) : undefined,
            action: urlObj.searchParams.get('action') || undefined,
            since: urlObj.searchParams.get('since') ? Number(urlObj.searchParams.get('since')) : undefined,
            until: urlObj.searchParams.get('until') ? Number(urlObj.searchParams.get('until')) : undefined,
            page: Number(urlObj.searchParams.get('page')) || undefined,
            page_size: Number(urlObj.searchParams.get('page_size')) || undefined,
          }))
          return
        }

        // Rotation alerts. Admins see all scopes; a dept_admin sees department +
        // user credential alerts; a normal user sees only user-scope alerts.
        if (req.method === 'GET' && pathname === '/api/v1/secret-rotation/alerts') {
          if (!canReadSecretAudit(auth)) {
            authService.requireScope(auth, 'admin:secrets')
          }
          const isAdmin = hasScope(auth.scopes, 'admin:secrets') || hasScope(auth.scopes, '*')
          const scopeFilter = isAdmin
            ? undefined
            : canReadDepartmentSecrets(auth)
              ? new Set<'system' | 'department' | 'user'>(['department', 'user'])
              : new Set<'system' | 'department' | 'user'>(['user'])
          writeJson(res, 200, secretsApi.listRotationAlerts(auth.orgId, auth.userId, scopeFilter))
          return
        }

        // Auth Proxy token management (admin only, for testing/session support)
        if (pathname === '/api/v1/auth-proxy/register-test-token' && req.method === 'POST') {
          authService.requireScope(auth, 'admin:secrets:write')
          const body = await readJsonBody(req)
          const ap = runtime.authProxy
          if (!ap) { writeJson(res, 503, { success: false, error: { code: 'auth_proxy_unavailable' } }); return }
          const testToken = body?.token || randomUUID()
          const testUserId = body?.user_id || auth.userId
          // Scope the test token to the caller's org so proxy rule matching is
          // org-correct (matches production registerToken semantics).
          ap.registerToken(testToken, testUserId, auth.orgId, body?.department_id || null, Boolean(body?.is_admin), null)
          writeJson(res, 200, { success: true, token: testToken })
          return
        }
        if (pathname === '/api/v1/auth-proxy/revoke-token' && req.method === 'POST') {
          authService.requireScope(auth, 'admin:secrets:write')
          const body = await readJsonBody(req)
          const ap = runtime.authProxy
          if (ap && body?.token) ap.revokeToken(body.token)
          writeJson(res, 200, { success: true })
          return
        }

        // Individual secret CRUD (enterprise + user)
        const secretMatch = pathname.match(/^\/api\/v1\/secrets\/([^/]+)\/([^/]+)(?:\/(enable|disable))?$/)
        if (secretMatch) {
          const namespace = decodeURIComponent(secretMatch[1])
          const key = decodeURIComponent(secretMatch[2])
          const action = secretMatch[3]
          if (action === 'enable' && req.method === 'POST') {
            authService.requireScope(auth, 'admin:secrets:write')
            writeJson(res, 200, await secretsApi.enableSecret(auth.orgId, auth.userId, namespace, key, clientIp))
            return
          }
          if (action === 'disable' && req.method === 'POST') {
            authService.requireScope(auth, 'admin:secrets:write')
            writeJson(res, 200, await secretsApi.disableSecret(auth.orgId, auth.userId, namespace, key, clientIp))
            return
          }
          if (req.method === 'GET') {
            authService.requireScope(auth, 'admin:secrets')
            writeJson(res, 200, await secretsApi.getSecret(auth.orgId, auth.userId, namespace, key, clientIp))
            return
          }
          if (req.method === 'PUT') {
            authService.requireScope(auth, 'admin:secrets:write')
            const body = await readJsonBody(req)
            writeJson(res, 200, await secretsApi.putSecret(auth.orgId, auth.userId, namespace, key, body.value ?? '', undefined, clientIp))
            return
          }
          if (req.method === 'DELETE') {
            authService.requireScope(auth, 'admin:secrets:write')
            writeJson(res, 200, await secretsApi.deleteSecret(auth.orgId, auth.userId, namespace, key, clientIp))
            return
          }
        }

        // User secrets (me endpoints)
        if (req.method === 'GET' && pathname === '/api/v1/me/secrets') {
          writeJson(res, 200, await secretsApi.listUserSecrets(auth.orgId, auth.userId))
          return
        }
        if (req.method === 'GET' && pathname === '/api/v1/me/authorized-system-configs') {
          try {
            // Org-scope: only this org's system/department config items.
            const orgActiveItems = runtime.store.getAllActiveConfigItems(auth.orgId)
            const allSystemItems = orgActiveItems.filter(i => (i.scope as string) === 'system')
            const allDeptItems = orgActiveItems.filter(i => (i.scope as string) === 'department')
            // Admins/super_admins hold all privileges within the org, so they
            // may use any department credential regardless of their own (or no)
            // department membership — matching the auth-proxy department gate.
            const isAdmin =
              auth.role === 'admin' || auth.role === 'super_admin' || hasScope(auth.scopes, '*')
            const user = authService.getUserById(auth.userId)
            const deptId = user?.departmentId ?? null
            let authorizedDeptIds: Set<number> = new Set()
            if (deptId) {
              const policies = runtime.store.getDepartmentPolicies(deptId, auth.orgId)
              authorizedDeptIds = new Set(policies.map(p => p.config_item_id as number))
            }
            let visible = [
              ...allSystemItems,
              ...allDeptItems.filter(i => isAdmin || authorizedDeptIds.has(i.id as number))
            ]
            if (nexusClient) {
              const configuredNs = nexusClient.listConfiguredNamespaces()
              const orgPrefix = `org:${auth.orgId}:`
              // The user's department chain (self-first) for hierarchical
              // inheritance: an item is usable if the user's own dept OR any
              // ancestor OR the legacy org-wide value is configured.
              const deptChain = authService.getDepartmentAncestorChain(auth.orgId, deptId)
              visible = visible.filter(i => {
                if ((i.scope as string) === 'department') {
                  const legacy = `${orgPrefix}role:${i.pinyin}`
                  if (configuredNs.has(legacy)) return true
                  return deptChain.some(d => configuredNs.has(`${orgPrefix}${deptSecretNamespace(d, i.pinyin as string)}`))
                }
                return configuredNs.has(`${orgPrefix}system:${i.pinyin}`)
              })
            }
            writeJson(res, 200, { success: true, data: visible })
          } catch {
            writeJson(res, 200, { success: true, data: [] })
          }
          return
        }
        const meSecretMatch = pathname.match(/^\/api\/v1\/me\/secrets\/([^/]+)\/([^/]+)(?:\/(enable|disable))?$/)
        if (meSecretMatch) {
          const namespace = decodeURIComponent(meSecretMatch[1])
          const key = decodeURIComponent(meSecretMatch[2])
          const action = meSecretMatch[3]
          // Writing own user-credential values requires secrets:user:write.
          // The API additionally enforces `user:{userId}:` namespace ownership,
          // so this is defense-in-depth and lets the frontend mirror the gate.
          const requireUserSecretWrite = () => {
            if (!canWriteUserSecrets(auth)) {
              throw new HttpError(403, 'Missing scope: secrets:user:write')
            }
          }
          if (action === 'enable' && req.method === 'POST') {
            requireUserSecretWrite()
            writeJson(res, 200, await secretsApi.enableUserSecret(auth.orgId, auth.userId, namespace, key, clientIp))
            return
          }
          if (action === 'disable' && req.method === 'POST') {
            requireUserSecretWrite()
            writeJson(res, 200, await secretsApi.disableUserSecret(auth.orgId, auth.userId, namespace, key, clientIp))
            return
          }
          if (req.method === 'GET') {
            writeJson(res, 200, await secretsApi.getUserSecret(auth.orgId, auth.userId, namespace, key, clientIp))
            return
          }
          if (req.method === 'PUT') {
            requireUserSecretWrite()
            const body = await readJsonBody(req)
            writeJson(res, 200, await secretsApi.putUserSecret(auth.orgId, auth.userId, namespace, key, body.value ?? '', clientIp))
            return
          }
          if (req.method === 'DELETE') {
            requireUserSecretWrite()
            writeJson(res, 200, await secretsApi.deleteUserSecret(auth.orgId, auth.userId, namespace, key, clientIp))
            return
          }
        }
      }

      // ==================== MCP Management ====================

      // SSE events endpoint (token query param auth handled above)
      if (req.method === 'GET' && pathname === '/api/v1/mcp/events') {
        handleMcpSseConnection(res, auth.orgId)
        return
      }

      // Admin: list MCP servers
      if (req.method === 'GET' && pathname === '/api/v1/admin/mcp-servers') {
        const result = mcpAdminApi.listMcpServers(auth, {
          scope: url.searchParams.get('scope') as any || undefined,
          department_id: url.searchParams.get('department_id') || undefined,
          status: url.searchParams.get('status') as any || undefined,
          risk_level: url.searchParams.get('risk_level') as any || undefined,
          mcp_type: url.searchParams.get('mcp_type') as any || undefined,
          audit_enabled: url.searchParams.get('audit_enabled') === 'true'
            ? true
            : url.searchParams.get('audit_enabled') === 'false' ? false : undefined,
          bound_assistant: url.searchParams.get('bound_assistant') || undefined,
          created_by: url.searchParams.get('created_by') || undefined,
          page: Number(url.searchParams.get('page')) || undefined,
          page_size: Number(url.searchParams.get('page_size')) || undefined,
        }, clientIp)
        writeJson(res, 200, result)
        return
      }

      // Admin: create MCP server
      if (req.method === 'POST' && pathname === '/api/v1/admin/mcp-servers') {
        const body = await readJsonBody(req)
        const result = mcpAdminApi.createMcpServer(auth, body, clientIp)
        writeJson(res, result.success ? 201 : 400, result)
        return
      }

      // Admin: get/update/delete/test MCP server by ID
      const mcpServerMatch = pathname.match(/^\/api\/v1\/admin\/mcp-servers\/([^/]+)$/)
      if (mcpServerMatch) {
        const serverId = mcpServerMatch[1]
        if (req.method === 'GET') {
          const result = mcpAdminApi.getMcpServer(auth, serverId)
          writeJson(res, result.success ? 200 : 404, result)
          return
        }
        if (req.method === 'PATCH') {
          const body = await readJsonBody(req)
          // Handle enable/disable via dedicated method
          if (body.enabled !== undefined && Object.keys(body).length === 1) {
            const result = mcpAdminApi.setMcpServerEnabled(auth, serverId, !!body.enabled, clientIp)
            writeJson(res, result.success ? 200 : 404, result)
          } else {
            const result = mcpAdminApi.updateMcpServer(auth, serverId, body, clientIp)
            writeJson(res, result.success ? 200 : 400, result)
          }
          return
        }
        if (req.method === 'DELETE') {
          const result = mcpAdminApi.deleteMcpServer(auth, serverId, clientIp)
          writeJson(res, result.success ? 200 : 404, result)
          return
        }
      }

      // Admin: test MCP connection
      const mcpTestMatch = pathname.match(/^\/api\/v1\/admin\/mcp-servers\/([^/]+)\/test$/)
      if (mcpTestMatch && req.method === 'POST') {
        const result = await mcpAdminApi.testConnection(auth, mcpTestMatch[1], clientIp)
        writeJson(res, result.success ? 200 : 404, result)
        return
      }

      // Admin: MCP 配置解析
      if (req.method === 'POST' && pathname === '/api/v1/admin/mcp-config/parse') {
        const body = await readJsonBody(req)
        const result = await mcpAdminApi.parseMcpConfig(auth, body)
        writeJson(res, result.success ? 200 : 400, result)
        return
      }

      // Admin: MCP server audit logs
      const mcpAuditMatch = pathname.match(/^\/api\/v1\/admin\/mcp-servers\/([^/]+)\/audit-logs$/)
      if (mcpAuditMatch && req.method === 'GET') {
        const result = mcpAdminApi.getServerAuditLogs(auth, mcpAuditMatch[1], {
          page: Number(url.searchParams.get('page')) || undefined,
          page_size: Number(url.searchParams.get('page_size')) || undefined,
        })
        writeJson(res, 200, result)
        return
      }

      // Admin: get MCP policy
      if (req.method === 'GET' && pathname === '/api/v1/tenant/mcp-policy') {
        const result = mcpAdminApi.getMcpPolicy(auth)
        writeJson(res, 200, result)
        return
      }

      // Admin: update MCP policy
      if (req.method === 'PATCH' && pathname === '/api/v1/admin/mcp-policy') {
        const body = await readJsonBody(req)
        const result = mcpAdminApi.updateMcpPolicy(auth, body, clientIp)
        writeJson(res, 200, result)
        return
      }

      // Admin: MCP audit logs
      if (req.method === 'GET' && pathname === '/api/v1/admin/mcp-audit-logs') {
        const statusParam = url.searchParams.get('status') || undefined
        const status = statusParam === 'success' || statusParam === 'error' ? statusParam : undefined
        const result = mcpAdminApi.getAuditLogs(auth, {
          mcp_server_id: url.searchParams.get('mcp_server_id') || undefined,
          mcp_server_name: url.searchParams.get('mcp_server_name') || undefined,
          user_id: url.searchParams.get('user_id') || undefined,
          action: url.searchParams.get('action') || undefined,
          status,
          since: Number(url.searchParams.get('since')) || undefined,
          until: Number(url.searchParams.get('until')) || undefined,
          page: Number(url.searchParams.get('page')) || undefined,
          page_size: Number(url.searchParams.get('page_size')) || undefined,
        })
        writeJson(res, 200, result)
        return
      }

      // Admin: list/approve/reject approval requests (Phase 2)
      if (req.method === 'GET' && pathname === '/api/v1/admin/mcp-approvals') {
        const result = mcpAdminApi.listApprovalRequests(auth, url.searchParams.get('status') || undefined)
        writeJson(res, 200, result)
        return
      }

      const mcpApproveMatch = pathname.match(/^\/api\/v1\/admin\/mcp-approvals\/([^/]+)\/approve$/)
      if (mcpApproveMatch && req.method === 'POST') {
        const result = mcpAdminApi.approveRequest(auth, mcpApproveMatch[1], clientIp)
        writeJson(res, 200, result)
        return
      }

      const mcpRejectMatch = pathname.match(/^\/api\/v1\/admin\/mcp-approvals\/([^/]+)\/reject$/)
      if (mcpRejectMatch && req.method === 'POST') {
        const body = await readJsonBody(req)
        const result = mcpAdminApi.rejectRequest(auth, mcpRejectMatch[1], body.review_note || '', clientIp)
        writeJson(res, 200, result)
        return
      }

      // MCP Templates: list
      if (req.method === 'GET' && pathname === '/api/v1/admin/mcp-templates') {
        const params = new URL(req.url, `http://${req.headers.host}`).searchParams
        const filter: Record<string, string> = {}
        if (params.get('category')) filter.category = params.get('category')!
        if (params.get('search')) filter.search = params.get('search')!
        if (params.get('page')) filter.page = params.get('page')!
        if (params.get('page_size')) filter.page_size = params.get('page_size')!
        const result = mcpAdminApi.listTemplates(auth, filter)
        writeJson(res, 200, result)
        return
      }

      // MCP Templates: get single
      const mcpTemplateMatch = pathname.match(/^\/api\/v1\/admin\/mcp-templates\/([^/]+)$/)
      if (mcpTemplateMatch && req.method === 'GET') {
        const result = mcpAdminApi.getTemplate(auth, mcpTemplateMatch[1])
        writeJson(res, result.success ? 200 : 404, result)
        return
      }

      // Template CRUD: create
      if (req.method === 'POST' && pathname === '/api/v1/admin/mcp-templates') {
        const body = await readJsonBody(req)
        const result = mcpAdminApi.createTemplate(auth, body as any, clientIp)
        writeJson(res, result.success ? 201 : 400, result)
        return
      }

      // Template CRUD: update / delete
      const mcpTemplateUpdateMatch = pathname.match(/^\/api\/v1\/admin\/mcp-templates\/([^/]+)$/)
      if (mcpTemplateUpdateMatch) {
        const templateId = mcpTemplateUpdateMatch[1]
        if (req.method === 'PATCH') {
          const body = await readJsonBody(req)
          const result = mcpAdminApi.updateTemplate(auth, templateId, body as any, clientIp)
          writeJson(res, 200, result)
          return
        }
        if (req.method === 'DELETE') {
          const result = mcpAdminApi.deleteTemplate(auth, templateId, clientIp)
          writeJson(res, 200, result)
          return
        }
      }

      // MCP Templates: install (create MCP from template)
      const mcpTemplateInstallMatch = pathname.match(/^\/api\/v1\/admin\/mcp-templates\/([^/]+)\/install$/)
      if (mcpTemplateInstallMatch && req.method === 'POST') {
        const body = await readJsonBody(req)
        const result = mcpAdminApi.installTemplate(auth, mcpTemplateInstallMatch[1], body, clientIp)
        writeJson(res, result.success ? 201 : 400, result)
        return
      }

      // User: list my MCP servers
      if (req.method === 'GET' && pathname === '/api/v1/me/mcp-servers') {
        const result = await mcpUserApi.listMyMcpServers(auth)
        writeJson(res, 200, result)
        return
      }

      // User / third-party: list available MCP templates (sanitized, no admin scope)
      if (req.method === 'GET' && pathname === '/api/v1/me/mcp-templates') {
        const filter: McpTemplateListFilter = {}
        if (url.searchParams.get('category')) filter.category = url.searchParams.get('category')!
        if (url.searchParams.get('search')) filter.search = url.searchParams.get('search')!
        if (url.searchParams.get('page')) filter.page = Number(url.searchParams.get('page')) || undefined
        if (url.searchParams.get('page_size')) filter.page_size = Number(url.searchParams.get('page_size')) || undefined
        const result = mcpUserApi.listAvailableTemplates(auth, filter)
        writeJson(res, 200, result)
        return
      }

      // User: install MCP from template (creates a personal scope=user MCP)
      const meMcpTemplateInstallMatch = pathname.match(/^\/api\/v1\/me\/mcp-templates\/([^/]+)\/install$/)
      if (meMcpTemplateInstallMatch && req.method === 'POST') {
        const body = (await readJsonBody(req)) as { config_values?: Record<string, string>; display_name?: string } | null
        const result = await mcpUserApi.installFromTemplate(
          auth,
          meMcpTemplateInstallMatch[1],
          body ?? {},
          clientIp,
        )
        if (result.success) {
          writeJson(res, 201, result)
        } else {
          const code = (result as any).error?.code
          const status =
            code === 'not_found' ? 404 :
            code === 'forbidden' ? 403 :
            code === 'already_installed' ? 409 :
            code === 'user_config_unavailable' ? 503 :
            400
          writeJson(res, status, result)
        }
        return
      }

      // User: install personal MCP by JSON config
      if (req.method === 'POST' && pathname === '/api/v1/me/mcp-servers/install-json') {
        const body = await readJsonBody(req)
        const result = await mcpUserApi.installByJson(auth, body, clientIp)
        writeJson(res, result.success ? 201 : 400, result)
        return
      }

      // User: create personal MCP (Phase 2)
      if (req.method === 'POST' && pathname === '/api/v1/me/mcp-servers') {
        const body = await readJsonBody(req)
        const result = await mcpUserApi.createPersonalMcp(auth, body, clientIp)
        writeJson(res, result.success ? 201 : 400, result)
        return
      }

      // User: enable/disable MCP for current user (must be before the generic :id match)
      const meMcpEnableMatch = pathname.match(/^\/api\/v1\/me\/mcp-servers\/([^/]+)\/enable$/)
      if (meMcpEnableMatch && req.method === 'PUT') {
        const result = await mcpUserApi.enableUserMcp(auth, meMcpEnableMatch[1], clientIp)
        writeJson(res, result.success ? 200 : 400, result)
        return
      }
      const meMcpDisableMatch = pathname.match(/^\/api\/v1\/me\/mcp-servers\/([^/]+)\/disable$/)
      if (meMcpDisableMatch && req.method === 'PUT') {
        const result = await mcpUserApi.disableUserMcp(auth, meMcpDisableMatch[1], clientIp)
        writeJson(res, result.success ? 200 : 400, result)
        return
      }

      // User: update/delete/test personal MCP (Phase 2)
      const meMcpMatch = pathname.match(/^\/api\/v1\/me\/mcp-servers\/([^/]+)$/)
      if (meMcpMatch) {
        const serverId = meMcpMatch[1]
        if (req.method === 'PATCH') {
          const body = await readJsonBody(req)
          const result = await mcpUserApi.updatePersonalMcp(auth, serverId, body, clientIp)
          writeJson(res, result.success ? 200 : 400, result)
          return
        }
        if (req.method === 'DELETE') {
          const result = await mcpUserApi.deletePersonalMcp(auth, serverId, clientIp)
          writeJson(res, result.success ? 200 : 404, result)
          return
        }
      }

      const meMcpTestMatch = pathname.match(/^\/api\/v1\/me\/mcp-servers\/([^/]+)\/test$/)
      if (meMcpTestMatch && req.method === 'POST') {
        const result = await mcpUserApi.testPersonalMcpConnection(auth, meMcpTestMatch[1], clientIp)
        writeJson(res, result.success ? 200 : 404, result)
        return
      }

      // User config routes
      const userConfigMatch = pathname.match(/^\/api\/v1\/me\/mcp-servers\/([^/]+)\/user-config(?:\/([^/]+))?$/)
      if (userConfigMatch) {
        if (!mcpUserConfigApi) {
          writeJson(res, 503, { error: { code: 'user_config_unavailable', message: '用户配置功能当前不可用' } })
          return
        }
        const serverId = userConfigMatch[1]
        const configKey = userConfigMatch[2]
        if (req.method === 'GET' && !configKey) {
          const result = await mcpUserConfigApi.listForServer(auth, serverId)
          writeJson(res, 200, result)
          return
        }
        // Batch update: PUT /me/mcp-servers/:id/user-config (no trailing key)
        if (req.method === 'PUT' && !configKey) {
          const body = await readJsonBody(req) as { config_values?: Record<string, string> } | null
          if (!body || typeof body.config_values !== 'object' || body.config_values === null) {
            writeJson(res, 400, { error: { code: 'bad_request', message: '请求体必须包含 config_values 字段' } })
            return
          }
          const result = await mcpUserConfigApi.batchUpdate(auth, serverId, body.config_values)
          if (result.success) {
            writeJson(res, 200, result)
          } else {
            const code = (result as any).error?.code
            const status =
              code === 'not_found' ? 404 :
              code === 'forbidden' ? 403 :
              code === 'missing_config' ? 400 :
              code === 'template_not_found' ? 400 :
              400
            writeJson(res, status, result)
          }
          return
        }
        if (req.method === 'PUT' && configKey) {
          const body = await readJsonBody(req) as { value?: string }
          if (!body || typeof body.value !== 'string') {
            writeJson(res, 400, { error: { code: 'bad_request', message: '请求体必须包含 value 字段' } })
            return
          }
          const result = await mcpUserConfigApi.setValue(auth, serverId, configKey, body.value)
          writeJson(res, result.success ? 200 : 400, result)
          return
        }
        if (req.method === 'DELETE' && configKey) {
          const result = await mcpUserConfigApi.deleteValue(auth, serverId, configKey)
          writeJson(res, 200, result)
          return
        }
      }

      if (req.method === 'GET' && pathname === '/api/v1/settings/system') {
        authService.requireScope(auth, 'admin:settings')
        writeJson(res, 200, getSystemSettings())
        return
      }

      // Non-secret store config for the skills/agents pages. GET /settings/system
      // requires admin:settings (it returns model API keys); dept_admins/users
      // with store:read need only skillStore.tenantId to fetch hub content, so
      // expose that slim, secret-free subset behind store:read (admins too).
      if (req.method === 'GET' && pathname === '/api/v1/store/config') {
        authService.requireAnyScope(auth, ['admin:settings', 'store:read'])
        const s = getSystemSettings()
        writeJson(res, 200, { skillStore: { tenantId: s.skillStore.tenantId } })
        return
      }

      if (req.method === 'PATCH' && pathname === '/api/v1/settings/system') {
        authService.requireScope(auth, 'admin:settings')
        const body = await readJsonBody(req)
        writeJson(res, 200, updateSystemSettings(body))
        return
      }

      if (req.method === 'PATCH' && pathname === '/api/v1/settings/enterprise') {
        authService.requireScope(auth, 'admin:settings')
        const body = await readJsonBody(req)
        writeJson(res, 200, await enterpriseApi.updateConfig(body))
        return
      }

      // ==================== Cron Jobs ====================
      // Department subtree of user ids whose jobs a dept_admin may read/manage,
      // resolved on the fly from current membership (null for admins, [self] for
      // a plain user). Shared by every per-job route below.
      const cronSubtreeUserIds = authService.listSubtreeUserIds(auth.orgId, auth)

      // List all cron jobs for current user (or subtree, for a dept_admin)
      if (req.method === 'GET' && pathname === '/api/v1/cron/jobs') {
        const result = await cronApi.listJobs(auth, cronSubtreeUserIds)
        writeJson(res, 200, result)
        return
      }

      // Create a new cron job
      if (req.method === 'POST' && pathname === '/api/v1/cron/jobs') {
        const body = await readJsonBody(req)
        const result = await cronApi.createJob(auth, {
          name: String(body.name || ''),
          enabled: body.enabled !== undefined ? Boolean(body.enabled) : true,
          coOwnerIds: Array.isArray(body.coOwnerIds)
            ? body.coOwnerIds.map(id => String(id || '').trim()).filter(Boolean)
            : undefined,
          executorUserId:
            typeof body.executorUserId === 'string' ? body.executorUserId : undefined,
          schedule: {
            kind: String((body.schedule as any)?.kind || 'cron'),
            value: String((body.schedule as any)?.value || ''),
            tz: typeof (body.schedule as any)?.tz === 'string' ? (body.schedule as any).tz : undefined,
            description: typeof (body.schedule as any)?.description === 'string' ? (body.schedule as any).description : undefined,
          },
          payloadMessage: String(body.payloadMessage || ''),
          conversationMode: String(body.conversationMode || 'new') as 'new' | 'reuse',
          boundSessionId: typeof body.boundSessionId === 'string' ? body.boundSessionId : undefined,
          assistantId: typeof body.assistantId === 'string' ? body.assistantId : undefined,
          assistantName: typeof body.assistantName === 'string' ? body.assistantName : undefined,
          workspace: typeof body.workspace === 'string' ? body.workspace : undefined,
          runtimeJson: typeof body.runtimeJson === 'string' ? body.runtimeJson : undefined,
          maxRetries: typeof body.maxRetries === 'number' ? body.maxRetries : undefined,
        })
        writeJson(res, 200, result)
        return
      }

      // Single cron job operations
      const cronJobMatch = pathname.match(/^\/api\/v1\/cron\/jobs\/([^/]+)$/)
      if (cronJobMatch) {
        const jobId = cronJobMatch[1]

        // Get a single cron job
        if (req.method === 'GET') {
          const result = await cronApi.getJob(auth, jobId, cronSubtreeUserIds)
          writeJson(res, 200, result)
          return
        }

        // Update a cron job
        if (req.method === 'PATCH') {
          const body = await readJsonBody(req)
          const updates: any = {}
          if (body.name !== undefined) updates.name = String(body.name)
          if (body.enabled !== undefined) updates.enabled = Boolean(body.enabled)
          if (body.coOwnerIds !== undefined) {
            updates.coOwnerIds = Array.isArray(body.coOwnerIds)
              ? body.coOwnerIds.map(id => String(id || '').trim()).filter(Boolean)
              : []
          }
          if (body.executorUserId !== undefined) {
            updates.executorUserId =
              body.executorUserId === null ? null : String(body.executorUserId)
          }
          if (body.schedule !== undefined) {
            updates.schedule = {
              kind: String((body.schedule as any)?.kind || 'cron'),
              value: String((body.schedule as any)?.value || ''),
              tz: typeof (body.schedule as any)?.tz === 'string' ? (body.schedule as any).tz : undefined,
              description: typeof (body.schedule as any)?.description === 'string' ? (body.schedule as any).description : undefined,
            }
          }
          if (body.payloadMessage !== undefined) updates.payloadMessage = String(body.payloadMessage)
          if (body.conversationMode !== undefined) updates.conversationMode = String(body.conversationMode)
          if (body.boundSessionId !== undefined) updates.boundSessionId = body.boundSessionId
          if (body.assistantId !== undefined) updates.assistantId = body.assistantId
          if (body.assistantName !== undefined) updates.assistantName = body.assistantName
          if (body.workspace !== undefined) updates.workspace = body.workspace
          if (body.runtimeJson !== undefined) updates.runtimeJson = body.runtimeJson
          if (body.maxRetries !== undefined) updates.maxRetries = body.maxRetries

          const result = await cronApi.updateJob(auth, jobId, updates, cronSubtreeUserIds)
          writeJson(res, 200, result)
          return
        }

        // Delete a cron job (soft delete)
        if (req.method === 'DELETE') {
          const result = await cronApi.deleteJob(auth, jobId, cronSubtreeUserIds)
          writeJson(res, 200, result)
          return
        }
      }

      // Trigger a job immediately
      const cronTriggerMatch = pathname.match(/^\/api\/v1\/cron\/jobs\/([^/]+)\/trigger$/)
      if (req.method === 'POST' && cronTriggerMatch) {
        const jobId = cronTriggerMatch[1]
        const result = await cronApi.triggerJob(auth, jobId, cronSubtreeUserIds)
        writeJson(res, 200, result)
        return
      }

      // List runs for a job
      const cronRunsMatch = pathname.match(/^\/api\/v1\/cron\/jobs\/([^/]+)\/runs$/)
      if (req.method === 'GET' && cronRunsMatch) {
        const jobId = cronRunsMatch[1]
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50
        const result = await cronApi.listRuns(auth, jobId, Number.isFinite(limit) ? limit : 50, cronSubtreeUserIds)
        writeJson(res, 200, result)
        return
      }

      // Admin: List all cron jobs in org
      if (req.method === 'GET' && pathname === '/api/v1/admin/cron/jobs') {
        authService.requireAnyScope(auth, ['admin:cron', 'cron:list:any'])
        const result = await cronApi.adminListJobs(auth)
        writeJson(res, 200, result)
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/upload/logo') {
        authService.requireScope(auth, 'admin:settings')
        const buffer = await readRawBody(req)
        const uploadDir = join(config.runtimeDir, 'uploads', 'enterprise')
        await mkdir(uploadDir, { recursive: true })

        const contentType = req.headers['content-type']
        let ext = '.png'
        if (typeof contentType === 'string') {
          const mime = contentType.split(';')[0].trim().toLowerCase()
          if (mime === 'image/png') {
            ext = '.png'
          } else if (mime === 'image/jpeg' || mime === 'image/jpg') {
            ext = '.jpg'
          } else if (mime === 'image/webp') {
            ext = '.webp'
          } else if (mime === 'image/svg+xml') {
            ext = '.svg'
          }
        }

        const filename = `logo_${Date.now()}${ext}`
        const filePath = join(uploadDir, filename)
        await writeFile(filePath, buffer)

        writeJson(res, 200, { success: true, data: { url: filename } })
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/upload/mcp-icon') {
        authService.requireScope(auth, 'admin:mcp')
        const buffer = await readRawBody(req)

        const url = await saveUploadedIcon(config.runtimeDir, buffer, req.headers['content-type'], 'mcp-icons')
        writeJson(res, 200, { success: true, data: { url } })
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/agent-hub/categories') {
        authService.requireAnyScope(auth, ['admin:settings', 'store:read'])
        writeJson(res, 200, await fetchAgentHubCategories())
        return
      }

      if (
        req.method === 'GET' &&
        pathname === '/api/v1/agent-hub/assistants/cursor'
      ) {
        authService.requireAnyScope(auth, ['admin:settings', 'store:read'])
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined

        writeJson(
          res,
          200,
          await fetchAgentHubAssistants({
            cursor: url.searchParams.get('cursor') || undefined,
            limit: Number.isFinite(limit) ? limit : undefined,
            query: url.searchParams.get('query') || undefined,
            category: url.searchParams.get('category') || undefined,
          }),
        )
        return
      }

      const agentHubDetailMatch = pathname.match(
        /^\/api\/v1\/agent-hub\/assistants\/([^/]+)$/,
      )
      if (req.method === 'GET' && agentHubDetailMatch) {
        authService.requireAnyScope(auth, ['admin:settings', 'store:read'])
        const assistantId = decodeURIComponent(agentHubDetailMatch[1] || '')
        writeJson(res, 200, await fetchAgentHubAssistantDetail(assistantId))
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/agent-hub/skills/by-ids') {
        authService.requireAnyScope(auth, ['admin:settings', 'store:read'])
        const body = await readJsonBody(req)
        const skillIds = Array.isArray(body.skillIds)
          ? body.skillIds
              .map(skillId => String(skillId || '').trim())
              .filter(Boolean)
          : []
        writeJson(res, 200, await fetchAgentHubSkillDetailsByIds(skillIds))
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/agents/installed') {
        const filter = authService.buildVisibilityFilter(auth)
        // Return all installed assistants: hub, tenant, and custom
        const all = await getInstalledAssistants()
        writeJson(
          res,
          200,
          all.filter(a => {
            if (a.meta?.feature === 'cabin' && !config.cabin.enabled) return false
            return isVisibleTo(a.visibleTo, filter)
          }),
        )
        return
      }

      const installedAgentRulesMatch = pathname.match(/^\/api\/v1\/agents\/installed\/([^/]+)\/rules$/)
      if (req.method === 'GET' && installedAgentRulesMatch) {
        authService.requireScope(auth, 'admin:settings')
        const assistantName = decodeURIComponent(installedAgentRulesMatch[1] || '')
        const rules = await getAssistantSystemPrompt(assistantName)
        if (rules === null) {
          throw new HttpError(404, `Assistant rules not found: ${assistantName}`)
        }
        writeJson(res, 200, { rules })
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/agents/install') {
        authService.requireScope(auth, 'admin:settings')
        const body = await readJsonBody(req)
        const assistantMeta = isJsonBody(body.assistantMeta)
          ? (body.assistantMeta as AgentHubAssistant)
          : null
        const selectedSkillIds = Array.isArray(body.selectedSkillIds)
          ? body.selectedSkillIds
              .map(skillId => String(skillId || '').trim())
              .filter(Boolean)
          : []

        writeJson(
          res,
          200,
          await installHubAssistant({
            assistantName:
              typeof body.assistantName === 'string' ? body.assistantName : '',
            sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl : '',
            version: typeof body.version === 'string' ? body.version : undefined,
            checksum:
              typeof body.checksum === 'string' ? body.checksum : undefined,
            assistantMeta,
            selectedSkillIds,
          }),
        )
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/agents/create') {
        authService.requireScope(auth, 'admin:settings')
        const body = await readJsonBody(req)

        const result = await createCustomAssistant({
          name: typeof body.name === 'string' ? body.name : '',
          displayName: typeof body.displayName === 'string' ? body.displayName : '',
          description: typeof body.description === 'string' ? body.description : undefined,
          avatar: typeof body.avatar === 'string' ? body.avatar : undefined,
          emoji: typeof body.emoji === 'string' ? body.emoji : undefined,
          rules: typeof body.rules === 'string' ? body.rules : '',
          skills: Array.isArray(body.skills)
            ? body.skills.filter((s): s is string => typeof s === 'string')
            : undefined,
          enabledWikis: Array.isArray(body.enabledWikis)
            ? body.enabledWikis.filter((s): s is string => typeof s === 'string')
            : undefined,
          enabledCorpApps: Array.isArray(body.enabledCorpApps)
            ? body.enabledCorpApps.filter((s): s is string => typeof s === 'string')
            : undefined,
          enableCorpAuth:
            typeof body.enableCorpAuth === 'boolean' ? body.enableCorpAuth : undefined,
          agent_type:
            body.agent_type === 'chat' || body.agent_type === 'workflow'
              ? body.agent_type
              : undefined,
          memory_mode:
            body.memory_mode === 'session' || body.memory_mode === 'user'
              ? body.memory_mode
              : undefined,
          visible_to:
            body.visible_to !== undefined
              ? (body.visible_to as AssistantStoreMeta['visible_to'])
              : undefined,
          workflow:
            body.workflow !== undefined
              ? (body.workflow as AssistantStoreMeta['workflow'])
              : undefined,
        })

        writeJson(res, 200, { success: true, data: result })
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/agents/uninstall') {
        authService.requireScope(auth, 'admin:settings')
        const body = await readJsonBody(req)
        await uninstallAssistant({
          assistantName:
            typeof body.assistantName === 'string' ? body.assistantName : '',
          sourcePath:
            typeof body.sourcePath === 'string' ? body.sourcePath : undefined,
        })
        writeJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'PATCH' && pathname === '/api/v1/agents/meta') {
        const body = await readJsonBody(req)
        // Editing installed hub/system agents stays admin-only. CUSTOM agents
        // (created from the SudoWork client, visible only to their owner) are
        // strictly creator-only — editable ONLY by the owner, even for an admin
        // who did not create it. Owner = a user id in the custom agent's
        // visible_to.user_ids (custom items are per-user, so seeing one implies
        // owning it). visible_to itself is still ignored for custom items on
        // write; this only opens up the other meta fields for the owner.
        {
          const targetName = typeof body.assistantName === 'string' ? body.assistantName : ''
          const found = await findAssistantDir(targetName)
          const targetMeta = found ? await readAssistantMeta(found.dir) : null
          if (targetMeta?.source_type === 'custom') {
            const ownsCustom = Array.isArray(targetMeta?.visible_to?.user_ids)
              && (targetMeta?.visible_to?.user_ids?.includes(auth.userId) ?? false)
            if (!ownsCustom) {
              throw new HttpError(403, 'Only the creator can edit this custom agent')
            }
          } else {
            authService.requireScope(auth, 'admin:settings')
          }
        }
        const updates = isJsonBody(body.updates) ? body.updates : {}

        await updateInstalledAssistantMeta({
          assistantName:
            typeof body.assistantName === 'string' ? body.assistantName : '',
          updates: {
            display_name:
              typeof updates.display_name === 'string'
                ? updates.display_name
                : undefined,
            description:
              typeof updates.description === 'string'
                ? updates.description
                : undefined,
            avatar:
              typeof updates.avatar === 'string' ? updates.avatar : undefined,
            emoji:
              typeof updates.emoji === 'string' ? updates.emoji : undefined,
            rules:
              typeof updates.rules === 'string' ? updates.rules : undefined,
            agent_type:
              updates.agent_type === 'chat' || updates.agent_type === 'workflow'
                ? updates.agent_type
                : undefined,
            memory_mode:
              updates.memory_mode === 'session' || updates.memory_mode === 'user'
                ? updates.memory_mode
                : undefined,
            visible_to:
              updates.visible_to !== undefined
                ? (updates.visible_to as AssistantStoreMeta['visible_to'])
                : undefined,
            workflow:
              updates.workflow !== undefined
                ? (updates.workflow as AssistantStoreMeta['workflow'])
                : undefined,
            enabledSkills:
              Array.isArray(updates.enabledSkills)
                ? updates.enabledSkills.filter((s: unknown) => typeof s === 'string')
                : undefined,
            enabledWikis:
              Array.isArray(updates.enabledWikis)
                ? updates.enabledWikis.filter((s: unknown) => typeof s === 'string')
                : undefined,
            enabledCorpApps:
              Array.isArray(updates.enabledCorpApps)
                ? updates.enabledCorpApps.filter((s: unknown) => typeof s === 'string')
                : undefined,
            enableCorpAuth:
              typeof updates.enableCorpAuth === 'boolean' ? updates.enableCorpAuth : undefined,
            skills:
              Array.isArray(updates.skills)
                ? updates.skills.filter((s: unknown) => typeof s === 'string')
                : undefined,
          },
        })
        writeJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'PATCH' && pathname === '/api/v1/agents/visibility') {
        authService.requireScope(auth, 'admin:settings')
        const body = await readJsonBody(req)
        await updateInstalledAssistantMeta({
          assistantName: typeof body.assistantName === 'string' ? body.assistantName : '',
          updates: { visible_to: (body.visible_to ?? null) as AssistantStoreMeta['visible_to'] },
        })
        writeJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/agents/sync-from-hub') {
        authService.requireScope(auth, 'admin:settings')
        if (getAgentSyncProgress().status === 'running') {
          writeJson(res, 409, { error: 'Sync already in progress' })
          return
        }
        resetAgentSyncProgress()
        updateAgentSyncProgress({ status: 'running', startedAt: Date.now() })
        batchSyncAssistants({
          onProgress: (processed, total) => {
            updateAgentSyncProgress({ processed, total })
          },
        }).then(result => {
          updateAgentSyncProgress({
            status: 'done',
            total: result.installed.length + result.updated.length + result.skipped.length + result.failed.length,
            processed: result.installed.length + result.updated.length + result.skipped.length + result.failed.length,
            installed: result.installed.length,
            updated: result.updated.length,
            skipped: result.skipped.length,
            failed: result.failed.length,
          })
        }).catch(err => {
          updateAgentSyncProgress({ status: 'error', error: err instanceof Error ? err.message : String(err) })
        })
        writeJson(res, 200, { started: true })
        return
      }

      // backward compat alias
      if (req.method === 'POST' && pathname === '/api/v1/agents/sync') {
        authService.requireScope(auth, 'admin:settings')
        if (getAgentSyncProgress().status === 'running') {
          writeJson(res, 409, { error: 'Sync already in progress' })
          return
        }
        resetAgentSyncProgress()
        updateAgentSyncProgress({ status: 'running', startedAt: Date.now() })
        batchSyncAssistants({
          onProgress: (processed, total) => {
            updateAgentSyncProgress({ processed, total })
          },
        }).then(result => {
          updateAgentSyncProgress({
            status: 'done',
            total: result.installed.length + result.updated.length + result.skipped.length + result.failed.length,
            processed: result.installed.length + result.updated.length + result.skipped.length + result.failed.length,
            installed: result.installed.length,
            updated: result.updated.length,
            skipped: result.skipped.length,
            failed: result.failed.length,
          })
        }).catch(err => {
          updateAgentSyncProgress({ status: 'error', error: err instanceof Error ? err.message : String(err) })
        })
        writeJson(res, 200, { started: true })
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/agents/sync-status') {
        authService.requireScope(auth, 'admin:settings')
        writeJson(res, 200, getAgentSyncProgress())
        return
      }

      // POST /api/v1/agents/custom - Upload custom agent
      if (req.method === 'POST' && pathname === '/api/v1/agents/custom') {
        const body = await readJsonBody(req)
        console.log('[Upload Assistant] Received upload request, name:', body.name, 'id:', body.id, 'displayName:', body.displayName)
        const fileBase64 = typeof body.file === 'string' ? body.file : ''
        const fileBuffer = Buffer.from(fileBase64, 'base64')
        // Parse enabledSkills - can be array or JSON string
        let enabledSkills: string[] = []
        if (Array.isArray(body.enabledSkills)) {
          enabledSkills = body.enabledSkills.filter((s: unknown) => typeof s === 'string')
        } else if (typeof body.enabledSkills === 'string') {
          try {
            const parsed = JSON.parse(body.enabledSkills)
            if (Array.isArray(parsed)) {
              enabledSkills = parsed.filter((s: unknown) => typeof s === 'string')
            }
          } catch {
            // Ignore parse errors
          }
        }
        const result = await uploadCustomAssistant({
          file: fileBuffer,
          name: typeof body.name === 'string' ? body.name : '',
          id: typeof body.id === 'string' ? body.id : undefined,
          displayName: typeof body.displayName === 'string' ? body.displayName : '',
          description: typeof body.description === 'string' ? body.description : undefined,
          version: typeof body.version === 'string' ? body.version : undefined,
          enabledSkills,
          memoryMode: body.memoryMode === 'user' ? 'user' : 'session',
          userId: auth.userId,
        })
        console.log('[Upload Assistant] Upload result:', JSON.stringify(result))
        writeJson(res, 200, result)
        return
      }

      // GET /api/v1/agents/tenant - List tenant assistants
      if (req.method === 'GET' && pathname === '/api/v1/agents/tenant') {
        const status = url.searchParams.get('status') || undefined
        const allRows = runtime.store.listTenantAssistants(status, auth.orgId)
        // Filter by visibility for non-admin users
        const filter = authService.buildVisibilityFilter(auth)
        const isAdmin = hasScope(auth.scopes, 'admin:settings')
        const rows = allRows.filter((row: Record<string, unknown>) => {
          // A caller can always see items they may manage (author in scope),
          // even if visibility wouldn't otherwise match — the "or created by
          // himself/subtree" clause of the spec.
          const canManage = authService.isCreatorInScope(auth.orgId, row.author_id as string, auth)
          if (row.status === 'pending') return isAdmin || canManage
          if (row.status === 'approved') {
            if (canManage) return true
            const visibleTo = typeof row.visible_to === 'string' ? JSON.parse(row.visible_to) : null
            return isVisibleTo(visibleTo, filter)
          }
          return canManage || isAdmin
        }).map((row: Record<string, unknown>) => {
          // Parse JSON fields for frontend consumption
          return {
            ...row,
            skills: typeof row.skills === 'string' ? JSON.parse(row.skills) : row.skills ?? [],
            enabled_skills: typeof row.enabled_skills === 'string' ? JSON.parse(row.enabled_skills) : row.enabled_skills ?? [],
            enabled_wikis: typeof row.enabled_wikis === 'string' ? JSON.parse(row.enabled_wikis) : row.enabled_wikis ?? [],
            enabled_corp_apps: typeof row.enabled_corp_apps === 'string' ? JSON.parse(row.enabled_corp_apps) : row.enabled_corp_apps ?? [],
            workflow: typeof row.workflow === 'string' ? JSON.parse(row.workflow) : row.workflow ?? null,
            visible_to: typeof row.visible_to === 'string' ? JSON.parse(row.visible_to) : row.visible_to ?? null,
            // Lets the frontend show edit/delete without re-deriving subtree math.
            can_manage: isAdmin || authService.isCreatorInScope(auth.orgId, row.author_id as string, auth),
          }
        })
        writeJson(res, 200, rows)
        return
      }

      // GET /api/v1/agents/installed/:id/download - Download installed agent by ID
      const agentDownloadMatch = pathname.match(/^\/api\/v1\/agents\/installed\/([^/]+)\/download$/)
      if (req.method === 'GET' && agentDownloadMatch) {
        const assistantId = decodeURIComponent(agentDownloadMatch[1] || '')
        try {
          // Find assistant by ID in installed assistants list
          const installedAssistants = await getInstalledAssistants()
          const assistant = installedAssistants.find(a => a.id === assistantId)
          if (!assistant) {
            throw new HttpError(404, `Assistant not found: ${assistantId}`)
          }
          // Use agent name for packaging (directory lookup)
          const zipBuffer = await packageAssistantZip(assistant.name)
          // Encode filename for Content-Disposition header (Chinese characters not allowed)
          const encodedFilename = encodeURIComponent(assistantId)
          res.setHeader('Content-Type', 'application/zip')
          res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}.zip"; filename*=UTF-8''${encodedFilename}.zip`)
          res.end(zipBuffer)
        } catch (error) {
          if (error instanceof HttpError) throw error
          throw new HttpError(404, `Assistant not found: ${assistantId}`)
        }
        return
      }

      // POST /api/v1/agents/tenant/create - Create a tenant assistant.
      // Admins (admin:settings) create it directly as approved (files in the
      // tenant dir, live immediately). Non-admins (store:tenant:write) instead
      // submit it as a PENDING approval request: files are staged in the
      // tenant-pending dir (invisible to the runtime scan) and only moved into
      // the tenant dir when an admin approves.
      if (req.method === 'POST' && pathname === '/api/v1/agents/tenant/create') {
        authService.requireAnyScope(auth, ['admin:settings', 'store:tenant:write'])
        const storeAdmin = isStoreAdmin(auth)
        const body = await readJsonBody(req)

        // Validate required fields
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : name

        if (!name) {
          throw new HttpError(400, 'name is required')
        }

        // Check if name already exists (within this org)
        const existingAssistant = runtime.store.getTenantAssistantByName(name, auth.orgId)
        if (existingAssistant) {
          throw new HttpError(400, `智能体名称 "${name}" 已存在，请使用其他名称`)
        }

        // Generate UUID for the agent
        const assistantId = randomUUID()

        // Get author info
        const authorUser = authService.getUserOrNull(auth.userId, auth.orgId, auth)
        const authorName = authorUser?.name || undefined

        // Admin → tenant dir (live now). Non-admin → tenant-pending staging dir
        // (invisible to the scan; moved to tenant on approval).
        const MOSS_HOME = process.env.MOSS_HOME || join(os.homedir(), '.moss')
        const ASSISTANT_TENANT_DIR = join(MOSS_HOME, 'assistants', 'tenant')
        const ASSISTANT_TENANT_PENDING_DIR = join(MOSS_HOME, 'assistants', 'tenant-pending')
        const assistantDir = join(storeAdmin ? ASSISTANT_TENANT_DIR : ASSISTANT_TENANT_PENDING_DIR, name)

        await mkdir(assistantDir, { recursive: true })

        // Visibility policy for the pending request:
        //  - admin: as submitted (they create live).
        //  - dept_admin: as submitted (a request the admin approves); when they
        //    submit nothing, fall back to their default scope (own department).
        //  - normal user: ALWAYS self-only, enforced server-side regardless of
        //    what was submitted (they have no picker; the roster is admin-only).
        const requestedVisibleTo = storeAdmin
          ? (body.visible_to ?? null)
          : authService.isDeptAdmin(auth)
            ? (body.visible_to !== undefined
                ? body.visible_to
                : (authService.defaultTenantVisibility(auth) ?? null))
            : (authService.defaultTenantVisibility(auth) ?? null)

        // Create metadata
        const rules = typeof body.rules === 'string' ? body.rules : ''
        const meta: AssistantStoreMeta = {
          id: assistantId,
          name,
          display_name: displayName,
          description: typeof body.description === 'string' ? body.description : undefined,
          avatar: typeof body.avatar === 'string' ? body.avatar : undefined,
          emoji: typeof body.emoji === 'string' ? body.emoji : undefined,
          source_type: 'tenant',
          enabled: true,
          ruleFile: 'system.md',
          skills: Array.isArray(body.skills) ? body.skills : [],
          enabledSkills: Array.isArray(body.enabled_skills) ? body.enabled_skills : [],
          enabledWikis: Array.isArray(body.enabled_wikis) ? body.enabled_wikis : [],
          enabledCorpApps: Array.isArray(body.enabled_corp_apps) ? body.enabled_corp_apps : [],
          enableCorpAuth: body.enable_corp_auth === true,
          agent_type: body.agent_type || 'chat',
          memory_mode: body.memory_mode || 'session',
          visible_to: requestedVisibleTo,
          workflow: body.workflow || null,
        }

        await writeAssistantMeta(assistantDir, meta)

        // Create rules file
        const rulesContent = rules.trim()
          ? rules
          : `# ${displayName}\n\n${typeof body.description === 'string' ? body.description : '这是一个专属智能体。'}\n`
        await writeFile(join(assistantDir, 'system.md'), rulesContent)

        // Admin → approved (live). Non-admin → pending (awaits approval).
        runtime.store.createTenantAssistant({
          id: assistantId,
          name,
          display_name: displayName,
          description: meta.description,
          author_id: auth.userId,
          author_name: authorName,
          status: storeAdmin ? 'approved' : 'pending',
          file_path: assistantDir,
          skills: meta.skills && meta.skills.length > 0 ? JSON.stringify(meta.skills) : null,
          enabled_skills: meta.enabledSkills && meta.enabledSkills.length > 0 ? JSON.stringify(meta.enabledSkills) : null,
          enabled_wikis: meta.enabledWikis && meta.enabledWikis.length > 0 ? JSON.stringify(meta.enabledWikis) : null,
          enabled_corp_apps: meta.enabledCorpApps && meta.enabledCorpApps.length > 0 ? JSON.stringify(meta.enabledCorpApps) : null,
          agent_type: meta.agent_type,
          memory_mode: meta.memory_mode,
          visible_to: meta.visible_to ? JSON.stringify(meta.visible_to) : null,
          enabled: 1,
          org_id: auth.orgId,
        })

        const result = runtime.store.getTenantAssistant(assistantId)
        writeJson(res, 200, {
          success: true,
          data: result,
          status: storeAdmin ? 'approved' : 'pending',
          message: storeAdmin ? undefined : '发布申请已提交，等待管理员审批',
        })
        return
      }

      const tenantAgentRulesMatch = pathname.match(/^\/api\/v1\/agents\/tenant\/([^/]+)\/rules$/)
      if (req.method === 'GET' && tenantAgentRulesMatch) {
        authService.requireScope(auth, 'admin:settings')
        const tenantAssistantId = decodeURIComponent(tenantAgentRulesMatch[1] || '')
        const tenantAssistant = runtime.store.getTenantAssistant(tenantAssistantId)
        if (!tenantAssistant) {
          throw new HttpError(404, `Tenant assistant not found: ${tenantAssistantId}`)
        }

        const filePath = typeof tenantAssistant.file_path === 'string' ? tenantAssistant.file_path : ''
        const assistantDir = filePath && existsSync(filePath)
          ? filePath
          : join(process.env.MOSS_HOME || join(os.homedir(), '.moss'), 'assistants', 'tenant', tenantAssistant.name as string)
        const rules = await getAssistantSystemPrompt(String(tenantAssistant.name || ''))

        if (rules === null && !existsSync(assistantDir)) {
          throw new HttpError(404, `Tenant assistant rules not found: ${tenantAssistantId}`)
        }

        if (rules !== null) {
          writeJson(res, 200, { rules })
          return
        }

        const fallback = await readFile(join(assistantDir, 'system.md'), 'utf8').catch(() => '')
        writeJson(res, 200, { rules: fallback })
        return
      }

      // POST /api/v1/agents/tenant/publish - Publish tenant agent request
      if (req.method === 'POST' && pathname === '/api/v1/agents/tenant/publish') {
        const body = await readJsonBody(req)
        const assistantId = typeof body.assistantId === 'string' ? body.assistantId : ''
        const publishNote = typeof body.publishNote === 'string' ? body.publishNote : undefined

        if (!assistantId) {
          throw new HttpError(400, `assistantId is required`)
        }

        // Check if agent exists
        const assistantResult = await findAssistantDir(assistantId)
        if (!assistantResult) {
          throw new HttpError(404, `Assistant not found: ${assistantId}`)
        }

        // Read agent metadata
        const meta = await readAssistantMeta(assistantResult.dir)

        // Use actual agent name from metadata or directory name
        const actualAssistantName = typeof meta?.name === 'string' && meta.name.trim() ? meta.name.trim() : assistantId

        // Get author name from user info
        const authorUser = authService.getUserOrNull(auth.userId, auth.orgId, auth)
        const authorName = authorUser?.name || undefined

        // Stamp the publisher's default visibility (dept_admin → own department,
        // user → self) so it survives approval instead of defaulting to global.
        const publishVisibility = authService.defaultTenantVisibility(auth)
        // Create tenant agent record with UUID as id
        runtime.store.createTenantAssistant({
          id: assistantId, // Use UUID as id
          name: actualAssistantName,
          display_name: meta?.display_name || actualAssistantName,
          description: meta?.description || undefined,
          version: meta?.installed_version || undefined,
          skills: meta?.skills ? JSON.stringify(meta.skills) : null,
          enabled_skills: meta?.enabledSkills ? JSON.stringify(meta.enabledSkills) : null,
          memory_mode: meta?.memory_mode || 'session',
          agent_type: meta?.agent_type || 'chat',
          publish_note: publishNote,
          author_id: auth.userId,
          author_name: authorName,
          status: 'pending',
          visible_to: publishVisibility ? JSON.stringify(publishVisibility) : null,
          file_path: assistantResult.dir, // Store source directory path for approval
          org_id: auth.orgId,
        })
        writeJson(res, 200, { id: assistantId, status: 'pending', message: '发布申请已提交，等待管理员审批' })
        return
      }

      // POST /api/v1/admin/agents/tenant/:id/approve - Approve tenant agent
      const agentApproveMatch = pathname.match(/^\/api\/v1\/admin\/agents\/tenant\/([^/]+)\/approve$/)
      if (req.method === 'POST' && agentApproveMatch) {
        authService.requireScope(auth, 'admin:settings')
        const tenantAssistantId = decodeURIComponent(agentApproveMatch[1] || '')
        const body = await readJsonBody(req)
        const approved = body.approved === true
        const reviewNote = typeof body.reviewNote === 'string' ? body.reviewNote : undefined

        const tenantAssistant = runtime.store.getTenantAssistant(tenantAssistantId)
        if (!tenantAssistant) {
          throw new HttpError(404, `Tenant assistant not found: ${tenantAssistantId}`)
        }

        if (approved) {
          // Update status to approved
          runtime.store.updateTenantAssistantStatus(tenantAssistantId, 'approved', auth.userId, reviewNote)
          // Preserve the publisher's default visibility (dept/self) through
          // approval. An admin may override via visible_to in the approve body;
          // a legacy record without one falls back to global (null).
          if (body.visible_to !== undefined) {
            runtime.store.updateTenantAssistantMeta(tenantAssistantId, {
              visible_to: body.visible_to === null ? null : JSON.stringify(body.visible_to),
            })
          } else if (tenantAssistant.visible_to == null) {
            runtime.store.updateTenantAssistantMeta(tenantAssistantId, { visible_to: null })
          }
          // Copy agent to tenant directory using stored file_path
          const sourcePath = tenantAssistant.file_path as string | undefined
          if (sourcePath && existsSync(sourcePath)) {
            await copyAssistantToTenantDirByPath(sourcePath)
            // Update file_path to the copied location (tenant/<dir name>).
            const MOSS_HOME = process.env.MOSS_HOME || join(os.homedir(), '.moss')
            const ASSISTANT_TENANT_PENDING_DIR = join(MOSS_HOME, 'assistants', 'tenant-pending')
            const tenantPath = join(MOSS_HOME, 'assistants', 'tenant', basename(sourcePath))
            runtime.store.updateTenantAssistantPath(tenantAssistantId, tenantPath)
            // MOVE semantics for non-admin-created pending items: remove the
            // staged source so it lives only in the tenant dir. Items published
            // from a real custom/ item keep their custom original (copy).
            if (isInsideDir(ASSISTANT_TENANT_PENDING_DIR, sourcePath)) {
              rmSync(sourcePath, { recursive: true, force: true })
            }
          } else {
            throw new HttpError(404, `Source assistant directory not found: ${sourcePath}`)
          }
        } else {
          runtime.store.updateTenantAssistantStatus(tenantAssistantId, 'rejected', auth.userId, reviewNote)
          // Clean up staged files for a rejected non-admin submission.
          const sourcePath = tenantAssistant.file_path as string | undefined
          const MOSS_HOME = process.env.MOSS_HOME || join(os.homedir(), '.moss')
          const ASSISTANT_TENANT_PENDING_DIR = join(MOSS_HOME, 'assistants', 'tenant-pending')
          if (sourcePath && isInsideDir(ASSISTANT_TENANT_PENDING_DIR, sourcePath) && existsSync(sourcePath)) {
            rmSync(sourcePath, { recursive: true, force: true })
          }
        }

        writeJson(res, 200, { id: tenantAssistantId, status: approved ? 'approved' : 'rejected' })
        return
      }

      // PATCH /api/v1/agents/tenant/:id - Update tenant agent meta
      const agentTenantPatchMatch = pathname.match(/^\/api\/v1\/agents\/tenant\/([^/]+)$/)
      if (req.method === 'PATCH' && agentTenantPatchMatch) {
        authService.requireAnyScope(auth, ['admin:settings', 'store:tenant:write'])
        const tenantAssistantId = decodeURIComponent(agentTenantPatchMatch[1] || '')
        const existingAssistant = runtime.store.getTenantAssistant(tenantAssistantId)
        if (!existingAssistant) {
          throw new HttpError(404, `Tenant assistant not found: ${tenantAssistantId}`)
        }
        // Non-admins may only manage tenant assistants authored by someone
        // currently in their scope, within their own org.
        const agentStoreAdmin = isStoreAdmin(auth)
        if (!agentStoreAdmin) {
          if (existingAssistant.org_id != null && existingAssistant.org_id !== auth.orgId) {
            throw new HttpError(404, `Tenant assistant not found: ${tenantAssistantId}`)
          }
          if (!authService.isCreatorInScope(auth.orgId, existingAssistant.author_id as string, auth)) {
            throw new HttpError(403, 'You cannot manage this tenant assistant')
          }
        }
        const body = await readJsonBody(req)
        // A non-admin cannot widen visibility beyond their own scope: keep only
        // the in-scope department/user ids they requested (out-of-scope ids an
        // admin set are dropped — the client warns before this happens). This
        // no longer overwrites a legitimate in-scope choice with their default.
        if (!agentStoreAdmin && body.visible_to !== undefined) {
          body.visible_to = authService.clampVisibleToScope(auth, body.visible_to as VisibleTo)
        }

        const updates: Record<string, unknown> = {}
        if (typeof body.display_name === 'string') {
          updates.display_name = body.display_name
        }
        if (typeof body.description === 'string') {
          updates.description = body.description
        }
        if (typeof body.avatar === 'string') {
          updates.avatar = body.avatar
        }
        if (typeof body.emoji === 'string') {
          updates.emoji = body.emoji
        }
        if (typeof body.agent_type === 'string') {
          updates.agent_type = body.agent_type
        }
        if (typeof body.memory_mode === 'string') {
          updates.memory_mode = body.memory_mode
        }
        if (typeof body.enabled === 'boolean') {
          updates.enabled = body.enabled ? 1 : 0
        }
        if (body.visible_to !== undefined) {
          updates.visible_to = body.visible_to ? JSON.stringify(body.visible_to) : null
        }
        if (Array.isArray(body.enabledSkills)) {
          updates.enabled_skills = JSON.stringify(body.enabledSkills.filter((s: unknown) => typeof s === 'string'))
        }
        if (Array.isArray(body.enabledWikis)) {
          updates.enabled_wikis = JSON.stringify(body.enabledWikis.filter((s: unknown) => typeof s === 'string'))
        }
        if (Array.isArray(body.enabledCorpApps)) {
          updates.enabled_corp_apps = JSON.stringify(body.enabledCorpApps.filter((s: unknown) => typeof s === 'string'))
        }
        if (typeof body.rules === 'string') {
          updates.rules = body.rules
        }
        if (Array.isArray(body.skills)) {
          updates.skills = JSON.stringify(body.skills.filter((s: unknown) => typeof s === 'string'))
        }
        if (body.workflow !== undefined) {
          updates.workflow = body.workflow ? JSON.stringify(body.workflow) : null
        }

        runtime.store.updateTenantAssistantMeta(tenantAssistantId, updates)

        // Sync to file metadata if approved
        const tenantAssistant = runtime.store.getTenantAssistant(tenantAssistantId)
        if (tenantAssistant && tenantAssistant.status === 'approved') {
          const assistantName = tenantAssistant.name as string
          const MOSS_HOME_LOCAL = process.env.MOSS_HOME || join(os.homedir(), '.moss')
          const ASSISTANT_TENANT_DIR = join(MOSS_HOME_LOCAL, 'assistants', 'tenant')
          const assistantDir = join(ASSISTANT_TENANT_DIR, assistantName)
          if (existsSync(assistantDir)) {
            const meta = await readAssistantMeta(assistantDir)
            if (meta) {
              if (updates.display_name !== undefined) meta.display_name = updates.display_name as string
              if (updates.description !== undefined) meta.description = updates.description as string
              if (updates.avatar !== undefined) meta.avatar = updates.avatar as string
              if (updates.emoji !== undefined) meta.emoji = updates.emoji as string
              if (updates.agent_type !== undefined) meta.agent_type = updates.agent_type as 'chat' | 'workflow'
              if (updates.memory_mode !== undefined) meta.memory_mode = updates.memory_mode as 'session' | 'user'
              if (updates.enabled !== undefined) meta.enabled = updates.enabled === 1
              if (body.visible_to !== undefined) meta.visible_to = body.visible_to as VisibleTo | null
              if (body.enabledSkills !== undefined) meta.enabledSkills = body.enabledSkills as string[]
              if (body.enabledWikis !== undefined) meta.enabledWikis = body.enabledWikis as string[]
              if (body.enabledCorpApps !== undefined) meta.enabledCorpApps = body.enabledCorpApps as string[]
              if (body.enableCorpAuth !== undefined) meta.enableCorpAuth = body.enableCorpAuth as boolean
              if (body.skills !== undefined) meta.skills = body.skills as string[]
              if (body.workflow !== undefined) meta.workflow = body.workflow as AssistantStoreMeta['workflow']
              if (typeof body.rules === 'string') {
                const ruleFile = meta.ruleFile || 'system.md'
                await writeFile(join(assistantDir, ruleFile), body.rules, 'utf8')
                meta.ruleFile = ruleFile
              }
              await writeAssistantMeta(assistantDir, meta)
            }
          }
        }

        writeJson(res, 200, { ok: true })
        return
      }

      // DELETE /api/v1/agents/tenant/:id - Delete tenant agent
      if (req.method === 'DELETE' && agentTenantPatchMatch) {
        authService.requireAnyScope(auth, ['admin:settings', 'store:tenant:write'])
        const tenantAssistantId = decodeURIComponent(agentTenantPatchMatch[1] || '')
        const tenantAssistant = runtime.store.getTenantAssistant(tenantAssistantId)
        // Non-admins may only delete tenant assistants authored by someone
        // currently in their scope, within their own org.
        if (tenantAssistant && !isStoreAdmin(auth)) {
          if (tenantAssistant.org_id != null && tenantAssistant.org_id !== auth.orgId) {
            throw new HttpError(404, `Tenant assistant not found: ${tenantAssistantId}`)
          }
          if (!authService.isCreatorInScope(auth.orgId, tenantAssistant.author_id as string, auth)) {
            throw new HttpError(403, 'You cannot manage this tenant assistant')
          }
        }
        if (tenantAssistant) {
          const assistantName = tenantAssistant.name as string
          // Delete from tenant directory if exists
          const MOSS_HOME = process.env.MOSS_HOME || join(os.homedir(), '.moss')
          const ASSISTANT_TENANT_DIR = join(MOSS_HOME, 'assistants', 'tenant')
          const assistantDir = join(ASSISTANT_TENANT_DIR, assistantName)
          if (existsSync(assistantDir)) {
            rmSync(assistantDir, { recursive: true, force: true })
          }
        }
        runtime.store.deleteTenantAssistant(tenantAssistantId)
        writeJson(res, 200, { ok: true })
        return
      }

      // GET /api/v1/agents/tenant/:id/download - Download tenant agent
      const tenantAgentDownloadMatch = pathname.match(/^\/api\/v1\/agents\/tenant\/([^/]+)\/download$/)
      if (req.method === 'GET' && tenantAgentDownloadMatch) {
        const tenantAssistantId = decodeURIComponent(tenantAgentDownloadMatch[1] || '')
        const tenantAssistant = runtime.store.getTenantAssistant(tenantAssistantId)
        if (!tenantAssistant || tenantAssistant.status !== 'approved') {
          throw new HttpError(404, `Tenant assistant not found or not approved: ${tenantAssistantId}`)
        }

        // file_path should point to tenant directory after approval
        const tenantPath = tenantAssistant.file_path as string | undefined
        if (!tenantPath) {
          throw new HttpError(404, `Tenant assistant file_path not found: ${tenantAssistantId}`)
        }

        if (!existsSync(tenantPath)) {
          throw new HttpError(404, `Assistant not found at: ${tenantPath}. This indicates the approval process did not copy the assistant correctly.`)
        }

        try {
          // Package from the tenant directory
          const zipBuffer = await packageAssistantZipByDir(tenantPath)
          // Encode filename for Content-Disposition header (Chinese characters not allowed)
          const encodedFilename = encodeURIComponent(tenantAssistantId)
          res.setHeader('Content-Type', 'application/zip')
          res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}.zip"; filename*=UTF-8''${encodedFilename}.zip`)
          res.end(zipBuffer)
        } catch (error) {
          throw new HttpError(404, `Failed to package assistant: ${error}`)
        }
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/skill-hub/categories') {
        authService.requireAnyScope(auth, ['admin:settings', 'store:read'])
        writeJson(res, 200, await fetchSkillHubCategories())
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/skill-hub/skills/cursor') {
        authService.requireAnyScope(auth, ['admin:settings', 'store:read'])
        const category =
          typeof url.searchParams.get('category') === 'string'
            ? url.searchParams.get('category') || ''
            : typeof url.searchParams.get('categories') === 'string'
              ? url.searchParams.get('categories') || ''
              : ''
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined

        writeJson(
          res,
          200,
          await fetchSkillHubSkills({
            cursor: url.searchParams.get('cursor') || undefined,
            limit: Number.isFinite(limit) ? limit : undefined,
            query: url.searchParams.get('query') || undefined,
            category: category || undefined,
            tenantId: url.searchParams.get('tenant_id') || undefined,
          }),
        )
        return
      }

      const skillHubDetailMatch = pathname.match(/^\/api\/v1\/skill-hub\/skills\/([^/]+)$/)
      if (req.method === 'GET' && skillHubDetailMatch) {
        authService.requireAnyScope(auth, ['admin:settings', 'store:read'])
        const skillId = decodeURIComponent(skillHubDetailMatch[1] || '')
        writeJson(res, 200, await fetchSkillHubSkillDetail(skillId))
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/skills/installed') {
        const filter = authService.buildVisibilityFilter(auth)
        // Scan all managed skill dirs (hub/system/custom/tenant), not just hub,
        // so tenant + custom skills are linkable by assistants and appear in the
        // Skills page's custom/local groups. Visibility is still enforced below.
        const all = await getInstalledSkills()
        writeJson(res, 200, all.filter(s => isVisibleTo(s.visibleTo, filter)))
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/skills/install') {
        authService.requireScope(auth, 'admin:settings')
        const body = await readJsonBody(req)
        const skillMeta = isJsonBody(body.skillMeta)
          ? (body.skillMeta as SkillHubSkill)
          : null
        writeJson(
          res,
          200,
          await installHubSkill({
            skillName: typeof body.skillName === 'string' ? body.skillName : '',
            sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl : '',
            version: typeof body.version === 'string' ? body.version : undefined,
            checksum:
              typeof body.checksum === 'string' ? body.checksum : undefined,
            skillMeta,
          }),
        )
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/skills/uninstall') {
        authService.requireScope(auth, 'admin:settings')
        const body = await readJsonBody(req)
        await uninstallSkill({
          skillName: typeof body.skillName === 'string' ? body.skillName : '',
          sourcePath:
            typeof body.sourcePath === 'string' ? body.sourcePath : undefined,
        })
        writeJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'PATCH' && pathname === '/api/v1/skills/enabled') {
        authService.requireScope(auth, 'admin:settings')
        const body = await readJsonBody(req)
        if (typeof body.enabled !== 'boolean') {
          throw new HttpError(400, 'enabled must be a boolean')
        }
        await setInstalledSkillEnabled({
          skillName: typeof body.skillName === 'string' ? body.skillName : '',
          enabled: body.enabled,
          sourcePath:
            typeof body.sourcePath === 'string' ? body.sourcePath : undefined,
        })
        writeJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/skills/import/archive') {
        authService.requireScope(auth, 'admin:settings')
        const body = await readJsonBody(req)
        writeJson(
          res,
          200,
          await importLocalSkillArchive({
            fileName: typeof body.fileName === 'string' ? body.fileName : '',
            archiveBase64:
              typeof body.archiveBase64 === 'string' ? body.archiveBase64 : '',
          }),
        )
        return
      }

      if (
        req.method === 'POST' &&
        pathname === '/api/v1/skills/import/directory'
      ) {
        authService.requireScope(auth, 'admin:settings')
        const body = await readJsonBody(req)
        const entries = Array.isArray(body.entries)
          ? body.entries
              .filter(isJsonBody)
              .map(entry => ({
                path: typeof entry.path === 'string' ? entry.path : '',
                contentBase64:
                  typeof entry.contentBase64 === 'string'
                    ? entry.contentBase64
                    : '',
              }))
              .filter(entry => entry.path && entry.contentBase64)
          : []
        writeJson(
          res,
          200,
          await importLocalSkillDirectory({
            entries,
          }),
        )
        return
      }

      if (req.method === 'PATCH' && pathname === '/api/v1/skills/visibility') {
        authService.requireScope(auth, 'admin:settings')
        const body = await readJsonBody(req)
        const skillName =
          typeof body.skillName === 'string' ? body.skillName : ''
        const visibleTo = body.visible_to ?? null
        await setInstalledSkillMeta(skillName, {
          visible_to: visibleTo as SkillStoreMeta['visible_to'],
        })
        writeJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/skills/sync-from-hub') {
        authService.requireScope(auth, 'admin:settings')
        if (getSkillSyncProgress().status === 'running') {
          writeJson(res, 409, { error: 'Sync already in progress' })
          return
        }
        const body = await readJsonBody(req)
        const tenantId =
          typeof body.tenantId === 'string' ? body.tenantId : undefined
        resetSkillSyncProgress()
        updateSkillSyncProgress({ status: 'running', startedAt: Date.now() })
        batchSyncSkills({
          tenantId,
          onProgress: (processed, total) => {
            updateSkillSyncProgress({ processed, total })
          },
        }).then(result => {
          updateSkillSyncProgress({
            status: 'done',
            total: result.installed.length + result.updated.length + result.skipped.length + result.failed.length,
            processed: result.installed.length + result.updated.length + result.skipped.length + result.failed.length,
            installed: result.installed.length,
            updated: result.updated.length,
            skipped: result.skipped.length,
            failed: result.failed.length,
          })
        }).catch(err => {
          updateSkillSyncProgress({ status: 'error', error: err instanceof Error ? err.message : String(err) })
        })
        writeJson(res, 200, { started: true })
        return
      }

      // backward compat alias
      if (req.method === 'POST' && pathname === '/api/v1/skills/sync') {
        authService.requireScope(auth, 'admin:settings')
        if (getSkillSyncProgress().status === 'running') {
          writeJson(res, 409, { error: 'Sync already in progress' })
          return
        }
        const body = await readJsonBody(req)
        const tenantId =
          typeof body.tenantId === 'string' ? body.tenantId : undefined
        resetSkillSyncProgress()
        updateSkillSyncProgress({ status: 'running', startedAt: Date.now() })
        batchSyncSkills({
          tenantId,
          onProgress: (processed, total) => {
            updateSkillSyncProgress({ processed, total })
          },
        }).then(result => {
          updateSkillSyncProgress({
            status: 'done',
            total: result.installed.length + result.updated.length + result.skipped.length + result.failed.length,
            processed: result.installed.length + result.updated.length + result.skipped.length + result.failed.length,
            installed: result.installed.length,
            updated: result.updated.length,
            skipped: result.skipped.length,
            failed: result.failed.length,
          })
        }).catch(err => {
          updateSkillSyncProgress({ status: 'error', error: err instanceof Error ? err.message : String(err) })
        })
        writeJson(res, 200, { started: true })
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/skills/sync-status') {
        authService.requireScope(auth, 'admin:settings')
        writeJson(res, 200, getSkillSyncProgress())
        return
      }

      // POST /api/v1/skills/custom - Upload custom skill
      if (req.method === 'POST' && pathname === '/api/v1/skills/custom') {
        const body = await readJsonBody(req)
        const fileBase64 = typeof body.file === 'string' ? body.file : ''
        const fileBuffer = Buffer.from(fileBase64, 'base64')
        const result = await uploadCustomSkill({
          file: fileBuffer,
          name: typeof body.name === 'string' ? body.name : '',
          displayName: typeof body.displayName === 'string' ? body.displayName : '',
          description: typeof body.description === 'string' ? body.description : undefined,
          version: typeof body.version === 'string' ? body.version : undefined,
          userId: auth.userId,
        })
        writeJson(res, 200, result)
        return
      }

      // GET /api/v1/skills/tenant - List tenant skills
      if (req.method === 'GET' && pathname === '/api/v1/skills/tenant') {
        const status = url.searchParams.get('status') || undefined
        const allRows = runtime.store.listTenantSkills(status, auth.orgId)
        // Filter by visibility for non-admin users
        const filter = authService.buildVisibilityFilter(auth)
        const isAdmin = hasScope(auth.scopes, 'admin:settings')
        const rows = allRows
          .filter((row: Record<string, unknown>) => {
            // A caller can always see items they may manage (author in scope),
            // even if the item's visibility wouldn't otherwise match — this is
            // the "or created by himself/subtree" clause of the spec.
            const canManage = authService.isCreatorInScope(auth.orgId, row.author_id as string, auth)
            if (row.status === 'pending') return isAdmin || canManage
            if (row.status === 'approved') {
              if (canManage) return true
              const visibleTo = typeof row.visible_to === 'string' ? JSON.parse(row.visible_to) : null
              return isVisibleTo(visibleTo, filter)
            }
            return canManage || isAdmin
          })
          .map((row: Record<string, unknown>) => ({
            ...row,
            // Parse visible_to so the approval page receives an object (matches
            // the /agents/tenant shape), not a raw JSON string.
            visible_to: typeof row.visible_to === 'string' ? JSON.parse(row.visible_to) : row.visible_to ?? null,
            // Lets the frontend show edit/delete without re-deriving subtree math.
            can_manage: isAdmin || authService.isCreatorInScope(auth.orgId, row.author_id as string, auth),
          }))
        writeJson(res, 200, rows)
        return
      }

      // GET /api/v1/skills/installed/:id/download - Download installed skill by ID
      const skillDownloadMatch = pathname.match(/^\/api\/v1\/skills\/installed\/([^/]+)\/download$/)
      if (req.method === 'GET' && skillDownloadMatch) {
        const skillId = decodeURIComponent(skillDownloadMatch[1] || '')
        try {
          // Find skill by ID in installed skills list
          const installedSkills = await getInstalledSkills()
          const skill = installedSkills.find(s => s.id === skillId)
          if (!skill) {
            throw new HttpError(404, `Skill not found: ${skillId}`)
          }
          // Use skill name for packaging (directory lookup)
          const zipBuffer = await packageSkillZip(skill.name)
          // Encode filename for Content-Disposition header (Chinese characters not allowed)
          const encodedFilename = encodeURIComponent(skillId)
          res.setHeader('Content-Type', 'application/zip')
          res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}.zip"; filename*=UTF-8''${encodedFilename}.zip`)
          res.end(zipBuffer)
        } catch (error) {
          if (error instanceof HttpError) throw error
          throw new HttpError(404, `Skill not found: ${skillId}`)
        }
        return
      }

      // POST /api/v1/skills/tenant/upload - Upload a tenant skill.
      // Admin → approved immediately (installed into the tenant dir). Non-admin →
      // pending: staged in the tenant-pending dir (invisible until approved),
      // visibility clamped to the publisher's scope.
      if (req.method === 'POST' && pathname === '/api/v1/skills/tenant/upload') {
        authService.requireAnyScope(auth, ['admin:settings', 'store:tenant:write'])
        const storeAdmin = isStoreAdmin(auth)
        const body = await readJsonBody(req)

        // Get author name from user info
        const authorUser = authService.getUserOrNull(auth.userId, auth.orgId, auth)
        const authorName = authorUser?.name || undefined
        // Visibility policy (same as agent create): admin as submitted;
        // dept_admin as submitted (default own dept when unset); normal user
        // ALWAYS self-only, enforced server-side (no picker; roster is admin-only).
        const skillStatus = storeAdmin ? 'approved' : 'pending'
        const requestedVisibleTo = storeAdmin
          ? (body.visible_to ?? null)
          : authService.isDeptAdmin(auth)
            ? (body.visible_to !== undefined
                ? body.visible_to
                : (authService.defaultTenantVisibility(auth) ?? null))
            : (authService.defaultTenantVisibility(auth) ?? null)
        const skillResponse = (result: unknown) =>
          storeAdmin
            ? result
            : { ...(result as Record<string, unknown>), status: 'pending', message: '发布申请已提交，等待管理员审批' }

        // Handle ZIP archive upload
        if (typeof body.archiveBase64 === 'string' && body.archiveBase64) {
          const result = await importTenantSkillArchive({
            fileName: typeof body.fileName === 'string' ? body.fileName : '',
            archiveBase64: body.archiveBase64,
            userId: auth.userId,
            authorName,
            pending: !storeAdmin,
          })

          runtime.store.createTenantSkill({
            id: result.id,
            name: result.skillName,
            display_name: result.displayName,
            description: result.description,
            version: result.version,
            author_id: auth.userId,
            author_name: authorName,
            status: skillStatus,
            enabled: 1,
            file_path: result.filePath,
            visible_to: requestedVisibleTo ? JSON.stringify(requestedVisibleTo) : null,
            org_id: auth.orgId,
          })

          writeJson(res, 200, skillResponse(result))
          return
        }

        // Handle directory upload
        if (Array.isArray(body.entries) && body.entries.length > 0) {
          const entries = body.entries
            .filter(isJsonBody)
            .map(entry => ({
              path: typeof entry.path === 'string' ? entry.path : '',
              contentBase64: typeof entry.contentBase64 === 'string' ? entry.contentBase64 : '',
            }))
            .filter(entry => entry.path && entry.contentBase64)

          const result = await importTenantSkillDirectory({
            entries,
            userId: auth.userId,
            authorName,
            pending: !storeAdmin,
          })

          runtime.store.createTenantSkill({
            id: result.id,
            name: result.skillName,
            display_name: result.displayName,
            description: result.description,
            version: result.version,
            author_id: auth.userId,
            author_name: authorName,
            status: skillStatus,
            enabled: 1,
            file_path: result.filePath,
            visible_to: requestedVisibleTo ? JSON.stringify(requestedVisibleTo) : null,
            org_id: auth.orgId,
          })

          writeJson(res, 200, skillResponse(result))
          return
        }

        throw new HttpError(400, 'Missing archiveBase64 or entries')
      }

      // POST /api/v1/skills/tenant/publish - Publish tenant skill request
      if (req.method === 'POST' && pathname === '/api/v1/skills/tenant/publish') {
        const body = await readJsonBody(req)
        const skillName = typeof body.skillName === 'string' ? body.skillName : ''
        const skillId = typeof body.skillId === 'string' ? body.skillId : skillName
        const publishNote = typeof body.publishNote === 'string' ? body.publishNote : undefined

        // Check if skill exists in custom directory
        const skillPath = await findInstalledSkillPath(skillId)
        if (!skillPath) {
          throw new HttpError(404, `Skill not found: ${skillId}`)
        }

        // Read skill metadata
        const meta = await readSkillMeta(skillPath)
        const version = await readSkillVersion(skillPath)
        const dirName = basename(skillPath)

        // Use actual skill name from metadata or directory name
        const actualSkillName = typeof meta?.name === 'string' && meta.name.trim() ? meta.name.trim() : dirName

        // Get author name from user info
        const authorUser = authService.getUserOrNull(auth.userId, auth.orgId, auth)
        const authorName = authorUser?.name || undefined

        // Create tenant skill record with metadata from source skill. Stamp the
        // publisher's default visibility (dept_admin → own department, user →
        // self) at publish time so it survives approval instead of defaulting to
        // global. Admins get null (global), unchanged.
        const publishVisibility = authService.defaultTenantVisibility(auth)
        const id = `tenant-skill-${Date.now()}`
        runtime.store.createTenantSkill({
          id,
          name: actualSkillName,
          display_name: meta?.display_name || actualSkillName,
          description: meta?.description || undefined,
          version: version || meta?.installed_version || undefined,
          publish_note: publishNote,
          author_id: auth.userId,
          author_name: authorName,
          status: 'pending',
          visible_to: publishVisibility ? JSON.stringify(publishVisibility) : null,
          org_id: auth.orgId,
        })
        writeJson(res, 200, { id, skillId, status: 'pending', message: '发布申请已提交，等待管理员审批' })
        return
      }

      // POST /api/v1/admin/skills/tenant/:id/approve - Approve tenant skill
      const skillApproveMatch = pathname.match(/^\/api\/v1\/admin\/skills\/tenant\/([^/]+)\/approve$/)
      if (req.method === 'POST' && skillApproveMatch) {
        authService.requireScope(auth, 'admin:settings')
        const tenantSkillId = decodeURIComponent(skillApproveMatch[1] || '')
        const body = await readJsonBody(req)
        const approved = body.approved === true
        const reviewNote = typeof body.reviewNote === 'string' ? body.reviewNote : undefined

        const tenantSkill = runtime.store.getTenantSkill(tenantSkillId)
        if (!tenantSkill) {
          throw new HttpError(404, `Tenant skill not found: ${tenantSkillId}`)
        }

        if (approved) {
          // Update status to approved
          runtime.store.updateTenantSkillStatus(tenantSkillId, 'approved', auth.userId, reviewNote)
          // Preserve the publisher's default visibility (dept/self) through
          // approval. An admin may still override it by passing visible_to in the
          // approve body; a record published before this change (no visible_to)
          // falls back to global (null), the prior behavior.
          if (body.visible_to !== undefined) {
            runtime.store.updateTenantSkillMeta(tenantSkillId, {
              visible_to: body.visible_to === null ? null : JSON.stringify(body.visible_to),
            })
          } else if (tenantSkill.visible_to == null) {
            runtime.store.updateTenantSkillMeta(tenantSkillId, { visible_to: null })
          }
          // Copy skill to tenant directory using the record's staged file_path
          // (tenant-pending for non-admin submissions), falling back to the
          // custom dir by name for legacy publish-from-custom records.
          const skillName = tenantSkill.name as string
          const sourcePath = typeof tenantSkill.file_path === 'string' ? tenantSkill.file_path : undefined
          await copySkillToTenantDir(skillName, sourcePath)
          // Point file_path at the tenant copy, and MOVE (remove the staged
          // source) for tenant-pending items so the skill lives only in tenant.
          const tenantSkillPath = join(MOSS_SKILLS_TENANT_DIR, skillName)
          runtime.store.updateTenantSkillFilePath(
            tenantSkillId,
            tenantSkillPath,
            typeof tenantSkill.source_url === 'string' ? tenantSkill.source_url : '',
            typeof tenantSkill.checksum === 'string' ? tenantSkill.checksum : '',
          )
          if (sourcePath && isInsideDir(MOSS_SKILLS_TENANT_PENDING_DIR, sourcePath) && existsSync(sourcePath)) {
            rmSync(sourcePath, { recursive: true, force: true })
          }
        } else {
          runtime.store.updateTenantSkillStatus(tenantSkillId, 'rejected', auth.userId, reviewNote)
          // Clean up staged files for a rejected non-admin submission.
          const sourcePath = typeof tenantSkill.file_path === 'string' ? tenantSkill.file_path : undefined
          if (sourcePath && isInsideDir(MOSS_SKILLS_TENANT_PENDING_DIR, sourcePath) && existsSync(sourcePath)) {
            rmSync(sourcePath, { recursive: true, force: true })
          }
        }

        writeJson(res, 200, { id: tenantSkillId, status: approved ? 'approved' : 'rejected' })
        return
      }

      // PATCH /api/v1/skills/tenant/:id - Update tenant skill meta
      const skillTenantPatchMatch = pathname.match(/^\/api\/v1\/skills\/tenant\/([^/]+)$/)
      if (req.method === 'PATCH' && skillTenantPatchMatch) {
        authService.requireAnyScope(auth, ['admin:settings', 'store:tenant:write'])
        const tenantSkillId = decodeURIComponent(skillTenantPatchMatch[1] || '')
        const existing = runtime.store.getTenantSkill(tenantSkillId)
        if (!existing) {
          throw new HttpError(404, `Tenant skill not found: ${tenantSkillId}`)
        }
        // Non-admins may only manage tenant skills authored by someone currently
        // in their scope (dept subtree for dept_admin, self for user), and only
        // within their own org.
        const skillStoreAdmin = isStoreAdmin(auth)
        if (!skillStoreAdmin) {
          if (existing.org_id != null && existing.org_id !== auth.orgId) {
            throw new HttpError(404, `Tenant skill not found: ${tenantSkillId}`)
          }
          if (!authService.isCreatorInScope(auth.orgId, existing.author_id as string, auth)) {
            throw new HttpError(403, 'You cannot manage this tenant skill')
          }
        }
        const body = await readJsonBody(req)

        const updates: { enabled?: number; visible_to?: string | null } = {}
        if (typeof body.enabled === 'boolean') {
          updates.enabled = body.enabled ? 1 : 0
        }
        if (body.visible_to !== undefined) {
          // A non-admin cannot widen visibility beyond their own scope: keep only
          // the in-scope ids they requested (out-of-scope admin-set ids are
          // dropped — the client warns first). Admins set it verbatim. This no
          // longer overwrites a legitimate in-scope choice with their default.
          const clamped = skillStoreAdmin
            ? (body.visible_to as VisibleTo)
            : authService.clampVisibleToScope(auth, body.visible_to as VisibleTo)
          updates.visible_to = clamped ? JSON.stringify(clamped) : null
        }

        runtime.store.updateTenantSkillMeta(tenantSkillId, updates)

        // Sync enabled/visible_to to file metadata
        const tenantSkill = runtime.store.getTenantSkill(tenantSkillId)
        if (tenantSkill && tenantSkill.status === 'approved') {
          const skillName = tenantSkill.name as string
          const skillDir = join(MOSS_SKILLS_TENANT_DIR, skillName)
          if (existsSync(skillDir)) {
            const meta = await readSkillMeta(skillDir)
            if (meta) {
              if (updates.enabled !== undefined) {
                meta.enabled = updates.enabled === 1
              }
              if (updates.visible_to !== undefined) {
                // Use the clamped value written to the DB, not the raw request,
                // so a non-admin can't push a wider visibility to the file meta.
                meta.visible_to = updates.visible_to ? JSON.parse(updates.visible_to) : null
              }
              await writeSkillMeta(skillDir, meta)
            }
          }
        }

        writeJson(res, 200, { ok: true })
        return
      }

      // DELETE /api/v1/skills/tenant/:id - Delete tenant skill
      if (req.method === 'DELETE' && skillTenantPatchMatch) {
        authService.requireAnyScope(auth, ['admin:settings', 'store:tenant:write'])
        const tenantSkillId = decodeURIComponent(skillTenantPatchMatch[1] || '')
        const tenantSkill = runtime.store.getTenantSkill(tenantSkillId)
        // Non-admins may only delete tenant skills authored by someone currently
        // in their scope, within their own org.
        if (tenantSkill && !isStoreAdmin(auth)) {
          if (tenantSkill.org_id != null && tenantSkill.org_id !== auth.orgId) {
            throw new HttpError(404, `Tenant skill not found: ${tenantSkillId}`)
          }
          if (!authService.isCreatorInScope(auth.orgId, tenantSkill.author_id as string, auth)) {
            throw new HttpError(403, 'You cannot manage this tenant skill')
          }
        }
        if (tenantSkill) {
          const skillName = tenantSkill.name as string
          // Delete from tenant directory if exists
          const skillDir = join(MOSS_SKILLS_TENANT_DIR, skillName)
          if (existsSync(skillDir)) {
            rmSync(skillDir, { recursive: true, force: true })
          }
        }
        runtime.store.deleteTenantSkill(tenantSkillId)
        writeJson(res, 200, { ok: true })
        return
      }

      // GET /api/v1/skills/tenant/:id/download - Download tenant skill
      const tenantSkillDownloadMatch = pathname.match(/^\/api\/v1\/skills\/tenant\/([^/]+)\/download$/)
      if (req.method === 'GET' && tenantSkillDownloadMatch) {
        const tenantSkillId = decodeURIComponent(tenantSkillDownloadMatch[1] || '')
        const tenantSkill = runtime.store.getTenantSkill(tenantSkillId)
        if (!tenantSkill || tenantSkill.status !== 'approved') {
          throw new HttpError(404, `Tenant skill not found or not approved: ${tenantSkillId}`)
        }
        // name is the actual skill name (e.g., "my-skill"), use it to find the directory
        const skillName = tenantSkill.name as string
        const skillPath = await findInstalledSkillPath(skillName)
        if (!skillPath) {
          throw new HttpError(404, `Skill not found: ${skillName}`)
        }
        try {
          const zipBuffer = await packageSkillZip(skillName)
          // Encode filename for Content-Disposition header (Chinese characters not allowed)
          const encodedFilename = encodeURIComponent(tenantSkillId)
          res.setHeader('Content-Type', 'application/zip')
          res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}.zip"; filename*=UTF-8''${encodedFilename}.zip`)
          res.end(zipBuffer)
        } catch (error) {
          throw new HttpError(404, `Failed to package skill: ${skillName}`)
        }
        return
      }

      if (pathname === '/api/v1/adapters/all') {
        authService.requireScope(auth, 'admin:settings')
        const rows = adaptersApi.listAll(auth.orgId)
        writeJson(res, 200, rows)
        return
      }

      if (pathname === '/api/v1/adapters') {
        const targetUserId = resolveAdapterTargetUserId(
          auth,
          authService,
          url.searchParams.get('userId'),
        )
        if (req.method === 'GET') {
          const result = adaptersApi.list(auth.orgId, targetUserId)
          writeJson(res, 200, result)
          return
        }
        if (req.method === 'PUT') {
          const body = await readJsonBody(req)
          const {
            platform: rawPlatform,
            userId: _ignoredUserId,
            ...patch
          } = body
          const platform =
            rawPlatform === 'feishu' ? 'feishu' : 'telegram'
          const result = adaptersApi.upsert(
            auth.orgId,
            targetUserId,
            platform,
            patch as Record<string, unknown>,
          )
          if ('error' in result) {
            writeJson(res, 400, result)
            return
          }
          writeJson(res, 200, result)
          return
        }
        throw new HttpError(405, `Method ${req.method} not allowed`)
      }

      // PUT /api/v1/adapters/:platform — platform-specific upsert
      const adapterPlatformMatch = pathname.match(/^\/api\/v1\/adapters\/(telegram|feishu)$/)
      if (adapterPlatformMatch) {
        const platform = adapterPlatformMatch[1]!
        const targetUserId = resolveAdapterTargetUserId(
          auth,
          authService,
          url.searchParams.get('userId'),
        )

        if (req.method === 'GET') {
          const result = adaptersApi.list(auth.orgId, targetUserId)
          writeJson(res, 200, result)
          return
        }
        if (req.method === 'PUT') {
          const body = await readJsonBody(req)
          const {
            userId: _ignoredUserId,
            platform: _ignoredPlatform,
            ...patch
          } = body
          const result = adaptersApi.upsert(
            auth.orgId,
            targetUserId,
            platform,
            patch as Record<string, unknown>,
          )
          if ('error' in result) {
            writeJson(res, 400, result)
            return
          }
          writeJson(res, 200, result)
          return
        }
        if (req.method === 'DELETE') {
          const result = adaptersApi.remove(auth.orgId, targetUserId, platform)
          writeJson(res, 200, result)
          return
        }
        throw new HttpError(405, `Method ${req.method} not allowed`)
      }

      if (pathname === '/api/v1/adapters/processes') {
        const targetUserId = resolveAdapterTargetUserId(
          auth,
          authService,
          url.searchParams.get('userId'),
        )
        writeJson(
          res,
          200,
          listAdapterProcessStatusesForUser(auth.orgId, targetUserId),
        )
        return
      }

      if (pathname === '/api/v1/adapters/processes/restart' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const adapter = typeof body.adapter === 'string' ? body.adapter : ''
        const userId = resolveAdapterTargetUserId(
          auth,
          authService,
          typeof body.userId === 'string' ? body.userId : undefined,
        )
        if (adapter !== 'telegram' && adapter !== 'feishu') {
          throw new HttpError(400, 'Invalid adapter name, must be "telegram" or "feishu"')
        }
        await adapterProcessManager.restart(adapter as 'telegram' | 'feishu', auth.orgId, userId)
        writeJson(res, 200, { ok: true })
        return
      }

      if (pathname === '/api/v1/adapters/processes/start' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const adapter = typeof body.adapter === 'string' ? body.adapter : ''
        const userId = resolveAdapterTargetUserId(
          auth,
          authService,
          typeof body.userId === 'string' ? body.userId : undefined,
        )
        if (adapter !== 'telegram' && adapter !== 'feishu') {
          throw new HttpError(400, 'Invalid adapter name, must be "telegram" or "feishu"')
        }
        await adapterProcessManager.start(adapter as 'telegram' | 'feishu', auth.orgId, userId)
        writeJson(res, 200, { ok: true })
        return
      }

      if (pathname === '/api/v1/adapters/processes/stop' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const adapter = typeof body.adapter === 'string' ? body.adapter : ''
        const userId = resolveAdapterTargetUserId(
          auth,
          authService,
          typeof body.userId === 'string' ? body.userId : undefined,
        )
        if (adapter !== 'telegram' && adapter !== 'feishu') {
          throw new HttpError(400, 'Invalid adapter name, must be "telegram" or "feishu"')
        }
        await adapterProcessManager.stop(adapter as 'telegram' | 'feishu', auth.orgId, userId)
        writeJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/sessions') {
        authService.requireAnyScope(auth, ['sessions:list', 'sessions:list:any'])
        const activeOnly = url.searchParams.get('active_only') === 'true'
        const source = url.searchParams.get('source') || undefined
        // Visibility tiers: sessions:list:any → whole org; a dept_admin →
        // sessions of every user in their department subtree (self + descendants,
        // dept_admins included); everyone else → their own only.
        const sessionSubtree = hasScope(auth.scopes, 'sessions:list:any')
          ? null
          : authService.listSubtreeUserIds(auth.orgId, auth)
        let sessions: ReturnType<typeof runtime.listSessions>
        if (hasScope(auth.scopes, 'sessions:list:any')) {
          sessions = runtime.listSessions({ orgId: auth.orgId, activeOnly })
        } else if (sessionSubtree && sessionSubtree.size > 1) {
          // dept_admin: list the whole org, then narrow to the subtree set.
          sessions = runtime
            .listSessions({ orgId: auth.orgId, activeOnly })
            .filter(session => sessionSubtree.has(session.userId))
        } else {
          sessions = runtime.listSessions({ orgId: auth.orgId, userId: auth.userId, activeOnly })
        }

        // Filter by source if provided
        if (source) {
          sessions = sessions.filter(session => {
            if (!session.source) return false
            try {
              const sourceData = JSON.parse(session.source)
              return sourceData.source === source
            } catch {
              return session.source === source
            }
          })
        }

        // Attach an org-agnostic owner name so the admin UI can display owners
        // outside this org's roster (e.g. a switched super_admin) by name.
        const resolveName = makeUserNameResolver(resolveUserName)
        const sessionsWithOwner = sessions.map(session => ({
          ...session,
          userName: resolveName(session.userId),
        }))

        writeJson(res, 200, { sessions: sessionsWithOwner })
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/dashboard/stats') {
        authService.requireAnyScope(auth, ['sessions:list', 'sessions:list:any'])
        const from = parseOptionalTimestampQuery(
          url.searchParams.get('from'),
          'from',
        )
        const to = parseOptionalTimestampQuery(url.searchParams.get('to'), 'to')
        if (from !== null && to !== null && from > to) {
          throw new HttpError(400, 'Invalid dashboard stats range')
        }

        const sessions = runtime
          .listSessionRecords({
            orgId: auth.orgId,
            userId: hasScope(auth.scopes, 'sessions:list:any')
              ? undefined
              : auth.userId,
          })
          .filter(session => {
            if (from !== null && session.createdAt < from) {
              return false
            }
            if (to !== null && session.createdAt > to) {
              return false
            }
            return true
          })

        const stats = await loadDashboardStats(sessions)
        writeJson(res, 200, stats)
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/budget/stats') {
        authService.requireAnyScope(auth, ['sessions:list', 'sessions:list:any'])
        // Same visibility tiers as the session list: org-wide, dept subtree, or
        // own only. Budget is derived from sessions, so it follows the same rule.
        const budgetSubtree = hasScope(auth.scopes, 'sessions:list:any')
          ? null
          : authService.listSubtreeUserIds(auth.orgId, auth)
        let sessions: ReturnType<typeof runtime.listSessionRecords>
        if (hasScope(auth.scopes, 'sessions:list:any')) {
          sessions = runtime.listSessionRecords({ orgId: auth.orgId })
        } else if (budgetSubtree && budgetSubtree.size > 1) {
          sessions = runtime
            .listSessionRecords({ orgId: auth.orgId })
            .filter(session => budgetSubtree.has(session.userId))
        } else {
          sessions = runtime.listSessionRecords({ orgId: auth.orgId, userId: auth.userId })
        }

        const stats = await loadBudgetStats(sessions)
        // Attach an org-agnostic owner name per user row so the page shows names
        // without depending on the admin:users roster (a normal user / dept_admin
        // may lack it, which otherwise fell back to a raw UUID).
        const resolveName = makeUserNameResolver(resolveUserName)
        const statsWithNames = {
          ...stats,
          users: stats.users.map(u => ({ ...u, userName: resolveName(u.userId) })),
        }
        writeJson(res, 200, statsWithNames)
        return
      }

      const sessionContextMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/context$/)
      if (req.method === 'GET' && sessionContextMatch) {
        const sessionId = sessionContextMatch[1] || ''
        const session = runtime.getSession(sessionId)
        if (!session) {
          throw new HttpError(404, 'Session not found')
        }
        if (!canAccessSession(auth, session, 'sessions:attach:any')) {
          throw new HttpError(403, 'Forbidden')
        }
        const context = await loadSessionContextFromTranscript(session)
        if (!context) {
          throw new HttpError(404, 'Session context not found')
        }
        writeJson(res, 200, {
          session: {
            ...serializeSession(session),
            userName: resolveUserName(session.userId),
          },
          usage: context.usage,
          context: {
            customTitle: context.customTitle,
            tag: context.tag,
            summary: context.summary,
            messages: context.messages,
          },
        })
        return
      }

      const sessionResumeMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/resume$/)
      if (req.method === 'POST' && sessionResumeMatch) {
        const sessionId = sessionResumeMatch[1] || ''
        const session = runtime.getSession(sessionId)
        if (!session) {
          throw new HttpError(404, 'Session not found')
        }
        if (!canAccessSession(auth, session, 'sessions:attach:any')) {
          throw new HttpError(403, 'Forbidden')
        }
        const ready = await runtime.ensureSessionReady(sessionId)
        writeJson(res, 200, {
          session: serializeSession(ready.session),
          ws_url: buildWsUrl(server, config, sessionId),
        })
        return
      }

      const sessionTerminateMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/terminate$/)
      if (req.method === 'POST' && sessionTerminateMatch) {
        const sessionId = sessionTerminateMatch[1] || ''
        const session = runtime.getSession(sessionId)
        if (!session) {
          throw new HttpError(404, 'Session not found')
        }
        if (!canAccessSession(auth, session, 'sessions:terminate:any')) {
          throw new HttpError(403, 'Forbidden')
        }
        await runtime.terminateSession(sessionId)
        writeJson(res, 200, { ok: true })
        return
      }

      const sessionWorkspaceTreeMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/workspace\/tree$/)
      if (req.method === 'GET' && sessionWorkspaceTreeMatch) {
        const sessionId = sessionWorkspaceTreeMatch[1] || ''
        const session = runtime.getSession(sessionId)
        if (!session) throw new HttpError(404, 'Session not found')
        if (!canAccessSession(auth, session, 'sessions:attach:any')) {
          throw new HttpError(403, 'Forbidden')
        }
        const root = await readWorkspaceTree(session, {
          path: url.searchParams.get('path'),
          search: url.searchParams.get('search'),
        })
        writeJson(res, 200, { root })
        return
      }

      const sessionWorkspaceFileMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/workspace\/file$/)
      if (req.method === 'GET' && sessionWorkspaceFileMatch) {
        const sessionId = sessionWorkspaceFileMatch[1] || ''
        const session = runtime.getSession(sessionId)
        if (!session) throw new HttpError(404, 'Session not found')
        if (!canAccessSession(auth, session, 'sessions:attach:any')) {
          throw new HttpError(403, 'Forbidden')
        }
        writeJson(res, 200, await readWorkspaceFilePreview(session, url.searchParams.get('path')))
        return
      }

      if (req.method === 'POST' && sessionWorkspaceFileMatch) {
        const sessionId = sessionWorkspaceFileMatch[1] || ''
        const session = runtime.getSession(sessionId)
        if (!session) throw new HttpError(404, 'Session not found')
        if (!canAccessSession(auth, session, 'sessions:attach:any')) {
          throw new HttpError(403, 'Forbidden')
        }
        const body = await readJsonBody(req)
        const result = await writeWorkspaceFile(session, {
          path: typeof body.path === 'string' ? body.path : null,
          contentBase64: typeof body.content_base64 === 'string' ? body.content_base64 : null,
        })
        writeJson(res, 200, result)
        return
      }

      const sessionAvailableSkillsMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/skills\/available$/)
      if (req.method === 'GET' && sessionAvailableSkillsMatch) {
        const sessionId = sessionAvailableSkillsMatch[1] || ''
        const session = runtime.getSession(sessionId)
        if (!session) throw new HttpError(404, 'Session not found')
        if (!canAccessSession(auth, session, 'sessions:attach:any')) {
          throw new HttpError(403, 'Forbidden')
        }
        writeJson(res, 200, { skills: getSessionAvailableSkills(runtime, sessionId) })
        return
      }

      const sessionIdMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/)
      if (req.method === 'GET' && sessionIdMatch) {
        const sessionId = sessionIdMatch[1] || ''
        const session = runtime.getSession(sessionId)
        if (!session) {
          throw new HttpError(404, 'Session not found')
        }
        if (!canAccessSession(auth, session, 'sessions:attach:any')) {
          throw new HttpError(403, 'Forbidden')
        }
        // Non-blocking: if the runtime is dead we kick off the respawn in the
        // background and return immediately, so opening an old session never
        // hangs on a cold Docker container start. The client connects via
        // ws_url and sees status flip to 'active' once the runtime is back.
        const ready =
          session.desiredState === 'active'
            ? await runtime.ensureSessionReadyNonBlocking(sessionId)
            : { session }
        writeJson(res, 200, {
          session: serializeSession(ready.session),
          ws_url: buildWsUrl(server, config, ready.session.sessionId),
        })
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/sessions') {
        authService.requireScope(auth, 'sessions:create')
        const body = await readJsonBody(req)
        const normalizeCwd = (p: string) => p === '/' ? os.homedir() : p
        const requestedCwd =
          typeof body.cwd === 'string' && body.cwd.trim()
            ? body.cwd
            : config.workspace
        const cwd = requestedCwd && existsSync(requestedCwd) ? normalizeCwd(requestedCwd) : undefined
        const dangerouslySkipPermissions =
          body.dangerously_skip_permissions === true
        const runtimeOptions = parseRuntimeOptions(body)
        const rawAssistantName =
          typeof body.assistant_name === 'string' && body.assistant_name.trim()
            ? body.assistant_name.trim()
            : undefined

        // Resolve agent display name from UUID or name.
        // The assistant_name from client may be a UUID; the runtime injects this
        // string verbatim as the agent identity, so we resolve it to the display
        // name (shared with the cron path via resolveAssistantDisplayName).
        const assistantDisplayName = rawAssistantName
          ? await resolveAssistantDisplayName(rawAssistantName)
          : rawAssistantName

        const created = await runtime.createSession({
          cwd,
          dangerouslySkipPermissions,
          userId: auth.userId,
          orgId: auth.orgId,
          role: auth.role,
          scopes: auth.scopes,
          runtime: runtimeOptions,
          assistantName: assistantDisplayName,
          // 新增: 从请求体获取 enabled_skills
          enabledSkills: Array.isArray(body.enabled_skills)
            ? body.enabled_skills.filter((s: unknown) => typeof s === 'string')
            : undefined,
        })
        writeJson(res, 200, {
          session_id: created.sessionId,
          ws_url: buildWsUrl(server, config, created.sessionId),
          work_dir: created.cwd,
          runtime: created.runtime,
        })
        return
      }

      throw new HttpError(404, 'Not found')
    } catch (error) {
      writeError(logger, res, error)
    }
  })

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      try {
        process.stderr.write(`[WS Upgrade] Incoming request: ${req.url}\n`)
        let token = getBearerToken(req)
        let auth = token ? authService.verifyAccessToken(token) : null

        // If access_token is expired, try refreshing with refresh_token from query param
        if (token && !auth) {
          const url = new URL(req.url || '/', 'http://localhost')
          const refreshToken = url.searchParams.get('refresh_token')
          if (refreshToken) {
            try {
              const refreshed = authService.refreshToken(refreshToken)
              auth = authService.verifyAccessToken(refreshed.access_token)
              if (auth) {
                token = refreshed.access_token
                process.stderr.write(`[WS Upgrade] Token refreshed successfully for user: ${auth.userId}\n`)
              }
            } catch (refreshError) {
              process.stderr.write(`[WS Upgrade] Token refresh failed: ${refreshError}\n`)
            }
          }
        }

        if (!auth) {
          process.stderr.write(`[WS Upgrade Auth Failed v2] Token: ${token ? (token.slice(0, 10) + '...') : 'MISSING'}, URL: ${req.url}\n`)
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }

        if (!isUserActive(auth.userId, authService)) {
          process.stderr.write(`[WS Upgrade] User ${auth.userId} is disabled\n`)
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }

        process.stderr.write(`[WS Upgrade Auth Success v2] User: ${auth.userId}, Org: ${auth.orgId}\n`)

        const url = new URL(req.url || '/', 'http://localhost')
        const pathname = url.pathname

        // Handle /ws/sessions/:sessionId for session WebSocket
        const match = pathname.match(/^\/ws\/sessions\/([^/]+)$/)
        if (!match) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
          socket.destroy()
          return
        }

        const sessionId = match[1] || ''
        const session = runtime.getSession(sessionId)
        if (!session) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
          socket.destroy()
          return
        }
        if (!canAccessSession(auth, session, 'sessions:attach:any')) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
          socket.destroy()
          return
        }

        const ready = await runtime.ensureSessionReady(sessionId)
        wss.handleUpgrade(req, socket, head, ws => {
          void runtime.connectToAttempt(ready.attempt).then((runnerSocket: net.Socket) => {
            let buffer = ''
            const sendToRunner = (payload: Record<string, unknown>) => {
              if (!runnerSocket.destroyed) {
                process.stderr.write(`[WS Message] Sending to runner: ${JSON.stringify(payload).slice(0, 200)}...\n`)
                runnerSocket.write(`${jsonStringify(payload)}\n`)
              } else {
                process.stderr.write(`[WS Message] Runner socket destroyed, cannot send\n`)
              }
            }

            ws.on('message', data => {
              const text =
                typeof data === 'string'
                  ? data
                  : Buffer.from(data).toString('utf8')
              process.stderr.write(`[WS Message] Received: ${text.slice(0, 200)}...\n`)
              sendToRunner({
                type: 'stdin',
                data: text.endsWith('\n') ? text : `${text}\n`,
              })
            })
            ws.on('close', () => {
              runnerSocket.destroy()
            })
            ws.on('error', () => {
              runnerSocket.destroy()
            })

            runnerSocket.on('data', chunk => {
              buffer += Buffer.from(chunk).toString('utf8')
              while (true) {
                const idx = buffer.indexOf('\n')
                if (idx < 0) {
                  break
                }
                const line = buffer.slice(0, idx)
                buffer = buffer.slice(idx + 1)
                if (!line.trim()) {
                  continue
                }

                let parsed: { type?: string; line?: string }
                try {
                  parsed = jsonParse(line) as { type?: string; line?: string }
                } catch {
                  continue
                }

                if (parsed.type === 'stdout' && typeof parsed.line === 'string') {
                  if (ws.readyState === ws.OPEN) {
                    ws.send(parsed.line)
                  }
                }
                if (parsed.type === 'exit') {
                  ws.close()
                }
              }
            })

            runnerSocket.on('close', () => {
              if (ws.readyState === ws.OPEN) {
                ws.close()
              }
            })
            runnerSocket.on('error', () => {
              if (ws.readyState === ws.OPEN) {
                ws.close()
              }
            })

            wss.emit('connection', ws, req)
          }).catch(error => {
            logger.error(error instanceof Error ? error.message : String(error))
            ws.close()
          })
        })
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error))
        socket.destroy()
      }
    })()
  })

  const ready = new Promise<number | null>((resolvePort, reject) => {
    const onError = (error: Error) => {
      logger.error(error.message)
      reject(error)
    }
    server.once('error', onError)
    server.once('listening', () => {
      server.off('error', onError)
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      // Document Center v2: export MOSS_SERVER_URL into process.env so
      // every scode child process spawned by RuntimeService inherits it.
      // wiki CLI requires this env var to know where to call back to.
      // Use 127.0.0.1 so it works in local/dev; production deployments
      // can override via MOSS_SERVER_URL env before launching moss-server.
      if (!process.env.MOSS_SERVER_URL && port) {
        const host = config.host && config.host !== '0.0.0.0' ? config.host : '127.0.0.1'
        process.env.MOSS_SERVER_URL = `http://${host}:${port}`
        console.log(`[server] MOSS_SERVER_URL set to ${process.env.MOSS_SERVER_URL} for scode children`)
      }
      resolvePort(port)
    })
  })

  server.listen(config.port, config.host)

  // ============================================================
  // 企业应用管理: PUBLIC corp-app callback listener (separate port)
  // ------------------------------------------------------------
  // External platforms (WeCom etc.) push events to a callback URL. This
  // runs on a DEDICATED port and serves ONLY /api/v1/corp-apps/callback/:id
  // — it never touches the admin/API/auth routing, so external traffic
  // to this port physically cannot reach admin endpoints. Anything else
  // is 404. Disabled when no callback port is configured.
  // ============================================================
  const callbackPort = config.callbackPort ?? Number(process.env.MOSS_CALLBACK_PORT ?? 0)
  let callbackServer: http.Server | null = null
  if (callbackPort && Number.isFinite(callbackPort) && callbackPort > 0) {
    callbackServer = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://localhost')
        const m = url.pathname.match(/^\/api\/v1\/corp-apps\/callback\/([^/]+)$/)
        if (!m) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('not found')
          return
        }
        const id = m[1] || ''
        const row = runtime.store.getCorpAppById(id) as Record<string, unknown> | null
        if (!row) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('not found')
          return
        }

        // Build + init the connector (resolve its credentials).
        const { createCorpApp } = await import('./corpapps/types.js')
        const { readSecret } = await import('./sources/secrets.js')
        const cfg = JSON.parse(String(row.config_json ?? '{}')) as Record<string, unknown>
        const creds =
          typeof row.credentials_secret_key === 'string' && row.credentials_secret_key
            ? await readSecret(row.credentials_secret_key)
            : {}
        const connector = createCorpApp(String(row.type))
        await connector.init(cfg, creds)

        const msgSignature = url.searchParams.get('msg_signature') ?? ''
        const timestamp = url.searchParams.get('timestamp') ?? ''
        const nonce = url.searchParams.get('nonce') ?? ''

        // GET → URL verification handshake (echo back decrypted echostr).
        if (req.method === 'GET') {
          const echostr = url.searchParams.get('echostr') ?? ''
          if (!connector.verifyCallbackUrl) {
            res.writeHead(501, { 'Content-Type': 'text/plain' })
            res.end('not supported')
            return
          }
          const plain = await connector.verifyCallbackUrl({ msgSignature, timestamp, nonce, echostr })
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end(plain)
          return
        }

        // POST → inbound event. Verify + decrypt + persist, reply empty 200.
        if (req.method === 'POST') {
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const bodyText = Buffer.concat(chunks).toString('utf8')
          if (connector.parseInboundCallback) {
            try {
              const messages = await connector.parseInboundCallback({
                msgSignature,
                timestamp,
                nonce,
                body: bodyText,
              })
              for (const msg of messages) {
                runtime.store.appendCorpAppInbound({
                  corp_app_id: id,
                  org_id: String(row.org_id),
                  from_user: msg.from,
                  msg_type: msg.type,
                  text: msg.text ?? null,
                  media_id: msg.mediaId ?? null,
                  file_name: msg.fileName ?? null,
                  received_at: msg.receivedAt,
                  payload_json: JSON.stringify(msg),
                })
              }
            } catch (err) {
              console.error('[corp-app callback] parse failed:', err)
              // Still reply 200 so the platform doesn't hammer retries.
            }
          }
          // WeCom expects a fast empty 200 (passive reply not implemented).
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('')
          return
        }

        res.writeHead(405, { 'Content-Type': 'text/plain' })
        res.end('method not allowed')
      } catch (err) {
        console.error('[corp-app callback] error:', err)
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('')
      }
    })
    callbackServer.on('error', (err) => {
      logger.error(`[corp-app callback] listener error: ${err.message}`)
    })
    callbackServer.listen(callbackPort, config.host, () => {
      console.log(`[server] corp-app callback listener on ${config.host}:${callbackPort} (public; callback route only)`)
    })
  }

  return {
    port: null,
    ready,
    stop: async () => {
      wikiJobExecutor.stop()
      sourceSyncWorker.stop()
      cronService.stop()
      cabinFlightAutomation?.stop()
      wss.close()
      if (callbackServer) {
        await new Promise<void>((resolveClose) => {
          callbackServer!.close(() => resolveClose())
        })
      }
      await new Promise<void>((resolveClose, reject) => {
        server.close(error => {
          if (error) {
            reject(error)
          } else {
            resolveClose()
          }
        })
      })
    },
  }
}
