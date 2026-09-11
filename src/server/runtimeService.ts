import { randomUUID } from 'crypto'
import { accessSync, constants, existsSync } from 'fs'
import { mkdir, readFile, writeFile, open } from 'fs/promises'
import net from 'net'
import os from 'os'
import { delimiter, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { spawn, type ChildProcess } from 'child_process'
import { loadBudgetStats } from './budgetStats.js'
import {
  DirectConnectStore,
  mergeRuntime,
  openDirectConnectStore,
  toSessionSummary,
} from './db.js'
import { AuthService } from './auth/service.js'
import { hasScope } from './auth/token.js'
import type {
  AttemptRecord,
  AttemptRuntimeState,
  DesiredSessionState,
  RunnerManifest,
  ServerConfig,
  SessionCreateInput,
  SessionRecord,
  SessionStatus,
  SessionSummary,
} from './types.js'
import type { VisibilityFilterContext } from './sessionManager.js'
import {
  getAttachPath,
  getAttemptDir,
  isNamedPipePath,
  getLegacyAttachPath,
  getRuntimeStatusPath,
  getRuntimeStderrLogPath,
  getRuntimeStdoutLogPath,
  getSessionConfigDir,
  getSessionWorkspaceDir,
  isSafeSessionCwd,
  getSessionScodeHomeDir,
  getSessionTmpDir,
  getInContainerPidFile,
  getTranscriptPath,
} from './runtimePaths.js'
import { errorMessage } from '../utils/errors.js'
import { getSystemSettings } from './systemSettings.js'
import { getUserModelPreference } from './userModelPreference.js'
import type { AuthProxyServer } from './authProxy/authProxyServer.js'
import {
  appendSharedAgentMemory,
  buildUserProfileMemory,
  readSharedAgentMemory,
  writeAssistantOverrideAgentsMd,
} from './sharedAgentMemory.js'
import { ensureDraftsDirectory } from './draftsCleanup.js'
import type { NexusClient } from './nexus/nexusClient.js'
import {
  openInternalSessionChannel,
  revokeInternalSessionToken,
  type InternalSessionChannel,
} from './internalSessionChannel.js'
import { resolveRuntimeScodePath } from './runtimeScodePath.js'
import { McpStore } from './mcp/db.js'
import { createMcpUserConfigApi, type McpUserConfigApi } from './api/mcpUserConfig.js'
import { resolveScodeMcpSettings } from './mcp/scodeMcpInjector.js'
import { type McpAuthSecretsApi, type ConfigItemLike } from './mcp/authResolver.js'

/** Bounded wait for a protocol-shutdown collection before falling back to fencing. */
const SHUTDOWN_COLLECT_TIMEOUT_MS = 5_000
/** Poll granularity of the background fencing-wait task. */
const FENCING_POLL_INTERVAL_MS = 5_000

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function safeKill0(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isTerminalAttemptState(state: AttemptRecord['runtimeState']): boolean {
  return state === 'stopped' || state === 'failed' || state === 'lost'
}

export type SessionSnapshot = {
  sessionId: string
  status: SessionStatus
  desiredState: DesiredSessionState
  endedAt: number | null
  currentAttemptId: string | null
  attempt?: {
    runtimeState: AttemptRuntimeState
    runnerPid: number | null
    attachPath: string | null
    lastHeartbeatAt: number | null
    stopReason: string | null
    errorText: string | null
  }
}

/**
 * 创建 McpAuthSecretsApi 实现，用于 secret_ref 运行时凭据解析。
 * 复用 DirectConnectStore 已有的 getConfigItemByPinyin / getConfigEntries 方法
 * 和 NexusClient 的 listSecrets 能力。
 */
function createMcpAuthSecretsApi(
  store: DirectConnectStore,
  nexusClient: { listSecrets(namespace: string, subject: string): Promise<Array<{ key: string; value: string | null; namespace: string; status: string; version: number }>> },
  orgId: string,
): McpAuthSecretsApi {
  return {
    async getConfigItemByPinyin(pinyin: string): Promise<ConfigItemLike | null> {
      // Org-scope the lookup so a session only resolves its own org's
      // (non-user) config items; user-scope defs remain global.
      const row = await store.getConfigItemByPinyin(pinyin, orgId)
      if (!row) return null
      const entries = (await store.getConfigEntries(row.id as number))
        .map((e: Record<string, unknown>) => ({ config_key: e.config_key as string }))
      return {
        pinyin: row.pinyin as string,
        scheme: row.scheme as ConfigItemLike['scheme'],
        bearer_prefix: row.bearer_prefix as string | null,
        entries,
      }
    },
    async listSecrets(namespace: string, subject: string) {
      const all = await nexusClient.listSecrets(namespace, subject)
      return all.map(({ key, value }) => ({ key, value }))
    },
  }
}

/** Copy of ServerConfig with credential-bearing fields removed, for anything
 *  persisted to shared storage (runner manifest.json). The runner child
 *  re-reads MOSS_DATABASE_URL from its inherited environment. */
function sanitizeConfigForManifest(config: ServerConfig): ServerConfig {
  const { databaseUrl: _stripped, ...rest } = config
  void _stripped
  return rest as ServerConfig
}

function resolveRunnerPath(): string {
  const fromEnv = process.env.MOSS_SESSION_RUNNER_PATH
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv
  }
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(currentDir, 'direct-connect-session-runner.mjs'),
    join(currentDir, '..', '..', 'bin', 'direct-connect-session-runner.mjs'),
    join(process.cwd(), 'direct-connect-session-runner.mjs'),
    join(process.cwd(), 'bin', 'direct-connect-session-runner.mjs'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error('Missing direct-connect-session-runner.mjs. Run bun run build:node first.')
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!candidate || !existsSync(candidate)) return false
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveFromPath(command: string): string | null {
  const pathValue = process.env.PATH ?? ''
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`)
      if (isExecutableFile(candidate)) {
        return candidate
      }
    }
  }
  return null
}

function resolveRunnerRuntimePath(): string {
  const candidates = [
    process.env.MOSS_NODE_PATH,
    process.env.NODE_BINARY,
    process.execPath,
    process.argv[0],
    resolveFromPath('node'),
    resolveFromPath('bun'),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    join(os.homedir(), '.bun', 'bin', 'bun'),
  ]

  for (const candidate of candidates) {
    if (candidate && isExecutableFile(candidate)) {
      return candidate
    }
  }

  throw new Error(
    `Failed to find a usable Node.js runtime for session runner. ` +
      `Set MOSS_NODE_PATH to a valid node executable. process.execPath=${process.execPath}`,
  )
}

async function spawnSessionRunner(
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
): Promise<ChildProcess> {
  return await new Promise<ChildProcess>((resolve, reject) => {
    const child = spawn(command, args, options)

    child.once('error', error => {
      reject(new Error(`Failed to spawn session runner with ${command}: ${errorMessage(error)}`))
    })
    child.once('spawn', () => {
      child.on('error', error => {
        process.stderr.write(
          `[RuntimeService] session runner process error (pid=${child.pid ?? 'unknown'}): ${errorMessage(error)}\n`,
        )
      })
      resolve(child)
    })
  })
}

async function readRunnerFailure(
  statusPath: string,
  stderrLogPath: string,
  includeStderrWithoutStatusError = false,
): Promise<string | null> {
  let statusError: string | null = null
  try {
    if (existsSync(statusPath)) {
      const raw = await readFile(statusPath, 'utf8')
      const parsed = JSON.parse(raw) as {
        state?: string
        error?: string
        code?: number | null
        signal?: string | null
      }
      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        statusError = parsed.error.trim()
      } else if (
        parsed.state === 'failed' ||
        (typeof parsed.code === 'number' && parsed.code !== 0)
      ) {
        statusError = `Runner failed before attach (code=${parsed.code ?? 'null'}, signal=${parsed.signal ?? 'null'})`
      }
    }
  } catch (err) {
    // Status file may not exist or be malformed - this is expected during normal startup
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[readRunnerFailure] Failed to read status file:', err)
    }
  }

  let stderrTail: string | null = null
  try {
    if (existsSync(stderrLogPath)) {
      const stderr = (await readFile(stderrLogPath, 'utf8')).trim()
      if (stderr) {
        const lines = stderr.split('\n')
        stderrTail = lines.slice(-20).join('\n').trim() || null
      }
    }
  } catch (err) {
    // Stderr log may not exist - this is expected
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[readRunnerFailure] Failed to read stderr log:', err)
    }
  }

  if (statusError && stderrTail) {
    return `${statusError}\n${stderrTail}`
  }
  if (statusError) {
    return statusError
  }
  return includeStderrWithoutStatusError ? stderrTail : null
}

async function waitForRunnerReady(
  attachPath: string,
  statusPath: string,
  stderrLogPath: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - start)
    if (await probeAttachPath(attachPath, Math.max(100, Math.min(remainingMs, 250)))) {
      return
    }
    const failure = await readRunnerFailure(statusPath, stderrLogPath)
    if (failure) {
      throw new Error(failure)
    }
    await wait(100)
  }
  const failure = await readRunnerFailure(statusPath, stderrLogPath, true)
  if (failure) {
    throw new Error(failure)
  }
  throw new Error(`Timed out waiting for runner socket at ${attachPath}`)
}

export async function probeAttachPath(
  attachPath: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!isNamedPipePath(attachPath) && !existsSync(attachPath)) {
    return false
  }
  return await new Promise<boolean>(resolve => {
    const socket = net.createConnection(attachPath)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

type RuntimeServiceOptions = {
  config: ServerConfig
  store?: DirectConnectStore
  authService: AuthService
  serverInstanceId: string
  /**
   * 主进程独占的密钥客户端。提供时启用"会话下发用户已安装 MCP"功能；
   * 缺省则跳过 MCP 注入（如测试或无 nexus 环境），不影响会话其余功能。
   */
  nexusClient?: NexusClient
}

/**
 * Thrown by createSession/spawnAttempt when the server is draining (post-SIGTERM
 * grace window). Mapped to HTTP 503 by server.ts writeError so the LB / caller
 * sees "instance unavailable" instead of a session being spun up on an instance
 * about to exit. Defined here (not server.ts) so RuntimeService can throw it
 * without a server.ts → runtimeService.ts circular import.
 */
/**
 * The attempt is being taken over (its previous owner died but the detached
 * runner's heartbeat is still fresh — fencing needs up to one heartbeat
 * interval plus the expiry window before a respawn is safe). Foreground
 * callers fail fast with 503; a background fencing-wait task drives the
 * respawn (see #scheduleFencingWait).
 */
export class AttemptTakeoverPendingError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} is being taken over, retry shortly`)
    this.name = 'AttemptTakeoverPendingError'
  }
}

