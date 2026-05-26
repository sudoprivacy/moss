import http from 'http'
import { randomUUID } from 'crypto'
import net from 'net'
import { existsSync, cpSync, rmSync } from 'fs'
import { readFile, stat, mkdir, writeFile, readdir } from 'fs/promises'
import os from 'os'
import { basename, dirname, extname, join, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import type { ServerConfig, SessionRecord } from './types.js'
import { createServerLogger, type ServerLogger } from './serverLog.js'
import { hasScope, type AuthContext } from './auth/token.js'
import { AuthService, AuthServiceError } from './auth/service.js'
import { isUserActive, invalidateUserStatusCache } from './auth/userStatusCache.js'
import { RuntimeService } from './runtimeService.js'
import { getSystemSettings, updateSystemSettings } from './systemSettings.js'
import {
  createCustomAssistant,
  fetchAgentHubAssistantDetail,
  fetchAgentHubAssistants,
  fetchAgentHubCategories,
  fetchAgentHubSkillDetailsByIds,
  getInstalledAssistants,
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
import { SourceSyncWorker } from './sources/syncWorker.js'
import { storeSecret, deleteSecret } from './sources/secrets.js'
// Connector implementations register themselves on import.
import './sources/filesystem.js'
import './sources/wecomDrive.js'
import { getUserProfile } from './api/userProfile.js'
import { createConfigItemsApi } from './api/configItems.js'
import { createSecretsApi } from './api/secrets.js'
import { createCronApi } from './api/cron.js'
import { CronService } from './services/cron/CronService.js'
import type { NexusClient } from './nexus/nexusClient.js'
import { loadBudgetStats } from './budgetStats.js'
import { loadDashboardStats } from './dashboardStats.js'
import { loadSessionContextFromTranscript } from './transcript.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { isVisibleTo, type VisibleTo } from './visibilityFilter.js'
import { MOSS_SKILLS_CUSTOM_DIR, MOSS_SKILLS_TENANT_DIR } from '../utils/skills/localSkillDirectories.js'
import { DocumentStore } from './documentStore.js'
import {
  getUserModelPreference,
  setUserModelPreference,
  initUserModelPreferenceStore,
} from './userModelPreference.js'
import { getAvailableModels, getCacheStatus, refreshModelCache } from './modelListCache.js'

type JsonBody = Record<string, unknown>

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
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

async function copySkillToTenantDir(skillName: string): Promise<void> {
  const sourceDir = join(MOSS_SKILLS_CUSTOM_DIR, skillName)
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

  // Copy the assistant directory
  cpSync(sourceDir, targetDir, { recursive: true })

  // Update metadata to set source_type to 'tenant'
  const meta = await readAssistantMeta(targetDir)
  if (meta) {
    meta.source_type = 'tenant'
    await writeAssistantMeta(targetDir, meta)
  }
}

/**
 * Copy assistant to tenant directory by source path
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

  // Copy the assistant directory
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
 *   - Only copies dirs that don't already exist on disk (so client edits
 *     to `wiki-builder.md` etc. survive server restarts).
 *   - Source dir search order: cwd/assistants → server-bundle-relative
 *     ../assistants → ../../assistants. Allows both dev (cwd in repo root)
 *     and packaged (`bin/moss-server.mjs` + `assistants/` next to it)
 *     deployments to find the source.
 *   - Best-effort: failures log a warning but never abort startup.
 */
async function seedBuiltinSystemAssistants(): Promise<void> {
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
  let skipped = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sourceDir = join(sourceRoot, entry.name)
    const targetDir = join(systemDir, entry.name)
    if (existsSync(targetDir)) {
      skipped++
      continue
    }
    try {
      cpSync(sourceDir, targetDir, { recursive: true })
      seeded++
    } catch (err) {
      console.warn(`[seedBuiltinSystemAssistants] copy failed for ${entry.name}:`, err)
    }
  }
  if (seeded > 0 || skipped > 0) {
    console.log(
      `[seedBuiltinSystemAssistants] seeded ${seeded} new, ${skipped} already present at ${systemDir}`,
    )
  }
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id')
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
  const enterpriseApi = createEnterpriseApi(runtime.store, config.runtimeDir)
  const configItemsApi = createConfigItemsApi(runtime.store)
  const secretsApi = nexusClient ? createSecretsApi(runtime.store, nexusClient, (userId: string) => {
    try {
      return authService.getUserName(userId)
    } catch { return undefined }
  }) : null

  // Cron Service - scheduled task execution engine
  const cronService = new CronService(runtime.store.db, {
    runtimeService: runtime,
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

  // Cron API - for scheduled tasks management
  const cronApi = createCronApi(runtime.store.db, { cronService })

  function refreshAuthProxyRules() {
    const ap = runtime.authProxy
    if (!ap) return
    const items = runtime.store.getAllActiveConfigItems()
    ap.updateRules(items.map(item => ({
      configItemId: item.id as number,
      name: item.name as string,
      urlPattern: (item.url_pattern as string) || '',
      scheme: (item.scheme as string) || '',
      bearerPrefix: (item.bearer_prefix as string) || '',
      secretNamespace: item.scope === 'user' ? `user:{userId}:${item.pinyin}` : `system:${item.pinyin}`,
      entries: (runtime.store.getConfigEntries(item.id as number) || []).map((e: any) => ({
        configKey: e.config_key as string,
        name: e.name as string,
        required: (e.required as number) === 1,
      })),
    })))
  }

  const documentStore = new DocumentStore(runtime.store)

  // Initialize user model preference store with the database
  initUserModelPreferenceStore(runtime.store.db)

  // Document Center v2: seed builtin system assistants (wiki-builder etc.)
  // from the repo into $MOSS_HOME/assistants/system/ if not already present.
  // Customers can override by editing files in place — subsequent boots
  // skip existing dirs. Fire-and-forget (best-effort) — boot must not
  // block on this, and failures don't affect server health.
  seedBuiltinSystemAssistants().catch((err) => {
    console.warn('[seedBuiltinSystemAssistants] background seed failed:', err)
  })

  // Boot-time settings.json sanity check — warns if model/url/apiKey
  // are missing so the operator doesn't discover it the hard way
  // (wiki builds hanging silently for minutes).
  checkSettingsOnBoot()

  // Document Center: start the wiki build worker. Polls wiki_build_jobs
  // and runs each queued job through RuntimeService with the system
  // `wiki-builder` assistant.
  const wikiJobExecutor = new WikiJobExecutor(runtime, documentStore, runtime.store)
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
      // pick it up on its next tick. Only fires when the source has
      // auto_build_enabled = 1.
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

  const channelsApi = createChannelsApi(runtime.store)

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const pathname = url.pathname
      const isHead = req.method === 'HEAD'

      // Handle CORS preflight for all API routes
      if (pathname.startsWith('/api/') && handleCorsPreflight(req, res)) {
        return
      }

      // Set CORS headers for all API routes (non-preflight)
      if (pathname.startsWith('/api/')) {
        setCorsHeaders(req, res)
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
        writeJson(res, 200, { enabled: true, authorize_url: authorizeUrl })
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

      // Public: Config Items (JWT auth, no admin scope)
      if (req.method === 'GET' && pathname === '/api/v1/config/items') {
        const auth = authenticateRequest(req, authService)
        if (!auth) throw new HttpError(401, 'Unauthorized')
        writeJson(res, 200, configItemsApi.listPublic())
        return
      }

      // Document Center v2: SSE build-events route accepts ?token=xxx as
      // a fallback because browser EventSource can't send custom headers.
      // Scope: only this single route; getBearerToken stays header-only
      // everywhere else.
      let auth = authenticateRequest(req, authService)
      if (!auth && req.method === 'GET') {
        const isSseBuildEvents = /^\/api\/v1\/wikis\/[^/]+\/build-events$/.test(pathname)
        if (isSseBuildEvents) {
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
          }),
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
          }),
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
          }),
        )
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
        // v2: auto_managed nodes can only be removed by deleting the
        // source or by sync's reverse-sweep. Admins delete the SOURCE,
        // not individual mirrored nodes.
        const existing = documentStore.getNode(nodeId, auth.orgId)
        if (existing?.autoManaged) {
          writeJson(res, 400, {
            error: {
              code: 'auto_managed',
              message: '该节点由外部数据源管理,无法直接删除。请在「外部数据源」中删除整个源,或在源系统中删除原文件后等待同步。',
            },
          })
          return
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
        writeJson(res, 200, { documents: documentStore.listDocumentsForNode(nodeId, auth.orgId) })
        return
      }

      if (req.method === 'POST' && documentsByNodeMatch) {
        authService.requireScope(auth, 'admin:documents')
        const nodeId = documentsByNodeMatch[1] || ''
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
          wikis: documentStore.listWikis(auth.orgId, {
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
        const sourceDocumentIds = Array.isArray(body.source_document_ids)
          ? body.source_document_ids.filter((v: unknown) => typeof v === 'string')
          : []
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
        const wiki = documentStore.getWiki(wikiId, auth.orgId)
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
            sourceDocumentIds: Array.isArray(body.source_document_ids)
              ? body.source_document_ids.filter((v: unknown) => typeof v === 'string')
              : undefined,
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
        const existing = runtime.store.getExternalSource(id, auth.orgId)
        if (existing) {
          const oldKey = (existing as Record<string, unknown>).credentials_secret_key
          if (typeof oldKey === 'string' && oldKey) {
            await deleteSecret(oldKey).catch(() => {})
          }
          runtime.store.deleteExternalSource(id, auth.orgId)
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
          const content = await readFile(resolved, 'utf-8')
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
        // P0: simple grep across .md files in wiki dir
        try {
          const entries = await readdir(wiki.storagePath, { withFileTypes: true })
          const matches: Array<{ file: string; line_no: number; line: string }> = []
          const qLower = query.toLowerCase()
          for (const e of entries) {
            if (!e.isFile() || !e.name.endsWith('.md')) continue
            const content = await readFile(resolve(wiki.storagePath, e.name), 'utf-8')
            const lines = content.split(/\r?\n/)
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(qLower)) {
                matches.push({ file: e.name, line_no: i + 1, line: lines[i] })
                if (matches.length >= 100) break
              }
            }
            if (matches.length >= 100) break
          }
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

      if (req.method === 'GET' && pathname === '/api/v1/users') {
        authService.requireScope(auth, 'admin:users')
        writeJson(res, 200, authService.listUsers(auth.orgId, auth))
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/users') {
        authService.requireScope(auth, 'admin:users')
        const body = await readJsonBody(req)
        writeJson(
          res,
          200,
          authService.createUser({
            orgId: auth.orgId,
            email: typeof body.email === 'string' ? body.email : '',
            name: typeof body.name === 'string' ? body.name : '',
            departmentId:
              body.department_id === null || typeof body.department_id === 'string'
                ? body.department_id
                : undefined,
            role: typeof body.role === 'string' ? body.role : 'user',
            password: typeof body.password === 'string' ? body.password : '',
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
          departmentId:
            body.department_id === null || typeof body.department_id === 'string'
              ? body.department_id
              : undefined,
          role: typeof body.role === 'string' ? body.role : undefined,
          status:
            typeof body.status === 'string' ? body.status : undefined,
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

      // Config item icon upload
      if (req.method === 'POST' && pathname === '/api/v1/config-items/icon') {
        authService.requireScope(auth, 'admin:secrets:write')
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        const raw = Buffer.concat(chunks)
        const contentType = req.headers['content-type'] || 'image/png'
        const base64 = raw.toString('base64')
        const icon = `data:${contentType};base64,${base64}`
        writeJson(res, 200, { success: true, icon })
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

        // Secret metadata: list + update
        if (req.method === 'GET' && pathname === '/api/v1/secret-metadata') {
          authService.requireScope(auth, 'admin:secrets')
          writeJson(res, 200, secretsApi.listMetadata(auth.orgId, auth.userId))
          return
        }
        const metadataMatch = pathname.match(/^\/api\/v1\/secret-metadata\/(\d+)$/)
        if (req.method === 'PUT' && metadataMatch) {
          authService.requireScope(auth, 'admin:secrets:write')
          const body = await readJsonBody(req)
          writeJson(res, 200, secretsApi.updateMetadata(auth.orgId, auth.userId, Number(metadataMatch[1]), body.expires_at ?? null))
          return
        }

        // Department policies
        const deptPolicyMatch = pathname.match(/^\/api\/v1\/departments\/([^/]+)\/secret-policies$/)
        if (deptPolicyMatch) {
          const deptId = deptPolicyMatch[1]
          if (req.method === 'GET') {
            authService.requireScope(auth, 'admin:secrets')
            writeJson(res, 200, secretsApi.getDepartmentPolicies(auth.orgId, auth.userId, deptId))
            return
          }
          if (req.method === 'PUT') {
            authService.requireScope(auth, 'admin:secrets:write')
            const body = await readJsonBody(req)
            writeJson(res, 200, secretsApi.updateDepartmentPolicies(auth.orgId, auth.userId, deptId, body.config_item_ids ?? []))
            return
          }
        }

        // Audit log
        if (req.method === 'GET' && pathname === '/api/v1/secrets-audit') {
          authService.requireScope(auth, 'admin:secrets')
          const urlObj = new URL(req.url as string, `http://${req.headers.host}`)
          writeJson(res, 200, secretsApi.listAuditLog(auth.orgId, auth.userId, {
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

        // Rotation alerts
        if (req.method === 'GET' && pathname === '/api/v1/secret-rotation/alerts') {
          authService.requireScope(auth, 'admin:secrets')
          writeJson(res, 200, secretsApi.listRotationAlerts(auth.orgId, auth.userId))
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
          ap.registerToken(testToken, testUserId, body?.department_id || null, null)
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
        const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket?.remoteAddress || undefined
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
          const allItems = runtime.store.getAllActiveConfigItems().filter(i => (i.scope as string) === 'system')
          try {
            const user = authService.getUserById(auth.userId)
            const deptId = user?.departmentId ?? null
            if (deptId) {
              const policies = runtime.store.getDepartmentPolicies(deptId)
              const authorizedIds = new Set(policies.map(p => p.config_item_id as number))
              writeJson(res, 200, { success: true, data: allItems.filter(i => authorizedIds.has(i.id as number)) })
            } else {
              writeJson(res, 200, { success: true, data: [] })
            }
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
          if (action === 'enable' && req.method === 'POST') {
            writeJson(res, 200, await secretsApi.enableUserSecret(auth.orgId, auth.userId, namespace, key, clientIp))
            return
          }
          if (action === 'disable' && req.method === 'POST') {
            writeJson(res, 200, await secretsApi.disableUserSecret(auth.orgId, auth.userId, namespace, key, clientIp))
            return
          }
          if (req.method === 'GET') {
            writeJson(res, 200, await secretsApi.getUserSecret(auth.orgId, auth.userId, namespace, key, clientIp))
            return
          }
          if (req.method === 'PUT') {
            const body = await readJsonBody(req)
            writeJson(res, 200, await secretsApi.putUserSecret(auth.orgId, auth.userId, namespace, key, body.value ?? '', clientIp))
            return
          }
          if (req.method === 'DELETE') {
            writeJson(res, 200, await secretsApi.deleteUserSecret(auth.orgId, auth.userId, namespace, key, clientIp))
            return
          }
        }
      }

      if (req.method === 'GET' && pathname === '/api/v1/settings/system') {
        authService.requireScope(auth, 'admin:settings')
        writeJson(res, 200, getSystemSettings())
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
      // List all cron jobs for current user
      if (req.method === 'GET' && pathname === '/api/v1/cron/jobs') {
        const result = await cronApi.listJobs(auth)
        writeJson(res, 200, result)
        return
      }

      // Create a new cron job
      if (req.method === 'POST' && pathname === '/api/v1/cron/jobs') {
        const body = await readJsonBody(req)
        const result = await cronApi.createJob(auth, {
          name: String(body.name || ''),
          enabled: body.enabled !== undefined ? Boolean(body.enabled) : true,
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
          const result = await cronApi.getJob(auth, jobId)
          writeJson(res, 200, result)
          return
        }

        // Update a cron job
        if (req.method === 'PATCH') {
          const body = await readJsonBody(req)
          const updates: any = {}
          if (body.name !== undefined) updates.name = String(body.name)
          if (body.enabled !== undefined) updates.enabled = Boolean(body.enabled)
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

          const result = await cronApi.updateJob(auth, jobId, updates)
          writeJson(res, 200, result)
          return
        }

        // Delete a cron job (soft delete)
        if (req.method === 'DELETE') {
          const result = await cronApi.deleteJob(auth, jobId)
          writeJson(res, 200, result)
          return
        }
      }

      // Trigger a job immediately
      const cronTriggerMatch = pathname.match(/^\/api\/v1\/cron\/jobs\/([^/]+)\/trigger$/)
      if (req.method === 'POST' && cronTriggerMatch) {
        const jobId = cronTriggerMatch[1]
        const result = await cronApi.triggerJob(auth, jobId)
        writeJson(res, 200, result)
        return
      }

      // List runs for a job
      const cronRunsMatch = pathname.match(/^\/api\/v1\/cron\/jobs\/([^/]+)\/runs$/)
      if (req.method === 'GET' && cronRunsMatch) {
        const jobId = cronRunsMatch[1]
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50
        const result = await cronApi.listRuns(auth, jobId, Number.isFinite(limit) ? limit : 50)
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

      if (req.method === 'GET' && pathname === '/api/v1/agent-hub/categories') {
        authService.requireScope(auth, 'admin:settings')
        writeJson(res, 200, await fetchAgentHubCategories())
        return
      }

      if (
        req.method === 'GET' &&
        pathname === '/api/v1/agent-hub/assistants/cursor'
      ) {
        authService.requireScope(auth, 'admin:settings')
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
        authService.requireScope(auth, 'admin:settings')
        const assistantId = decodeURIComponent(agentHubDetailMatch[1] || '')
        writeJson(res, 200, await fetchAgentHubAssistantDetail(assistantId))
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/agent-hub/skills/by-ids') {
        authService.requireScope(auth, 'admin:settings')
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
        writeJson(res, 200, all.filter(a => isVisibleTo(a.visibleTo, filter)))
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
        authService.requireScope(auth, 'admin:settings')
        const body = await readJsonBody(req)
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

      // POST /api/v1/agents/custom - Upload custom assistant
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
        const allRows = runtime.store.listTenantAssistants(status)
        // Filter by visibility for non-admin users
        const filter = authService.buildVisibilityFilter(auth)
        const isAdmin = hasScope(auth.scopes, 'admin:settings')
        const rows = allRows.filter((row: Record<string, unknown>) => {
          // Pending records are only visible to admins
          if (row.status === 'pending' && !isAdmin) return false
          // Approved records are filtered by visibility
          if (row.status === 'approved') {
            const visibleTo = typeof row.visible_to === 'string' ? JSON.parse(row.visible_to) : null
            return isVisibleTo(visibleTo, filter)
          }
          return true
        }).map((row: Record<string, unknown>) => {
          // Parse JSON fields for frontend consumption
          return {
            ...row,
            skills: typeof row.skills === 'string' ? JSON.parse(row.skills) : row.skills ?? [],
            enabled_skills: typeof row.enabled_skills === 'string' ? JSON.parse(row.enabled_skills) : row.enabled_skills ?? [],
            enabled_wikis: typeof row.enabled_wikis === 'string' ? JSON.parse(row.enabled_wikis) : row.enabled_wikis ?? [],
            workflow: typeof row.workflow === 'string' ? JSON.parse(row.workflow) : row.workflow ?? null,
            visible_to: typeof row.visible_to === 'string' ? JSON.parse(row.visible_to) : row.visible_to ?? null,
          }
        })
        writeJson(res, 200, rows)
        return
      }

      // GET /api/v1/agents/installed/:id/download - Download installed assistant by ID
      const agentDownloadMatch = pathname.match(/^\/api\/v1\/agents\/installed\/([^/]+)\/download$/)
      if (req.method === 'GET' && agentDownloadMatch) {
        const assistantId = agentDownloadMatch[1] || ''
        try {
          // Find assistant by ID in installed assistants list
          const installedAssistants = await getInstalledAssistants()
          const assistant = installedAssistants.find(a => a.id === assistantId)
          if (!assistant) {
            throw new HttpError(404, `Assistant not found: ${assistantId}`)
          }
          // Use assistant name for packaging (directory lookup)
          const zipBuffer = await packageAssistantZip(assistant.name)
          res.setHeader('Content-Type', 'application/zip')
          res.setHeader('Content-Disposition', `attachment; filename="${assistantId}.zip"`)
          res.end(zipBuffer)
        } catch (error) {
          if (error instanceof HttpError) throw error
          throw new HttpError(404, `Assistant not found: ${assistantId}`)
        }
        return
      }

      // POST /api/v1/agents/tenant/create - Create tenant assistant directly (admin only)
      if (req.method === 'POST' && pathname === '/api/v1/agents/tenant/create') {
        authService.requireScope(auth, 'admin:settings')
        const body = await readJsonBody(req)

        // Validate required fields
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : name

        if (!name) {
          throw new HttpError(400, 'name is required')
        }

        // Check if name already exists
        const existingAssistant = runtime.store.getTenantAssistantByName(name)
        if (existingAssistant) {
          throw new HttpError(400, `智能体名称 "${name}" 已存在，请使用其他名称`)
        }

        // Generate UUID for the assistant
        const assistantId = randomUUID()

        // Get author info
        const authorUser = authService.getUserOrNull(auth.userId, auth.orgId, auth)
        const authorName = authorUser?.name || undefined

        // Create assistant directory in tenant folder using name (not UUID)
        const MOSS_HOME = process.env.MOSS_HOME || join(os.homedir(), '.moss')
        const ASSISTANT_TENANT_DIR = join(MOSS_HOME, 'assistants', 'tenant')
        const assistantDir = join(ASSISTANT_TENANT_DIR, name)

        await mkdir(assistantDir, { recursive: true })

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
          agent_type: body.agent_type || 'chat',
          memory_mode: body.memory_mode || 'session',
          visible_to: body.visible_to || null,
          workflow: body.workflow || null,
        }

        await writeAssistantMeta(assistantDir, meta)

        // Create rules file
        const rulesContent = rules.trim()
          ? rules
          : `# ${displayName}\n\n${typeof body.description === 'string' ? body.description : '这是一个专属智能体。'}\n`
        await writeFile(join(assistantDir, 'system.md'), rulesContent)

        // Create database record with approved status
        runtime.store.createTenantAssistant({
          id: assistantId,
          name,
          display_name: displayName,
          description: meta.description,
          author_id: auth.userId,
          author_name: authorName,
          status: 'approved',
          file_path: assistantDir,
          skills: meta.skills && meta.skills.length > 0 ? JSON.stringify(meta.skills) : null,
          enabled_skills: meta.enabledSkills && meta.enabledSkills.length > 0 ? JSON.stringify(meta.enabledSkills) : null,
          enabled_wikis: meta.enabledWikis && meta.enabledWikis.length > 0 ? JSON.stringify(meta.enabledWikis) : null,
          agent_type: meta.agent_type,
          memory_mode: meta.memory_mode,
          visible_to: meta.visible_to ? JSON.stringify(meta.visible_to) : null,
          enabled: 1,
        })

        const result = runtime.store.getTenantAssistant(assistantId)
        writeJson(res, 200, { success: true, data: result })
        return
      }

      const tenantAgentRulesMatch = pathname.match(/^\/api\/v1\/agents\/tenant\/([^/]+)\/rules$/)
      if (req.method === 'GET' && tenantAgentRulesMatch) {
        authService.requireScope(auth, 'admin:settings')
        const tenantAssistantId = tenantAgentRulesMatch[1] || ''
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

      // POST /api/v1/agents/tenant/publish - Publish tenant assistant request
      if (req.method === 'POST' && pathname === '/api/v1/agents/tenant/publish') {
        const body = await readJsonBody(req)
        const assistantId = typeof body.assistantId === 'string' ? body.assistantId : ''
        const publishNote = typeof body.publishNote === 'string' ? body.publishNote : undefined

        if (!assistantId) {
          throw new HttpError(400, `assistantId is required`)
        }

        // Check if assistant exists
        const assistantResult = await findAssistantDir(assistantId)
        if (!assistantResult) {
          throw new HttpError(404, `Assistant not found: ${assistantId}`)
        }

        // Read assistant metadata
        const meta = await readAssistantMeta(assistantResult.dir)

        // Use actual assistant name from metadata or directory name
        const actualAssistantName = typeof meta?.name === 'string' && meta.name.trim() ? meta.name.trim() : assistantId

        // Get author name from user info
        const authorUser = authService.getUserOrNull(auth.userId, auth.orgId, auth)
        const authorName = authorUser?.name || undefined

        // Create tenant assistant record with UUID as id
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
          file_path: assistantResult.dir, // Store source directory path for approval
        })
        writeJson(res, 200, { id: assistantId, status: 'pending', message: '发布申请已提交，等待管理员审批' })
        return
      }

      // POST /api/v1/admin/agents/tenant/:id/approve - Approve tenant assistant
      const agentApproveMatch = pathname.match(/^\/api\/v1\/admin\/agents\/tenant\/([^/]+)\/approve$/)
      if (req.method === 'POST' && agentApproveMatch) {
        authService.requireScope(auth, 'admin:settings')
        const tenantAssistantId = agentApproveMatch[1] || ''
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
          // Set visibility to all users (null)
          runtime.store.updateTenantAssistantMeta(tenantAssistantId, { visible_to: null })
          // Copy assistant to tenant directory using stored file_path
          const sourcePath = tenantAssistant.file_path as string | undefined
          if (sourcePath && existsSync(sourcePath)) {
            await copyAssistantToTenantDirByPath(sourcePath)
            // Update file_path to point to tenant directory after copy
            const MOSS_HOME = process.env.MOSS_HOME || join(os.homedir(), '.moss')
            const tenantPath = join(MOSS_HOME, 'assistants', 'tenant', tenantAssistantId)
            runtime.store.updateTenantAssistantPath(tenantAssistantId, tenantPath)
          } else {
            throw new HttpError(404, `Source assistant directory not found: ${sourcePath}`)
          }
        } else {
          runtime.store.updateTenantAssistantStatus(tenantAssistantId, 'rejected', auth.userId, reviewNote)
        }

        writeJson(res, 200, { id: tenantAssistantId, status: approved ? 'approved' : 'rejected' })
        return
      }

      // PATCH /api/v1/agents/tenant/:id - Update tenant assistant meta
      const agentTenantPatchMatch = pathname.match(/^\/api\/v1\/agents\/tenant\/([^/]+)$/)
      if (req.method === 'PATCH' && agentTenantPatchMatch) {
        authService.requireScope(auth, 'admin:settings')
        const tenantAssistantId = agentTenantPatchMatch[1] || ''
        const body = await readJsonBody(req)

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

      // DELETE /api/v1/agents/tenant/:id - Delete tenant assistant
      if (req.method === 'DELETE' && agentTenantPatchMatch) {
        authService.requireScope(auth, 'admin:settings')
        const tenantAssistantId = agentTenantPatchMatch[1] || ''
        const tenantAssistant = runtime.store.getTenantAssistant(tenantAssistantId)
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

      // GET /api/v1/agents/tenant/:id/download - Download tenant assistant
      const tenantAgentDownloadMatch = pathname.match(/^\/api\/v1\/agents\/tenant\/([^/]+)\/download$/)
      if (req.method === 'GET' && tenantAgentDownloadMatch) {
        const tenantAssistantId = tenantAgentDownloadMatch[1] || ''
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
          const downloadName = tenantAssistant.display_name || tenantAssistant.name || 'assistant'
          // Use UUID as filename to avoid encoding issues with Chinese characters
          const safeFilename = `${tenantAssistantId}.zip`
          res.setHeader('Content-Type', 'application/zip')
          res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`)
          res.end(zipBuffer)
        } catch (error) {
          throw new HttpError(404, `Failed to package assistant: ${error}`)
        }
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/skill-hub/categories') {
        authService.requireScope(auth, 'admin:settings')
        writeJson(res, 200, await fetchSkillHubCategories())
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/skill-hub/skills/cursor') {
        authService.requireScope(auth, 'admin:settings')
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
        authService.requireScope(auth, 'admin:settings')
        const skillId = decodeURIComponent(skillHubDetailMatch[1] || '')
        writeJson(res, 200, await fetchSkillHubSkillDetail(skillId))
        return
      }

      if (req.method === 'GET' && pathname === '/api/v1/skills/installed') {
        const filter = authService.buildVisibilityFilter(auth)
        const all = await getHubInstalledSkills()
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
        const allRows = runtime.store.listTenantSkills(status)
        // Filter by visibility for non-admin users
        const filter = authService.buildVisibilityFilter(auth)
        const isAdmin = hasScope(auth.scopes, 'admin:settings')
        const rows = allRows.filter((row: Record<string, unknown>) => {
          // Pending records are only visible to admins
          if (row.status === 'pending' && !isAdmin) return false
          // Approved records are filtered by visibility
          if (row.status === 'approved') {
            const visibleTo = typeof row.visible_to === 'string' ? JSON.parse(row.visible_to) : null
            return isVisibleTo(visibleTo, filter)
          }
          return true
        })
        writeJson(res, 200, rows)
        return
      }

      // GET /api/v1/skills/installed/:id/download - Download installed skill by ID
      const skillDownloadMatch = pathname.match(/^\/api\/v1\/skills\/installed\/([^/]+)\/download$/)
      if (req.method === 'GET' && skillDownloadMatch) {
        const skillId = skillDownloadMatch[1] || ''
        try {
          // Find skill by ID in installed skills list
          const installedSkills = await getInstalledSkills()
          const skill = installedSkills.find(s => s.id === skillId)
          if (!skill) {
            throw new HttpError(404, `Skill not found: ${skillId}`)
          }
          // Use skill name for packaging (directory lookup)
          const zipBuffer = await packageSkillZip(skill.name)
          res.setHeader('Content-Type', 'application/zip')
          res.setHeader('Content-Disposition', `attachment; filename="${skillId}.zip"`)
          res.end(zipBuffer)
        } catch (error) {
          if (error instanceof HttpError) throw error
          throw new HttpError(404, `Skill not found: ${skillId}`)
        }
        return
      }

      // POST /api/v1/skills/tenant/upload - Upload tenant skill (auto-approved)
      if (req.method === 'POST' && pathname === '/api/v1/skills/tenant/upload') {
        authService.requireScope(auth, 'admin:settings')
        const body = await readJsonBody(req)

        // Get author name from user info
        const authorUser = authService.getUserOrNull(auth.userId, auth.orgId, auth)
        const authorName = authorUser?.name || undefined

        // Handle ZIP archive upload
        if (typeof body.archiveBase64 === 'string' && body.archiveBase64) {
          const result = await importTenantSkillArchive({
            fileName: typeof body.fileName === 'string' ? body.fileName : '',
            archiveBase64: body.archiveBase64,
            userId: auth.userId,
            authorName,
          })

          // Create tenant_skills record with approved status
          runtime.store.createTenantSkill({
            id: result.id,
            name: result.skillName,
            display_name: result.displayName,
            description: result.description,
            version: result.version,
            author_id: auth.userId,
            author_name: authorName,
            status: 'approved',
            enabled: 1,
          })

          writeJson(res, 200, result)
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
          })

          // Create tenant_skills record with approved status
          runtime.store.createTenantSkill({
            id: result.id,
            name: result.skillName,
            display_name: result.displayName,
            description: result.description,
            version: result.version,
            author_id: auth.userId,
            author_name: authorName,
            status: 'approved',
            enabled: 1,
          })

          writeJson(res, 200, result)
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

        // Create tenant skill record with metadata from source skill
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
        })
        writeJson(res, 200, { id, skillId, status: 'pending', message: '发布申请已提交，等待管理员审批' })
        return
      }

      // POST /api/v1/admin/skills/tenant/:id/approve - Approve tenant skill
      const skillApproveMatch = pathname.match(/^\/api\/v1\/admin\/skills\/tenant\/([^/]+)\/approve$/)
      if (req.method === 'POST' && skillApproveMatch) {
        authService.requireScope(auth, 'admin:settings')
        const tenantSkillId = skillApproveMatch[1] || ''
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
          // Set visibility to all users (null)
          runtime.store.updateTenantSkillMeta(tenantSkillId, { visible_to: null })
          // Copy skill to tenant directory
          const skillName = tenantSkill.name as string
          await copySkillToTenantDir(skillName)
        } else {
          runtime.store.updateTenantSkillStatus(tenantSkillId, 'rejected', auth.userId, reviewNote)
        }

        writeJson(res, 200, { id: tenantSkillId, status: approved ? 'approved' : 'rejected' })
        return
      }

      // PATCH /api/v1/skills/tenant/:id - Update tenant skill meta
      const skillTenantPatchMatch = pathname.match(/^\/api\/v1\/skills\/tenant\/([^/]+)$/)
      if (req.method === 'PATCH' && skillTenantPatchMatch) {
        authService.requireScope(auth, 'admin:settings')
        const tenantSkillId = skillTenantPatchMatch[1] || ''
        const body = await readJsonBody(req)

        const updates: { enabled?: number; visible_to?: string | null } = {}
        if (typeof body.enabled === 'boolean') {
          updates.enabled = body.enabled ? 1 : 0
        }
        if (body.visible_to !== undefined) {
          updates.visible_to = body.visible_to ? JSON.stringify(body.visible_to) : null
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
              if (body.visible_to !== undefined) {
                meta.visible_to = body.visible_to || null
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
        authService.requireScope(auth, 'admin:settings')
        const tenantSkillId = skillTenantPatchMatch[1] || ''
        const tenantSkill = runtime.store.getTenantSkill(tenantSkillId)
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
        const tenantSkillId = tenantSkillDownloadMatch[1] || ''
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
          res.setHeader('Content-Type', 'application/zip')
          res.setHeader('Content-Disposition', `attachment; filename="${skillName}.zip"`)
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
        let sessions = runtime.listSessions({
          orgId: auth.orgId,
          userId: hasScope(auth.scopes, 'sessions:list:any') ? undefined : auth.userId,
          activeOnly,
        })

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

        writeJson(res, 200, { sessions })
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
        const sessions = runtime.listSessionRecords({
          orgId: auth.orgId,
          userId: hasScope(auth.scopes, 'sessions:list:any')
            ? undefined
            : auth.userId,
        })

        const stats = await loadBudgetStats(sessions)
        writeJson(res, 200, stats)
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
          session: serializeSession(session),
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
        const ready =
          session.desiredState === 'active'
            ? await runtime.ensureSessionReady(sessionId)
            : { session, attempt: null }
        writeJson(res, 200, {
          session: serializeSession(ready.session),
          ws_url: buildWsUrl(server, config, ready.session.sessionId),
        })
        return
      }

      if (req.method === 'POST' && pathname === '/api/v1/sessions') {
        authService.requireScope(auth, 'sessions:create')
        const body = await readJsonBody(req)
        const fallbackCwd = config.workspace || process.cwd()
        const normalizeCwd = (p: string) => p === '/' ? os.homedir() : p
        const requestedCwd =
          typeof body.cwd === 'string' && body.cwd.trim()
            ? body.cwd
            : fallbackCwd
        const cwd = normalizeCwd(existsSync(requestedCwd) ? requestedCwd : fallbackCwd)
        const dangerouslySkipPermissions =
          body.dangerously_skip_permissions === true
        const runtimeOptions = parseRuntimeOptions(body)
        const rawAssistantName =
          typeof body.assistant_name === 'string' && body.assistant_name.trim()
            ? body.assistant_name.trim()
            : undefined

        // Resolve assistant display name from UUID or name
        // The assistant_name from client may be UUID, we need to find the actual display name
        let assistantDisplayName = rawAssistantName
        if (rawAssistantName) {
          try {
            const installedAssistants = await getInstalledAssistants()
            // Try to find by id (UUID) first, then by name (directory name)
            const assistant = installedAssistants.find(a => a.id === rawAssistantName) ||
              installedAssistants.find(a => a.name === rawAssistantName)
            if (assistant && assistant.displayName) {
              assistantDisplayName = assistant.displayName
            }
          } catch {
            // If lookup fails, use the raw name
          }
        }

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

  return {
    port: null,
    ready,
    stop: async () => {
      wikiJobExecutor.stop()
      sourceSyncWorker.stop()
      cronService.stop()
      wss.close()
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
