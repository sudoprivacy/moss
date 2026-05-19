import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, writeFile, open } from 'fs/promises'
import net from 'net'
import os from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { loadBudgetStats } from './budgetStats.js'
import { DirectConnectStore, mergeRuntime, openDirectConnectStore, toSessionSummary } from './db.js'
import { AuthService } from './auth/service.js'
import type {
  AttemptRecord,
  RunnerManifest,
  ServerConfig,
  SessionCreateInput,
  SessionRecord,
  SessionSummary,
} from './types.js'
import {
  getAttachPath,
  getAttemptDir,
  getRuntimeStatusPath,
  getRuntimeStderrLogPath,
  getRuntimeStdoutLogPath,
  getSessionConfigDir,
  getTranscriptPath,
} from './runtimePaths.js'
import { errorMessage } from '../utils/errors.js'
import { getSystemSettings } from './systemSettings.js'
import { getUserModelPreference } from './userModelPreference.js'

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function resolveRunnerPath(): string {
  const fromEnv = process.env.MOSS_SESSION_RUNNER_PATH
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv
  }
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(currentDir, 'direct-connect-session-runner.mjs'),
    join(process.cwd(), 'direct-connect-session-runner.mjs'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error('Missing direct-connect-session-runner.mjs. Run bun run build:node first.')
}

async function readRunnerFailure(
  statusPath: string,
  stderrLogPath: string,
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
  } catch {}

  let stderrTail: string | null = null
  try {
    if (existsSync(stderrLogPath)) {
      const stderr = (await readFile(stderrLogPath, 'utf8')).trim()
      if (stderr) {
        const lines = stderr.split('\n')
        stderrTail = lines.slice(-20).join('\n').trim() || null
      }
    }
  } catch {}

  if (statusError && stderrTail) {
    return `${statusError}\n${stderrTail}`
  }
  return statusError || stderrTail || null
}

async function waitForRunnerReady(
  attachPath: string,
  statusPath: string,
  stderrLogPath: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(attachPath)) {
      return
    }
    const failure = await readRunnerFailure(statusPath, stderrLogPath)
    if (failure) {
      throw new Error(failure)
    }
    await wait(100)
  }
  const failure = await readRunnerFailure(statusPath, stderrLogPath)
  if (failure) {
    throw new Error(failure)
  }
  throw new Error(`Timed out waiting for runner socket at ${attachPath}`)
}

export async function probeAttachPath(
  attachPath: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!existsSync(attachPath)) {
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
}

export class RuntimeService {
  readonly store: DirectConnectStore
  readonly authService: AuthService
  private readonly pendingEnsures = new Map<string, Promise<AttemptRecord>>()

  constructor(private readonly options: RuntimeServiceOptions) {
    this.store = options.store ?? openDirectConnectStore(options.config)
    this.authService = options.authService
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
    const runtime = mergeRuntime(this.options.config, input.runtime)
    runtime.configDir =
      runtime.configDir ||
      getSessionConfigDir(
        this.options.config,
        sessionId,
        input.userId,
        runtime.type === 'docker' ? runtime.dockerMode : 'session',
      )
    const transcriptPath = getTranscriptPath(
      this.options.config.transcriptDir || runtime.configDir,
      input.cwd,
      sessionId,
    )
    const created = this.store.createSession({
      sessionId,
      transcriptSessionId: sessionId,
      transcriptPath,
      userId: input.userId,
      orgId: input.orgId,
      role: input.role,
      scopes: input.scopes,
      cwd: input.cwd,
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
      } catch {}
    }

    try {
      await this.spawnAttempt(created, {
        dangerouslySkipPermissions: input.dangerouslySkipPermissions,
        assistantName: input.assistantName,
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

  async reconcileOnStartup(): Promise<void> {
    const sessions = this.store.listSessionsToRecover()
    for (const session of sessions) {
      try {
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
    this.store.setSessionLifecycle(sessionId, 'terminated', 'terminated')
    this.store.addEvent(sessionId, attempt?.attemptId ?? null, 'session_terminate_requested', {})
    if (attempt?.runnerPid) {
      try {
        process.kill(attempt.runnerPid, 'SIGTERM')
      } catch {}
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
    } = {},
  ): Promise<AttemptRecord> {
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

    // Force sync global engine config into session runtime for manifest
    session.runtime.engine = this.options.config.engine
    session.runtime.scodePath = this.options.config.scodePath

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
        assistantName: options.assistantName ?? null,
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
    if (options.assistantName) {
      try {
        const { findAssistantDir, readAssistantMeta } = await import('./agentStore.js')
        const found = await findAssistantDir(options.assistantName)
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
        }
      } catch (err) {
        console.warn(
          `[RuntimeService] failed to resolve availableWikis for ${options.assistantName}:`,
          err,
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
        assistantName: options.assistantName,
        sessionToken,
        availableWikis,
        runtime: {
          ...session.runtime,
          containerName:
            session.runtime.type === 'docker'
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
    const defaultModel = userModelPref?.modelId
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

    const runnerPath = resolveRunnerPath()
    const cwd = (existsSync(session.cwd) ? session.cwd : process.cwd())
    const safeCwd = cwd === '/' ? os.homedir() : cwd

    // Open log files for runner output
    const stdoutFd = await open(stdoutLogPath, 'a')
    const stderrFd = await open(stderrLogPath, 'a')

    const child = spawn(process.execPath, [runnerPath, manifestPath], {
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
      cwd: session.cwd,
      env: runnerEnv,
    })
    child.unref()
    if (!child.pid) {
      throw new Error('Failed to spawn session runner')
    }
    this.store.updateAttemptRunner(attempt.attemptId, child.pid)
    await waitForRunnerReady(attachPath, statusPath, stderrLogPath, 5_000)
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