export class ServerDrainingError extends Error {
  constructor(message = 'server is draining, not accepting new sessions') {
    super(message)
    this.name = 'ServerDrainingError'
  }
}

export class RuntimeService {
  readonly store: DirectConnectStore
  readonly authService: AuthService
  private readonly mcpStore: McpStore | null
  private readonly mcpUserConfig: McpUserConfigApi | null
  private readonly pendingEnsures = new Map<string, Promise<AttemptRecord>>()
  /** Dedup set for in-flight background fencing-wait tasks (per sessionId). */
  readonly #fencingWaits = new Set<string>()
  private readonly sessionTokens = new Map<string, { token: string; pid: number }>()
  authProxy: AuthProxyServer | null = null
  /**
   * Graceful-drain flag (multi-instance LB). Set true by server.ts beginDrain()
   * on SIGTERM. While true, createSession/spawnAttempt reject with
   * ServerDrainingError (no new runner on an exiting instance) and
   * adoptOrphanedSessions no-ops (don't take over orphans we can't keep serving).
   * Reconnects to already-running local attempts still pass (they never reach
   * spawnAttempt). Default false → single-instance behavior unchanged.
   */
  draining = false

  constructor(private readonly options: RuntimeServiceOptions) {
    if (!options.store && options.config.dbBackend === 'postgres') {
      // Never silently fall back to a local sqlite file when the deployment
      // expects the shared PG database — that split-brain would be invisible
      // until data goes missing. The async openStoreAsync() path must be used.
      throw new Error(
        'postgres backend requires a store opened via openStoreAsync(); pass options.store',
      )
    }
    this.store = options.store ?? openDirectConnectStore(options.config)
    this.authService = options.authService
    if (options.nexusClient) {
      this.mcpStore = new McpStore(this.store.driver)
      this.mcpUserConfig = createMcpUserConfigApi({
        nexusClient: options.nexusClient,
        mcpStore: this.mcpStore,
        getUserByIdAndOrg: async (userId: string, _orgId: string) => {
          try {
            const u = await this.authService.getUserById(userId)
            if (!u) return null
            return { role: 'user', departmentId: u.departmentId }
          } catch {
            return null
          }
        },
        listDepartmentsByOrg: async (orgId: string) => {
          try {
            return (await this.authService.listDepartments(orgId)).departments
          } catch {
            return []
          }
        },
      })
    } else {
      this.mcpStore = null
      this.mcpUserConfig = null
    }
  }

  async listSessions(filter: {
    orgId: string
    userId?: string
    activeOnly?: boolean
  }): Promise<SessionSummary[]> {
    return this.store.listSessions({
      orgId: filter.orgId,
      userId: filter.userId,
      activeOnly: filter.activeOnly,
    })
  }

  async listSessionRecords(filter: {
    orgId: string
    userId?: string
    activeOnly?: boolean
  }): Promise<SessionRecord[]> {
    return this.store.listSessionRecords({
      orgId: filter.orgId,
      userId: filter.userId,
      activeOnly: filter.activeOnly,
    })
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.store.getSession(sessionId)
  }

