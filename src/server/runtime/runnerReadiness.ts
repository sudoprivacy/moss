import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import { setTimeout as wait } from 'node:timers/promises'
import { COHOST_RECOVERY_TIMEOUT_MS } from '../backends/cohostRecovery.js'
import { isNamedPipePath } from '../runtimePaths.js'
import type { SessionRuntimeType } from '../sessionManager.js'

const RUNNER_BOOT_TIMEOUT_MS = 5_000

/** Wait for the backend's startup budget as well as the local runner boot. */
export async function waitForBackendRunnerReady(
  attachPath: string,
  statusPath: string,
  stderrLogPath: string,
  runtimeType: SessionRuntimeType,
  podReadyTimeoutSec = 90,
): Promise<void> {
  const timeoutMs = runtimeType === 'cohost'
    ? COHOST_RECOVERY_TIMEOUT_MS + RUNNER_BOOT_TIMEOUT_MS
    : runtimeType === 'k8s' ? (podReadyTimeoutSec + 30) * 1000 : RUNNER_BOOT_TIMEOUT_MS
  await waitForRunnerReady(attachPath, statusPath, stderrLogPath, timeoutMs)
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

  if (!statusError && !includeStderrWithoutStatusError) return null

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

/** The runner listens during startup; only a running backend can accept a session. */
export async function waitForRunnerReady(
  attachPath: string,
  statusPath: string,
  stderrLogPath: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const failure = await readRunnerFailure(statusPath, stderrLogPath)
    if (failure) {
      throw new Error(failure)
    }
    let isRunning = false
    try {
      const status = JSON.parse(await readFile(statusPath, 'utf8')) as { state?: string }
      isRunning = status.state === 'running'
    } catch {
      // A missing or partially written startup status is not readiness.
    }
    const remainingMs = timeoutMs - (Date.now() - start)
    if (isRunning && await probeAttachPath(attachPath, Math.max(100, Math.min(remainingMs, 250)))) return
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
  return probeRunnerSocket(attachPath, timeoutMs, 'listener')
}

/** A reachable bridge is ready only after its execution backend answers the probe. */
export async function probeRunnerReady(attachPath: string, timeoutMs: number): Promise<boolean> {
  return probeRunnerSocket(attachPath, timeoutMs, 'execution')
}

/** Read volatile turn state only from a ready execution in the expected attempt. */
export async function probeRunnerActivity(attachPath: string, attemptId: string, timeoutMs: number): Promise<'idle' | 'busy' | 'unavailable'> {
  return await probeRunnerSocket(attachPath, timeoutMs, 'activity', attemptId)
}

function probeRunnerSocket(attachPath: string, timeoutMs: number, mode: 'listener' | 'execution'): Promise<boolean>
function probeRunnerSocket(attachPath: string, timeoutMs: number, mode: 'activity', attemptId: string): Promise<'idle' | 'busy' | 'unavailable'>
async function probeRunnerSocket(attachPath: string, timeoutMs: number, mode: 'listener' | 'execution' | 'activity', attemptId?: string): Promise<boolean | 'idle' | 'busy' | 'unavailable'> {
  const unavailable = mode === 'activity' ? 'unavailable' : false
  if (!isNamedPipePath(attachPath) && !existsSync(attachPath)) {
    return unavailable
  }
  return await new Promise(resolve => {
    const socket = net.createConnection(attachPath)
    const finish = (result: boolean | 'idle' | 'busy' | 'unavailable') => {
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => finish(unavailable), timeoutMs)
    socket.once('connect', () => {
      if (mode === 'listener') finish(true)
      else socket.write(`${JSON.stringify({ type: 'ping' })}\n`)
    })
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      if (buffer.length > 1_048_576) { finish(unavailable); return }
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        try {
          const message = JSON.parse(line) as { type?: unknown; isReady?: unknown; attemptId?: unknown; isBusy?: unknown }
          if (message.type === 'pong') {
            if (mode === 'activity') finish(message.isReady === true && message.attemptId === attemptId && typeof message.isBusy === 'boolean'
              ? message.isBusy ? 'busy' : 'idle' : unavailable)
            else finish(message.isReady === true)
            return
          }
        } catch { finish(unavailable); return }
      }
    })
    socket.once('error', () => finish(unavailable))
    socket.once('close', () => finish(unavailable))
  })
}

