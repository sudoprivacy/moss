/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'

type SqlRow = Record<string, unknown>

/**
 * Run lifecycle. Deliberately mirrors CronStore.RunStatus so the two
 * subsystems read the same way in logs and UIs:
 *   queued  -> accepted, waiting for an executor slot
 *   running -> claimed by the executor, agent session in flight
 *   ok / error / skipped -> terminal
 */
export type EventRunStatus = 'queued' | 'running' | 'ok' | 'error' | 'skipped'

const TERMINAL_STATUSES: EventRunStatus[] = ['ok', 'error', 'skipped']

/** Secret shown to the client once at create/rotate time. */
export const SECRET_PREFIX = 'moss_evt_'

export interface EventTrigger {
  id: string
  orgId: string
  userId: string
  name: string
  enabled: boolean
  deletedAt: number | null
  /** sha256 of the raw secret. The secret itself is never stored. */
  secretHash: string
  /** Display-only fragment, e.g. "moss_evt_a1b2c3…". */
  secretPrefix: string
  promptTemplate: string
  assistantName: string | null
  conversationMode: 'new' | 'reuse'
  boundSessionId: string | null
  lastSessionId: string | null
  workspace: string | null
  timeoutMs: number | null
  rateLimitPerMin: number | null
  lastUsedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface EventTriggerRun {
  id: string
  triggerId: string
  orgId: string
  userId: string
  sessionId: string | null
  status: EventRunStatus
  payloadJson: string | null
  idempotencyKey: string | null
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  summary: string | null
  createdAt: number
}

export interface CreateEventTriggerInput {
  orgId: string
  userId: string
  name: string
  promptTemplate: string
  enabled?: boolean
  assistantName?: string | null
  conversationMode?: 'new' | 'reuse'
  boundSessionId?: string | null
  workspace?: string | null
  timeoutMs?: number | null
  rateLimitPerMin?: number | null
}

export interface UpdateEventTriggerInput {
  name?: string
  enabled?: boolean
  promptTemplate?: string
  assistantName?: string | null
  conversationMode?: 'new' | 'reuse'
  boundSessionId?: string | null
  workspace?: string | null
  timeoutMs?: number | null
  rateLimitPerMin?: number | null
}

function now(): number {
  return Date.now()
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Mint a new bearer secret. 24 random bytes (192 bits) base64url-encoded,
 * matching createApiKeyRecord in authCenter/db.ts. High entropy is what makes
 * an unsalted sha256 acceptable here — never reuse this shape for a
 * user-chosen value.
 */
export function generateSecret(): { secret: string; secretHash: string; secretPrefix: string } {
  const secret = `${SECRET_PREFIX}${randomBytes(24).toString('base64url')}`
  return {
    secret,
    secretHash: sha256(secret),
    secretPrefix: secret.slice(0, 16),
  }
}

/**
 * Constant-time comparison of two hex digests. The values compared are
 * already hashes of a high-entropy secret, so this is defence in depth
 * rather than a strict necessity — but it costs nothing and keeps this
 * surface consistent with cabin/auth.ts and token.ts.
 */
export function secretMatches(candidateSecret: string, storedHash: string): boolean {
  const candidateBuf = Buffer.from(sha256(candidateSecret), 'utf8')
  const storedBuf = Buffer.from(storedHash, 'utf8')
  if (candidateBuf.length !== storedBuf.length) return false
  return timingSafeEqual(candidateBuf, storedBuf)
}

function mapTrigger(row: SqlRow): EventTrigger {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    name: String(row.name),
    enabled: Boolean(row.enabled),
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
    secretHash: String(row.secret_hash),
    secretPrefix: String(row.secret_prefix),
    promptTemplate: String(row.prompt_template),
    assistantName: typeof row.assistant_name === 'string' ? row.assistant_name : null,
    conversationMode: String(row.conversation_mode ?? 'new') as 'new' | 'reuse',
    boundSessionId: typeof row.bound_session_id === 'string' ? row.bound_session_id : null,
    lastSessionId: typeof row.last_session_id === 'string' ? row.last_session_id : null,
    workspace: typeof row.workspace === 'string' ? row.workspace : null,
    timeoutMs: row.timeout_ms == null ? null : Number(row.timeout_ms),
    rateLimitPerMin: row.rate_limit_per_min == null ? null : Number(row.rate_limit_per_min),
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapRun(row: SqlRow): EventTriggerRun {
  return {
    id: String(row.id),
    triggerId: String(row.trigger_id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    sessionId: typeof row.session_id === 'string' ? row.session_id : null,
    status: String(row.status) as EventRunStatus,
    payloadJson: typeof row.payload_json === 'string' ? row.payload_json : null,
    idempotencyKey: typeof row.idempotency_key === 'string' ? row.idempotency_key : null,
    startedAt: row.started_at == null ? null : Number(row.started_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    error: typeof row.error === 'string' ? row.error : null,
    summary: typeof row.summary === 'string' ? row.summary : null,
    createdAt: Number(row.created_at),
  }
}

export class EventTriggerStore {
  constructor(private db: DatabaseSync) {}

  // ==================== Trigger CRUD ====================

  /**
   * Create a trigger and return it alongside the one-time plaintext secret.
   * The caller must surface `secret` to the client immediately — it is
   * unrecoverable afterwards.
   */
  insert(input: CreateEventTriggerInput): { trigger: EventTrigger; secret: string } {
    const id = randomUUID()
    const ts = now()
    const { secret, secretHash, secretPrefix } = generateSecret()

    this.db.prepare(`
      INSERT INTO event_triggers (
        id, org_id, user_id, name, enabled, deleted_at,
        secret_hash, secret_prefix, prompt_template,
        assistant_name, conversation_mode, bound_session_id, last_session_id,
        workspace, timeout_ms, rate_limit_per_min,
        last_used_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)
    `).run(
      id,
      input.orgId,
      input.userId,
      input.name,
      (input.enabled ?? true) ? 1 : 0,
      secretHash,
      secretPrefix,
      input.promptTemplate,
      input.assistantName ?? null,
      input.conversationMode ?? 'new',
      input.boundSessionId ?? null,
      input.workspace ?? null,
      input.timeoutMs ?? null,
      input.rateLimitPerMin ?? null,
      ts,
      ts,
    )

    return { trigger: this.getById(id)!, secret }
  }

  update(triggerId: string, input: UpdateEventTriggerInput): EventTrigger | null {
    const existing = this.getById(triggerId)
    if (!existing) return null

    this.db.prepare(`
      UPDATE event_triggers
      SET name = ?, enabled = ?, prompt_template = ?,
          assistant_name = ?, conversation_mode = ?, bound_session_id = ?,
          workspace = ?, timeout_ms = ?, rate_limit_per_min = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      input.name ?? existing.name,
      input.enabled !== undefined ? (input.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
      input.promptTemplate ?? existing.promptTemplate,
      input.assistantName !== undefined ? input.assistantName : existing.assistantName,
      input.conversationMode ?? existing.conversationMode,
      input.boundSessionId !== undefined ? input.boundSessionId : existing.boundSessionId,
      input.workspace !== undefined ? input.workspace : existing.workspace,
      input.timeoutMs !== undefined ? input.timeoutMs : existing.timeoutMs,
      input.rateLimitPerMin !== undefined ? input.rateLimitPerMin : existing.rateLimitPerMin,
      now(),
      triggerId,
    )

    return this.getById(triggerId)
  }

  /** Mint a fresh secret, invalidating the old one immediately. */
  rotateSecret(triggerId: string): { trigger: EventTrigger; secret: string } | null {
    const existing = this.getById(triggerId)
    if (!existing) return null
    const { secret, secretHash, secretPrefix } = generateSecret()
    this.db.prepare(`
      UPDATE event_triggers SET secret_hash = ?, secret_prefix = ?, updated_at = ? WHERE id = ?
    `).run(secretHash, secretPrefix, now(), triggerId)
    return { trigger: this.getById(triggerId)!, secret }
  }

  softDelete(triggerId: string): void {
    this.db.prepare(`UPDATE event_triggers SET deleted_at = ? WHERE id = ?`).run(now(), triggerId)
  }

  getById(triggerId: string): EventTrigger | null {
    const row = this.db.prepare(`
      SELECT * FROM event_triggers WHERE id = ? AND deleted_at IS NULL LIMIT 1
    `).get(triggerId) as SqlRow | undefined
    return row ? mapTrigger(row) : null
  }

  listByOrg(orgId: string): EventTrigger[] {
    const rows = this.db.prepare(`
      SELECT * FROM event_triggers
      WHERE org_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC
    `).all(orgId) as SqlRow[]
    return rows.map(mapTrigger)
  }

  markUsed(triggerId: string): void {
    this.db.prepare(`UPDATE event_triggers SET last_used_at = ? WHERE id = ?`).run(now(), triggerId)
  }

  updateLastSession(triggerId: string, sessionId: string): void {
    this.db.prepare(`
      UPDATE event_triggers SET last_session_id = ?, updated_at = ? WHERE id = ?
    `).run(sessionId, now(), triggerId)
  }

  // ==================== Runs ====================

  /**
   * Enqueue a run. Returns null when `idempotencyKey` collides with an
   * existing run for this trigger — the unique partial index is the
   * authority, so two concurrent requests with the same key can never both
   * insert. Callers should re-read via findRunByIdempotencyKey on null.
   */
  createRun(input: {
    triggerId: string
    orgId: string
    userId: string
    payloadJson: string | null
    idempotencyKey?: string | null
  }): EventTriggerRun | null {
    const id = randomUUID()
    try {
      this.db.prepare(`
        INSERT INTO event_trigger_runs (
          id, trigger_id, org_id, user_id, session_id, status,
          payload_json, idempotency_key,
          started_at, finished_at, error, summary, created_at
        ) VALUES (?, ?, ?, ?, NULL, 'queued', ?, ?, NULL, NULL, NULL, NULL, ?)
      `).run(
        id,
        input.triggerId,
        input.orgId,
        input.userId,
        input.payloadJson,
        input.idempotencyKey ?? null,
        now(),
      )
    } catch (err) {
      // UNIQUE violation on (trigger_id, idempotency_key) => duplicate event.
      if (String(err).includes('UNIQUE')) return null
      throw err
    }
    return this.getRunById(id)
  }

  findRunByIdempotencyKey(triggerId: string, key: string): EventTriggerRun | null {
    const row = this.db.prepare(`
      SELECT * FROM event_trigger_runs
      WHERE trigger_id = ? AND idempotency_key = ? LIMIT 1
    `).get(triggerId, key) as SqlRow | undefined
    return row ? mapRun(row) : null
  }

  /**
   * Atomically claim up to `limit` queued runs, flipping them to 'running'
   * in the same statement that selects them.
   *
   * This single UPDATE is what makes concurrent executor ticks safe: SQLite
   * serializes writers, and the `status = 'queued'` predicate is re-evaluated
   * under that write lock, so a run claimed by one tick is no longer eligible
   * for the next. Selecting first and updating after would leave a window in
   * which two ticks both see the same queued row and double-run the event.
   */
  claimQueuedRuns(limit: number): EventTriggerRun[] {
    if (limit <= 0) return []
    const ts = now()
    const rows = this.db.prepare(`
      UPDATE event_trigger_runs
      SET status = 'running', started_at = ?
      WHERE id IN (
        SELECT id FROM event_trigger_runs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        LIMIT ?
      )
      RETURNING *
    `).all(ts, limit) as SqlRow[]
    return rows.map(mapRun)
  }

  getRunById(runId: string): EventTriggerRun | null {
    const row = this.db.prepare(`
      SELECT * FROM event_trigger_runs WHERE id = ? LIMIT 1
    `).get(runId) as SqlRow | undefined
    return row ? mapRun(row) : null
  }

  listRunsByTrigger(triggerId: string, limit = 50): EventTriggerRun[] {
    const rows = this.db.prepare(`
      SELECT * FROM event_trigger_runs
      WHERE trigger_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(triggerId, limit) as SqlRow[]
    return rows.map(mapRun)
  }

  countActiveRuns(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM event_trigger_runs WHERE status = 'running'
    `).get() as SqlRow | undefined
    return Number(row?.n ?? 0)
  }

  /**
   * Update a run's status. `finished_at` is stamped automatically on terminal
   * statuses. sessionId uses COALESCE so a null never clobbers an id already
   * recorded; error/summary are written as given.
   */
  updateRunStatus(
    runId: string,
    updates: { status: EventRunStatus; sessionId?: string | null; error?: string | null; summary?: string | null },
  ): void {
    const isTerminal = TERMINAL_STATUSES.includes(updates.status)
    this.db.prepare(`
      UPDATE event_trigger_runs
      SET status = ?,
          session_id = COALESCE(?, session_id),
          error = ?,
          summary = ?,
          finished_at = ?
      WHERE id = ?
    `).run(
      updates.status,
      updates.sessionId ?? null,
      updates.error ?? null,
      updates.summary ?? null,
      isTerminal ? now() : null,
      runId,
    )
  }

  /**
   * Fail runs left 'running' past `startedBefore` — the crash-recovery path.
   * Without this a run orphaned by a server restart stays 'running' forever
   * and permanently consumes a concurrency slot.
   */
  reapStaleRuns(startedBefore: number, error: string): number {
    const result = this.db.prepare(`
      UPDATE event_trigger_runs
      SET status = 'error', error = ?, finished_at = ?
      WHERE status IN ('queued', 'running')
        AND COALESCE(started_at, created_at) < ?
    `).run(error, now(), startedBefore)
    return Number(result.changes ?? 0)
  }
}
