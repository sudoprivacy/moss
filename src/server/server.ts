import http from 'http'
import net from 'net'
import { existsSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { dirname, extname, join, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
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
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'

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
        wss.handleUpgrade(req, socket, head, ws => {
          void runtime.connectToAttempt(ready.attempt).then((runnerSocket: net.Socket) => {
            let buffer = ''
            const sendToRunner = (payload: Record<string, unknown>) => {
              if (!runnerSocket.destroyed) {
                runnerSocket.write(`${jsonStringify(payload)}\n`)
              }
            }

            ws.on('message', data => {
              const text =
                typeof data === 'string'
                  ? data
                  : Buffer.from(data).toString('utf8')
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
