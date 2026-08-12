/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'http'
import type { EventTriggerService } from '../services/eventTrigger/EventTriggerService.js'
import type { EventTrigger, EventTriggerRun, EventTriggerStore } from '../services/eventTrigger/EventTriggerStore.js'
import { secretMatches } from '../services/eventTrigger/EventTriggerStore.js'

/** Hard cap on an inbound event body. */
const MAX_EVENT_BODY_BYTES = 1024 * 1024

/** Default per-trigger ingest ceiling when the trigger sets none. */
const DEFAULT_RATE_LIMIT_PER_MIN = Number(process.env.MOSS_EVENT_RATE_LIMIT_PER_MIN) || 120

type AuthLike = { orgId: string; userId: string; role?: string; scopes?: string[] }

/**
 * Parse an optional positive-integer setting (timeout_ms, rate_limit_per_min).
 *
 * Returns null for "unset — use the default". Note that `Number(null)` and
 * `Number('')` are both 0, so a bare `Number.isFinite(Number(v))` check would
 * silently turn an explicit null (which is what the UI sends when the field is
 * left empty) into 0 — a 0ms timeout kills the run on the next tick, and a
 * 0/min rate limit rejects every request. Non-positive and unparseable values
 * are treated as unset for the same reason.
 */
function optionalPositiveInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.floor(n)
}

/**
 * Public (client-visible) trigger shape. Deliberately omits secret_hash —
 * the secret is returned exactly once, at create/rotate time.
 */
function mapTrigger(t: EventTrigger) {
  return {
    id: t.id,
    org_id: t.orgId,
    user_id: t.userId,
    name: t.name,
    enabled: t.enabled,
    secret_prefix: t.secretPrefix,
    prompt_template: t.promptTemplate,
    assistant_name: t.assistantName,
    conversation_mode: t.conversationMode,
    bound_session_id: t.boundSessionId,
    last_session_id: t.lastSessionId,
    workspace: t.workspace,
    timeout_ms: t.timeoutMs,
    rate_limit_per_min: t.rateLimitPerMin,
    last_used_at: t.lastUsedAt,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    events_url: `/api/v1/triggers/${t.id}/events`,
  }
}

function mapRun(r: EventTriggerRun) {
  return {
    id: r.id,
    trigger_id: r.triggerId,
    org_id: r.orgId,
    user_id: r.userId,
    session_id: r.sessionId,
    status: r.status,
    payload: r.payloadJson ? safeParse(r.payloadJson) : null,
    idempotency_key: r.idempotencyKey,
    started_at: r.startedAt,
    finished_at: r.finishedAt,
    error: r.error,
    summary: r.summary,
    created_at: r.createdAt,
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * Fixed-window rate limiter, keyed by trigger id. In-memory and per-process,
 * which matches the single-process deployment; a multi-node rollout would
 * need this moved into the DB alongside the runs table.
 */
class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>()

  check(key: string, limitPerMin: number): boolean {
    if (limitPerMin <= 0) return true
    const now = Date.now()
    const entry = this.windows.get(key)
    if (!entry || now >= entry.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + 60_000 })
      return true
    }
    if (entry.count >= limitPerMin) return false
    entry.count += 1
    return true
  }

  /** Drop expired windows so the map cannot grow without bound. */
  sweep(): void {
    const now = Date.now()
    for (const [key, entry] of this.windows.entries()) {
      if (now >= entry.resetAt) this.windows.delete(key)
    }
  }
}

class IngestError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

/**
 * Read the raw body with a hard byte cap, destroying the request when
 * exceeded. The main server's readRawBody has NO cap; this surface is
 * reachable by external systems, so it must not use it.
 */
function readCappedBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', chunk => {
      const buf = Buffer.from(chunk)
      total += buf.length
      if (total > maxBytes) {
        reject(new IngestError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'))
        req.destroy()
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function getHeader(req: http.IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()]
  return Array.isArray(raw) ? raw[0] : raw
}

/** Accept either `Authorization: Bearer <secret>` or `X-Moss-Trigger-Secret`. */
function extractSecret(req: http.IncomingMessage): string | null {
  const header = getHeader(req, 'authorization')
  const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (bearer) return bearer.trim()
  const direct = getHeader(req, 'x-moss-trigger-secret')
  return direct ? direct.trim() : null
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/**
 * Ingest sub-router. Mounted ABOVE the server's bearer-JWT auth wall because
 * it authenticates with a per-trigger secret instead. Returns false for any
 * path it does not own so the main router continues.
 */
export function createEventTriggerIngest(service: EventTriggerService) {
  const store = service.getStore()
  const limiter = new RateLimiter()
  const sweeper = setInterval(() => limiter.sweep(), 60_000)
  sweeper.unref?.()

  return {
    async handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
      const match = pathname.match(/^\/api\/v1\/triggers\/([^/]+)\/events$/)
      if (!match) return false
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method_not_allowed' })
        return true
      }

      const triggerId = match[1]
      try {
        const secret = extractSecret(req)
        if (!secret) {
          throw new IngestError(401, 'MISSING_SECRET', 'A trigger secret is required')
        }

        const trigger = store.getById(triggerId)
        // Same opaque 401 whether the trigger is missing, deleted, or the
        // secret is wrong: a caller holding no valid secret must not be able
        // to probe which trigger ids exist.
        if (!trigger || !secretMatches(secret, trigger.secretHash)) {
          throw new IngestError(401, 'INVALID_SECRET', 'Invalid trigger credentials')
        }
        if (!trigger.enabled) {
          throw new IngestError(403, 'TRIGGER_DISABLED', 'This trigger is disabled')
        }

        // Non-positive means "unset" — a stored 0 (written before the API
        // stopped coercing null → 0) would otherwise reject every request.
        const limit =
          trigger.rateLimitPerMin && trigger.rateLimitPerMin > 0
            ? trigger.rateLimitPerMin
            : DEFAULT_RATE_LIMIT_PER_MIN
        if (!limiter.check(trigger.id, limit)) {
          res.setHeader('Retry-After', '60')
          throw new IngestError(429, 'RATE_LIMITED', `Rate limit of ${limit}/min exceeded for this trigger`)
        }

        const raw = await readCappedBody(req, MAX_EVENT_BODY_BYTES)
        const text = raw.toString('utf8').trim()
        let payloadJson: string | null = null
        if (text) {
          try {
            // Re-serialize so we store canonical JSON and reject junk early,
            // rather than discovering it when building the prompt.
            payloadJson = JSON.stringify(JSON.parse(text))
          } catch {
            throw new IngestError(400, 'INVALID_JSON', 'Request body must be valid JSON')
          }
        }

        const idempotencyKey = getHeader(req, 'x-moss-idempotency-key')?.trim() || null

        // The run identity comes from the TRIGGER record, never the request.
        // This is the org-isolation boundary for an externally-started run.
        let run = store.createRun({
          triggerId: trigger.id,
          orgId: trigger.orgId,
          userId: trigger.userId,
          payloadJson,
          idempotencyKey,
        })

        if (!run && idempotencyKey) {
          // Unique-index collision: this event was already accepted. Return
          // the original run so a client retry is a no-op, not a duplicate.
          const existing = store.findRunByIdempotencyKey(trigger.id, idempotencyKey)
          if (existing) {
            writeJson(res, 200, {
              run_id: existing.id,
              status: existing.status,
              duplicate: true,
            })
            return true
          }
        }
        if (!run) {
          throw new IngestError(500, 'ENQUEUE_FAILED', 'Failed to enqueue the event')
        }

        store.markUsed(trigger.id)

        // 202 immediately — the agent runs out of band. Blocking here would
        // tie the client's request to a multi-minute agent run.
        writeJson(res, 202, {
          run_id: run.id,
          status: run.status,
          trigger_id: trigger.id,
          status_url: `/api/v1/triggers/${trigger.id}/runs/${run.id}`,
        })
        return true
      } catch (err) {
        if (err instanceof IngestError) {
          writeJson(res, err.status, { error: err.code, message: err.message })
          return true
        }
        console.error('[eventTriggers] ingest error:', err)
        writeJson(res, 500, { error: 'internal_error' })
        return true
      }
    },
  }
}

/**
 * Management API (create/list/update/delete/rotate + run history).
 * Every method is org-pinned: orgId comes from the caller's token, never the
 * body, and a cross-org id returns null so the route layer answers 404 —
 * matching revokeApiKey, so existence does not leak across orgs.
 */
