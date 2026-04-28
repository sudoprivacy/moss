import http from 'http'
import net from 'net'
import { existsSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { dirname, extname, join, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { WebSocket, WebSocketServer } from 'ws'
import type { ServerConfig, SessionRecord } from './types.js'
import { createServerLogger, type ServerLogger } from './serverLog.js'
import { hasScope, type AuthContext } from './auth/token.js'
import { AuthService, AuthServiceError } from './auth/service.js'
import { RuntimeService } from './runtimeService.js'
import { getSystemSettings, updateSystemSettings } from './systemSettings.js'
import {
  fetchAgentHubAssistantDetail,
  fetchAgentHubAssistants,
  fetchAgentHubCategories,
  fetchAgentHubSkillDetailsByIds,
  getInstalledAssistants,
  installHubAssistant,
  type AgentHubAssistant,
  uninstallAssistant,
  updateInstalledAssistantMeta,
} from './agentStore.js'
import {
  fetchSkillHubCategories,
  fetchSkillHubSkillDetail,
  fetchSkillHubSkills,
  getInstalledSkills,
  importLocalSkillArchive,
  importLocalSkillDirectory,
  installHubSkill,
  setInstalledSkillEnabled,
  type SkillHubSkill,
  uninstallSkill,
} from './skillStore.js'
import { createAdaptersApi } from './api/adapters.js'
import { adapterProcessManager } from './adapterProcessManager.js'
import { loadBudgetStats } from './budgetStats.js'
import { loadDashboardStats } from './dashboardStats.js'
import { loadSessionContextFromTranscript } from './transcript.js'
import { createEmptyUsageSummary } from '../utils/sessionUsage.js'
import type { SessionRuntimeOptions } from './sessionManager.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { errorMessage } from '../utils/errors.js'

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
  createdAt: number
  lastActiveAt: number
  endedAt: number | null
  // ACP config fields (for model/mode switching)
  acpMode?: string | null
  acpModelId?: string | null
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
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    endedAt: session.endedAt,
    // Always ACP protocol now
    protocol: 'acp',
    // ACP config fields
    acpMode: session.acpMode,
    acpModelId: session.acpModelId,
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
  return token ? authService.verifyAccessToken(token) : null
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

function redirect(
  res: http.ServerResponse,
  location: string,
): void {
  res.writeHead(302, { location })
  res.end()
}

function parseRuntimeOptions(body: JsonBody): SessionRuntimeOptions | undefined {
  if (typeof body.runtime_type === 'string') {
    return {
      type: (body.runtime_type === 'docker' ? 'docker' : 'host') as 'host' | 'docker',
      dockerImage:
        typeof body.docker_image === 'string' ? body.docker_image : undefined,
      dockerMode:
        body.docker_mode === 'user'
          ? 'user'
          : body.docker_mode === 'session'
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
    type: type as 'host' | 'docker',
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

function resolveAdapterTargetUserId(
  auth: AuthContext,
  authService: AuthService,
  requestedUserId: string | null | undefined,
): string {
  const targetUserId =
    typeof requestedUserId === 'string' ? requestedUserId.trim() : ''

  if (!targetUserId || targetUserId === auth.userId) {
    return auth.userId
  }

  if (!hasScope(auth.scopes, 'admin:settings')) {
    throw new AuthServiceError(403, 'Missing scope: admin:settings')
  }

  if (!authService.getUserOrNull(targetUserId, auth.orgId)) {
    throw new HttpError(404, 'Unknown user_id')
  }

  return targetUserId
}

function listAdapterProcessStatusesForUser(
  orgId: string,
  userId: string,
): Record<
  string,
  {
    status: 'running' | 'stopped' | 'error'
    pid: number | null
    error: string | null
    startedAt: number | null
    orgId: string
    userId: string
    platform: 'telegram' | 'feishu'
  }
> {
  const result: Record<
    string,
    {
      status: 'running' | 'stopped' | 'error'
      pid: number | null
      error: string | null
      startedAt: number | null
      orgId: string
      userId: string
      platform: 'telegram' | 'feishu'
    }
  > = {}

  for (const platform of ['telegram', 'feishu'] as const) {
    const key = `${orgId}:${userId}:${platform}`
    result[key] = {
      ...adapterProcessManager.getStatus(platform, orgId, userId),
      orgId,
      userId,
      platform,
    }
  }

  return result
}

function resolveAdminDistDir(): string | null {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(process.cwd(), 'admin', 'dist'),
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

export function startServer(
  config: ServerConfig,
  runtime: RuntimeService,
  authService: AuthService,
  logger: ServerLogger = createServerLogger(),
): {
  port: number | null
  ready: Promise<number | null>
  stop: () => Promise<void>
} {
  const adminDistDir = resolveAdminDistDir()
  const wss = new WebSocketServer({ noServer: true })
  const adaptersApi = createAdaptersApi(runtime.store.db)

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const pathname = url.pathname
      const isHead = req.method === 'HEAD'

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
          writeJson(
            res,
            200,
            authService.issueTokenFromApiKey(
              typeof body.api_key === 'string' ? body.api_key : '',
            ),
          )
          return
        }

        if (grantType === 'password') {
          writeJson(
            res,
            200,
            authService.issueTokenFromPassword({
              username: typeof body.username === 'string' ? body.username : '',
              email: typeof body.email === 'string' ? body.email : '',
              password: typeof body.password === 'string' ? body.password : '',
            }),
          )
          return
        }

        throw new HttpError(400, `Unsupported grant_type: ${grantType}`)
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
        writeJson(res, 200, authService.getMe(auth))
        return
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

      const auth = authenticateRequest(req, authService)
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
        writeJson(
          res,
          200,
          authService.updateUser({
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
          }, auth),
        )
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
        writeJson(res, 200, await getInstalledAssistants())
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
          },
        })
        writeJson(res, 200, { ok: true })
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
        authService.requireScope(auth, 'admin:settings')
        writeJson(res, 200, await getInstalledSkills())
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
        const sessions = runtime.listSessions({
          orgId: auth.orgId,
          userId: hasScope(auth.scopes, 'sessions:list:any') ? undefined : auth.userId,
          activeOnly,
        })
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
        // For active/creating sessions, return empty context if transcript doesn't exist yet
        // This allows viewing session details for newly created sessions
        if (!context) {
          const isActiveSession = ['creating', 'active', 'detached'].includes(session.status)
          if (isActiveSession) {
            writeJson(res, 200, {
              session: serializeSession(session),
              usage: createEmptyUsageSummary(),
              context: {
                customTitle: undefined,
                tag: undefined,
                summary: undefined,
                messages: [],
              },
            })
            return
          }
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
        const cwd =
          typeof body.cwd === 'string' && body.cwd.trim()
            ? body.cwd
            : config.workspace || process.cwd()
        const dangerouslySkipPermissions =
          body.dangerously_skip_permissions === true
        const runtimeOptions = parseRuntimeOptions(body)
        const assistantName =
          typeof body.assistant_name === 'string' && body.assistant_name.trim()
            ? body.assistant_name.trim()
            : undefined

        const created = await runtime.createSession({
          cwd,
          dangerouslySkipPermissions,
          userId: auth.userId,
          orgId: auth.orgId,
          role: auth.role,
          scopes: auth.scopes,
          runtime: runtimeOptions,
          assistantName,
        })

        // Build response (always ACP protocol now)
        const response: Record<string, unknown> = {
          session_id: created.sessionId,
          ws_url: buildWsUrl(server, config, created.sessionId),
          work_dir: created.cwd,
          runtime: created.runtime,
          protocol: 'acp',
        }

        writeJson(res, 200, response)
        return
      }

      // GET /api/v1/acp/backends - Get ACP backend list
      // Note: This endpoint is deprecated since we no longer support external ACP backends
      // All sessions now use cli-node.js with --acp flag
      if (req.method === 'GET' && pathname === '/api/v1/acp/backends') {
        writeJson(res, 200, { backends: [] })
        return
      }

      // POST /api/v1/sessions/:sessionId/cancel - Cancel session operation
      const cancelMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/cancel$/)
      if (req.method === 'POST' && cancelMatch) {
        authService.requireScope(auth, 'sessions:attach')
        const sessionId = cancelMatch[1] || ''
        const session = runtime.getSession(sessionId)
        if (!session) {
          throw new HttpError(404, 'Session not found')
        }
        if (!canAccessSession(auth, session, 'sessions:attach:any')) {
          throw new HttpError(403, 'Forbidden')
        }

        const body = await readJsonBody(req)
        const force = body.force === true

        // Send session/cancel to ACP agent
        try {
          await runtime.sendAcpRequest(sessionId, 'session/cancel', {
            sessionId,
            force,
          })
        } catch (error) {
          // Log error but still return success (session may have already ended)
          process.stderr.write(`[server] Failed to cancel session: ${errorMessage(error)}\n`)
        }

        writeJson(res, 200, { ok: true, result: 'cancelled', session })
        return
      }

      // POST /api/v1/sessions/:sessionId/model - Switch model (ACP only)
      const modelMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/model$/)
      if (req.method === 'POST' && modelMatch) {
        authService.requireScope(auth, 'sessions:attach')
        const sessionId = modelMatch[1] || ''
        const session = runtime.getSession(sessionId)
        if (!session) {
          throw new HttpError(404, 'Session not found')
        }
        if (!canAccessSession(auth, session, 'sessions:attach:any')) {
          throw new HttpError(403, 'Forbidden')
        }

        const body = await readJsonBody(req)
        const modelId = typeof body.model_id === 'string' ? body.model_id : ''

        // Send session/set_model to ACP agent
        try {
          await runtime.sendAcpRequest(sessionId, 'session/set_model', {
            sessionId,
            modelId,
          })
          // Update database record
          runtime.store.updateSessionAcpConfig(sessionId, { acpModelId: modelId })
        } catch (error) {
          // Log error but still return success (agent may not support model switching)
          process.stderr.write(`[server] Failed to set model: ${errorMessage(error)}\n`)
        }

        writeJson(res, 200, {
          ok: true,
          model_info: {
            current_model_id: modelId,
            can_switch: true,
            available_models: [],
          },
        })
        return
      }

      // POST /api/v1/sessions/:sessionId/mode - Switch mode
      const modeMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/mode$/)
      if (req.method === 'POST' && modeMatch) {
        authService.requireScope(auth, 'sessions:attach')
        const sessionId = modeMatch[1] || ''
        const session = runtime.getSession(sessionId)
        if (!session) {
          throw new HttpError(404, 'Session not found')
        }
        if (!canAccessSession(auth, session, 'sessions:attach:any')) {
          throw new HttpError(403, 'Forbidden')
        }

        const body = await readJsonBody(req)
        const mode = typeof body.mode === 'string' ? body.mode : 'default'

        // Send session/set_mode to ACP agent
        try {
          await runtime.sendAcpRequest(sessionId, 'session/set_mode', {
            sessionId,
            modeId: mode,
          })
          // Update database record
          runtime.store.updateSessionAcpConfig(sessionId, { acpMode: mode })
        } catch (error) {
          // Log error but still return success
          process.stderr.write(`[server] Failed to set mode: ${errorMessage(error)}\n`)
        }

        writeJson(res, 200, { ok: true, mode })
        return
      }

      // GET /api/v1/sessions/:sessionId/model - Get model info
      if (req.method === 'GET' && modelMatch) {
        authService.requireScope(auth, 'sessions:attach')
        const sessionId = modelMatch[1] || ''
        const session = runtime.getSession(sessionId)
        if (!session) {
          throw new HttpError(404, 'Session not found')
        }
        if (!canAccessSession(auth, session, 'sessions:attach:any')) {
          throw new HttpError(403, 'Forbidden')
        }

        // Always ACP protocol now, so can_switch is always true
        writeJson(res, 200, {
          model_info: {
            source: 'configOption',
            current_model_id: session.acpModelId || null,
            current_model_label: session.acpModelId || 'Default',
            can_switch: true,
            available_models: [],
          },
        })
        return
      }

      // GET /api/v1/sessions/:sessionId/config-options - Get config options (ACP only)
      const configOptionsMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/config-options$/)
      if (req.method === 'GET' && configOptionsMatch) {
        authService.requireScope(auth, 'sessions:attach')
        const sessionId = configOptionsMatch[1] || ''
        const session = runtime.getSession(sessionId)
        if (!session) {
          throw new HttpError(404, 'Session not found')
        }
        if (!canAccessSession(auth, session, 'sessions:attach:any')) {
          throw new HttpError(403, 'Forbidden')
        }

        // TODO: Fetch actual config options from ACP agent
        writeJson(res, 200, {
          config_options: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              current_value: session.acpModelId || '',
              options: [],
            },
            {
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              type: 'select',
              current_value: session.acpMode || 'default',
              options: [
                { value: 'default', label: 'Default' },
                { value: 'yolo', label: 'YOLO' },
                { value: 'bypassPermissions', label: 'Bypass Permissions' },
              ],
            },
          ],
        })
        return
      }

      // PATCH /api/v1/sessions/:sessionId/config-options/:configId - Set config option (ACP only)
      const configOptionPatchMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/config-options\/([^/]+)$/)
      if (req.method === 'PATCH' && configOptionPatchMatch) {
        authService.requireScope(auth, 'sessions:attach')
        const sessionId = configOptionPatchMatch[1] || ''
        const configId = configOptionPatchMatch[2] || ''
        const session = runtime.getSession(sessionId)
        if (!session) {
          throw new HttpError(404, 'Session not found')
        }
        if (!canAccessSession(auth, session, 'sessions:attach:any')) {
          throw new HttpError(403, 'Forbidden')
        }

        const body = await readJsonBody(req)
        const value = typeof body.value === 'string' ? body.value : ''

        // Send session/set_config_option to ACP agent
        try {
          const result = await runtime.sendAcpRequest(sessionId, 'session/set_config_option', {
            sessionId,
            configId,
            value,
          }) as { configOptions?: Array<{ id: string; currentValue?: string }> }

          // Update database record based on configId
          if (configId === 'mode') {
            runtime.store.updateSessionAcpConfig(sessionId, { acpMode: value })
          } else if (configId === 'model') {
            runtime.store.updateSessionAcpConfig(sessionId, { acpModelId: value })
          }

          writeJson(res, 200, {
            ok: true,
            config_id: configId,
            value,
            config_options: result?.configOptions || [],
          })
        } catch (error) {
          process.stderr.write(`[server] Failed to set config option: ${errorMessage(error)}\n`)
          writeJson(res, 200, {
            ok: true,
            config_id: configId,
            value,
          })
        }
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
        const auth = authenticateRequest(req, authService)
        if (!auth) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }

        const url = new URL(req.url || '/', 'http://localhost')
        const pathname = url.pathname
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

        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          void runtime.connectToAttempt(ready.attempt).then((runnerSocket: net.Socket) => {
            let buffer = ''
            let msgIdCounter = 0
            let sessionInitialized = false
            const pendingAcpResponses = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }>()
            const nextMsgId = () => {
              msgIdCounter++
              return `msg-${msgIdCounter}-${Date.now()}`
            }

            const sendToRunner = (payload: Record<string, unknown>) => {
              if (!runnerSocket.destroyed) {
                runnerSocket.write(`${jsonStringify(payload)}\n`)
              }
            }

            // Send JSON-RPC to runner and optionally wait for response
            const sendAcpRequest = (method: string, params?: unknown, waitForResponse = false): string | Promise<unknown> => {
              const id = nextMsgId()
              const request = {
                jsonrpc: '2.0',
                id,
                method,
                params,
              }
              sendToRunner({ type: 'stdin', data: `${jsonStringify(request)}\n` })

              if (waitForResponse) {
                return new Promise<unknown>((resolve, reject) => {
                  const timeout = setTimeout(() => {
                    pendingAcpResponses.delete(id)
                    reject(new Error(`ACP request ${id} timed out`))
                  }, 10_000)
                  pendingAcpResponses.set(id, {
                    resolve: (result: unknown) => {
                      clearTimeout(timeout)
                      resolve(result)
                    },
                    reject,
                  })
                })
              }
              return id
            }

            const sendAcpNotification = (method: string, params?: unknown) => {
              const notification = {
                jsonrpc: '2.0',
                method,
                params,
              }
              sendToRunner({ type: 'stdin', data: `${jsonStringify(notification)}\n` })
            }

            // Initialize ACP session on connection
            const initializeAcpSession = async () => {
              try {
                // Send initialize request
                await sendAcpRequest('initialize', {}, true)

                // Send session/new with the sessionId and cwd
                const cwd = session.cwd
                await sendAcpRequest('session/new', { sessionId, cwd }, true)

                sessionInitialized = true
              } catch (error) {
                // Log error but don't fail the connection
                process.stderr.write(`[server] ACP initialization failed: ${errorMessage(error)}\n`)
              }
            }

            // Pending messages queue for during initialization
            const pendingMessages: string[] = []
            let initializationComplete = false

            // Process pending messages after initialization
            const processPendingMessages = () => {
              for (const msg of pendingMessages) {
                // Re-trigger message handling
                ws.emit('message', Buffer.from(msg))
              }
              pendingMessages.length = 0
            }

            // Start initialization and then process pending messages
            initializeAcpSession().then(() => {
              initializationComplete = true
              processPendingMessages()
            }).catch(error => {
              process.stderr.write(`[server] ACP initialization error: ${errorMessage(error)}\n`)
              initializationComplete = true
              processPendingMessages()
            })

            // Handle client messages - always ACP protocol
            ws.on('message', (data: string | Buffer) => {
              const text =
                typeof data === 'string'
                  ? data
                  : Buffer.from(data).toString('utf8')

              // Queue messages during initialization
              if (!initializationComplete) {
                pendingMessages.push(text)
                return
              }

              // ACP protocol: Parse client message and convert to JSON-RPC
              try {
                const clientMsg = jsonParse(text) as {
                  type?: string
                  content?: string
                  images?: unknown[]
                  request_id?: string
                  option_id?: string
                  force?: boolean
                }

                if (clientMsg.type === 'user_message') {
                  // Convert to session/prompt with proper ACP format
                  const promptContent: Array<Record<string, unknown>> = [
                    { type: 'text', text: clientMsg.content || '' },
                  ]
                  // Add images if present (ACP format)
                  if (clientMsg.images && Array.isArray(clientMsg.images)) {
                    for (const img of clientMsg.images) {
                      if (typeof img === 'object' && img !== null) {
                        promptContent.push(img as Record<string, unknown>)
                      }
                    }
                  }
                  ;(sendAcpRequest('session/prompt', {
                    sessionId,
                    prompt: { content: promptContent },
                  }, true) as Promise<unknown>).catch(error => {
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(jsonStringify({
                        type: 'error',
                        msg_id: nextMsgId(),
                        data: {
                          message: error instanceof Error ? error.message : 'Prompt failed',
                        },
                      }))
                    }
                  })
                } else if (clientMsg.type === 'permission_response') {
                  // Send JSON-RPC response for permission request
                  if (clientMsg.request_id) {
                    const optionId = clientMsg.option_id || ''
                    const outcome = optionId.startsWith('reject') ? 'cancelled' : 'selected'
                    sendToRunner({
                      type: 'stdin',
                      data: `${jsonStringify({
                        jsonrpc: '2.0',
                        id: clientMsg.request_id,
                        result: {
                          outcome: {
                            outcome,
                            optionId,
                          },
                        },
                      })}\n`,
                    })
                  }
                } else if (clientMsg.type === 'cancel') {
                  // Send session/cancel as notification (no need to wait for response)
                  sendAcpNotification('session/cancel', { sessionId, force: clientMsg.force })
                } else if (clientMsg.type === 'interrupt') {
                  // Send interrupt notification with sessionId
                  sendAcpNotification('session/interrupt', { sessionId })
                } else {
                  // Fallback: send as stdin
                  sendToRunner({
                    type: 'stdin',
                    data: text.endsWith('\n') ? text : `${text}\n`,
                  })
                }
              } catch {
                // Not valid JSON, send as stdin
                sendToRunner({
                  type: 'stdin',
                  data: text.endsWith('\n') ? text : `${text}\n`,
                })
              }
            })

            ws.on('close', () => {
              runnerSocket.destroy()
            })
            ws.on('error', () => {
              runnerSocket.destroy()
            })

            // Handle runner output
            runnerSocket.on('data', (chunk: Buffer) => {
              buffer += chunk.toString('utf8')
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

                let parsed: { type?: string; line?: string; jsonrpc?: string; method?: string; params?: unknown; notification?: { jsonrpc: string; method: string; params?: unknown }; id?: string; result?: unknown; error?: { message?: string } }
                try {
                  parsed = jsonParse(line) as typeof parsed
                } catch {
                  continue
                }

                // Check for ACP JSON-RPC (always ACP now)
                if (parsed.jsonrpc === '2.0') {
                  // ACP notification
                  if (parsed.method && ws.readyState === WebSocket.OPEN) {
                    // Convert ACP notification to client-friendly format
                    const params = parsed.params as Record<string, unknown> | undefined
                    const update = params?.update as Record<string, unknown> | undefined
                    const msgId = nextMsgId()

                    if (parsed.method === 'session/update' && update) {
                      const sessionUpdate = update.sessionUpdate as string

                      if (sessionUpdate === 'agent_message_chunk') {
                        const content = update.content as Record<string, unknown>
                        ws.send(jsonStringify({
                          type: 'start',
                          msg_id: msgId,
                        }))
                        ws.send(jsonStringify({
                          type: 'content',
                          msg_id: msgId,
                          data: content.text || '',
                        }))
                      } else if (sessionUpdate === 'agent_thought_chunk') {
                        const content = update.content as Record<string, unknown>
                        ws.send(jsonStringify({
                          type: 'thought',
                          msg_id: msgId,
                          data: content.text || '',
                        }))
                      } else if (sessionUpdate === 'tool_call') {
                        ws.send(jsonStringify({
                          type: 'tool_call',
                          msg_id: msgId,
                          data: {
                            tool_name: update.title || update.kind || 'unknown',
                            tool_use_id: update.toolCallId || '',
                            input: update.rawInput || {},
                            kind: update.kind || 'other',
                            status: update.status || 'pending',
                          },
                        }))
                      } else if (sessionUpdate === 'tool_call_update') {
                        ws.send(jsonStringify({
                          type: 'tool_call_update',
                          msg_id: msgId,
                          data: {
                            tool_use_id: update.toolCallId || '',
                            status: update.status || 'running',
                            output: typeof update.rawOutput === 'string' ? update.rawOutput :
                                    update.rawOutput ? jsonStringify(update.rawOutput) : '',
                          },
                        }))
                      } else if (sessionUpdate === 'plan') {
                        ws.send(jsonStringify({
                          type: 'plan',
                          msg_id: msgId,
                          data: { entries: update.entries || [] },
                        }))
                      } else if (sessionUpdate === 'permission_request') {
                        const toolCall = update.toolCall as Record<string, unknown> | undefined
                        const options = update.options as Array<Record<string, unknown>> | undefined
                        const requestId = update.requestId as string | undefined
                        ws.send(jsonStringify({
                          type: 'permission_request',
                          request_id: requestId || msgId,
                          data: {
                            tool_name: toolCall?.title || '',
                            tool_use_id: toolCall?.toolCallId || '',
                            description: toolCall?.title || '',
                            input: toolCall?.rawInput || {},
                            options: (options || []).map(o => ({
                              id: o.optionId as string || '',
                              name: o.name as string || '',
                            })),
                          },
                        }))
                      } else if (sessionUpdate === 'config_option_update') {
                        ws.send(jsonStringify({
                          type: 'model_info',
                          msg_id: msgId,
                          data: update.configOptions || [],
                        }))
                      } else if (sessionUpdate === 'message_stopped') {
                        ws.send(jsonStringify({
                          type: 'finish',
                          msg_id: msgId,
                          stop_reason: update.stopReason,
                        }))
                      } else if (sessionUpdate === 'usage_update') {
                        ws.send(jsonStringify({
                          type: 'context_usage',
                          msg_id: msgId,
                          data: { used: update.used, size: update.size },
                        }))
                      } else if (sessionUpdate === 'error') {
                        ws.send(jsonStringify({
                          type: 'error',
                          msg_id: msgId,
                          data: {
                            message: update.message || 'Unknown error',
                            code: update.code || undefined,
                          },
                        }))
                      }
                    }
                  }
                  // ACP response (has id) - resolve pending request if applicable
                  else if ('id' in parsed) {
                    const responseId = String(parsed.id)
                    const pending = pendingAcpResponses.get(responseId)
                    if (pending) {
                      pendingAcpResponses.delete(responseId)
                      if (parsed.error) {
                        pending.reject(new Error((parsed.error as { message?: string }).message || 'ACP error'))
                      } else {
                        pending.resolve(parsed.result)
                      }
                    }
                    // Could also be permission response acknowledgment, forward to client if needed
                  }
                }
                // ACP notification from daemon (always ACP now)
                else if (parsed.type === 'acp_notification' && parsed.notification) {
                  const notification = parsed.notification as { jsonrpc: string; id?: string | number; method: string; params?: unknown }
                  // Handle agent→client permission requests (have both id and method)
                  if (notification.id !== undefined && notification.method === 'session/request_permission' && ws.readyState === WebSocket.OPEN) {
                    const params = notification.params as Record<string, unknown> | undefined
                    const toolCall = params?.toolCall as Record<string, unknown> | undefined
                    const options = params?.options as Array<Record<string, unknown>> | undefined
                    // Use the ACP request id as the request_id so the response can be correlated
                    const requestId = String(notification.id)
                    ws.send(jsonStringify({
                      type: 'permission_request',
                      request_id: requestId,
                      data: {
                        tool_name: toolCall?.title || toolCall?.kind || 'unknown',
                        tool_use_id: toolCall?.toolCallId || '',
                        description: toolCall?.title || '',
                        input: toolCall?.rawInput || {},
                        options: (options || []).map(o => ({
                          id: o.optionId as string || '',
                          name: o.name as string || '',
                        })),
                      },
                    }))
                  } else if (notification.jsonrpc === '2.0' && notification.method === 'session/update' && ws.readyState === WebSocket.OPEN) {
                    const params = notification.params as Record<string, unknown> | undefined
                    const update = params?.update as Record<string, unknown> | undefined
                    const msgId = nextMsgId()

                    if (update) {
                      const sessionUpdate = update.sessionUpdate as string
                      // Same handling as above - all types
                      if (sessionUpdate === 'agent_message_chunk') {
                        const content = update.content as Record<string, unknown>
                        ws.send(jsonStringify({
                          type: 'start',
                          msg_id: msgId,
                        }))
                        ws.send(jsonStringify({
                          type: 'content',
                          msg_id: msgId,
                          data: content.text || '',
                        }))
                      } else if (sessionUpdate === 'agent_thought_chunk') {
                        const content = update.content as Record<string, unknown>
                        ws.send(jsonStringify({
                          type: 'thought',
                          msg_id: msgId,
                          data: content.text || '',
                        }))
                      } else if (sessionUpdate === 'tool_call') {
                        ws.send(jsonStringify({
                          type: 'tool_call',
                          msg_id: msgId,
                          data: {
                            tool_name: update.title || update.kind || 'unknown',
                            tool_use_id: update.toolCallId || '',
                            input: update.rawInput || {},
                            kind: update.kind || 'other',
                            status: update.status || 'pending',
                          },
                        }))
                      } else if (sessionUpdate === 'tool_call_update') {
                        ws.send(jsonStringify({
                          type: 'tool_call_update',
                          msg_id: msgId,
                          data: {
                            tool_use_id: update.toolCallId || '',
                            status: update.status || 'running',
                            output: typeof update.rawOutput === 'string' ? update.rawOutput :
                                    update.rawOutput ? jsonStringify(update.rawOutput) : '',
                          },
                        }))
                      } else if (sessionUpdate === 'permission_request') {
                        const toolCall = update.toolCall as Record<string, unknown> | undefined
                        const options = update.options as Array<Record<string, unknown>> | undefined
                        const requestId = update.requestId as string | undefined
                        ws.send(jsonStringify({
                          type: 'permission_request',
                          request_id: requestId || msgId,
                          data: {
                            tool_name: toolCall?.title || '',
                            tool_use_id: toolCall?.toolCallId || '',
                            description: toolCall?.title || '',
                            input: toolCall?.rawInput || {},
                            options: (options || []).map(o => ({
                              id: o.optionId as string || '',
                              name: o.name as string || '',
                            })),
                          },
                        }))
                      } else if (sessionUpdate === 'plan') {
                        ws.send(jsonStringify({
                          type: 'plan',
                          msg_id: msgId,
                          data: { entries: update.entries || [] },
                        }))
                      } else if (sessionUpdate === 'message_stopped') {
                        ws.send(jsonStringify({
                          type: 'finish',
                          msg_id: msgId,
                          stop_reason: update.stopReason,
                        }))
                      } else if (sessionUpdate === 'usage_update') {
                        ws.send(jsonStringify({
                          type: 'context_usage',
                          msg_id: msgId,
                          data: { used: update.used, size: update.size },
                        }))
                      } else if (sessionUpdate === 'error') {
                        ws.send(jsonStringify({
                          type: 'error',
                          msg_id: msgId,
                          data: {
                            message: update.message || 'Unknown error',
                            code: update.code || undefined,
                          },
                        }))
                      }
                    }
                  }
                }
                // stdout from daemon (non-JSON lines)
                else if (parsed.type === 'stdout' && typeof parsed.line === 'string') {
                  // Check if this is an ACP response
                  try {
                    const acpParsed = jsonParse(parsed.line) as { jsonrpc?: string; id?: string; result?: unknown; error?: { message?: string } }
                    if (acpParsed.jsonrpc === '2.0' && acpParsed.id) {
                      const pending = pendingAcpResponses.get(acpParsed.id)
                      if (pending) {
                        pendingAcpResponses.delete(acpParsed.id)
                        if (acpParsed.error) {
                          pending.reject(new Error(acpParsed.error.message || 'ACP error'))
                        } else {
                          pending.resolve(acpParsed.result)
                        }
                      }
                    } else if (ws.readyState === WebSocket.OPEN) {
                      // Not an ACP response, forward to client
                      ws.send(parsed.line)
                    }
                  } catch {
                    // Not valid JSON, forward to client
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(parsed.line)
                    }
                  }
                }
                else if (parsed.type === 'exit') {
                  ws.close()
                }
              }
            })

            runnerSocket.on('close', () => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.close()
              }
            })
            runnerSocket.on('error', () => {
              if (ws.readyState === WebSocket.OPEN) {
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
      resolvePort(typeof address === 'object' && address ? address.port : null)
    })
  })

  server.listen(config.port, config.host)

  return {
    port: null,
    ready,
    stop: async () => {
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
