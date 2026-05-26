/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSync } from 'node:sqlite'
import { CronStore, type CronJob, type CronJobRun, type CronJobRunWithSession, type CreateCronJobInput, type UpdateCronJobInput } from '../services/cron/CronStore.js'
import { CronService } from '../services/cron/CronService.js'
import { hasScope } from '../auth/token.js'

type SqlRow = Record<string, unknown>

function mapJobToResponse(job: CronJob) {
  return {
    id: job.id,
    orgId: job.orgId,
    userId: job.userId,
    name: job.name,
    enabled: job.enabled,
    schedule: {
      kind: job.schedule.kind,
      value: job.schedule.value,
      tz: job.schedule.tz,
      description: job.schedule.description,
    },
    payloadMessage: job.payloadMessage,
    conversationMode: job.conversationMode,
    boundSessionId: job.boundSessionId,
    lastSessionId: job.lastSessionId,
    assistantId: job.assistantId,
    assistantName: job.assistantName,
    workspace: job.workspace,
    runtimeJson: job.runtimeJson,
    nextRunAt: job.nextRunAt,
    leaseUntil: job.leaseUntil,
    lastRunAt: job.lastRunAt,
    lastStatus: job.lastStatus,
    lastError: job.lastError,
    runCount: job.runCount,
    retryCount: job.retryCount,
    maxRetries: job.maxRetries,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

function mapRunToResponse(run: CronJobRun) {
  return {
    id: run.id,
    jobId: run.jobId,
    orgId: run.orgId,
    userId: run.userId,
    sessionId: run.sessionId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    summary: run.summary,
    createdAt: run.createdAt,
  }
}

function mapRunWithSessionToResponse(run: CronJobRunWithSession) {
  return {
    ...mapRunToResponse(run),
    session: run.sessionId
      ? {
          id: run.sessionId,
          status: run.sessionStatus,
          title: run.sessionTitle,
          assistantName: run.sessionAssistantName,
          cwd: run.sessionCwd,
          deletedAt: run.sessionDeletedAt,
        }
      : null,
  }
}

function canReadJob(auth: { orgId: string; userId: string; scopes?: string[] }, job: CronJob): boolean {
  const scopes = auth.scopes ?? []
  return job.orgId === auth.orgId && (job.userId === auth.userId || hasScope(scopes, 'admin:cron') || hasScope(scopes, 'cron:list:any'))
}

function canDisableJob(auth: { orgId: string; userId: string; scopes?: string[] }, job: CronJob): boolean {
  const scopes = auth.scopes ?? []
  return job.orgId === auth.orgId && (job.userId === auth.userId || hasScope(scopes, 'admin:cron') || hasScope(scopes, 'cron:disable:any'))
}

export interface CronApiConfig {
  cronService: CronService
}

export function createCronApi(db: DatabaseSync, config: CronApiConfig) {
  const store = new CronStore(db)

  return {
    /**
     * List all cron jobs for the current user
     */
    listJobs: async (auth: { orgId: string; userId: string }) => {
      try {
        const jobs = store.listByUser(auth.orgId, auth.userId)
        return {
          success: true,
          data: jobs.map(mapJobToResponse),
        }
      } catch (err) {
        console.error('[CronApi] Failed to list jobs:', err)
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        }
      }
    },

    /**
     * Get a single cron job by ID
     */
    getJob: async (auth: { orgId: string; userId: string }, jobId: string) => {
      try {
        const job = store.getById(jobId)
        if (!job) {
          return { success: false, message: 'Job not found' }
        }
        if (job.orgId !== auth.orgId || job.userId !== auth.userId) {
          return { success: false, message: 'Access denied' }
        }
        return {
          success: true,
          data: mapJobToResponse(job),
        }
      } catch (err) {
        console.error('[CronApi] Failed to get job:', err)
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        }
      }
    },

    /**
     * Create a new cron job
     */
    createJob: async (auth: { orgId: string; userId: string }, input: Omit<CreateCronJobInput, 'orgId' | 'userId'>) => {
      try {
        const job = store.insert({
          ...input,
          orgId: auth.orgId,
          userId: auth.userId,
        })
        config.cronService.addJob(job)
        return {
          success: true,
          data: mapJobToResponse(job),
        }
      } catch (err) {
        console.error('[CronApi] Failed to create job:', err)
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        }
      }
    },

    /**
     * Update a cron job
     */
    updateJob: async (auth: { orgId: string; userId: string; scopes?: string[] }, jobId: string, updates: UpdateCronJobInput) => {
      try {
        const existing = store.getById(jobId)
        if (!existing) {
          return { success: false, message: 'Job not found' }
        }
        const isOwner = existing.orgId === auth.orgId && existing.userId === auth.userId
        if (!isOwner) {
          if (!canDisableJob(auth, existing)) {
            return { success: false, message: 'Access denied' }
          }
          const updateKeys = Object.keys(updates)
          if (updateKeys.length !== 1 || updates.enabled !== false) {
            return { success: false, message: 'Admins may only disable other users cron jobs' }
          }
        }
        if (!isOwner && updates.enabled !== false) {
          return { success: false, message: 'Access denied' }
        }

        const job = store.update(jobId, updates)
        if (!job) {
          return { success: false, message: 'Failed to update job' }
        }
        config.cronService.updateJob(job)
        return {
          success: true,
          data: mapJobToResponse(job),
        }
      } catch (err) {
        console.error('[CronApi] Failed to update job:', err)
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        }
      }
    },

    /**
     * Delete (soft) a cron job
     */
    deleteJob: async (auth: { orgId: string; userId: string }, jobId: string) => {
      try {
        const existing = store.getById(jobId)
        if (!existing) {
          return { success: false, message: 'Job not found' }
        }
        if (existing.orgId !== auth.orgId || existing.userId !== auth.userId) {
          return { success: false, message: 'Access denied' }
        }

        store.softDelete(jobId)
        config.cronService.removeJob(jobId)
        return { success: true }
      } catch (err) {
        console.error('[CronApi] Failed to delete job:', err)
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        }
      }
    },

    /**
     * Trigger a job immediately
     */
    triggerJob: async (auth: { orgId: string; userId: string }, jobId: string) => {
      try {
        const existing = store.getById(jobId)
        if (!existing) {
          return { success: false, message: 'Job not found' }
        }
        if (existing.orgId !== auth.orgId || existing.userId !== auth.userId) {
          return { success: false, message: 'Access denied' }
        }

        const run = await config.cronService.triggerJob(jobId)
        return {
          success: true,
          data: mapRunToResponse(run),
        }
      } catch (err) {
        console.error('[CronApi] Failed to trigger job:', err)
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        }
      }
    },

    /**
     * List runs for a job
     */
    listRuns: async (auth: { orgId: string; userId: string; scopes?: string[] }, jobId: string, limit = 50) => {
      try {
        const existing = store.getById(jobId)
        if (!existing) {
          return { success: false, message: 'Job not found' }
        }
        if (!canReadJob(auth, existing)) {
          return { success: false, message: 'Access denied' }
        }

        const runs = store.listRunsWithSessionByJob(jobId, limit)
        return {
          success: true,
          data: runs.map(mapRunWithSessionToResponse),
        }
      } catch (err) {
        console.error('[CronApi] Failed to list runs:', err)
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        }
      }
    },

    /**
     * Admin: List all cron jobs in org
     */
    adminListJobs: async (auth: { orgId: string }) => {
      try {
        const rows = db.prepare(`
          SELECT * FROM cron_jobs
          WHERE org_id = ? AND deleted_at IS NULL
          ORDER BY created_at DESC
        `).all(auth.orgId) as SqlRow[]

        // We need to use the store to map properly
        const jobs = rows.map(row => {
          return mapJobToResponse({
            id: String(row.id),
            orgId: String(row.org_id),
            userId: String(row.user_id),
            name: String(row.name),
            enabled: Boolean(row.enabled),
            deletedAt: null,
            schedule: {
              kind: String(row.schedule_kind) as 'at' | 'every' | 'cron',
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
          })
        })

        return {
          success: true,
          data: jobs,
        }
      } catch (err) {
        console.error('[CronApi] Failed to admin list jobs:', err)
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        }
      }
    },
  }
}

export type CronApi = ReturnType<typeof createCronApi>
