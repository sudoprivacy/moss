import net from 'net'
import { appendFile, mkdir, unlink, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { RuntimeBackend } from './backends/runtimeBackend.js'
import { DirectConnectStore } from './db.js'
import { getTranscriptPath, isNamedPipePath } from './runtimePaths.js'
import { logRuntimeEvent, logRuntimeMetric } from './runtime/runtimeMetrics.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import type { RunnerClientMessage, RunnerServerMessage } from './runnerProtocol.js'
import type { RunnerManifest } from './types.js'
import type { BackendHandle } from './sessionManager.js'

type SocketWithBuffer = net.Socket & {
  __buffer?: string
}

async function safeUnlink(path: string): Promise<void> {
  if (isNamedPipePath(path)) {
    return
  }
  try {
    await unlink(path)
  } catch {}
}

async function writeStatus(path: string, payload: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractTranscriptSessionCandidate(value: unknown): {
  sessionId: string
  sourceType: string
  sourceSubtype: string | null
} | null {
  if (!isJsonObject(value)) {
    return null
  }
  const sessionId =
    typeof value.session_id === 'string' ? value.session_id.trim() : ''
  if (!sessionId) {
    return null
  }
  if (value.type === 'result') {
    return {
      sessionId,
      sourceType: 'result',
      sourceSubtype: null,
    }
  }
  if (value.type === 'system' && value.subtype === 'init') {
    return {
      sessionId,
      sourceType: 'system',
      sourceSubtype: 'init',
    }
  }
  return null
}

export class SessionRunnerDaemon {
  readonly #store: DirectConnectStore
  readonly #backend: RuntimeBackend
  readonly #clients = new Set<SocketWithBuffer>()
  readonly #heartbeatTimer: NodeJS.Timeout
  #server: net.Server | null = null
  #handle: BackendHandle | null = null
  #state: 'starting' | 'running' | 'stopped' | 'failed' = 'starting'
  #stopping = false
  #stopReason: 'terminated' | 'idle_timeout' | 'runtime_exit' | 'idle_busy_timeout' = 'runtime_exit'
  #idleTimer: NodeJS.Timeout | null = null
  #busyCeilingTimer: NodeJS.Timeout | null = null
  #busyUnsubscribe: (() => void) | null = null
  #busy = false
  #detachedSince: number | null = null
  #notBusySince: number | null = null
  #detachedBusySince: number | null = null
  #finalized = false
  #recentStderr: string[] = []
  #pendingStdin: string[] = []  // Buffer for messages arriving before handle is ready

  constructor(private readonly manifest: RunnerManifest) {
    this.#store = new DirectConnectStore(manifest.config.dbPath)
    this.#backend = new RuntimeBackend({
      engine: manifest.session.runtime.engine,
      scodePath: manifest.session.runtime.scodePath,
      defaultRuntime: manifest.session.runtime,
      docker: {
        image: manifest.session.runtime.dockerImage,
        mode: manifest.session.runtime.dockerMode,
        containerMode: manifest.session.runtime.containerMode || manifest.config.docker?.containerMode,
        execKillGraceMs: manifest.config.docker?.execKillGraceMs,
        network: manifest.config.dockerNetwork,
        labels: manifest.config.dockerLabels,
      },
    })
    this.#heartbeatTimer = setInterval(() => {
      this.#store.touchAttemptHeartbeat(this.manifest.attempt.attemptId)
    }, Math.max(5_000, Math.floor(this.manifest.config.heartbeatTimeoutMs / 3)))
    this.#heartbeatTimer.unref?.()
  }

  async start(): Promise<void> {
    try {
      await mkdir(this.manifest.attempt.runtimeDir, { recursive: true })
      if (!isNamedPipePath(this.manifest.attempt.attachPath)) {
        await mkdir(dirname(this.manifest.attempt.attachPath), { recursive: true })
      }
      await safeUnlink(this.manifest.attempt.attachPath)
      await writeStatus(this.manifest.attempt.statusPath, {
        state: 'starting',
        pid: process.pid,
        attemptId: this.manifest.attempt.attemptId,
      })
      this.#server = net.createServer(socket => this.#onClient(socket as SocketWithBuffer))
      await new Promise<void>((resolve, reject) => {
        this.#server!.once('error', reject)
        this.#server!.listen(this.manifest.attempt.attachPath, () => {
          this.#server!.off('error', reject)
          resolve()
        })
      })
      this.#store.updateAttemptRunner(this.manifest.attempt.attemptId, process.pid)

      const handle = await this.#backend.spawn({
        sessionId: this.manifest.session.sessionId,
        resumeSessionId: this.manifest.session.resumeFromTranscript
          ? this.manifest.session.transcriptSessionId
          : undefined,
        cwd: this.manifest.session.cwd,
        transcriptPath: this.manifest.session.transcriptPath,
        dangerouslySkipPermissions: this.manifest.session.dangerouslySkipPermissions,
        userId: this.manifest.session.userId,
        orgId: this.manifest.session.orgId,
        role: this.manifest.session.role,
        scopes: this.manifest.session.scopes,
        runtime: this.manifest.session.runtime,
        assistantName: this.manifest.session.assistantName,
        sessionToken: this.manifest.session.sessionToken,
        availableWikis: this.manifest.session.availableWikis,
        availableCorpApps: this.manifest.session.availableCorpApps,
        sharedMemory: this.manifest.session.sharedMemory,
        enabledSkillNames: this.manifest.session.enabledSkills,
        visibilityFilter: this.manifest.session.visibilityFilter ? {
          isAdmin: this.manifest.session.visibilityFilter.isAdmin,
          userId: this.manifest.session.visibilityFilter.userId,
          departmentId: this.manifest.session.visibilityFilter.departmentId,
          visibleDepartmentIds: this.manifest.session.visibilityFilter.visibleDepartmentIds
            ? new Set(this.manifest.session.visibilityFilter.visibleDepartmentIds)
            : null,
        } : null,
        mcpSettings: this.manifest.session.mcpSettings,
      })

      this.#handle = handle
      this.manifest.session.runtime.containerName = handle.runtime.containerName
      this.manifest.session.runtime.configDir = handle.runtime.configDir
      if (handle.runtime.containerMode) {
        this.manifest.session.runtime.containerMode = handle.runtime.containerMode
      }
      if (handle.runtime.userContainerName) {
        this.manifest.session.runtime.userContainerName = handle.runtime.userContainerName
      }
      if (handle.runtime.scodeHomeDir) {
        this.manifest.session.runtime.scodeHomeDir = handle.runtime.scodeHomeDir
      }
      if (handle.runtime.inContainerPidFile) {
        this.manifest.session.runtime.inContainerPidFile = handle.runtime.inContainerPidFile
      }
      if (handle.runtime.tmpDirInContainer) {
        this.manifest.session.runtime.tmpDirInContainer = handle.runtime.tmpDirInContainer
      }

      // A2: subscribe to busy transitions so reschedule() can flip between
      // idle and busy-ceiling timers correctly.
      if (handle.onBusyChange) {
        this.#busyUnsubscribe = handle.onBusyChange(next => {
          if (next === this.#busy) return
          this.#busy = next
          const now = Date.now()
          if (next) {
            // busy true→false→true elsewhere: reset notBusySince
            this.#notBusySince = null
            if (this.#detachedSince !== null && this.#detachedBusySince === null) {
              this.#detachedBusySince = now
            }
          } else {
            this.#notBusySince = now
            this.#detachedBusySince = null
          }
          this.#reschedule()
        })
      }
      if (handle.isBusy) {
        this.#busy = handle.isBusy()
      }
      this.#store.addEvent(
        this.manifest.session.sessionId,
        this.manifest.attempt.attemptId,
        'available_skills_snapshot',
        {
          runtime: handle.runtime,
          skills: handle.availableSkills ?? [],
        },
      )

      // Flush any pending stdin messages that arrived before handle was ready
      if (this.#pendingStdin.length > 0) {
        process.stderr.write(`[SessionRunnerDaemon] Flushing ${this.#pendingStdin.length} pending stdin messages\n`)
        for (const data of this.#pendingStdin) {
          this.#handle.writeStdin(data)
        }
        this.#pendingStdin = []
      }

      this.#state = 'running'
      this.#store.touchAttemptHeartbeat(this.manifest.attempt.attemptId, 'running')
      this.#store.setSessionLifecycle(
        this.manifest.session.sessionId,
        'active',
        'active',
      )
      this.#store.addEvent(
        this.manifest.session.sessionId,
        this.manifest.attempt.attemptId,
        'attempt_started',
        {
          pid: process.pid,
          runtime: handle.runtime,
          availableSkills: handle.availableSkills ?? [],
        },
      )
      await writeStatus(this.manifest.attempt.statusPath, {
        state: 'running',
        pid: process.pid,
        attemptId: this.manifest.attempt.attemptId,
        runtime: handle.runtime,
      })
      this.#armIdleTimer()

      handle.onStdoutLine(line => {
        process.stderr.write(`[SessionRunnerDaemon] ON STDOUT: ${line}`)
        this.#maybeUpdateTranscriptSession(line)
        this.#store.touchAttemptHeartbeat(this.manifest.attempt.attemptId)
        this.#store.touchSessionActivity(this.manifest.session.sessionId)
        void appendFile(this.manifest.attempt.stdoutLogPath, line, 'utf8').catch(() => {})
        this.#broadcast({ type: 'stdout', line })
      })

      handle.onStderrLine(line => {
        this.#rememberStderr(line)
        void appendFile(this.manifest.attempt.stderrLogPath, line, 'utf8').catch(() => {})
        this.#broadcast({ type: 'stderr', line })
      })

      handle.onExit((code, signal) => {
        if (this.#finalized) {
          return
        }
        this.#finalized = true
        const runtimeState = code === 0 ? 'stopped' : 'failed'
        const errorText =
          code === 0
            ? null
            : this.#recentStderrText() ||
              `Runtime exited before attach became stable (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
        this.#state = code === 0 ? 'stopped' : 'failed'
        this.#store.markAttemptStopped(this.manifest.attempt.attemptId, {
          runtimeState,
          exitCode: code,
          exitSignal: signal,
          stopReason: this.#stopping ? this.#stopReason : 'runtime_exit',
          errorText,
        })
        // Lifecycle marks:
        //   terminate (client-initiated delete)    -> status=terminated, desired=terminated
        //   idle / busy-ceiling kill (server-side) -> status=ended, desired=ACTIVE
        //     The Sudowork client treats WS close as "detach": session stays
        //     alive on the server, scode may be killed after idleTimeoutMs /
        //     maxDetachedBusyMs, but the user still wants the session and may
        //     come back via /api/v1/sessions/:id/resume or /ws/sessions/:id.
        //     desired_state stays 'active' so ensureSessionReady will respawn.
        //     status='ended' is excluded from listSessionsToRecover (no
        //     auto-respawn on moss-server restart) but explicit resume works.
        //   natural exit code=0 (no stopping)     -> status=ended, desired=ended
        //   non-zero exit (no stopping)           -> status=failed, desired=active
        //     keeps last user intent active so client can retry.
        const idleish =
          this.#stopReason === 'idle_timeout' ||
          this.#stopReason === 'idle_busy_timeout'
        let nextStatus: 'ended' | 'failed' | 'terminated'
        let nextDesired: 'active' | 'ended' | 'terminated'
        if (this.#stopping) {
          if (idleish) {
            nextStatus = 'ended'
            nextDesired = 'active'
          } else {
            nextStatus = 'terminated'
            nextDesired = 'terminated'
          }
        } else if (code === 0) {
          nextStatus = 'ended'
          nextDesired = 'ended'
        } else {
          nextStatus = 'failed'
          nextDesired = 'active'
        }
        this.#store.markSessionEnded(
          this.manifest.session.sessionId,
          nextStatus,
          nextDesired,
        )
        this.#store.addEvent(
          this.manifest.session.sessionId,
          this.manifest.attempt.attemptId,
          'attempt_exited',
          { code, signal, stopping: this.#stopping, errorText },
        )
        this.#broadcast({ type: 'exit', code, signal: signal ?? null })
        void writeStatus(this.manifest.attempt.statusPath, {
          state: this.#state,
          code,
          signal,
          error: errorText,
        })
        void this.shutdown()
      })

      process.once('SIGTERM', () => {
        this.#stopping = true
        this.#stopReason = 'terminated'
        void Promise.resolve(this.#handle?.destroy(true)).catch(() => {})
      })
      process.once('SIGINT', () => {
        this.#stopping = true
        this.#stopReason = 'terminated'
        void Promise.resolve(this.#handle?.destroy(true)).catch(() => {})
      })
    } catch (error) {
      await this.#fail(error, 'startup_failed')
      throw error
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.#heartbeatTimer)
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer)
      this.#idleTimer = null
    }
    if (this.#busyCeilingTimer) {
      clearTimeout(this.#busyCeilingTimer)
      this.#busyCeilingTimer = null
    }
    if (this.#busyUnsubscribe) {
      try { this.#busyUnsubscribe() } catch {}
      this.#busyUnsubscribe = null
    }
    for (const client of this.#clients) {
      try {
        client.destroy()
      } catch (err) {
        // Client may already be disconnected
        console.warn('[SessionRunnerDaemon] Failed to destroy client on shutdown:', err)
      }
    }
    this.#clients.clear()
    if (this.#server) {
      await new Promise<void>(resolve => this.#server!.close(() => resolve()))
      this.#server = null
    }
    await safeUnlink(this.manifest.attempt.attachPath)
    this.#store.close()
  }

  #onClient(socket: SocketWithBuffer): void {
    this.#clients.add(socket)
    this.#clearIdleTimer()
    this.#store.setSessionLifecycle(
      this.manifest.session.sessionId,
      'active',
      'active',
    )
    this.#send(socket, {
      type: 'hello',
      attemptId: this.manifest.attempt.attemptId,
      sessionId: this.manifest.session.sessionId,
      runtimeType: this.manifest.session.runtime.type,
      state: this.#state,
    })
    socket.on('data', chunk => {
      const text = Buffer.from(chunk).toString('utf8')
      socket.__buffer = (socket.__buffer ?? '') + text
      while (true) {
        const idx = socket.__buffer.indexOf('\n')
        if (idx < 0) break
        const line = socket.__buffer.slice(0, idx)
        socket.__buffer = socket.__buffer.slice(idx + 1)
        this.#handleClientLine(socket, line)
      }
    })
    socket.on('close', () => {
      this.#clients.delete(socket)
      this.#armIdleTimer()
    })
    socket.on('error', () => {
      this.#clients.delete(socket)
      this.#armIdleTimer()
    })
  }

  #handleClientLine(socket: SocketWithBuffer, line: string): void {
    process.stderr.write(`[SessionRunnerDaemon] Received client line: ${line.slice(0, 200)}...\n`)
    if (!line.trim()) return
    let parsed: RunnerClientMessage
    try {
      parsed = jsonParse(line) as RunnerClientMessage
    } catch {
      this.#send(socket, { type: 'error', message: 'invalid_json' })
      return
    }
    process.stderr.write(`[SessionRunnerDaemon] Parsed message type: ${parsed.type}\n`)
    if (parsed.type === 'ping') {
      this.#send(socket, { type: 'pong', ts: Date.now() })
      return
    }
    if (parsed.type === 'shutdown') {
      this.#stopping = true
      this.#stopReason = 'terminated'
      this.#store.addEvent(
        this.manifest.session.sessionId,
        this.manifest.attempt.attemptId,
        'attempt_shutdown_requested',
        { force: parsed.force === true },
      )
      process.kill(process.pid, 'SIGTERM')
      return
    }
    if (parsed.type === 'stdin') {
      process.stderr.write(`[SessionRunnerDaemon] RECEIVED STDIN: ${parsed.data?.slice(0, 100)}...\n`)
      if (this.#handle) {
        this.#handle.writeStdin(parsed.data)
      } else {
        process.stderr.write(`[SessionRunnerDaemon] Handle not ready, buffering message (${this.#pendingStdin.length} pending)\n`)
        this.#pendingStdin.push(parsed.data)
      }
      this.#send(socket, { type: 'stdin_ack' })
    }
  }

  #broadcast(message: RunnerServerMessage): void {
    const line = `${jsonStringify(message)}\n`
    process.stderr.write(`[SessionRunnerDaemon] BROADCASTING TO ${this.#clients.size} CLIENTS: ${line}`)
    for (const client of this.#clients) {
      if (!client.destroyed) {
        client.write(line)
      }
    }
  }

  #send(socket: SocketWithBuffer, message: RunnerServerMessage): void {
    socket.write(`${jsonStringify(message)}\n`)
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer)
      this.#idleTimer = null
    }
    if (this.#busyCeilingTimer) {
      clearTimeout(this.#busyCeilingTimer)
      this.#busyCeilingTimer = null
    }
  }

  #armIdleTimer(): void {
    this.#reschedule()
  }

  /**
   * A2: single source of truth for idle / busy-ceiling timers.
   *
   * Invariants:
   *   - sockets > 0          -> no timer.
   *   - detached && !busy    -> idleTimer, base = max(detachedSince, notBusySince).
   *   - detached && busy     -> busyCeilingTimer, base = detachedBusySince.
   *   - busy true↔false flip -> swap timers (never accumulate both).
   */
  #reschedule(): void {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer)
      this.#idleTimer = null
    }
    if (this.#busyCeilingTimer) {
      clearTimeout(this.#busyCeilingTimer)
      this.#busyCeilingTimer = null
    }
    if (this.#clients.size > 0) {
      this.#detachedSince = null
      this.#detachedBusySince = null
      return
    }
    if (!this.#store.isOpen()) return

    const idleMs = this.manifest.config.idleTimeoutMs
    const maxDetachedBusyMs =
      this.manifest.config.session?.maxDetachedBusyMs ?? 2 * 60 * 60 * 1000
    const now = Date.now()
    if (this.#detachedSince === null) {
      this.#detachedSince = now
      if (this.#busy) this.#detachedBusySince = now
    }
    this.#store.setSessionLifecycle(
      this.manifest.session.sessionId,
      'detached',
      'active',
    )

    if (!this.#busy) {
      if (idleMs <= 0) return
      const base = Math.max(
        this.#detachedSince ?? now,
        this.#notBusySince ?? this.#detachedSince ?? now,
      )
      const remaining = Math.max(0, idleMs - (now - base))
      this.#idleTimer = setTimeout(() => {
        this.#stopping = true
        this.#stopReason = 'idle_timeout'
        this.#store.addEvent(
          this.manifest.session.sessionId,
          this.manifest.attempt.attemptId,
          'attempt_idle_timeout',
          { idleTimeoutMs: idleMs },
        )
        void Promise.resolve(this.#handle?.destroy(true)).catch(() => {})
      }, remaining)
      this.#idleTimer.unref?.()
      return
    }

    // sockets===0 && busy: only the busy ceiling timer arms.
    if (maxDetachedBusyMs <= 0) return
    const since = this.#detachedBusySince ?? now
    const remaining = Math.max(0, maxDetachedBusyMs - (now - since))
    this.#busyCeilingTimer = setTimeout(() => {
      this.#stopping = true
      this.#stopReason = 'idle_busy_timeout'
      this.#store.addEvent(
        this.manifest.session.sessionId,
        this.manifest.attempt.attemptId,
        'attempt_idle_busy_timeout',
        { maxDetachedBusyMs },
      )
      logRuntimeMetric('session_idle_busy_timeout', {})
      logRuntimeEvent('session_idle_busy_timeout', {
        sessionId: this.manifest.session.sessionId,
        maxDetachedBusyMs,
      })
      const persistP = this.#handle?.persistInProgressTurn
        ? this.#handle.persistInProgressTurn().catch(err => {
            process.stderr.write(`[SessionRunnerDaemon] persistInProgressTurn failed: ${err}\n`)
          })
        : Promise.resolve()
      void persistP.then(() => {
        void Promise.resolve(this.#handle?.destroy(true)).catch(() => {})
      })
    }, remaining)
    this.#busyCeilingTimer.unref?.()
  }

  #rememberStderr(line: string): void {
    this.#recentStderr.push(line.trimEnd())
    if (this.#recentStderr.length > 50) {
      this.#recentStderr.splice(0, this.#recentStderr.length - 50)
    }
  }

  #recentStderrText(): string | null {
    const text = this.#recentStderr
      .map(line => line.trim())
      .filter(Boolean)
      .join('\n')
      .trim()
    return text || null
  }

  #maybeUpdateTranscriptSession(line: string): void {
    let parsed: unknown
    try {
      parsed = jsonParse(line)
    } catch {
      return
    }
    const candidate = extractTranscriptSessionCandidate(parsed)
    if (!candidate) {
      return
    }
    const nextTranscriptSessionId = candidate.sessionId
    const currentTranscriptSessionId = this.manifest.session.transcriptSessionId
    if (nextTranscriptSessionId === currentTranscriptSessionId) {
      return
    }
    const currentTranscriptPath = this.manifest.session.transcriptPath
    const runtimeDir = this.manifest.config.runtimeDir
    const nextTranscriptPath = runtimeDir
      ? getTranscriptPath(
          runtimeDir,
          this.manifest.session.sessionId,
          nextTranscriptSessionId,
        )
      : currentTranscriptPath
    this.#store.updateSessionTranscript(this.manifest.session.sessionId, {
      transcriptSessionId: nextTranscriptSessionId,
      transcriptPath: nextTranscriptPath,
    })
    this.manifest.session.transcriptSessionId = nextTranscriptSessionId
    this.manifest.session.transcriptPath = nextTranscriptPath
    this.#store.addEvent(
      this.manifest.session.sessionId,
      this.manifest.attempt.attemptId,
      'transcript_session_updated',
      {
        previousTranscriptSessionId: currentTranscriptSessionId,
        transcriptSessionId: nextTranscriptSessionId,
        previousTranscriptPath: currentTranscriptPath,
        transcriptPath: nextTranscriptPath,
        sourceType: candidate.sourceType,
        sourceSubtype: candidate.sourceSubtype,
      },
    )
  }

  async #fail(error: unknown, stopReason: string): Promise<void> {
    if (this.#finalized) {
      return
    }
    this.#finalized = true
    this.#state = 'failed'
    const message = error instanceof Error ? error.stack || error.message : String(error)
    this.#rememberStderr(message)
    await appendFile(this.manifest.attempt.stderrLogPath, `${message}\n`, 'utf8').catch(() => {})
    this.#store.markAttemptStopped(this.manifest.attempt.attemptId, {
      runtimeState: 'failed',
      stopReason,
      errorText: message,
    })
    this.#store.markSessionEnded(
      this.manifest.session.sessionId,
      'failed',
      'active',
    )
    this.#store.addEvent(
      this.manifest.session.sessionId,
      this.manifest.attempt.attemptId,
      'attempt_failed',
      { stopReason, error: message },
    )
    await writeStatus(this.manifest.attempt.statusPath, {
      state: 'failed',
      pid: process.pid,
      attemptId: this.manifest.attempt.attemptId,
      error: message,
    }).catch(() => {})
    await this.shutdown().catch(() => {})
  }
}
