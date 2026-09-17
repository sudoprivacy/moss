import type { ServerResponse } from 'http'
import type { McpEventType, McpSseEvent } from '../mcp/types.js'

interface ConnectedClient {
  res: ServerResponse
  orgId: string
  connectedAt: number
  lastActivityAt: number
}

const clients: ConnectedClient[] = []
const MAX_CONNECTIONS_PER_ORG = 10
const HEARTBEAT_INTERVAL_MS = 30_000
const CLIENT_TIMEOUT_MS = 120_000

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

function startHeartbeat(): void {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    const now = Date.now()
    const toRemove: number[] = []

    for (let i = clients.length - 1; i >= 0; i--) {
      const client = clients[i]
      if (now - client.lastActivityAt > CLIENT_TIMEOUT_MS) {
        toRemove.push(i)
        continue
      }
      try {
        client.res.write(':ping\n\n')
      } catch {
        toRemove.push(i)
      }
    }

    for (const idx of toRemove) {
      try { clients[idx].res.end() } catch { /* ignore */ }
      clients.splice(idx, 1)
    }

    if (clients.length === 0 && heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref()
}

export function broadcastMcpEvent(event: McpSseEvent): void {
  const data = JSON.stringify(event)
  const sseMessage = `event: ${event.type}\ndata: ${data}\n\n`
  // Local change: refresh this org's baseline so the cross-instance poll below
  // never re-emits an event the local instance already broadcast. The provider
  // is async (DB driver); fire-and-forget keeps broadcast synchronous — the
  // refresh lands well before the next 3s poll tick.
  void refreshOrgBaseline(event.org_id)

  const toRemove: number[] = []
  for (let i = clients.length - 1; i >= 0; i--) {
    const client = clients[i]
    if (client.orgId !== event.org_id) continue
    try {
      client.res.write(sseMessage)
      client.lastActivityAt = Date.now()
    } catch {
      toRemove.push(i)
    }
  }

  for (const idx of toRemove) {
    try { clients[idx].res.end() } catch { /* ignore */ }
    clients.splice(idx, 1)
  }
}

// Test-only seam: reset the module singleton (clients + heartbeat timer) between
// test cases. No-op in production code paths (never called there).
export function __resetMcpEventsForTest(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  clients.length = 0
  stopChangePolling()
  fingerprintProvider = null
}

// ==================== Cross-instance change detection (HA) ====================
// broadcastMcpEvent only reaches SSE clients connected to the instance that
// made the change; with a shared DB and multiple instances, admin browsers
// attached to another instance would miss the notification. Polling a cheap
// per-org fingerprint closes that gap (≤ CHANGE_POLL_INTERVAL_MS delay for
// remote changes; local changes stay instant via broadcastMcpEvent).

type McpFingerprintProvider = (orgId: string) => Promise<{ servers: string; policy: string }>

let fingerprintProvider: McpFingerprintProvider | null = null
let changePollTimer: ReturnType<typeof setInterval> | null = null
const CHANGE_POLL_INTERVAL_MS = 3_000
const orgBaselines = new Map<string, { servers: string; policy: string }>()

/** Dependency-injected wiring (server.ts): keeps this module free of db imports. */
export function configureMcpChangeDetection(provider: McpFingerprintProvider): void {
  fingerprintProvider = provider
  if (clients.length > 0) ensureChangePolling()
}

function ensureChangePolling(): void {
  if (changePollTimer || !fingerprintProvider) return
  changePollTimer = setInterval(tickMcpChangeDetection, CHANGE_POLL_INTERVAL_MS)
  changePollTimer.unref?.()
}

function stopChangePolling(): void {
  if (changePollTimer) { clearInterval(changePollTimer); changePollTimer = null }
  orgBaselines.clear()
}

async function refreshOrgBaseline(orgId: string): Promise<void> {
  if (!fingerprintProvider) return
  try {
    orgBaselines.set(orgId, await fingerprintProvider(orgId))
  } catch {
    // provider failure must never affect the broadcast path
  }
}

async function tickMcpChangeDetection(): Promise<void> {
  if (!fingerprintProvider) return
  const orgs = new Set<string>()
  for (const client of clients) orgs.add(client.orgId)
  if (orgs.size === 0) {
    stopChangePolling()
    return
  }
  for (const orgId of orgs) {
    let current: { servers: string; policy: string }
    try {
      current = await fingerprintProvider(orgId)
    } catch {
      continue
    }
    const prev = orgBaselines.get(orgId)
    if (!prev) {
      // First sight of this org: the client just connected and did its
      // initial fetch — seed silently instead of replaying history.
      orgBaselines.set(orgId, current)
      continue
    }
    if (prev.servers !== current.servers) {
      broadcastMcpEvent({ org_id: orgId, type: 'mcp.changed' })
    }
    if (prev.policy !== current.policy) {
      broadcastMcpEvent({ org_id: orgId, type: 'mcp.policy.changed' })
    }
    orgBaselines.set(orgId, current)
  }
}

// Test-only seam: run one poll iteration synchronously instead of waiting for
// the real interval.
export async function __tickMcpChangeDetectionForTest(): Promise<void> {
  await tickMcpChangeDetection()
}

export function handleMcpSseConnection(res: ServerResponse, orgId: string): void {
  // Enforce connection limit per org
  const orgConnections = clients.filter(c => c.orgId === orgId)
  if (orgConnections.length >= MAX_CONNECTIONS_PER_ORG) {
    // Close the oldest connection
    const oldest = orgConnections[0]
    const idx = clients.indexOf(oldest)
    if (idx >= 0) {
      try { oldest.res.end() } catch { /* ignore */ }
      clients.splice(idx, 1)
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const client: ConnectedClient = {
    res,
    orgId,
    connectedAt: Date.now(),
    lastActivityAt: Date.now(),
  }
  clients.push(client)

  startHeartbeat()
  ensureChangePolling()

  res.write(':connected\n\n')

  res.on('close', () => {
    const idx = clients.indexOf(client)
    if (idx >= 0) clients.splice(idx, 1)

    if (clients.length === 0 && heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    if (clients.length === 0) {
      stopChangePolling()
    }
  })
}
