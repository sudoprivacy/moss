import { setTimeout as delay } from 'node:timers/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError } from './httpError.js'
import { AttemptTakeoverPendingError, type RuntimeService } from './runtimeService.js'

// Leave room for the response inside the WebUI client's 180-second budget.
// This bounds the entire request, including an already-running shared spawn.
export const SESSION_RESUME_TIMEOUT_MS = 165_000

type ResumeRuntime = Pick<RuntimeService, 'ensureSessionReady' | 'getSession'>
type SessionReady = Awaited<ReturnType<RuntimeService['ensureSessionReady']>>
type ResumeOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  retryDelayMs?: number
  complete?: (ready: SessionReady, signal: AbortSignal) => Promise<void>
}

/** Stop waiting without cancelling a spawn that other requests also await. */
function cancellable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void Promise.resolve().then(() => {
      signal.throwIfAborted()
      return operation()
    }).then(value => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

/**
 * Explicit resume waits through safe owner takeover. Other errors remain
 * immediate, and RuntimeService retains ownership/fencing and spawn deduping.
 * A disconnected caller stops polling; shared background recovery continues.
 */
export async function waitForSessionResume(
  runtime: ResumeRuntime,
  sessionId: string,
  options: ResumeOptions = {},
): ReturnType<RuntimeService['ensureSessionReady']> {
  options.signal?.throwIfAborted()
  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const deadline = setTimeout(() => controller.abort(new AttemptTakeoverPendingError(sessionId)),
    options.timeoutMs ?? SESSION_RESUME_TIMEOUT_MS)
  try {
    for (;;) {
      try {
        const ready = await cancellable(() => runtime.ensureSessionReady(sessionId), controller.signal)
        if (ready.session.desiredState === 'terminated') {
          throw new HttpError(409, 'Session was terminated while waiting for recovery')
        }
        if (options.complete) {
          await cancellable(() => options.complete!(ready, controller.signal), controller.signal)
        }
        return ready
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason
        if (!(error instanceof AttemptTakeoverPendingError)) throw error
      }
      await delay(options.retryDelayMs ?? 1_000, undefined, { signal: controller.signal })
      // A terminate received while this request was waiting supersedes its
      // earlier resume intent; never let the next ensure resurrect it.
      const current = await cancellable(() => runtime.getSession(sessionId), controller.signal)
      if (!current) throw new HttpError(404, 'Session not found')
      if (current.desiredState === 'terminated') {
        throw new HttpError(409, 'Session was terminated while waiting for recovery')
      }
    }
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(deadline)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/** Bind resume and response metadata to one deadline and the HTTP connection. */
export async function respondAfterSessionResume(
  runtime: ResumeRuntime,
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
  complete: NonNullable<ResumeOptions['complete']>,
  options: Omit<ResumeOptions, 'signal' | 'complete'> = {},
): Promise<void> {
  const controller = new AbortController()
  const onDisconnect = () => controller.abort()
  req.once('aborted', onDisconnect)
  res.once('close', onDisconnect)
  try {
    if (req.aborted || res.destroyed) return
    await waitForSessionResume(runtime, sessionId, { ...options, signal: controller.signal, complete })
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    req.off('aborted', onDisconnect)
    res.off('close', onDisconnect)
  }
}