  /**
   * Read-only session + current-attempt snapshot for cabin recovery classification.
   * Never mutates runtime state. Returns null when the session id is unknown, which
   * the caller must treat as "replace" (mint a fresh session), never "reuse".
   */
  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    const session = await this.store.getSession(sessionId)
    if (!session) return null
    const attempt = session.currentAttemptId
      ? await this.store.getAttempt(session.currentAttemptId)
      : null
    return {
      sessionId: session.sessionId,
      status: session.status,
      desiredState: session.desiredState,
      endedAt: session.endedAt,
      currentAttemptId: session.currentAttemptId,
      attempt: attempt
        ? {
            runtimeState: attempt.runtimeState,
            runnerPid: attempt.runnerPid,
            attachPath: attempt.attachPath,
            lastHeartbeatAt: attempt.lastHeartbeatAt,
            stopReason: attempt.stopReason,
            errorText: attempt.errorText,
          }
        : undefined,
    }
  }

  async countActiveSessions(): Promise<number> {
    return this.store.countActiveSessions()
  }

  async createSession(input: SessionCreateInput): Promise<SessionRecord> {
    // Graceful drain: reject before writing any session row (avoids a stranded
    // status='failed' half-created record that spawnAttempt-level rejection
    // would leave behind).
    if (this.draining) throw new ServerDrainingError()
    const active = await this.store.listSessions({
      orgId: input.orgId,
      activeOnly: true,
    })
    if (
      this.options.config.maxSessions > 0 &&
      active.length >= this.options.config.maxSessions
    ) {
      throw new Error(
        `Maximum concurrent sessions reached (${this.options.config.maxSessions})`,
      )
    }

    // Token Quota Enforcement (System wide / User specific / Department specific)
    const [budgetStats, limits] = await Promise.all([
      loadBudgetStats(await this.store.listUserSessions(input.orgId, input.userId)),
      this.authService.getTokenLimits(input.userId, input.orgId)
    ])
    const totalTokensUsed = budgetStats.summary.totalTokens

    // 1. Check User Limit
    if (limits.userLimit !== null && totalTokensUsed >= limits.userLimit) {
      throw new Error(`个人 Token 额度已用尽 (已用: ${totalTokensUsed.toLocaleString()}, 限额: ${limits.userLimit.toLocaleString()})`)
    }

    // 2. Check Department Limit (Aggregate usage for all users in department)
    if (limits.departmentLimit !== null) {
      const user = await this.authService.getUserOrNull(input.userId, input.orgId)
      if (user?.departmentId) {
        // This is a simple heuristic: list sessions, then filter by those users who belong to the same department.
        // In a real high-scale system, this should be a DB join or aggregate table.
        const allOrgSessions = await this.store.listSessionRecords({ orgId: input.orgId })
        // Resolve each DISTINCT user once: active orgs routinely have many
        // sessions per user, and a per-session getUserOrNull multiplies the
        // lookups (a network round-trip each on the postgres backend).
        const uniqueUserIds = [...new Set(allOrgSessions.map(s => s.userId))]
        const usersById = new Map(
          await Promise.all(
            uniqueUserIds.map(id =>
              this.authService.getUserOrNull(id, input.orgId).then(u => [id, u] as const),
            ),
          ),
        )
        const deptSessions = allOrgSessions.filter(
          s => usersById.get(s.userId)?.departmentId === user.departmentId,
        )
        const deptStats = await loadBudgetStats(deptSessions)
        const deptTotalUsed = deptStats.summary.totalTokens
        if (deptTotalUsed >= limits.departmentLimit) {
          throw new Error(`部门 Token 额度已用尽 (已用: ${deptTotalUsed.toLocaleString()}, 限额: ${limits.departmentLimit.toLocaleString()})`)
        }
      }
    }

    const sessionId = randomUUID()
    let runtimeInput = input.runtime
    const runtimeType = input.runtime?.type || this.options.config.defaultRuntime

    // Let agent memory_mode decide the initial dockerMode/configDir when the
    // caller did not explicitly choose one. Otherwise the global default
    // dockerMode=session gets baked into the session too early and overrides
    // memory_mode=user.
    if (input.assistantName) {
      try {
        const { getAssistantRuntimeConfig } = await import(
          './backends/backendUtils.js'
        )
        const assistantRuntime = await getAssistantRuntimeConfig(
          input.assistantName,
        )
        if (
          runtimeType === 'docker' &&
          input.runtime?.dockerMode === undefined
        ) {
          runtimeInput = {
            ...runtimeInput,
            dockerMode: assistantRuntime.memoryMode,
          }
        }
        if (
          runtimeType === 'host' &&
          input.runtime?.hostMode === undefined
        ) {
          runtimeInput = {
            ...runtimeInput,
            hostMode: assistantRuntime.memoryMode,
          }
        }
      } catch (error) {
        console.warn(
          `[RuntimeService] failed to resolve assistant memory_mode for ${input.assistantName}:`,
          error,
        )
      }
    }

    // A caller-supplied cwd is bind-mounted into the runtime container, so a
    // path like moss-server's own /app would expose every session's transcript,
    // manifest (JWTs included) and moss.db to the agent — and make the workspace
    // shared, which collapses scode's per-workspace session store into one
    // bucket that assistants read each other's history out of. Fall back to the
    // isolated per-session workspace when the request asks for such a path.
    const sessionWorkspaceDir = getSessionWorkspaceDir(this.options.config, sessionId)
    let workspaceDir = sessionWorkspaceDir
    if (input.cwd) {
      if (isSafeSessionCwd(this.options.config, input.cwd)) {
        workspaceDir = input.cwd
      } else {
        console.warn(
          `[RuntimeService] refusing unsafe session cwd ${input.cwd} for ${sessionId}; using ${sessionWorkspaceDir}`,
        )
      }
    }
    await mkdir(workspaceDir, { recursive: true })
    await ensureDraftsDirectory(workspaceDir)

    const runtime = mergeRuntime(this.options.config, runtimeInput)
    runtime.configDir =
      runtime.configDir ||
      getSessionConfigDir(
        this.options.config,
        sessionId,
        input.userId,
        runtime.type === 'docker'
          ? runtime.dockerMode
          : runtime.hostMode || 'session',
      )
    const transcriptPath = getTranscriptPath(
      this.options.config.runtimeDir,
      sessionId,
      sessionId,
    )
    await mkdir(dirname(transcriptPath), { recursive: true })
    const created = await this.store.createSession({
      sessionId,
      transcriptSessionId: sessionId,
      transcriptPath,
      userId: input.userId,
      orgId: input.orgId,
      role: input.role,
      scopes: input.scopes,
      cwd: workspaceDir,
      runtime,
      status: 'creating',
      desiredState: 'active',
      assistantName: input.assistantName,
      source: input.source,
      channelChatId: input.channelChatId,
    })

    // Ensure config directory exists for scode sessions (which don't use session-runner which normally creates it)
    if (runtime.engine === 'scode') {
      try {
        await mkdir(runtime.configDir!, { recursive: true })
      } catch (err) {
        // Directory may already exist or parent may be read-only
        console.warn('[RuntimeService] Failed to create config directory:', runtime.configDir, err)
      }
    }

    try {
      await this.spawnAttempt(created, {
        dangerouslySkipPermissions: input.dangerouslySkipPermissions,
        assistantName: input.assistantName,
        assistantDisplayName: input.assistantDisplayName,
        enabledSkills: input.enabledSkills,
      })
    } catch (error) {
      await this.store.markSessionEnded(created.sessionId, 'failed', 'active')
      throw error
    }
    return (await this.store.getSession(created.sessionId)) ?? created
  }

  async ensureSessionReady(
    sessionId: string,
  ): Promise<{
    session: SessionRecord
    attempt: AttemptRecord
  }> {
    const session = await this.store.getSession(sessionId)
    if (!session) {
      throw new Error('Session not found')
    }
    const attempt = await this.ensureAttempt(session)
    return { session: (await this.store.getSession(sessionId)) ?? session, attempt }
  }

  /**
   * Non-blocking variant of ensureSessionReady used by the session-detail GET.
   *
   * For a Docker runtime, respawning a dead session means a cold `docker run`
   * (container create + scode boot inside) that can take many seconds — far
   * longer than the runner-ready timeout in some cases. Awaiting that on the
   * HTTP request makes opening an old session "hang for a long time, if not
   * forever". Instead we:
   *   - probe the existing attach socket quickly; if it's live, return active.
   *   - otherwise mark the session 'creating', kick the respawn off in the
   *     background (deduped via pendingEnsures, same as ensureAttempt), and
   *     return immediately. The client then connects/polls the ws_url and the
   *     status flips to 'active' once the runtime is back.
   */
  async ensureSessionReadyNonBlocking(
    sessionId: string,
  ): Promise<{ session: SessionRecord }> {
    const session = await this.store.getSession(sessionId)
    if (!session) {
      throw new Error('Session not found')
    }

    const existing = session.currentAttemptId
      ? await this.store.getAttempt(session.currentAttemptId)
      : null
    if (
      existing &&
      !isTerminalAttemptState(existing.runtimeState) &&
      existing.serverInstanceId !== this.options.serverInstanceId
    ) {
      // Owned by ANOTHER instance: never probe its (remote-host) socket and
      // never kick a local respawn from a GET. Live owner → metadata already
      // reflects an active session served there (ws_url carries the owner
      // route). Dead owner → the adopt timer / foreground ensure paths own
      // the takeover (with fencing), not this non-blocking read.
      return { session: (await this.store.getSession(sessionId)) ?? session }
    }
    if (existing?.attachPath && !isTerminalAttemptState(existing.runtimeState)) {
      const healthy = await probeAttachPath(
        existing.attachPath,
        // Fast probe only — never block the GET on a slow/dead socket.
        Math.min(this.options.config.reattachProbeTimeoutMs, 500),
      )
      if (healthy) {
        await this.store.setSessionLifecycle(
          session.sessionId,
          'active',
          session.desiredState,
        )
        return { session: (await this.store.getSession(sessionId)) ?? session }
      }
    }

    // Runtime is missing/dead — schedule a background respawn unless one is
    // already in flight, and reflect the transitional state to the client.
    if (!this.pendingEnsures.has(session.sessionId)) {
      await this.store.setSessionLifecycle(session.sessionId, 'creating', 'active')
      void this.ensureAttempt(session).catch(async error => {
        await this.store.addEvent(
          session.sessionId,
          session.currentAttemptId,
          'reconcile_failed',
          { error: errorMessage(error) },
        )
      })
    }
    return { session: (await this.store.getSession(sessionId)) ?? session }
  }

  /**
   * Concurrent multi-instance HA: adopt sessions orphaned by a dead instance.
   * Run periodically. For each orphan, atomically claim its attempt (skip if
   * another surviving instance claimed it first) and make it ready under our
   * ownership — `ensureSessionReadyNonBlocking` reattaches to a still-alive
   * scode/pod or respawns. This is what turns startup-only recovery into live
   * failover: when an instance dies, a survivor picks up its sessions within a
   * heartbeat timeout instead of on the next restart.
   */
  async adoptOrphanedSessions(): Promise<void> {
    // Graceful drain: an exiting instance must not take over other instances'
    // orphans — it can't keep serving them, and would just turn them into
    // orphans again on exit. Heartbeat continues (owned attempts stay ours).
    if (this.draining) return
    let orphans: SessionRecord[]
    try {
      orphans = await this.store.listOrphanedActiveSessions(
        this.options.serverInstanceId,
        this.options.config.heartbeatTimeoutMs,
      )
    } catch (err) {
      process.stderr.write(
        `[RuntimeService] listOrphanedActiveSessions failed: ${errorMessage(err)}\n`,
      )
      return
    }
    for (const session of orphans) {
      const attemptId = session.currentAttemptId
      if (!attemptId) continue
      // Atomically adopt; another survivor may have claimed it first.
      if (
        !(await this.store.claimAttempt(
          attemptId,
          this.options.serverInstanceId,
          this.options.config.heartbeatTimeoutMs,
        ))
      ) {
        continue
      }
      await this.store.addEvent(session.sessionId, attemptId, 'adopted_orphan_session', {
        byInstance: this.options.serverInstanceId,
      })
      try {
        await this.ensureSessionReadyNonBlocking(session.sessionId)
      } catch (err) {
        await this.store.addEvent(session.sessionId, attemptId, 'adopt_recover_failed', {
          error: errorMessage(err),
        })
      }
    }
  }

  /**
   * k8s orphan sweep: reap pods + per-session Secrets left behind when teardown
   * never ran (runner crash, node reboot). The keep-set is every session we'd
   * recover (`listSessionsToRecover`); any `app=moss-scode` pod/Secret whose
   * session-id label is not in that set is deleted. Gated on k8s being the
   * active default runtime so non-k8s hosts never shell out to kubectl. Runs on
   * startup and periodically. Best-effort — failures are logged, never thrown.
   */
  async gcOrphanedK8sPods(): Promise<void> {
    if (this.options.config.defaultRuntime !== 'k8s') return
    const k8s = this.options.config.k8s
    if (!k8s) return
    const activeIds = (await this.store.listSessionsToRecover()).map(s => s.sessionId)
    try {
      const { gcOrphanedPods } = await import('./backends/k8sBackend.js')
      const res = await gcOrphanedPods(activeIds, {
        namespace: k8s.namespace,
        kubeconfig: k8s.kubeconfig,
      })
      if (res.deleted.length > 0 || res.deletedSecrets.length > 0) {
        process.stderr.write(
          `[RuntimeService] k8s orphan sweep: reaped ${res.deleted.length} pod(s), ${res.deletedSecrets.length} secret(s)\n`,
        )
      }
    } catch (err) {
      process.stderr.write(
        `[RuntimeService] k8s orphan sweep failed: ${errorMessage(err)}\n`,
      )
    }
  }

  /**
   * Concurrent HA WS affinity: claim an attempt for this instance (confirm our
   * ownership, or adopt a dead owner). Returns false when a live OTHER instance
   * owns it — the WS upgrade path then rejects so the client re-routes to the
   * owner instead of this instance bridging a runner it does not hold.
   */
  async tryOwnAttempt(attemptId: string): Promise<boolean> {
    return this.store.claimAttempt(
      attemptId,
      this.options.serverInstanceId,
      this.options.config.heartbeatTimeoutMs,
    )
  }

  /**
   * Return a running attempt already owned by this process. The WebSocket path
   * can connect to this socket directly instead of opening a disposable probe
   * connection immediately before the real client connection. Some runners may
   * still be processing that probe disconnect, which can race with the attach.
   */
  async getLocallyOwnedRunningAttempt(attemptId: string): Promise<AttemptRecord | null> {
    const attempt = await this.store.getAttempt(attemptId)
    if (
      attempt?.serverInstanceId === this.options.serverInstanceId
      && attempt.runtimeState === 'running'
      && attempt.attachPath
    ) {
      return attempt
    }
    return null
  }

  async reconcileOnStartup(): Promise<void> {
    // Rebuild UserContainerRegistry from `docker ps` before touching sessions
    // so ensureAttempt() reuses existing user containers rather than spawning
    // duplicates. Silent on error — Docker may not be available in this
    // process and that's fine for non-docker sessions.
    try {
      const reg = await import('./runtime/userContainerRegistry.js')
      await reg.reconcile()

      // Optional rollback hatch: force-drain all user containers on startup.
      if (process.env.MOSS_FORCE_DRAIN_USER_CONTAINERS === 'true') {
        process.stderr.write(
          '[RuntimeService] MOSS_FORCE_DRAIN_USER_CONTAINERS=true — draining all user containers\n',
        )
        await reg.shutdownAll(this.options.config)
      }
    } catch (err) {
      process.stderr.write(
        `[RuntimeService] userContainerRegistry reconcile failed: ${errorMessage(err)}\n`,
      )
    }

    // Clean stale attempt rows. An attempt sitting in 'starting/running/
    // detached' whose runner_pid is no longer alive on this host means the
    // runner died (or was killed) without its onExit handler completing the
    // DB write. The site repro showed `runtime_state=running, runner_pid=86`
    // surviving a terminate while host `ps -p 86` returned no such process.
    try {
      const candidates = await this.store.listAttemptsByRuntimeState(['starting', 'running', 'detached'])
      let cleaned = 0
      for (const att of candidates) {
        // Concurrent multi-instance HA: only reap attempts we can own (already
        // ours, unowned, or a dead owner). An attempt owned by a live other
        // instance whose runner_pid is simply not on THIS host must be left
        // alone — reaping it would kill a healthy session on another node.
        if (
          !(await this.store.claimAttempt(
            att.attemptId,
            this.options.serverInstanceId,
            this.options.config.heartbeatTimeoutMs,
          ))
        ) {
          continue
        }
        // No PID at all → cannot have been running.
        // PID present but not alive → runner crashed silently.
        if (att.runnerPid !== null && safeKill0(att.runnerPid)) continue
        await this.store.markAttemptStopped(att.attemptId, {
          runtimeState: 'stopped',
          stopReason: 'stale_on_startup',
          errorText: att.runnerPid === null
            ? 'attempt had no runner_pid recorded'
            : `runner_pid=${att.runnerPid} no longer alive`,
        })
        await this.store.addEvent(att.sessionId, att.attemptId, 'attempt_stale_marked_stopped', {
          runnerPid: att.runnerPid,
          previousState: att.runtimeState,
        })
        cleaned += 1
      }
      if (cleaned > 0) {
        process.stderr.write(
          `[RuntimeService] reconcileOnStartup: marked ${cleaned} stale attempt(s) stopped\n`,
        )
      }
    } catch (err) {
      process.stderr.write(
        `[RuntimeService] stale attempt cleanup failed: ${errorMessage(err)}\n`,
      )
    }

    const sessions = await this.store.listSessionsToRecover()

    // Reap k8s pods/Secrets orphaned by a crash before recovering — anything
    // not backing a session we're about to recover is a leak. No-op unless k8s
    // is the active runtime.
    await this.gcOrphanedK8sPods()

    for (const session of sessions) {
      try {
        // Per-user container mode: probe scode in the container and reap
        // orphan processes before resuming. runner-alive cases reattach via
        // ensureAttempt; runner-dead cases need a clean kill so the next
        // attempt can fresh-spawn.
        const runtimeAny = session.runtime as {
          containerMode?: 'session' | 'user'
          userContainerName?: string
        }
        const attempt = session.currentAttemptId
          ? await this.store.getAttempt(session.currentAttemptId)
          : null
        // Concurrent multi-instance HA: skip sessions whose attempt is owned by
        // a live other instance; adopt (claim) dead-owner/self attempts before
        // recovering so at most one instance ever revives a given session.
        if (
          attempt &&
          !(await this.store.claimAttempt(
            attempt.attemptId,
            this.options.serverInstanceId,
            this.options.config.heartbeatTimeoutMs,
          ))
        ) {
          continue
        }
        const runnerAlive = attempt?.runnerPid
          ? safeKill0(attempt.runnerPid)
          : false
        // Whether any live runtime backs this session. For user containers we
        // also accept an orphan scode (runner died but scode lives → reapable
        // and resumable). Defaults to runnerAlive for non-container sessions.
        let recoverable = runnerAlive
        if (
          runtimeAny.containerMode === 'user' &&
          runtimeAny.userContainerName &&
          this.options.config.runtimeDir
        ) {
          try {
            const { probeContainerSession } = await import(
              './runtime/probeContainerSession.js'
            )
            const probe = await probeContainerSession({
              userContainerName: runtimeAny.userContainerName,
              sessionId: session.sessionId,
              runtimeDirInContainer: this.options.config.runtimeDir,
            })
            if (!runnerAlive && probe.kind === 'alive') {
              // Orphan scode — runner died with stdio. Reap before resume.
              recoverable = true
              const { reapInUserContainer } = await import('./runtime/reaper.js')
              await reapInUserContainer({
                userContainerName: runtimeAny.userContainerName,
                sessionId: session.sessionId,
                graceMs: 0,
              })
              await this.store.addEvent(session.sessionId, attempt?.attemptId ?? null, 'reconcile_orphan_scode', {
                userContainer: runtimeAny.userContainerName,
              })
              const { logRuntimeEvent, logRuntimeMetric } = await import('./runtime/runtimeMetrics.js')
              logRuntimeMetric('reconcile_orphan_scode', {})
              logRuntimeEvent('reconcile_orphan_scode', {
                sessionId: session.sessionId,
                containerName: runtimeAny.userContainerName,
              })
            } else if (probe.kind === 'stale_pid_reuse') {
              await this.store.addEvent(session.sessionId, attempt?.attemptId ?? null, 'reconcile_pid_reuse', {
                pid: probe.pid,
                recordedStartTicks: probe.recordedStartTicks,
                currentStartTicks: probe.currentStartTicks,
              })
              const { logRuntimeEvent, logRuntimeMetric } = await import('./runtime/runtimeMetrics.js')
              logRuntimeMetric('reconcile_pid_reuse', {})
              logRuntimeEvent('reconcile_pid_reuse', {
                sessionId: session.sessionId,
                pid: probe.pid,
              })
            }
          } catch (probeErr) {
            await this.store.addEvent(session.sessionId, attempt?.attemptId ?? null, 'reconcile_probe_failed', {
              error: errorMessage(probeErr),
            })
            const { logRuntimeMetric } = await import('./runtime/runtimeMetrics.js')
            logRuntimeMetric('reconcile_probe_failed', { reason: 'exception' })
          }
        }

        if (!recoverable) {
          // No live runner and no live scode to reattach to. Resurrecting this
          // session would respawn a fresh runner and re-occupy a per-user/global
          // session slot for what is effectively an abandoned session — the
          // root cause of "maxSessionsPerUser exceeded" after restarts. Retire
          // it to the natural-exit terminal state (status=ended, desired=ended)
          // instead: excluded from listSessionsToRecover() so it won't be
          // re-picked, and desired!='active' so the session-detail GET won't
          // silently auto-respawn it — yet POST /sessions/:id/resume still
          // revives it on demand (that route doesn't gate on desired_state).
          await this.store.markSessionEnded(session.sessionId, 'ended', 'ended')
          await this.store.addEvent(session.sessionId, attempt?.attemptId ?? null, 'reconcile_retired_unrecoverable', {
            runnerPid: attempt?.runnerPid ?? null,
            previousStatus: session.status,
            containerMode: runtimeAny.containerMode ?? null,
          })
          const { logRuntimeEvent, logRuntimeMetric } = await import('./runtime/runtimeMetrics.js')
          logRuntimeMetric('reconcile_retired_unrecoverable', {})
          logRuntimeEvent('reconcile_retired_unrecoverable', {
            sessionId: session.sessionId,
            previousStatus: session.status,
          })
          continue
        }

        await this.ensureAttempt(session)
      } catch (error) {
        await this.store.addEvent(session.sessionId, session.currentAttemptId, 'reconcile_failed', {
          error: errorMessage(error),
        })
      }
    }
  }

  /**
   * Revoke this session's auth-proxy token on the instance that minted it
   * (this one). Returns false when there is nothing local to revoke — either
   * the attempt is owned by another instance (its registry holds the token)
   * or this instance restarted since spawning (the registry died with the
   * previous process, so no live token remains anywhere on this host).
   */
  revokeSessionTokenLocally(sessionId: string): boolean {
    const tokenEntry = this.sessionTokens.get(sessionId)
    if (!tokenEntry || !this.authProxy) return false
    this.authProxy.revokeToken(tokenEntry.token)
    this.sessionTokens.delete(sessionId)
    return true
  }

  async terminateSession(sessionId: string): Promise<void> {
    const session = await this.store.getSession(sessionId)
    if (!session) return
    const attempt = await this.store.getCurrentAttempt(sessionId)
    // Revoke auth proxy token. The registry is instance-local (tokens are
    // minted in spawnAttempt on the OWNING instance), so a terminate the LB
    // routed to a non-owner finds nothing local — forward the revoke to the
    // owner via the same owner-aware route the internal WS channel uses. A
    // dead owner needs nothing: its registry died with the process.
    if (this.authProxy && !this.revokeSessionTokenLocally(sessionId)) {
      if (
        attempt?.serverInstanceId &&
        attempt.serverInstanceId !== this.options.serverInstanceId
      ) {
        await revokeInternalSessionToken(
          {
            authService: this.authService,
            store: this.store,
            config: this.options.config,
          },
          session,
          attempt.serverInstanceId,
        )
      }
    }
    await this.store.setSessionLifecycle(sessionId, 'terminated', 'terminated')
    await this.store.addEvent(sessionId, attempt?.attemptId ?? null, 'session_terminate_requested', {})

    if (attempt?.runnerPid) {
      // Ownership guard: terminate is a REST op and can land on ANY instance
      // behind an LB. The stored runnerPid is a pid on the OWNING host —
      // killing it here would hit an unrelated local process with the same
      // pid number. Only kill locally when this instance owns the attempt;
      // otherwise markAttemptStopped (above/below) is the whole story: the
      // remote runner's fenced heartbeat (runtime_state no longer 'running')
      // makes it exit on its own.
      if (attempt.serverInstanceId === this.options.serverInstanceId) {
        try {
          process.kill(attempt.runnerPid, 'SIGTERM')
        } catch (err) {
          // ESRCH = no such process; the runner already exited and our
          // termination signal has nothing to deliver. Other codes are real
          // failures and worth logging.
          if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ESRCH') {
            console.warn('[RuntimeService] Failed to terminate runner process:', err)
          }
        }
      }
    }

    // Always mark the current attempt stopped on terminate. The runner's
    // own onExit handler will also try to mark it; markAttemptStopped is an
    // UPDATE so a second write from the runner side just overwrites with
    // the same terminal state. This covers three failure modes:
    //   - runner already dead (ESRCH on SIGTERM, onExit never runs)
    //   - runner SIGKILL'd before reaching its onExit
    //   - moss-server crashes between SIGTERM and the runner's DB write
    // Without this, DB carries stale runtime_state='running' rows pointing
    // at PIDs that no longer exist (the site repro showed exactly this).
    if (attempt && attempt.runtimeState !== 'stopped' && attempt.runtimeState !== 'failed' && attempt.runtimeState !== 'lost') {
      await this.store.markAttemptStopped(attempt.attemptId, {
        runtimeState: 'stopped',
        stopReason: 'terminated',
      })
    }
  }

  async connectToAttempt(attempt: AttemptRecord): Promise<net.Socket> {
    if (!attempt.attachPath) {
      throw new Error('Attempt has no attach path')
    }
    return await new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(attempt.attachPath)
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
    })
  }

  /**
   * Server-internal channel to a session's runner (HA). Consumers that used
   * to call connectToAttempt directly (channels gateway / cron / event
   * triggers / cabin) must use this instead: the attach unix socket is only
   * reachable on the OWNING instance, while those consumers execute on
   * whichever instance the LB/lease picks. The channel routes to the owner
   * like any external client (internal WS endpoint + owner route) and
   * retries 5xx through the takeover window. The internal endpoint performs
   * the ensure/owner checks on its side, so no ensure is done here.
   */
  async connectInternalChannel(
    sessionId: string,
  ): Promise<InternalSessionChannel> {
    if (!this.options.authService) {
      throw new Error('connectInternalChannel requires authService')
    }
    return openInternalSessionChannel(
      {
        authService: this.options.authService,
        store: this.store,
        config: this.options.config,
      },
      sessionId,
    )
  }

  private async ensureAttempt(session: SessionRecord): Promise<AttemptRecord> {
    const pending = this.pendingEnsures.get(session.sessionId)
    if (pending) {
      return pending
    }

    const ensurePromise = this.ensureAttemptInternal(session).finally(() => {
      if (this.pendingEnsures.get(session.sessionId) === ensurePromise) {
        this.pendingEnsures.delete(session.sessionId)
      }
    })
    this.pendingEnsures.set(session.sessionId, ensurePromise)
    return ensurePromise
  }

  private async ensureAttemptInternal(
    session: SessionRecord,
  ): Promise<AttemptRecord> {
    const existing = session.currentAttemptId
      ? await this.store.getAttempt(session.currentAttemptId)
      : null
    if (existing?.attachPath) {
      // ---- Owner-aware liveness layering (multi-instance HA) ----
      // Single-instance deployments always take the ownerIsSelf quadrants
      // below (the resolved owner UUID is this process), keeping their
      // current behaviour.
      const ownerIsSelf =
        existing.serverInstanceId === this.options.serverInstanceId

      if (!ownerIsSelf) {
        const { ownerLive } = await this.store.getAttemptOwnerStatus(
          existing.attemptId,
          this.options.config.heartbeatTimeoutMs,
        )
        if (ownerLive) {
          // Owned by another LIVE instance: never probe/mark/spawn here.
          // Metadata consumers (resume/GET) are redirected via the owner
          // route in ws_url; the WS upgrade path 409s before reaching this.
          return existing
        }
        // Owner is dead: try the atomic claim (CAS). A racing survivor may
        // have won already — then behave like the live-owner case.
        const claimed = await this.store.claimAttempt(
          existing.attemptId,
          this.options.serverInstanceId,
          this.options.config.heartbeatTimeoutMs,
        )
        if (!claimed) return existing
        if (this.#attemptHeartbeatFresh(existing)) {
          // Takeover in progress: the previous owner's detached runner is
          // still alive on its host with a fresh heartbeat. Fencing kills
          // it within one heartbeat interval; respawning before its
          // heartbeat expires would double-write the transcript/DB.
          this.#scheduleFencingWait(session)
          throw new AttemptTakeoverPendingError(session.sessionId)
        }
        // Claimed and the old runner is already dead — fall through to the
        // probe/respawn path below (now as owner).
      }

      const healthy = await probeAttachPath(
        existing.attachPath,
        this.options.config.reattachProbeTimeoutMs,
      )
      if (healthy) {
        await this.store.setSessionLifecycle(session.sessionId, 'active', session.desiredState)
        return existing
      }

      if (ownerIsSelf && this.#attemptHeartbeatFresh(existing)) {
        // Self-owned, DB-stored attachPath unreachable, runner heartbeat
        // still fresh. Try the legacy (pre-socket-decoupling) name
        // defensively: a detached runner from before an upgrade still
        // listens there. If reachable, collect it with a protocol-level
        // shutdown — confirmed exit lets us respawn immediately (no need to
        // wait out the heartbeat: this is direct confirmation, not
        // inference). Never recompute the primary path live; the DB value
        // IS the runner's listening name.
        const legacyPath = getLegacyAttachPath(
          this.options.config,
          session.sessionId,
          existing.generation,
        )
        if (legacyPath !== existing.attachPath) {
          const legacyHealthy = await probeAttachPath(
            legacyPath,
            this.options.config.reattachProbeTimeoutMs,
          )
          if (legacyHealthy) {
            const exited = await this.#shutdownRunnerViaSocket(legacyPath)
            if (exited) {
              await this.store.markAttemptLost(existing.attemptId, 'collected via protocol shutdown')
              await this.store.addEvent(session.sessionId, existing.attemptId, 'attempt_lost', {
                reason: 'collected_via_protocol_shutdown',
              })
              await this.store.setSessionLifecycle(session.sessionId, 'lost', 'active')
              // fall through to respawn
              if (!this.options.config.resumeOnMissingRuntime) {
                throw new Error(`Runtime missing for session ${session.sessionId}`)
              }
              return await this.spawnAttempt(session, {
                resumeTranscriptSessionId: session.transcriptSessionId,
              })
            }
            // Shutdown timed out (runner wedged after SIGTERM) — same
            // treatment as the unreachable case below.
          }
        }
        // Nothing reachable but the heartbeat is fresh: the runner lives on
        // another host (claim window) or is wedged. Fail fast; the
        // background fencing-wait owns the respawn.
        this.#scheduleFencingWait(session)
        throw new AttemptTakeoverPendingError(session.sessionId)
      }

      await this.store.markAttemptLost(existing.attemptId, 'attach socket unavailable')
      await this.store.addEvent(session.sessionId, existing.attemptId, 'attempt_lost', {
        reason: 'attach_socket_unavailable',
      })
      await this.store.setSessionLifecycle(session.sessionId, 'lost', 'active')
    }

    if (!this.options.config.resumeOnMissingRuntime) {
      throw new Error(`Runtime missing for session ${session.sessionId}`)
    }

    return await this.spawnAttempt(session, {
      resumeTranscriptSessionId: session.transcriptSessionId,
    })
  }

  /**
   * Fresh = the runner daemon's heartbeat landed within the expiry window.
   * (NULL heartbeat counts as stale — nothing vouches for the runner.)
   */
  #attemptHeartbeatFresh(attempt: AttemptRecord): boolean {
    return (
      attempt.lastHeartbeatAt !== null &&
      Date.now() - attempt.lastHeartbeatAt < this.options.config.heartbeatTimeoutMs
    )
  }

  /**
   * Collect a (locally reachable) runner via the runner protocol: send
   * `shutdown`, wait bounded for the connection to close (= the daemon's
   * exit chain ran). Returns false on timeout — the caller then falls back
   * to the fencing-wait path.
   */
  async #shutdownRunnerViaSocket(attachPath: string): Promise<boolean> {
    try {
      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(attachPath)
        const timer = setTimeout(() => {
          s.destroy()
          reject(new Error('connect timeout'))
        }, this.options.config.reattachProbeTimeoutMs)
        s.once('connect', () => {
          clearTimeout(timer)
          resolve(s)
        })
        s.once('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
      })
      const closed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          socket.destroy()
          resolve(false)
        }, SHUTDOWN_COLLECT_TIMEOUT_MS)
        socket.once('close', () => {
          clearTimeout(timer)
          resolve(true)
        })
        socket.once('error', () => {
          clearTimeout(timer)
          resolve(false)
        })
        socket.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
      })
      return closed
    } catch {
      return false
    }
  }

  /**
   * Background fencing-wait: after a claim, wait out the old runner's
   * heartbeat expiry (fencing makes it exit within one heartbeat; expiry
   * then makes the attempt eligible for respawn), then respawn via
   * ensureAttempt — its pendingEnsures serialisation makes concurrent
   * triggers (multiple foreground 503s, the adopt timer) collapse into one
   * spawn. Fire-and-forget by design; deduped per session.
   */
  #scheduleFencingWait(session: SessionRecord): void {
    if (this.#fencingWaits.has(session.sessionId)) return
    this.#fencingWaits.add(session.sessionId)
    const timeoutMs = this.options.config.heartbeatTimeoutMs * 3
    const startedAt = Date.now()
    const poll = async () => {
      let current: SessionRecord | null = null
      let attempt: AttemptRecord | null = null
      try {
        current = await this.store.getSession(session.sessionId)
        attempt = current?.currentAttemptId
          ? await this.store.getAttempt(current.currentAttemptId)
          : null
      } catch {
        // DB hiccup: release the slot so a later trigger (foreground 503,
        // adopt timer) can schedule a fresh wait instead of this sessionId
        // staying in the set for the rest of the process lifetime.
        this.#fencingWaits.delete(session.sessionId)
        return
      }
      const timedOut = Date.now() - startedAt > timeoutMs
      if (
        !current ||
        !attempt ||
        !this.#attemptHeartbeatFresh(attempt) ||
        timedOut
      ) {
        this.#fencingWaits.delete(session.sessionId)
        if (current && attempt && (!this.#attemptHeartbeatFresh(attempt) || timedOut)) {
          // Timeout with a still-fresh heartbeat = the runner lives but its
          // attach socket is unreachable (e.g. OS tmp-dir cleanup) — the
          // expiry condition can never become true, so fence instead of
          // silently giving up (pre-P2 semantics: mark lost + respawn).
          // markAttemptLost flips runtime_state off 'running'; the runner's
          // fenced heartbeat exits it within one interval, so the respawn
          // pays the same short double-write window a normal failover does.
          if (timedOut && this.#attemptHeartbeatFresh(attempt)) {
            await this.store.markAttemptLost(
              attempt.attemptId,
              'fencing wait timed out (attach unreachable, heartbeat fresh)',
            )
            await this.store.addEvent(current.sessionId, attempt.attemptId, 'attempt_lost', {
              reason: 'fencing_wait_timeout_heartbeat_fresh',
            })
          }
          void this.ensureAttempt(current).catch(async error => {
            await this.store.addEvent(
              current.sessionId,
              attempt.attemptId,
              'reconcile_failed',
              { error: errorMessage(error) },
            )
          })
        }
        return
      }
      setTimeout(poll, FENCING_POLL_INTERVAL_MS).unref?.()
    }
    setTimeout(poll, FENCING_POLL_INTERVAL_MS).unref?.()
  }

  private async spawnAttempt(
    session: SessionRecord,
    options: {
      dangerouslySkipPermissions?: boolean
      resumeTranscriptSessionId?: string
      assistantName?: string
      assistantDisplayName?: string
      enabledSkills?: string[]
    } = {},
  ): Promise<AttemptRecord> {
    // Graceful drain: this is the single choke point every "spin up a new
    // runner / new attempt" path funnels through (createSession, resume cold
    // start, GET respawn, WS cold upgrade, background services). Reconnects to
    // an already-running local attempt reuse the healthy attach earlier and
    // never reach here, so they are unaffected.
    if (this.draining) throw new ServerDrainingError()
    // Effective agent for this attempt. Callers that *create* a session
    // pass `options.assistantName`, but relaunch/reuse paths (e.g. a reused
    // cron session — spawnAttempt is reached via ensureRuntime with only
    // `resumeTranscriptSessionId`) do not. Fall back to the agent stored
    // on the session record so the pre-signed wiki/corp-app token carries the
    // right `assistant_id`, and the wiki / corp-app / shared-memory resolution
    // below still runs. Without this, a reused session signs a token with
    // `assistant_id: null`, which makes every assistant-gated agent endpoint
    // (corp-app send, enabled wikis, …) 403 with "insufficient scope".
    const effectiveAssistantName = options.assistantName ?? session.assistantName ?? undefined
    let assistantDisplayName = options.assistantDisplayName
    if (!assistantDisplayName && effectiveAssistantName) {
      try {
        const { resolveAssistantDisplayName } = await import('./agentStore.js')
        assistantDisplayName = await resolveAssistantDisplayName(effectiveAssistantName)
      } catch {
        assistantDisplayName = effectiveAssistantName
      }
    }

    const generation = await this.store.getNextGeneration(session.sessionId)
    const attemptDir = getAttemptDir(this.options.config, session.sessionId, generation)
    const attachPath = getAttachPath(this.options.config, session.sessionId, generation)
    const stdoutLogPath = getRuntimeStdoutLogPath(
      this.options.config,
      session.sessionId,
      generation,
    )
    const stderrLogPath = getRuntimeStderrLogPath(
      this.options.config,
      session.sessionId,
      generation,
    )
    const statusPath = getRuntimeStatusPath(
      this.options.config,
      session.sessionId,
      generation,
    )
    await mkdir(attemptDir, { recursive: true })
    const attempt = await this.store.createAttempt({
      sessionId: session.sessionId,
      generation,
      backendType: session.runtime.type,
      resumeTranscriptSessionId:
        options.resumeTranscriptSessionId ?? session.transcriptSessionId,
      serverInstanceId: this.options.serverInstanceId,
      containerName:
        session.runtime.type === 'docker'
          ? `moss-session-${session.sessionId.slice(0, 12)}-g${generation}`
          : undefined,
      attachPath,
    })
    await this.store.setCurrentAttempt(session.sessionId, attempt.attemptId)

    // Resume path: if the session was previously idle-killed (status=ended,
    // desired_state=active, ended_at set), clear those terminal markers so
    // the row reads as a live session again.
    if (session.endedAt !== null || session.status === 'ended' || session.status === 'failed' || session.status === 'lost') {
      await this.store.reactivateSession(session.sessionId)
      await this.store.addEvent(session.sessionId, attempt.attemptId, 'session_reactivated', {
        previousStatus: session.status,
        previousEndedAt: session.endedAt,
      })
    }

    // Force sync global engine config into session runtime for manifest
    session.runtime.engine = this.options.config.engine
    session.runtime.scodePath = resolveRuntimeScodePath(
      this.options.config,
      session.runtime.type,
    )
    if (
      session.runtime.type === 'docker'
      && this.options.config.dockerImage
      && session.runtime.dockerImage !== this.options.config.dockerImage
    ) {
      const previousDockerImage = session.runtime.dockerImage
      session.runtime.dockerImage = this.options.config.dockerImage
      await this.store.updateSessionRuntimeImage(
        session.sessionId,
        this.options.config.dockerImage,
      )
      await this.store.addEvent(
        session.sessionId,
        attempt.attemptId,
        'session_runtime_image_updated',
        {
          previousDockerImage,
          dockerImage: this.options.config.dockerImage,
        },
      )
    }

    // Document Center v2: pre-sign a wiki session token so the
    // in-container `wiki` CLI can authenticate to /api/v1/agent/wikis*.
    // Token TTL matches typical session length (24h default). Best-effort:
    // if signing fails we still spawn (other features don't need this
    // token), but log so it's visible.
    let sessionToken: string | undefined
    try {
      const signed = this.authService.issueWikiSession({
        userId: session.userId,
        orgId: session.orgId,
        role: session.role,
        scopes: session.scopes,
        assistantName: effectiveAssistantName ?? null,
      })
      sessionToken = signed.token
    } catch (err) {
      console.warn(
        `[RuntimeService] failed to sign wiki session token (session=${session.sessionId}):`,
        err,
      )
    }

    // Document Center v2: resolve `enabledWikis` from the bound agent's
    // meta + look up wiki name/description so acpBridge can inject an
    // `[Available Wikis]` block into the first user message. Without this,
    // even though SESSION_TOKEN is set the agent has no idea it can use
    // the `wiki` CLI.
    let availableWikis: Array<{ id: string; name: string; description?: string | null }> | undefined
    let availableCorpApps: Array<{ id: string; name: string; type: string; key: string }> | undefined
    let sharedMemory: string | null = null
    if (effectiveAssistantName) {
      try {
        const { findAssistantDir, readAssistantMeta } = await import('./agentStore.js')
        const found = await findAssistantDir(effectiveAssistantName)
        if (found) {
          const meta = await readAssistantMeta(found.dir)
          const ids = Array.isArray(meta?.enabledWikis)
            ? meta.enabledWikis.filter((v: unknown): v is string => typeof v === 'string')
            : []
          if (ids.length > 0) {
            const { DocumentStore } = await import('./documentStore.js')
            const docStore = new DocumentStore(this.store)
            const collected: Array<{ id: string; name: string; description?: string | null }> = []
            for (const wid of ids) {
              const wiki = await docStore.getWikiById(wid)
              if (wiki && wiki.orgId === session.orgId) {
                collected.push({
                  id: wiki.id,
                  name: wiki.name,
                  description: wiki.description,
                })
              }
            }
            if (collected.length > 0) availableWikis = collected
          }

          // 企业应用管理: resolve `enabledCorpApps` so acpBridge can advertise
          // the `corpapp` CLI + the instance names the agent may use.
          const corpAppIds = Array.isArray(meta?.enabledCorpApps)
            ? meta.enabledCorpApps.filter((v: unknown): v is string => typeof v === 'string')
            : []
          if (corpAppIds.length > 0) {
            const collectedApps: Array<{ id: string; name: string; type: string; key: string }> = []
            for (const appId of corpAppIds) {
              const appRow = await this.store.getCorpApp(appId, session.orgId)
              if (appRow && Number(appRow.enabled ?? 0) === 1) {
                collectedApps.push({
                  id: String(appRow.id),
                  name: String(appRow.name),
                  type: String(appRow.type),
                  key: String(appRow.app_key ?? ''),
                })
              }
            }
            if (collectedApps.length > 0) availableCorpApps = collectedApps
          }

          if (
            meta?.memory_mode === 'user' &&
            session.runtime.configDir &&
            session.userId
          ) {
            const user = await this.authService.getUserOrNull(
              session.userId,
              session.orgId,
            )
            const departmentName = user?.departmentId
              ? (await this.authService
                  .listDepartments(session.orgId))
                  .departments.find(d => d.id === user.departmentId)?.name ?? null
              : null
            const userProfileMemory = buildUserProfileMemory({
              // Prefer the human display name; fall back to the login username.
              userName: user?.displayName?.trim() || user?.name || null,
              role: user?.role ?? null,
              departmentName,
              email: user?.email ?? null,
            })
            if (userProfileMemory) {
              await appendSharedAgentMemory({
                configDir: session.runtime.configDir,
                assistantName: effectiveAssistantName,
                content: userProfileMemory,
                source: 'profile',
              }).catch(() => {})
            }
            sharedMemory = await readSharedAgentMemory(
              session.runtime.configDir,
              effectiveAssistantName,
            )
          }

          if (session.runtime.configDir) {
            await writeAssistantOverrideAgentsMd({
              configDir: session.runtime.configDir,
              // scode reads AGENTS.md from the workspace it runs in, not from configDir —
              // without this the assistant identity never reaches the agent.
              workspace: session.cwd,
              assistantName: effectiveAssistantName,
              assistantDisplayName,
              assistantRules: await import('./agentStore.js').then(m =>
                m.getAssistantSystemPrompt(effectiveAssistantName!),
              ),
              sharedMemory,
            }).catch(err => {
              console.warn(
                `[RuntimeService] failed to write assistant override AGENTS.md for ${effectiveAssistantName}:`,
                err,
              )
            })
          }
        }
      } catch (err) {
        console.warn(
          `[RuntimeService] failed to resolve availableWikis for ${effectiveAssistantName}:`,
          err,
        )
      }
    }

    // Build visibility filter context for skill filtering
    let visibilityFilter: VisibilityFilterContext | null = null
    if (session.userId) {
      const isAdmin =
        session.role === 'admin' ||
        session.role === 'super_admin' ||
        hasScope(session.scopes, '*')
      if (isAdmin) {
        visibilityFilter = { isAdmin: true, userId: session.userId, departmentId: null, visibleDepartmentIds: null }
      } else {
        const user = await this.authService.getUserOrNull(session.userId, session.orgId)
        const departmentId = user?.departmentId ?? null
        const visibleDepartmentIds =
          (await this.authService.getUserDepartmentAncestorIds(
            session.userId,
            session.orgId,
          )) ?? new Set()
        visibilityFilter = { isAdmin: false, userId: session.userId, departmentId, visibleDepartmentIds }
      }
    }

    // Resolve the user's visible MCP servers into scode settings.json shape.
    // Done here (main process) because secret resolution needs nexusClient,
    // which the detached runner can't reach; result travels via manifest.
    let mcpSettings: { mcpServers: Record<string, unknown> } | undefined
    if (session.userId && visibilityFilter && this.mcpStore && this.mcpUserConfig) {
      try {
        const secretsApi = this.store && this.options.nexusClient
          ? createMcpAuthSecretsApi(this.store, this.options.nexusClient, session.orgId)
          : undefined
        const resolvedMcp = await resolveScodeMcpSettings({
          mcpStore: this.mcpStore,
          mcpUserConfig: this.mcpUserConfig,
          secretsApi,
          orgId: session.orgId,
          userId: session.userId,
          departmentId: visibilityFilter.departmentId,
          visibilityFilter,
        })
        if (resolvedMcp) mcpSettings = resolvedMcp
      } catch (err) {
        console.warn(
          `[RuntimeService] failed to resolve MCP settings for session ${session.sessionId}:`,
          err,
        )
      }
    }

    // A1: every session gets its own SUDO_CODE_CONFIG_HOME under runtimeDir so
    // sudocode.json / settings.json never write into a shared configDir.
    const scodeHomeDir = getSessionScodeHomeDir(
      this.options.config.runtimeDir,
      session.sessionId,
    )
    await mkdir(scodeHomeDir, { recursive: true })

    // C2: when containerMode='user' the runner uses `docker exec` into a
    // long-lived user container. Resolve the user container name + per-session
    // helper paths here so the runner can build the exec command without
    // touching UserContainerRegistry (which lives only in the main process).
    const containerMode: 'session' | 'user' =
      (session.runtime as { containerMode?: 'session' | 'user' }).containerMode
      || this.options.config.docker?.containerMode
      || 'session'

    let userContainerName: string | undefined
    let inContainerPidFile: string | undefined
    let tmpDirInContainer: string | undefined

    // Track whether we successfully acquired a refcount for the user
    // container so we can release it on any spawn-side failure between here
    // and the child.once('close') registration below.
    let userContainerAcquired = false
    if (session.runtime.type === 'docker' && containerMode === 'user') {
      const { ensureUserContainer, acquireSession, buildUserContainerName } =
        await import('./runtime/userContainerRegistry.js')
      userContainerName = buildUserContainerName(session.orgId, session.userId)
      inContainerPidFile = getInContainerPidFile(
        this.options.config.runtimeDir,
        session.sessionId,
      )
      tmpDirInContainer = getSessionTmpDir(
        this.options.config.runtimeDir,
        session.sessionId,
      )
      await mkdir(tmpDirInContainer, { recursive: true })
      await mkdir(dirname(inContainerPidFile), { recursive: true })

      try {
        await ensureUserContainer(this.options.config, {
          orgId: session.orgId,
          userId: session.userId,
          role: session.role,
          scopes: session.scopes,
          image: session.runtime.dockerImage,
        })
        await acquireSession(
          session.orgId,
          session.userId,
          session.sessionId,
          this.options.config,
        )
        userContainerAcquired = true
      } catch (err) {
        process.stderr.write(
          `[RuntimeService] ensureUserContainer failed for ${session.userId}: ${errorMessage(err)}\n`,
        )
        throw err
      }
    }

    const releaseGuard = async (reason: string): Promise<void> => {
      if (!userContainerAcquired) return
      userContainerAcquired = false
      try {
        const { releaseSession } = await import('./runtime/userContainerRegistry.js')
        await releaseSession(session.orgId, session.userId, session.sessionId, this.options.config)
        const { logRuntimeMetric } = await import('./runtime/runtimeMetrics.js')
        logRuntimeMetric('release_session_via_child_close', { reason })
      } catch (err) {
        process.stderr.write(
          `[RuntimeService] releaseGuard(${reason}) failed for ${session.sessionId}: ${errorMessage(err)}\n`,
        )
      }
    }

    const manifest: RunnerManifest = {
      // Strip the PG connection string before the config hits shared storage:
      // manifest.json lives on the shared runtime dir, and the URL carries
      // credentials. The runner child re-derives it from the inherited env
      // (MOSS_DATABASE_URL) instead.
      config: sanitizeConfigForManifest(this.options.config),
      session: {
        sessionId: session.sessionId,
        transcriptSessionId:
          options.resumeTranscriptSessionId ?? session.transcriptSessionId,
        resumeFromTranscript: Boolean(options.resumeTranscriptSessionId),
        cwd: session.cwd,
        transcriptPath: session.transcriptPath,
        userId: session.userId,
        orgId: session.orgId,
        role: session.role,
        scopes: session.scopes,
        dangerouslySkipPermissions:
          options.dangerouslySkipPermissions === true,
        assistantName: effectiveAssistantName,
        assistantDisplayName,
        sessionToken,
        availableWikis,
        availableCorpApps,
        sharedMemory,
        enabledSkills: options.enabledSkills,
        visibilityFilter: visibilityFilter ? {
          isAdmin: visibilityFilter.isAdmin,
          userId: visibilityFilter.userId,
          departmentId: visibilityFilter.departmentId,
          visibleDepartmentIds: visibilityFilter.visibleDepartmentIds ? Array.from(visibilityFilter.visibleDepartmentIds) : null,
        } : null,
        ...(mcpSettings ? { mcpSettings } : {}),
        runtime: {
          ...session.runtime,
          containerMode,
          scodeHomeDir,
          ...(userContainerName ? { userContainerName } : {}),
          ...(inContainerPidFile ? { inContainerPidFile } : {}),
          ...(tmpDirInContainer ? { tmpDirInContainer } : {}),
          containerName:
            session.runtime.type === 'docker' && containerMode === 'session'
              ? `moss-session-${session.sessionId.slice(0, 12)}-g${generation}`
              : session.runtime.containerName,
        },
      },
      attempt: {
        attemptId: attempt.attemptId,
        generation,
        runtimeDir: attemptDir,
        attachPath,
        stdoutLogPath,
        stderrLogPath,
        statusPath,
      },
    }

    const manifestPath = join(attemptDir, 'manifest.json')
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    // Build environment for runner from system settings
    const systemSettings = getSystemSettings()

    // Get user model preference in main process (runner doesn't have DB access)
    // Model priority: user preference > system settings > default
    const userModelPref = session.userId ? await getUserModelPreference(session.userId) : null
    const isCabinSession = session.source === 'cabin'
    const defaultModel = isCabinSession
      ? (session.runtime.model || this.options.config.cabin.llmModel)
      : userModelPref?.modelId
      || systemSettings.model
      || process.env.MOSS_DEFAULT_MODEL
      || 'gemini-3-flash-preview'

    process.stderr.write(`[RuntimeService] Model selection for session ${session.sessionId}:\n`)
    process.stderr.write(`  - userId: ${session.userId}\n`)
    process.stderr.write(`  - userModelPref: ${JSON.stringify(userModelPref)}\n`)
    process.stderr.write(`  - systemSettings.model: ${systemSettings.model || 'undefined'}\n`)
    process.stderr.write(`  - defaultModel: ${defaultModel}\n`)

    const runnerEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      MOSS_DEFAULT_MODEL: defaultModel,
    }
    // Pass settings.json env vars to runner
    if (systemSettings.url) {
      runnerEnv.ANTHROPIC_BASE_URL = systemSettings.url
    }
    // A metered deployment keys its credit ledger on a per-user gateway token,
    // so a session must spend the token of the user who owns it. Falling back to
    // the shared server key would bill every user to one account and leave each
    // balance untouched. Users without a token (private / on-prem deployments,
    // where no metered gateway exists) keep the shared key. Resolved here in the
    // main process: the runner subprocess has no database.
    const userModelKey = session.userId
      ? (await this.authService.getUserModelCredential(session.userId))?.sudorouterKey
      : undefined
    const sessionApiKey = userModelKey || systemSettings.apiKey
    if (sessionApiKey) {
      runnerEnv.ANTHROPIC_AUTH_TOKEN = sessionApiKey
      // 同值补设 API_KEY：runner 子进程 buildSessionEnv 的选值链为
      // settings.apiKey || ANTHROPIC_API_KEY || ANTHROPIC_AUTH_TOKEN，显式注入
      // 两个同名值可消除主进程 env 自带 ANTHROPIC_API_KEY 时的优先级翻转
      runnerEnv.ANTHROPIC_API_KEY = sessionApiKey
    }
    if (systemSettings.model) {
      runnerEnv.ANTHROPIC_MODEL = systemSettings.model
    }
    if (isCabinSession) {
      runnerEnv.MOSS_FORCE_ENV_MODEL_CONFIG = '1'
      runnerEnv.MOSS_DEFAULT_MODEL = session.runtime.model || this.options.config.cabin.llmModel
      runnerEnv.ANTHROPIC_BASE_URL = this.options.config.cabin.llmBaseUrl
      runnerEnv.ANTHROPIC_API_KEY = this.options.config.cabin.llmApiKey || process.env.ANTHROPIC_API_KEY || 'local-no-auth'
      runnerEnv.ANTHROPIC_AUTH_TOKEN = runnerEnv.ANTHROPIC_API_KEY
      runnerEnv.PROXY_AUTH_TOKEN = runnerEnv.ANTHROPIC_API_KEY
      runnerEnv.ANTHROPIC_MODEL = runnerEnv.MOSS_DEFAULT_MODEL
      if (this.options.config.cabin.controlBaseUrl) {
        runnerEnv.CABIN_CONTROL_BASE_URL = this.options.config.cabin.controlBaseUrl
      }
      if (this.options.config.cabin.controlAuth) {
        runnerEnv.CABIN_CONTROL_AUTH = this.options.config.cabin.controlAuth
      }
      runnerEnv.CABIN_CONTROL_TIMEOUT_MS = String(this.options.config.cabin.controlTimeoutMs)
      // Intent-first: the skill only emits the structured command; the server performs the
      // hardware dispatch and authors the confirmation. The LLM never triggers hardware.
      runnerEnv.CABIN_CONTROL_MODE = 'emit'
      runnerEnv.CABIN_LOG_FILE = this.options.config.cabin.logFile || join(this.options.config.rootDir, 'logs', 'cabin.jsonl')
    }

    // Inject Auth Proxy token for scode process. The URL must be reachable from
    // wherever the session runs: for the local runner that's loopback, but for
    // the Docker runtime moss-server and the session container are peers on the
    // `moss-network` bridge, so MOSS_AUTH_PROXY_URL should point at the
    // moss-server container by name (e.g. http://moss-server:12013). Defaults to
    // localhost for the non-Docker path.
    if (this.authProxy) {
      const authToken = randomUUID()
      // Session credential-fetch URL. config.authProxyUrl resolves as: env
      // MOSS_AUTH_PROXY_URL → server.json authProxyUrl → null. When null
      // (not explicitly set) the URL is derived from the proxy's actually
      // bound port, so MOSS_AUTH_PROXY_PORT can move without a matching URL
      // edit. HA/Docker/K8s MUST still point this at a container-reachable
      // address (localhost is not reachable from a session container/pod) —
      // those deployments set the URL explicitly.
      const proxyUrl = this.options.config.authProxyUrl
        ?? `http://localhost:${this.authProxy.port}`
      runnerEnv.SUDOWORK_AUTH_PROXY_URL = proxyUrl
      runnerEnv.SUDOWORK_AUTH_PROXY_BASE_URL = proxyUrl
      runnerEnv.SUDOWORK_AUTH_PROXY_TOKEN = authToken
      // Token will be registered after spawn (needs pid)
      this.sessionTokens.set(session.sessionId, { token: authToken, pid: -1 })
    }

    const runnerPath = resolveRunnerPath()
    const runtimePath = resolveRunnerRuntimePath()
    const cwd = (existsSync(session.cwd) ? session.cwd : process.cwd())
    const safeCwd = cwd === '/' ? os.homedir() : cwd

    // Open log files for runner output
    let stdoutFd: Awaited<ReturnType<typeof open>>
    let stderrFd: Awaited<ReturnType<typeof open>>
    try {
      stdoutFd = await open(stdoutLogPath, 'a')
    } catch (err) {
      await releaseGuard('log_open_failed')
      throw err
    }
    try {
      stderrFd = await open(stderrLogPath, 'a')
    } catch (err) {
      // stdout opened but stderr failed — close stdout so it isn't GC-leaked.
      await stdoutFd.close().catch(() => {})
      await releaseGuard('log_open_failed')
      throw err
    }

    let child: ChildProcess
    try {
      child = await spawnSessionRunner(runtimePath, [runnerPath, manifestPath], {
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        cwd: safeCwd,
        env: runnerEnv,
      })
    } catch (err) {
      // Close our copies of the log handles before bailing — the child never
      // inherited them. Leaking a FileHandle to GC is fatal on Node >=26.
      await stdoutFd.close().catch(() => {})
      await stderrFd.close().catch(() => {})
      await releaseGuard('runner_spawn_failed')
      throw err
    }
    // The spawned child has inherited (dup'd) the log fds; close the parent's
    // copies so they aren't left for GC to close, which throws ERR_INVALID_STATE
    // on Node >=26 and crashes the server.
    await stdoutFd.close().catch(() => {})
    await stderrFd.close().catch(() => {})
    child.unref()
    if (!child.pid) {
      await releaseGuard('runner_no_pid')
      throw new Error('Failed to spawn session runner')
    }

    // Register auth proxy token with pid
    if (this.authProxy) {
      const entry = this.sessionTokens.get(session.sessionId)
      if (entry) {
        entry.pid = child.pid
        const tokenUser = await this.authService.getUserById(session.userId)
        const deptId = tokenUser?.departmentId ?? null
        // Admins/super_admins bypass the department-credential policy gate in
        // the auth proxy (full privileges within org / across orgs).
        const isAdmin = tokenUser?.role === 'admin' || tokenUser?.role === 'super_admin'
        this.authProxy.registerToken(entry.token, session.userId, session.orgId, deptId, isAdmin, child.pid)
      }
    }

    await this.store.updateAttemptRunner(attempt.attemptId, child.pid)

    // Release the per-user container session refcount when the runner exits.
    // Only applies in containerMode='user' — session mode never acquired one.
    // releaseGuard is a single-shot, so this fires once whether the runner
    // exits via SIGTERM/idle/busy-ceiling/natural exit/crash.
    if (containerMode === 'user') {
      child.once('close', () => {
        void releaseGuard('child_close')
      })
    }

    try {
      await waitForRunnerReady(attachPath, statusPath, stderrLogPath, 5_000)
    } catch (err) {
      // Runner failed to come up. Its child.once('close') will still fire
      // (the process is going to exit), so releaseGuard runs once. We just
      // propagate the error.
      throw err
    }
    await this.store.setSessionLifecycle(session.sessionId, 'active', 'active')
    await this.store.addEvent(session.sessionId, attempt.attemptId, 'attempt_spawned', {
      runnerPid: child.pid,
      generation,
      attachPath,
    })
    return (await this.store.getAttempt(attempt.attemptId)) ?? attempt
  }
}

export function toSummary(session: SessionRecord): SessionSummary {
  return toSessionSummary(session)
}
