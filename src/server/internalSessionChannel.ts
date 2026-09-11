/**
 * Server-side internal session channel (HA).
 *
 * Why this exists: several server-side consumers (channels gateway,
 * CronService, EventTriggerService, cabin) used to `ensureSessionReady` then
 * `connectToAttempt` — a DIRECT unix-socket connect to the runner. That only
 * works when the consumer happens to run on the owning instance; behind an LB
 * with multiple instances that is a coin flip (channel messages via pool
 * routing, cron/event via DB lease on any instance), and on cross-host
 * deployments the attach socket lives on the owner's host, period.
 *
 * This module gives those consumers a runner-socket-shaped channel that is
 * actually a WebSocket to the owner instance through the same routing as
 * external clients (`/ws/internal/sessions/:id` + `?moss_route=<owner>`):
 * same-host, cross-host and single-instance deployments all take one path.
 * The wire is bare newline-delimited runnerProtocol JSON both ways (the
 * internal endpoint passes messages through unfiltered — stdin_ack included).
 */
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import type { AuthService } from './auth/service.js'
import type { DirectConnectStore } from './db.js'
import type { ServerConfig } from './types.js'

/** Same retry budget as the desktop client's reconnect: covers the worst
 * failover timeline (instance-death detection + fencing + heartbeat expiry
 * ≈70-105s) with margin. */
const CONNECT_MAX_ATTEMPTS = 9
const CONNECT_RETRY_BASE_MS = 1_000
const CONNECT_RETRY_MAX_MS = 30_000
/** Internal channel tokens live only as long as one channel setup. */
const INTERNAL_TOKEN_TTL_SEC = 120

export interface InternalSessionChannel extends EventEmitter {
  /** Send one runner-protocol client message line (without trailing \n).
   * Optional callback mirrors net.Socket.write's error hook. */
  write(line: string, onError?: (error: unknown) => void): boolean
  /** Socket-compatible alias for consumers migrating off net.Socket. */
  end(): void
  destroy(): void
  /** Socket-compatible liveness flag (true once closed). */
  readonly destroyed: boolean
}

export interface ChannelDeps {
  authService: AuthService
  store: DirectConnectStore
  config: ServerConfig
}

function retryDelayMs(retryIndex: number): number {
  return Math.min(CONNECT_RETRY_BASE_MS * 2 ** (retryIndex - 1), CONNECT_RETRY_MAX_MS)
}

function internalBaseWsUrl(config: ServerConfig): { base: string; behindLb: boolean } {
  if (config.publicBaseUrl) {
    try {
      const u = new URL(config.publicBaseUrl)
      const scheme = u.protocol === 'https:' ? 'wss' : 'ws'
      const basePath = u.pathname.replace(/\/+$/, '')
      return { base: `${scheme}://${u.host}${basePath}`, behindLb: true }
    } catch {
      // fall through to local
    }
  }
  const host = config.host && config.host !== '0.0.0.0' && config.host !== '::' ? config.host : '127.0.0.1'
  return { base: `ws://${host}:${config.port}`, behindLb: false }
}

/** Short-lived JWT for the session's own user/org — reuses the regular
 * upgrade auth chain (verifyAccessToken + isUserActive + canAccessSession)
 * with no new auth surface and no standing privileged identity. */
