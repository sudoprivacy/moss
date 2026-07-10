/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'

type SqlRow = Record<string, unknown>

export type ScheduleKind = 'at' | 'every' | 'cron'
export type RunStatus = 'queued' | 'running' | 'ok' | 'error' | 'skipped' | 'missed'

export interface CronJobSchedule {
  kind: ScheduleKind
  value: string
  tz?: string
  description?: string
}

export interface CronJob {
  id: string
  orgId: string
  userId: string
  /** User ids granted flat parity (view/manage/trigger) with the creator. */
  coOwnerIds: string[]
  /**
   * Identity a SCHEDULED run executes under (its credentials/workspace/scopes).
   * null (legacy rows) falls back to userId — use `resolveExecutorId(job)`.
   */
  executorUserId: string | null
  name: string
  enabled: boolean
  deletedAt: number | null
  schedule: CronJobSchedule
  payloadMessage: string
  conversationMode: 'new' | 'reuse'
  boundSessionId: string | null
  lastSessionId: string | null
  assistantId: string | null
  assistantName: string | null
  workspace: string | null
  runtimeJson: string | null
  nextRunAt: number | null
  leaseUntil: number | null
  lastRunAt: number | null
  lastStatus: string | null
  lastError: string | null
  runCount: number
  retryCount: number
  maxRetries: number
  createdAt: number
  updatedAt: number
}

export interface CronJobRun {
  id: string
  jobId: string
  orgId: string
  userId: string
  sessionId: string | null
  status: RunStatus
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  summary: string | null
  createdAt: number
}

export interface CronJobRunWithSession extends CronJobRun {
  sessionStatus: string | null
  sessionTitle: string | null
  sessionAssistantName: string | null
  sessionCwd: string | null
  sessionDeletedAt: number | null
}

export interface CreateCronJobInput {
  orgId: string
  userId: string
  coOwnerIds?: string[]
  /** Defaults to userId (creator) when omitted; see CronJob.executorUserId. */
  executorUserId?: string | null
  name: string
  enabled?: boolean
  schedule: CronJobSchedule
  payloadMessage: string
  conversationMode: 'new' | 'reuse'
  boundSessionId?: string
  assistantId?: string
  assistantName?: string
  workspace?: string
  runtimeJson?: string
  maxRetries?: number
}

export interface UpdateCronJobInput {
  coOwnerIds?: string[]
  executorUserId?: string | null
  name?: string
  enabled?: boolean
  schedule?: CronJobSchedule
  payloadMessage?: string
  conversationMode?: 'new' | 'reuse'
  boundSessionId?: string | null
  assistantId?: string
  assistantName?: string
  workspace?: string
  runtimeJson?: string
  maxRetries?: number
}

function now(): number {
  return Date.now()
}