export function createEventTriggerApi(options: {
  store: EventTriggerStore
  getUserName?: (userId: string) => string | undefined
}) {
  const { store, getUserName } = options

  /** Fetch org-scoped; null for missing OR cross-org (caller returns 404). */
  function getOwned(auth: AuthLike, triggerId: string): EventTrigger | null {
    const trigger = store.getById(triggerId)
    if (!trigger || trigger.orgId !== auth.orgId) return null
    return trigger
  }

  return {
    listTriggers(auth: AuthLike) {
      return {
        triggers: store.listByOrg(auth.orgId).map(t => ({
          ...mapTrigger(t),
          user_name: getUserName?.(t.userId),
        })),
      }
    },

    getTrigger(auth: AuthLike, triggerId: string) {
      const trigger = getOwned(auth, triggerId)
      if (!trigger) return null
      return { trigger: { ...mapTrigger(trigger), user_name: getUserName?.(trigger.userId) } }
    },

    createTrigger(
      auth: AuthLike,
      input: {
        name?: unknown
        prompt_template?: unknown
        assistant_name?: unknown
        conversation_mode?: unknown
        workspace?: unknown
        timeout_ms?: unknown
        rate_limit_per_min?: unknown
        enabled?: unknown
      },
    ) {
      const name = typeof input.name === 'string' ? input.name.trim() : ''
      const promptTemplate =
        typeof input.prompt_template === 'string' ? input.prompt_template.trim() : ''
      if (!name) return { success: false as const, message: 'name is required' }
      if (!promptTemplate) return { success: false as const, message: 'prompt_template is required' }

      const { trigger, secret } = store.insert({
        orgId: auth.orgId,
        userId: auth.userId,
        name,
        promptTemplate,
        enabled: input.enabled === undefined ? true : Boolean(input.enabled),
        assistantName: typeof input.assistant_name === 'string' ? input.assistant_name : null,
        conversationMode: input.conversation_mode === 'reuse' ? 'reuse' : 'new',
        workspace: typeof input.workspace === 'string' ? input.workspace : null,
        timeoutMs: optionalPositiveInt(input.timeout_ms),
        rateLimitPerMin: optionalPositiveInt(input.rate_limit_per_min),
      })

      return {
        success: true as const,
        trigger: mapTrigger(trigger),
        // Shown exactly once — unrecoverable afterwards.
        secret,
      }
    },

    updateTrigger(auth: AuthLike, triggerId: string, updates: Record<string, unknown>) {
      const existing = getOwned(auth, triggerId)
      if (!existing) return null

      const updated = store.update(triggerId, {
        name: typeof updates.name === 'string' ? updates.name.trim() : undefined,
        enabled: updates.enabled === undefined ? undefined : Boolean(updates.enabled),
        promptTemplate:
          typeof updates.prompt_template === 'string' ? updates.prompt_template : undefined,
        assistantName:
          updates.assistant_name === undefined
            ? undefined
            : typeof updates.assistant_name === 'string'
              ? updates.assistant_name
              : null,
        conversationMode:
          updates.conversation_mode === 'reuse'
            ? 'reuse'
            : updates.conversation_mode === 'new'
              ? 'new'
              : undefined,
        workspace:
          updates.workspace === undefined
            ? undefined
            : typeof updates.workspace === 'string'
              ? updates.workspace
              : null,
        timeoutMs:
          updates.timeout_ms === undefined ? undefined : optionalPositiveInt(updates.timeout_ms),
        rateLimitPerMin:
          updates.rate_limit_per_min === undefined
            ? undefined
            : optionalPositiveInt(updates.rate_limit_per_min),
      })

      return updated ? { success: true as const, trigger: mapTrigger(updated) } : null
    },

    deleteTrigger(auth: AuthLike, triggerId: string) {
      const existing = getOwned(auth, triggerId)
      if (!existing) return null
      store.softDelete(triggerId)
      return { success: true as const }
    },

    rotateSecret(auth: AuthLike, triggerId: string) {
      const existing = getOwned(auth, triggerId)
      if (!existing) return null
      const rotated = store.rotateSecret(triggerId)
      if (!rotated) return null
      return { success: true as const, trigger: mapTrigger(rotated.trigger), secret: rotated.secret }
    },

    listRuns(auth: AuthLike, triggerId: string, limit = 50) {
      const existing = getOwned(auth, triggerId)
      if (!existing) return null
      return { runs: store.listRunsByTrigger(triggerId, limit).map(mapRun) }
    },

    getRun(auth: AuthLike, triggerId: string, runId: string) {
      const existing = getOwned(auth, triggerId)
      if (!existing) return null
      const run = store.getRunById(runId)
      // Guard against reading a run id belonging to another trigger.
      if (!run || run.triggerId !== triggerId) return null
      return { run: mapRun(run) }
    },
  }
}
