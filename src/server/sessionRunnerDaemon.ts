import net from 'net'
import { appendFile, mkdir, unlink, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { RuntimeBackend } from './backends/runtimeBackend.js'
import { DirectConnectStore } from './db.js'
import { getTranscriptPath } from './runtimePaths.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import type { RunnerClientMessage, RunnerServerMessage } from './runnerProtocol.js'
import type { RunnerManifest } from './types.js'
import type { BackendHandle } from './sessionManager.js'

type SocketWithBuffer = net.Socket & {
  __buffer?: string
}

async function safeUnlink(path: string): Promise<void> {
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
  #stopReason: 'terminated' | 'idle_timeout' | 'runtime_exit' = 'runtime_exit'
  #idleTimer: NodeJS.Timeout | null = null
  #finalized = false
  #recentStderr: string[] = []

  constructor(private readonly manifest: RunnerManifest) {
    this.#store = new DirectConnectStore(manifest.config.dbPath)
    this.#backend = new RuntimeBackend({
      defaultRuntime: manifest.session.runtime,
      docker: {
        image: manifest.session.runtime.dockerImage,
        mode: manifest.session.runtime.dockerMode,
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
      await mkdir(dirname(this.manifest.attempt.attachPath), { recursive: true })
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
        dangerouslySkipPermissions: this.manifest.session.dangerouslySkipPermissions,
        userId: this.manifest.session.userId,
        orgId: this.manifest.session.orgId,
        role: this.manifest.session.role,
        scopes: this.manifest.session.scopes,
        runtime: this.manifest.session.runtime,
        assistantName: this.manifest.session.assistantName,
      })

      this.#handle = handle
      this.manifest.session.runtime.containerName = handle.runtime.containerName
      this.manifest.session.runtime.configDir = handle.runtime.configDir
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
        this.#store.markSessionEnded(
          this.manifest.session.sessionId,
          this.#stopping
            ? this.#stopReason === 'idle_timeout'
              ? 'ended'
              : 'terminated'
            : code === 0
              ? 'ended'
              : 'failed',
          this.#stopping
            ? this.#stopReason === 'idle_timeout'
              ? 'ended'
              : 'terminated'
            : code === 0
              ? 'ended'
              : 'active',
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
        this.#handle?.destroy(true)
      })
      process.once('SIGINT', () => {
        this.#stopping = true
        this.#stopReason = 'terminated'
        this.#handle?.destroy(true)
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
    for (const client of this.#clients) {
      try {
        client.destroy()
      } catch {}
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
    if (!line.trim()) return
    let parsed: RunnerClientMessage
    try {
      parsed = jsonParse(line) as RunnerClientMessage
    } catch {
      this.#send(socket, { type: 'error', message: 'invalid_json' })
      return
    }
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
      if (this.#handle) {
        this.#handle.writeStdin(parsed.data)
      }
    }
  }

  #broadcast(message: RunnerServerMessage): void {
    const line = `${jsonStringify(message)}\n`
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
  }

  #armIdleTimer(): void {
    this.#clearIdleTimer()
    if (this.#clients.size > 0 || this.manifest.config.idleTimeoutMs <= 0) {
      return
    }
    this.#store.setSessionLifecycle(
      this.manifest.session.sessionId,
      'detached',
      'active',
    )
    this.#idleTimer = setTimeout(() => {
      this.#stopping = true
      this.#stopReason = 'idle_timeout'
      this.#store.addEvent(
        this.manifest.session.sessionId,
        this.manifest.attempt.attemptId,
        'attempt_idle_timeout',
        { idleTimeoutMs: this.manifest.config.idleTimeoutMs },
      )
      this.#handle?.destroy(true)
    }, this.manifest.config.idleTimeoutMs)
    this.#idleTimer.unref?.()
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
    const nextTranscriptPath = this.manifest.session.runtime.configDir
      ? getTranscriptPath(
          this.manifest.session.runtime.configDir,
          this.manifest.session.cwd,
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