/** Parse the co_owner_ids JSON column into a string[] (empty on null/garbage). */
function parseCoOwnerIds(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/**
 * The identity a run uses: the explicit executor, or the creator (userId) as a
 * fallback for legacy rows. Callers resolving the scheduled-run identity should
 * use this rather than reading executorUserId directly.
 */
export function resolveExecutorId(job: Pick<CronJob, 'userId' | 'executorUserId'>): string {
  return job.executorUserId ?? job.userId
}

function mapCronJob(row: SqlRow): CronJob {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    coOwnerIds: parseCoOwnerIds(row.co_owner_ids),
    executorUserId: typeof row.executor_user_id === 'string' ? row.executor_user_id : null,
    name: String(row.name),
    enabled: Boolean(row.enabled),
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
    schedule: {
      kind: String(row.schedule_kind) as ScheduleKind,
      value: String(row.schedule_value),
      tz: typeof row.schedule_tz === 'string' ? row.schedule_tz : undefined,
      description: typeof row.schedule_description === 'string' ? row.schedule_description : undefined,
    },
    payloadMessage: String(row.payload_message),
    conversationMode: String(row.conversation_mode) as 'new' | 'reuse',
    boundSessionId: typeof row.bound_session_id === 'string' ? row.bound_session_id : null,
    lastSessionId: typeof row.last_session_id === 'string' ? row.last_session_id : null,
    assistantId: typeof row.assistant_id === 'string' ? row.assistant_id : null,
    assistantName: typeof row.assistant_name === 'string' ? row.assistant_name : null,
    workspace: typeof row.workspace === 'string' ? row.workspace : null,
    runtimeJson: typeof row.runtime_json === 'string' ? row.runtime_json : null,
    nextRunAt: row.next_run_at == null ? null : Number(row.next_run_at),
    leaseUntil: row.lease_until == null ? null : Number(row.lease_until),
    lastRunAt: row.last_run_at == null ? null : Number(row.last_run_at),
    lastStatus: typeof row.last_status === 'string' ? row.last_status : null,
    lastError: typeof row.last_error === 'string' ? row.last_error : null,
    runCount: Number(row.run_count ?? 0),
    retryCount: Number(row.retry_count ?? 0),
    maxRetries: Number(row.max_retries ?? 3),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapCronJobRun(row: SqlRow): CronJobRun {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    sessionId: typeof row.session_id === 'string' ? row.session_id : null,
    status: String(row.status) as RunStatus,
    startedAt: row.started_at == null ? null : Number(row.started_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    error: typeof row.error === 'string' ? row.error : null,
    summary: typeof row.summary === 'string' ? row.summary : null,
    createdAt: Number(row.created_at),
  }
}

function mapCronJobRunWithSession(row: SqlRow): CronJobRunWithSession {
  const run = mapCronJobRun(row)
  return {
    ...run,
    sessionStatus: typeof row.session_status === 'string' ? row.session_status : null,
    sessionTitle: typeof row.session_title === 'string' ? row.session_title : null,
    sessionAssistantName: typeof row.session_assistant_name === 'string' ? row.session_assistant_name : null,
    sessionCwd: typeof row.session_cwd === 'string' ? row.session_cwd : null,
    sessionDeletedAt: row.session_deleted_at == null ? null : Number(row.session_deleted_at),
  }
}

export class CronStore {
  constructor(private db: DatabaseSync) {}

  // ==================== CRUD Operations ====================

  insert(input: CreateCronJobInput): CronJob {
    const id = randomUUID()
    const ts = now()
    const schedule = input.schedule

    // Initial executor equals the creator unless explicitly given (both are
    // still validated for org membership + co-owner constraint at the API layer).
    const executorUserId = input.executorUserId ?? input.userId
    const coOwnerIds = input.coOwnerIds ?? []

    this.db.prepare(`
      INSERT INTO cron_jobs (
        id, org_id, user_id, co_owner_ids, executor_user_id, name, enabled, deleted_at,
        schedule_kind, schedule_value, schedule_tz, schedule_description,
        payload_message, conversation_mode, bound_session_id, last_session_id,
        assistant_id, assistant_name, workspace, runtime_json,
        next_run_at, lease_until, last_run_at, last_status, last_error,
        run_count, retry_count, max_retries,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, 0, ?, ?, ?)
    `).run(
      id,
      input.orgId,
      input.userId,
      JSON.stringify(coOwnerIds),
      executorUserId,
      input.name,
      input.enabled ?? true ? 1 : 0,
      schedule.kind,
      schedule.value,
      schedule.tz ?? null,
      schedule.description ?? null,
      input.payloadMessage,
      input.conversationMode,
      input.boundSessionId ?? null,
      input.assistantId ?? null,
      input.assistantName ?? null,
      input.workspace ?? null,
      input.runtimeJson ?? null,
      input.maxRetries ?? 3,
      ts,
      ts,
    )

    return this.getById(id)!
  }

  update(jobId: string, input: UpdateCronJobInput): CronJob | null {
    const existing = this.getById(jobId)
    if (!existing) return null

    const ts = now()
    const schedule = input.schedule ?? existing.schedule

    const coOwnerIds = input.coOwnerIds !== undefined ? input.coOwnerIds : existing.coOwnerIds
    const executorUserId =
      input.executorUserId !== undefined ? input.executorUserId : existing.executorUserId

    this.db.prepare(`
      UPDATE cron_jobs
      SET name = ?, enabled = ?,
          co_owner_ids = ?, executor_user_id = ?,
          schedule_kind = ?, schedule_value = ?, schedule_tz = ?, schedule_description = ?,
          payload_message = ?, conversation_mode = ?, bound_session_id = ?,
          assistant_id = ?, assistant_name = ?, workspace = ?, runtime_json = ?,
          max_retries = ?, lease_until = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      input.name ?? existing.name,
      input.enabled !== undefined ? (input.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
      JSON.stringify(coOwnerIds ?? []),
      executorUserId,
      schedule.kind,
      schedule.value,
      schedule.tz ?? null,
      schedule.description ?? null,
      input.payloadMessage ?? existing.payloadMessage,
      input.conversationMode ?? existing.conversationMode,
      input.boundSessionId !== undefined ? input.boundSessionId : existing.boundSessionId,
      input.assistantId !== undefined ? input.assistantId : existing.assistantId,
      input.assistantName !== undefined ? input.assistantName : existing.assistantName,
      input.workspace !== undefined ? input.workspace : existing.workspace,
      input.runtimeJson !== undefined ? input.runtimeJson : existing.runtimeJson,
      input.maxRetries ?? existing.maxRetries,
      ts,
      jobId,
    )

    return this.getById(jobId)
  }

  softDelete(jobId: string): void {
    this.db.prepare(`
      UPDATE cron_jobs SET deleted_at = ? WHERE id = ?
    `).run(now(), jobId)
  }

  // ==================== Query Operations ====================

  getById(jobId: string): CronJob | null {
    const row = this.db.prepare(`
      SELECT * FROM cron_jobs WHERE id = ? AND deleted_at IS NULL LIMIT 1
    `).get(jobId) as SqlRow | undefined
    return row ? mapCronJob(row) : null
  }

  /**
   * List jobs a user may see as owner OR co-owner. The co-owner match uses
   * json_each over the co_owner_ids JSON array (JSON1 ships with node:sqlite);
   * the id is bound as a parameter so it is injection-safe.
   */
  listByUser(orgId: string, userId: string): CronJob[] {
    const rows = this.db.prepare(`
      SELECT * FROM cron_jobs
      WHERE org_id = ? AND deleted_at IS NULL
        AND (
          user_id = ?
          OR EXISTS (
            SELECT 1 FROM json_each(COALESCE(cron_jobs.co_owner_ids, '[]'))
            WHERE json_each.value = ?
          )
        )
      ORDER BY created_at DESC
    `).all(orgId, userId, userId) as SqlRow[]
    return rows.map(mapCronJob)
  }

  /**
   * List jobs owned OR co-owned by any of the given user ids within an org.
   * Used for a dept_admin's subtree view. An empty id set returns nothing
   * (fail-closed); ids are bound as parameters so the IN list is injection-safe.
   */
  listBySubtree(orgId: string, userIds: string[]): CronJob[] {
    if (userIds.length === 0) return []
    const placeholders = userIds.map(() => '?').join(', ')
    const rows = this.db.prepare(`
      SELECT * FROM cron_jobs
      WHERE org_id = ? AND deleted_at IS NULL
        AND (
          user_id IN (${placeholders})
          OR EXISTS (
            SELECT 1 FROM json_each(COALESCE(cron_jobs.co_owner_ids, '[]'))
            WHERE json_each.value IN (${placeholders})
          )
        )
      ORDER BY created_at DESC
    `).all(orgId, ...userIds, ...userIds) as SqlRow[]
    return rows.map(mapCronJob)
  }

  listEnabled(): CronJob[] {
    const rows = this.db.prepare(`
      SELECT * FROM cron_jobs
      WHERE enabled = 1 AND deleted_at IS NULL
      ORDER BY next_run_at ASC
    `).all() as SqlRow[]
    return rows.map(mapCronJob)
  }

  listDueJobs(nowTs: number): CronJob[] {
    const rows = this.db.prepare(`
      SELECT * FROM cron_jobs
      WHERE enabled = 1 AND deleted_at IS NULL
        AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC
    `).all(nowTs) as SqlRow[]
    return rows.map(mapCronJob)
  }

  listOverdueJobs(nowTs: number): CronJob[] {
    const rows = this.db.prepare(`
      SELECT * FROM cron_jobs
      WHERE enabled = 1 AND deleted_at IS NULL
        AND next_run_at IS NOT NULL AND next_run_at < ?
      ORDER BY next_run_at ASC
    `).all(nowTs) as SqlRow[]
    return rows.map(mapCronJob)
  }

  // ==================== Status Updates ====================

  updateNextRunAt(jobId: string, nextRunAt: number | null): void {
    this.db.prepare(`
      UPDATE cron_jobs SET next_run_at = ?, lease_until = NULL, updated_at = ? WHERE id = ?
    `).run(nextRunAt, now(), jobId)
  }

  updateRunResult(
    jobId: string,
    result: {
      lastSessionId?: string
      lastStatus: string
      lastError?: string
      runCountIncrement?: number
    },
  ): void {
    const ts = now()
    this.db.prepare(`
      UPDATE cron_jobs
      SET last_session_id = COALESCE(?, last_session_id),
          last_run_at = ?,
          last_status = ?,
          last_error = ?,
          run_count = run_count + ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      result.lastSessionId ?? null,
      ts,
      result.lastStatus,
      result.lastError ?? null,
      result.runCountIncrement ?? 1,
      ts,
      jobId,
    )
  }

  /**
   * Acquire the lease for a due job AND advance next_run_at in the same
   * atomic UPDATE. Advancing next_run_at here (rather than after the run
   * completes) is what prevents duplicate fires: a run can take up to
   * CRON_RUN_TIMEOUT_MS (30 min) while the lease is only ~30s, so without
   * this the 60s checkDueJobs poll would keep seeing the job as due
   * (next_run_at <= now, lease expired) and re-fire it every minute until
   * completion. SQLite serializes these UPDATEs and the WHERE still gates on
   * the OLD next_run_at <= now, so exactly one caller wins; concurrent
   * callers see the advanced next_run_at and get changes === 0.
   *
   * nextRunAt is the next occurrence computed by the caller (null for
   * one-shot 'at' jobs, which must never re-fire).
   */
  acquireLease(jobId: string, nowTs: number, leaseUntil: number, nextRunAt: number | null): boolean {
    const result = this.db.prepare(`
      UPDATE cron_jobs
      SET lease_until = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
        AND enabled = 1
        AND deleted_at IS NULL
        AND next_run_at IS NOT NULL
        AND next_run_at <= ?
        AND (lease_until IS NULL OR lease_until < ?)
    `).run(leaseUntil, nextRunAt, nowTs, jobId, nowTs, nowTs)
    return result.changes > 0
  }

  // ==================== Job Runs ====================

  createRun(jobId: string, orgId: string, userId: string): CronJobRun {
    const id = randomUUID()
    const ts = now()

    this.db.prepare(`
      INSERT INTO cron_job_runs (id, job_id, org_id, user_id, session_id, status, started_at, finished_at, error, summary, created_at)
      VALUES (?, ?, ?, ?, NULL, 'queued', NULL, NULL, NULL, NULL, ?)
    `).run(id, jobId, orgId, userId, ts)

    return this.getRunById(id)!
  }

  getRunById(runId: string): CronJobRun | null {
    const row = this.db.prepare(`
      SELECT * FROM cron_job_runs WHERE id = ? LIMIT 1
    `).get(runId) as SqlRow | undefined
    return row ? mapCronJobRun(row) : null
  }

  listRunsByJob(jobId: string, limit = 50): CronJobRun[] {
    const rows = this.db.prepare(`
      SELECT * FROM cron_job_runs WHERE job_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(jobId, limit) as SqlRow[]
    return rows.map(mapCronJobRun)
  }

  listRunsWithSessionByJob(jobId: string, limit = 50): CronJobRunWithSession[] {
    const rows = this.db.prepare(`
      SELECT
        r.*,
        s.status AS session_status,
        s.title AS session_title,
        s.assistant_name AS session_assistant_name,
        s.cwd AS session_cwd,
        s.deleted_at AS session_deleted_at
      FROM cron_job_runs r
      LEFT JOIN sessions s ON s.session_id = r.session_id
      WHERE r.job_id = ?
      ORDER BY r.created_at DESC
      LIMIT ?
    `).all(jobId, limit) as SqlRow[]
    return rows.map(mapCronJobRunWithSession)
  }

  updateRunStatus(
    runId: string,
    update: {
      status: RunStatus
      sessionId?: string
      error?: string
      summary?: string
    },
  ): void {
    const ts = now()
    const finishedAt = ['ok', 'error', 'skipped', 'missed'].includes(update.status) ? ts : null

    this.db.prepare(`
      UPDATE cron_job_runs
      SET status = ?, session_id = COALESCE(?, session_id), finished_at = ?, error = ?, summary = ?
      WHERE id = ?
    `).run(
      update.status,
      update.sessionId ?? null,
      finishedAt,
      update.error ?? null,
      update.summary ?? null,
      runId,
    )
  }

  startRun(runId: string): void {
    const ts = now()
    this.db.prepare(`
      UPDATE cron_job_runs SET status = 'running', started_at = ? WHERE id = ?
    `).run(ts, runId)
  }

  /**
   * True when a job already has a run in flight (queued or running). Used as a
   * concurrency guard so a job whose previous run is stuck/long-running does
   * not stack another run on top — in reuse mode the stacked runs collide on
   * the same single-turn session and each blocks until the timeout.
   */
  hasActiveRun(jobId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM cron_job_runs
      WHERE job_id = ? AND status IN ('queued', 'running')
      LIMIT 1
    `).get(jobId)
    return row != null
  }

  /**
   * Mark runs that have been 'running'/'queued' since before `startedBefore` as
   * errored. Reaps orphans left behind by a server crash/restart (their socket
   * is long gone but the row never reached a terminal status) and runs that
   * blew past the run timeout without their promise settling. Returns the
   * number of runs reaped.
   */
  reapStaleRuns(startedBefore: number, error: string): number {
    const ts = now()
    const result = this.db.prepare(`
      UPDATE cron_job_runs
      SET status = 'error', finished_at = ?, error = ?
      WHERE status IN ('queued', 'running')
        AND COALESCE(started_at, created_at) < ?
    `).run(ts, error, startedBefore)
    return result.changes
  }
}
