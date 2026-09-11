/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { isUniqueViolation, type DbDriver } from '../../db/driver.js'

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
  constructor(private driver: DbDriver) {}

  // ==================== Trigger CRUD ====================

  /**
   * Create a trigger and return it alongside the one-time plaintext secret.
   * The caller must surface `secret` to the client immediately — it is
   * unrecoverable afterwards.
   */
  async insert(input: CreateEventTriggerInput): Promise<{ trigger: EventTrigger; secret: string }> {
    const id = randomUUID()
    const ts = now()
    const { secret, secretHash, secretPrefix } = generateSecret()

    await this.driver.run(`
      INSERT INTO event_triggers (
        id, org_id, user_id, name, enabled, deleted_at,
        secret_hash, secret_prefix, prompt_template,
        assistant_name, conversation_mode, bound_session_id, last_session_id,
        workspace, timeout_ms, rate_limit_per_min,
        last_used_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)
    `, [
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
    ])

    return { trigger: (await this.getById(id))!, secret }
  }

  async update(triggerId: string, input: UpdateEventTriggerInput): Promise<EventTrigger | null> {
    const existing = await this.getById(triggerId)
    if (!existing) return null

    await this.driver.run(`
      UPDATE event_triggers
      SET name = ?, enabled = ?, prompt_template = ?,
          assistant_name = ?, conversation_mode = ?, bound_session_id = ?,
          workspace = ?, timeout_ms = ?, rate_limit_per_min = ?,
          updated_at = ?
      WHERE id = ?
    `, [
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
    ])

    return this.getById(triggerId)
  }

  /** Mint a fresh secret, invalidating the old one immediately. */
  async rotateSecret(triggerId: string): Promise<{ trigger: EventTrigger; secret: string } | null> {
    const existing = await this.getById(triggerId)
    if (!existing) return null
    const { secret, secretHash, secretPrefix } = generateSecret()
    await this.driver.run(`
      UPDATE event_triggers SET secret_hash = ?, secret_prefix = ?, updated_at = ? WHERE id = ?
    `, [secretHash, secretPrefix, now(), triggerId])
    return { trigger: (await this.getById(triggerId))!, secret }
  }

  async softDelete(triggerId: string): Promise<void> {
    await this.driver.run(`UPDATE event_triggers SET deleted_at = ? WHERE id = ?`, [now(), triggerId])
  }

  async getById(triggerId: string): Promise<EventTrigger | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM event_triggers WHERE id = ? AND deleted_at IS NULL LIMIT 1
    `, [triggerId])
    return row ? mapTrigger(row) : null
  }

  async listByOrg(orgId: string): Promise<EventTrigger[]> {
    const rows = await this.driver.all<SqlRow>(`
      SELECT * FROM event_triggers
      WHERE org_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC
    `, [orgId])
    return rows.map(mapTrigger)
  }

  async markUsed(triggerId: string): Promise<void> {
    await this.driver.run(`UPDATE event_triggers SET last_used_at = ? WHERE id = ?`, [now(), triggerId])
  }

  async updateLastSession(triggerId: string, sessionId: string): Promise<void> {
    await this.driver.run(`
      UPDATE event_triggers SET last_session_id = ?, updated_at = ? WHERE id = ?
    `, [sessionId, now(), triggerId])
  }

  // ==================== Runs ====================

  /**
   * Enqueue a run. Returns null when `idempotencyKey` collides with an
   * existing run for this trigger — the unique partial index is the
   * authority, so two concurrent requests with the same key can never both
   * insert. Callers should re-read via findRunByIdempotencyKey on null.
   */
  async createRun(input: {
    triggerId: string
    orgId: string
    userId: string
    payloadJson: string | null
    idempotencyKey?: string | null
  }): Promise<EventTriggerRun | null> {
    const id = randomUUID()
    try {
      await this.driver.run(`
        INSERT INTO event_trigger_runs (
          id, trigger_id, org_id, user_id, session_id, status,
          payload_json, idempotency_key,
          started_at, finished_at, error, summary, created_at
        ) VALUES (?, ?, ?, ?, NULL, 'queued', ?, ?, NULL, NULL, NULL, NULL, ?)
      `, [
        id,
        input.triggerId,
        input.orgId,
        input.userId,
        input.payloadJson,
        input.idempotencyKey ?? null,
        now(),
      ])
    } catch (err) {
      // UNIQUE violation on (trigger_id, idempotency_key) => duplicate event.
      if (isUniqueViolation(err)) return null
      throw err
    }
    return this.getRunById(id)
  }

  async findRunByIdempotencyKey(triggerId: string, key: string): Promise<EventTriggerRun | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM event_trigger_runs
      WHERE trigger_id = ? AND idempotency_key = ? LIMIT 1
    `, [triggerId, key])
    return row ? mapRun(row) : null
  }

  /**
   * Atomically claim up to `limit` queued runs, flipping them to 'running'
   * in the same statement that selects them.
   *
   * This single UPDATE is what makes concurrent executor ticks safe across
   * instances. The `status = 'queued'` predicate appears on BOTH the inner
   * SELECT and the outer UPDATE: under PG READ COMMITTED two instances can pick
   * the same id in their subqueries, but the loser blocks on the row lock and,
   * when it unblocks, re-evaluates the OUTER `status = 'queued'` against the
   * winner's committed 'running' row (EvalPlanQual) — which no longer matches,
   * so the UPDATE skips it and it is not returned. Without the outer predicate
   * the loser would overwrite started_at and double-run the event. (SQLite
   * serializes writers, so the subquery re-eval alone already sufficed there.)
   */
  async claimQueuedRuns(limit: number): Promise<EventTriggerRun[]> {
    if (limit <= 0) return []
    const ts = now()
    const rows = await this.driver.all<SqlRow>(`
      UPDATE event_trigger_runs
      SET status = 'running', started_at = ?
      WHERE id IN (
        SELECT id FROM event_trigger_runs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        LIMIT ?
      )
      AND status = 'queued'
      RETURNING *
    `, [ts, limit])
    return rows.map(mapRun)
  }

  async getRunById(runId: string): Promise<EventTriggerRun | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM event_trigger_runs WHERE id = ? LIMIT 1
    `, [runId])
    return row ? mapRun(row) : null
  }

  async listRunsByTrigger(triggerId: string, limit = 50): Promise<EventTriggerRun[]> {
    const rows = await this.driver.all<SqlRow>(`
      SELECT * FROM event_trigger_runs
      WHERE trigger_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `, [triggerId, limit])
    return rows.map(mapRun)
  }

  async countActiveRuns(): Promise<number> {
    const row = await this.driver.get<SqlRow>(`
      SELECT COUNT(*) AS n FROM event_trigger_runs WHERE status = 'running'
    `)
    return Number(row?.n ?? 0)
  }

  /**
   * Update a run's status. `finished_at` is stamped automatically on terminal
   * statuses. sessionId uses COALESCE so a null never clobbers an id already
   * recorded; error/summary are written as given.
   */
  async updateRunStatus(
    runId: string,
    updates: { status: EventRunStatus; sessionId?: string | null; error?: string | null; summary?: string | null },
  ): Promise<void> {
    const isTerminal = TERMINAL_STATUSES.includes(updates.status)
    await this.driver.run(`
      UPDATE event_trigger_runs
      SET status = ?,
          session_id = COALESCE(?, session_id),
          error = ?,
          summary = ?,
          finished_at = ?
      WHERE id = ?
    `, [
      updates.status,
      updates.sessionId ?? null,
      updates.error ?? null,
      updates.summary ?? null,
      isTerminal ? now() : null,
      runId,
    ])
  }

  /**
   * Fail runs left 'running' past `startedBefore` — the crash-recovery path.
   * Without this a run orphaned by a server restart stays 'running' forever
   * and permanently consumes a concurrency slot.
   */
  async reapStaleRuns(startedBefore: number, error: string): Promise<number> {
    const changes = await this.driver.run(`
      UPDATE event_trigger_runs
      SET status = 'error', error = ?, finished_at = ?
      WHERE status IN ('queued', 'running')
        AND COALESCE(started_at, created_at) < ?
    `, [error, now(), startedBefore])
    return changes
  }
}
