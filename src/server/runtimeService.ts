import { randomUUID } from 'crypto'
import { accessSync, constants, existsSync } from 'fs'
import { mkdir, readFile, writeFile, open } from 'fs/promises'
import net from 'net'
import os from 'os'
import { delimiter, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { spawn, type ChildProcess } from 'child_process'
import { loadBudgetStats } from './budgetStats.js'
import { DirectConnectStore, mergeRuntime, openDirectConnectStore, toSessionSummary } from './db.js'
import { AuthService } from './auth/service.js'
import { hasScope } from './auth/token.js'
import type {
  AttemptRecord,
  RunnerManifest,
  ServerConfig,
  SessionCreateInput,
  SessionRecord,
  SessionSummary,
} from './types.js'
import type { VisibilityFilterContext } from './sessionManager.js'
import {
  getAttachPath,
  getAttemptDir,
  isNamedPipePath,
  getRuntimeStatusPath,
  getRuntimeStderrLogPath,
  getRuntimeStdoutLogPath,
  getSessionConfigDir,
  getSessionWorkspaceDir,
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
import { McpStore } from './mcp/db.js'
import { createMcpUserConfigApi, type McpUserConfigApi } from './api/mcpUserConfig.js'
import { resolveScodeMcpSettings } from './mcp/scodeMcpInjector.js'
import { type McpAuthSecretsApi, type ConfigItemLike } from './mcp/authResolver.js'

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
    getConfigItemByPinyin(pinyin: string): ConfigItemLike | null {
      // Org-scope the lookup so a session only resolves its own org's
      // (non-user) config items; user-scope defs remain global.
      const row = store.getConfigItemByPinyin(pinyin, orgId)
      if (!row) return null
      const entries = store.getConfigEntries(row.id as number)
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

export class RuntimeService {
  readonly store: DirectConnectStore
  readonly authService: AuthService
  private readonly mcpStore: McpStore | null
  private readonly mcpUserConfig: McpUserConfigApi | null
  private readonly pendingEnsures = new Map<string, Promise<AttemptRecord>>()
  private readonly sessionTokens = new Map<string, { token: string; pid: number }>()
  authProxy: AuthProxyServer | null = null

  constructor(private readonly options: RuntimeServiceOptions) {
    this.store = options.store ?? openDirectConnectStore(options.config)
    this.authService = options.authService
    if (options.nexusClient) {
      this.mcpStore = new McpStore(this.store.db)
      this.mcpUserConfig = createMcpUserConfigApi({
        nexusClient: options.nexusClient,
        mcpStore: this.mcpStore,
        getUserByIdAndOrg: (userId: string, _orgId: string) => {
          try {
            const u = this.authService.getUserById(userId)
            if (!u) return null
            return { role: 'user', departmentId: u.departmentId }
          } catch {
            return null
          }
        },
        listDepartmentsByOrg: (orgId: string) => {
          try {
            return this.authService.listDepartments(orgId).departments
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

  listSessions(filter: {
    orgId: string
    userId?: string
    activeOnly?: boolean
  }): SessionSummary[] {
    return this.store.listSessions({
      orgId: filter.orgId,
      userId: filter.userId,
      activeOnly: filter.activeOnly,
    })
  }

  listSessionRecords(filter: {
    orgId: string
    userId?: string
    activeOnly?: boolean
  }): SessionRecord[] {
    return this.store.listSessionRecords({
      orgId: filter.orgId,
      userId: filter.userId,
      activeOnly: filter.activeOnly,
    })
  }

  getSession(sessionId: string): SessionRecord | null {
    return this.store.getSession(sessionId)
  }

  countActiveSessions(): number {
    return this.store.countActiveSessions()
  }

  async createSession(input: SessionCreateInput): Promise<SessionRecord> {
    const active = this.store.listSessions({
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
      loadBudgetStats(this.store.listUserSessions(input.orgId, input.userId)),
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
        const deptSessions = this.store.listSessionRecords({ orgId: input.orgId }).filter(s => {
          // This is a simple heuristic: list sessions, then filter by those users who belong to the same department.
          // In a real high-scale system, this should be a DB join or aggregate table.
          const sessionUser = this.authService.getUserOrNull(s.userId, input.orgId)
          return sessionUser?.departmentId === user.departmentId
        })
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

    // Let assistant memory_mode decide the initial dockerMode/configDir when the
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

    const workspaceDir = input.cwd || getSessionWorkspaceDir(this.options.config, sessionId)
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
    const created = this.store.createSession({
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
      this.store.markSessionEnded(created.sessionId, 'failed', 'active')
      throw error
    }
    return this.store.getSession(created.sessionId) ?? created
  }

  async ensureSessionReady(
    sessionId: string,
  ): Promise<{
    session: SessionRecord
    attempt: AttemptRecord
  }> {
    const session = this.store.getSession(sessionId)
    if (!session) {
      throw new Error('Session not found')
    }
    const attempt = await this.ensureAttempt(session)
    return { session: this.store.getSession(sessionId) ?? session, attempt }
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
    const session = this.store.getSession(sessionId)
    if (!session) {
      throw new Error('Session not found')
    }

    const existing = session.currentAttemptId
      ? this.store.getAttempt(session.currentAttemptId)
      : null
    if (existing?.attachPath && !isTerminalAttemptState(existing.runtimeState)) {
      const healthy = await probeAttachPath(
        existing.attachPath,
        // Fast probe only — never block the GET on a slow/dead socket.
        Math.min(this.options.config.reattachProbeTimeoutMs, 500),
      )
      if (healthy) {
        this.store.setSessionLifecycle(
          session.sessionId,
          'active',
          session.desiredState,
        )
        return { session: this.store.getSession(sessionId) ?? session }
      }
    }

    // Runtime is missing/dead — schedule a background respawn unless one is
    // already in flight, and reflect the transitional state to the client.
    if (!this.pendingEnsures.has(session.sessionId)) {
      this.store.setSessionLifecycle(session.sessionId, 'creating', 'active')
      void this.ensureAttempt(session).catch(error => {
        this.store.addEvent(
          session.sessionId,
          session.currentAttemptId,
          'reconcile_failed',
          { error: errorMessage(error) },
        )
      })
    }
    return { session: this.store.getSession(sessionId) ?? session }
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
      const candidates = this.store.listAttemptsByRuntimeState(['starting', 'running', 'detached'])
      let cleaned = 0
      for (const att of candidates) {
        // No PID at all → cannot have been running.
        // PID present but not alive → runner crashed silently.
        if (att.runnerPid !== null && safeKill0(att.runnerPid)) continue
        this.store.markAttemptStopped(att.attemptId, {
          runtimeState: 'stopped',
          stopReason: 'stale_on_startup',
          errorText: att.runnerPid === null
            ? 'attempt had no runner_pid recorded'
            : `runner_pid=${att.runnerPid} no longer alive`,
        })
        this.store.addEvent(att.sessionId, att.attemptId, 'attempt_stale_marked_stopped', {
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

    const sessions = this.store.listSessionsToRecover()
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
          ? this.store.getAttempt(session.currentAttemptId)
          : null
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
              this.store.addEvent(session.sessionId, attempt?.attemptId ?? null, 'reconcile_orphan_scode', {
                userContainer: runtimeAny.userContainerName,
              })
              const { logRuntimeEvent, logRuntimeMetric } = await import('./runtime/runtimeMetrics.js')
              logRuntimeMetric('reconcile_orphan_scode', {})
              logRuntimeEvent('reconcile_orphan_scode', {
                sessionId: session.sessionId,
                containerName: runtimeAny.userContainerName,
              })
            } else if (probe.kind === 'stale_pid_reuse') {
              this.store.addEvent(session.sessionId, attempt?.attemptId ?? null, 'reconcile_pid_reuse', {
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
            this.store.addEvent(session.sessionId, attempt?.attemptId ?? null, 'reconcile_probe_failed', {
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
          this.store.markSessionEnded(session.sessionId, 'ended', 'ended')
          this.store.addEvent(session.sessionId, attempt?.attemptId ?? null, 'reconcile_retired_unrecoverable', {
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
        this.store.addEvent(session.sessionId, session.currentAttemptId, 'reconcile_failed', {
          error: errorMessage(error),
        })
      }
    }
  }

  async terminateSession(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId)
    if (!session) return
    const attempt = this.store.getCurrentAttempt(sessionId)
    // Revoke auth proxy token
    if (this.authProxy) {
      const tokenEntry = this.sessionTokens.get(sessionId)
      if (tokenEntry) {
        this.authProxy.revokeToken(tokenEntry.token)
        this.sessionTokens.delete(sessionId)
      }
    }
    this.store.setSessionLifecycle(sessionId, 'terminated', 'terminated')
    this.store.addEvent(sessionId, attempt?.attemptId ?? null, 'session_terminate_requested', {})

    if (attempt?.runnerPid) {
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
      this.store.markAttemptStopped(attempt.attemptId, {
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
      ? this.store.getAttempt(session.currentAttemptId)
      : null
    if (existing?.attachPath) {
      const healthy = await probeAttachPath(
        existing.attachPath,
        this.options.config.reattachProbeTimeoutMs,
      )
      if (healthy) {
        this.store.setSessionLifecycle(session.sessionId, 'active', session.desiredState)
        return existing
      }
      this.store.markAttemptLost(existing.attemptId, 'attach socket unavailable')
      this.store.addEvent(session.sessionId, existing.attemptId, 'attempt_lost', {
        reason: 'attach_socket_unavailable',
      })
      this.store.setSessionLifecycle(session.sessionId, 'lost', 'active')
    }

    if (!this.options.config.resumeOnMissingRuntime) {
      throw new Error(`Runtime missing for session ${session.sessionId}`)
    }

    return await this.spawnAttempt(session, {
      resumeTranscriptSessionId: session.transcriptSessionId,
    })
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
    // Effective assistant for this attempt. Callers that *create* a session
    // pass `options.assistantName`, but relaunch/reuse paths (e.g. a reused
    // cron session — spawnAttempt is reached via ensureRuntime with only
    // `resumeTranscriptSessionId`) do not. Fall back to the assistant stored
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

    const generation = this.store.getNextGeneration(session.sessionId)
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
    const attempt = this.store.createAttempt({
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
    this.store.setCurrentAttempt(session.sessionId, attempt.attemptId)

    // Resume path: if the session was previously idle-killed (status=ended,
    // desired_state=active, ended_at set), clear those terminal markers so
    // the row reads as a live session again.
    if (session.endedAt !== null || session.status === 'ended' || session.status === 'failed' || session.status === 'lost') {
      this.store.reactivateSession(session.sessionId)
      this.store.addEvent(session.sessionId, attempt.attemptId, 'session_reactivated', {
        previousStatus: session.status,
        previousEndedAt: session.endedAt,
      })
    }

    // Force sync global engine config into session runtime for manifest
    session.runtime.engine = this.options.config.engine
    session.runtime.scodePath = this.options.config.scodePath
    if (
      session.runtime.type === 'docker'
      && this.options.config.dockerImage
      && session.runtime.dockerImage !== this.options.config.dockerImage
    ) {
      const previousDockerImage = session.runtime.dockerImage
      session.runtime.dockerImage = this.options.config.dockerImage
      this.store.updateSessionRuntimeImage(
        session.sessionId,
        this.options.config.dockerImage,
      )
      this.store.addEvent(
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

    // Document Center v2: resolve `enabledWikis` from the bound assistant's
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
              const wiki = docStore.getWikiById(wid)
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
              const appRow = this.store.getCorpApp(appId, session.orgId) as Record<string, unknown> | null
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
            const user = this.authService.getUserOrNull(
              session.userId,
              session.orgId,
            )
            const departmentName = user?.departmentId
              ? this.authService
                  .listDepartments(session.orgId)
                  .departments.find(d => d.id === user.departmentId)?.name ?? null
              : null
            const userProfileMemory = buildUserProfileMemory({
              userName: user?.name ?? null,
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
        const user = this.authService.getUserOrNull(session.userId, session.orgId)
        const departmentId = user?.departmentId ?? null
        const visibleDepartmentIds =
          this.authService.getUserDepartmentAncestorIds(
            session.userId,
            session.orgId,
          ) ?? new Set()
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
      config: this.options.config,
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
    const userModelPref = session.userId ? getUserModelPreference(session.userId) : null
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
    if (systemSettings.apiKey) {
      runnerEnv.ANTHROPIC_AUTH_TOKEN = systemSettings.apiKey
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
      const proxyUrl = process.env.MOSS_AUTH_PROXY_URL?.trim() || 'http://localhost:12013'
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
        const tokenUser = this.authService.getUserById(session.userId)
        const deptId = tokenUser?.departmentId ?? null
        this.authProxy.registerToken(entry.token, session.userId, session.orgId, deptId, child.pid)
      }
    }

    this.store.updateAttemptRunner(attempt.attemptId, child.pid)

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
    this.store.setSessionLifecycle(session.sessionId, 'active', 'active')
    this.store.addEvent(session.sessionId, attempt.attemptId, 'attempt_spawned', {
      runnerPid: child.pid,
      generation,
      attachPath,
    })
    return this.store.getAttempt(attempt.attemptId) ?? attempt
  }
}

export function toSummary(session: SessionRecord): SessionSummary {
  return toSessionSummary(session)
}
