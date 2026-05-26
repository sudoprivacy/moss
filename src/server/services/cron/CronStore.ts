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

function mapCronJob(row: SqlRow): CronJob {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
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

    this.db.prepare(`
      INSERT INTO cron_jobs (
        id, org_id, user_id, name, enabled, deleted_at,
        schedule_kind, schedule_value, schedule_tz, schedule_description,
        payload_message, conversation_mode, bound_session_id, last_session_id,
        assistant_id, assistant_name, workspace, runtime_json,
        next_run_at, lease_until, last_run_at, last_status, last_error,
        run_count, retry_count, max_retries,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, 0, ?, ?, ?)
    `).run(
      id,
      input.orgId,
      input.userId,
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

    this.db.prepare(`
      UPDATE cron_jobs
      SET name = ?, enabled = ?,
          schedule_kind = ?, schedule_value = ?, schedule_tz = ?, schedule_description = ?,
          payload_message = ?, conversation_mode = ?, bound_session_id = ?,
          assistant_id = ?, assistant_name = ?, workspace = ?, runtime_json = ?,
          max_retries = ?, lease_until = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      input.name ?? existing.name,
      input.enabled !== undefined ? (input.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
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

  listByUser(orgId: string, userId: string): CronJob[] {
    const rows = this.db.prepare(`
      SELECT * FROM cron_jobs
      WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC
    `).all(orgId, userId) as SqlRow[]
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

  acquireLease(jobId: string, nowTs: number, leaseUntil: number): boolean {
    const result = this.db.prepare(`
      UPDATE cron_jobs
      SET lease_until = ?, updated_at = ?
      WHERE id = ?
        AND enabled = 1
        AND deleted_at IS NULL
        AND next_run_at IS NOT NULL
        AND next_run_at <= ?
        AND (lease_until IS NULL OR lease_until < ?)
    `).run(leaseUntil, nowTs, jobId, nowTs, nowTs)
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
}