async function mintInternalToken(
  deps: ChannelDeps,
  userId: string,
  orgId: string,
): Promise<string | null> {
  const issued = await deps.authService.issueInternalChannelToken(userId, orgId)
  return issued?.access_token ?? null
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Open an internal channel to a session's runner. Resolves once the WS to
 * the owning instance is open; the returned emitter delivers runner-protocol
 * lines as `data` (each ending in \n, matching the raw socket contract the
 * consumers already parse) and accepts `write(line)`.
 */
export async function openInternalSessionChannel(
  deps: ChannelDeps,
  sessionId: string,
): Promise<InternalSessionChannel> {
  const session = await deps.store.getSession(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)

  let lastError: unknown = null
  for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(retryDelayMs(attempt - 1))

    // Resolve owner/route freshly each attempt: after a failover the owner
    // moves and the route parameter changes with it.
    const current = await deps.store.getSession(sessionId)
    if (!current) throw new Error(`Session not found: ${sessionId}`)
    const owner = current.currentAttemptId
      ? await deps.store.getAttemptOwnerStatus(current.currentAttemptId, deps.config.heartbeatTimeoutMs)
      : { ownerInstanceId: null, ownerLive: false }
    const route =
      deps.config.instanceId && owner.ownerLive ? owner.ownerInstanceId : null

    const { base, behindLb } = internalBaseWsUrl(deps.config)
    const url = `${base}/ws/internal/sessions/${encodeURIComponent(sessionId)}${
      behindLb && route ? `?${deps.config.routeCookieName}=${encodeURIComponent(route)}` : ''
    }`
    const token = await mintInternalToken(deps, current.userId, current.orgId)
    if (!token) throw new Error(`Cannot mint internal token for session ${sessionId}`)

    try {
      return await connectOnce(url, token)
    } catch (error) {
      lastError = error
      // Permanent handshake failures only: 401/403 (auth) and 404
      // (not-found). 409 means a LIVE other instance currently owns the
      // attempt — an owner-contention instant that resolves within the
      // retry budget — and must retry like 5xx (takeover in progress) and
      // network errors, not abort it.
      const status = (error as { status?: number })?.status
      if (status === 401 || status === 403 || status === 404) throw error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Internal channel to session ${sessionId} failed to connect`)
}

/**
 * Ask the OWNING instance to revoke a session's auth-proxy token (HA).
 * Terminate is a REST op and can land on any instance behind the LB, but
 * the token registry lives in the owner's process — so the non-owner
 * forwards the revoke through the same owner-aware route the WS channel
 * uses (`?moss_route=<owner>`). Failure is logged and swallowed: a dead
 * owner's registry died with its process (nothing left to revoke), so the
 * only real loss is the token's natural TTL on a live-but-unreachable
 * owner.
 */
export async function revokeInternalSessionToken(
  deps: ChannelDeps,
  session: { sessionId: string; userId: string; orgId: string },
  ownerInstanceId: string,
): Promise<void> {
  const { base } = internalBaseWsUrl(deps.config)
  const httpBase = base.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')
  const url =
    `${httpBase}/api/v1/internal/sessions/${encodeURIComponent(session.sessionId)}` +
    `/revoke-token?${deps.config.routeCookieName}=${encodeURIComponent(ownerInstanceId)}`
  const token = await mintInternalToken(deps, session.userId, session.orgId)
  if (!token) {
    process.stderr.write(
      `[InternalChannel] cannot mint token to forward token-revoke for session ${session.sessionId}\n`,
    )
    return
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      process.stderr.write(
        `[InternalChannel] token-revoke forward for session ${session.sessionId} ` +
          `returned ${res.status}\n`,
      )
    }
  } catch (error) {
    process.stderr.write(
      `[InternalChannel] token-revoke forward for session ${session.sessionId} failed: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
}

function connectOnce(url: string, token: string): Promise<InternalSessionChannel> {
  return new Promise((resolve, reject) => {
    const emitter = new EventEmitter() as InternalSessionChannel & { destroyed: boolean }
    let settled = false
    let ws: WebSocket
    try {
      ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
    } catch (error) {
      reject(error)
      return
    }

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      try { ws.terminate() } catch { /* ignore */ }
      reject(error)
    }

    ws.on('unexpected-response', (_req: unknown, res: { statusCode?: number }) => {
      const error = new Error(`internal channel handshake failed: ${res.statusCode}`) as Error & { status?: number }
      error.status = res.statusCode ?? undefined
      fail(error)
    })
    ws.on('error', (error: unknown) => fail(error))
    ws.on('open', () => {
      if (settled) return
      settled = true
      ws.on('message', (data: unknown) => {
        const line = String(data)
        emitter.emit('data', line.endsWith('\n') ? line : `${line}\n`)
      })
      ws.on('close', () => emitter.emit('close'))
      resolve(emitter)
    })

    emitter.write = (line: string, onError?: (error: unknown) => void) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(line, onError ? (error: unknown) => onError(error) : undefined)
        return true
      }
      return false
    }
    emitter.end = () => emitter.destroy()
    emitter.destroy = () => {
      emitter.destroyed = true
      try { ws.terminate() } catch { /* ignore */ }
    }
    ws.on('close', () => { emitter.destroyed = true })
  })
}
