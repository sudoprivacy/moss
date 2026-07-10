/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSync } from 'node:sqlite'
import { CronStore, type CronJob, type CronJobRun, type CronJobRunWithSession, type CreateCronJobInput, type UpdateCronJobInput } from '../services/cron/CronStore.js'
import { CronService } from '../services/cron/CronService.js'
import { hasScope, isCronAdminCapable } from '../auth/token.js'
import { getSystemSettings } from '../systemSettings.js'

/**
 * Auth shape carrying the fields needed for the clientCronEnabled gate.
 * createJob historically typed auth as { orgId, userId }, but the route always
 * passes the full AuthContext (with role/scopes), so widen it here.
 */
type CronAuth = { orgId: string; userId: string; role?: string; scopes?: string[] }

/**
 * Pure org-policy decision for client-issued cron mutations (#83/#85): is the
 * mutation blocked? Blocked when client cron is disabled and the actor is not
 * admin-capable. Exported for unit testing.
 */
export function isCronMutationBlocked(clientCronEnabled: boolean, auth: CronAuth): boolean {
  return !clientCronEnabled && !isCronAdminCapable(auth)
}

/**
 * Org-policy gate for client-issued cron mutations (#83/#85). Enforced INSIDE
 * the api methods — not only on the HTTP route — so any caller (HTTP route, a
 * future in-session agent tool, internal code) is gated regardless of how it is
 * wired. Admins bypass, matching the route-level and scheduler checks. Returns
 * an error result when blocked so callers surface a clean message.
 */
function cronDisabledError(auth: CronAuth): { success: false; message: string } | null {
  if (isCronMutationBlocked(getSystemSettings().clientCronEnabled, auth)) {
    return { success: false, message: 'cron_disabled_by_org' }
  }
  return null
}

type SqlRow = Record<string, unknown>

/** Parse a co_owner_ids JSON column value into string[] (used by adminListJobs,
 * which builds CronJob objects from raw rows rather than via CronStore). */
function parseCoOwnerIdsRow(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function mapJobToResponse(job: CronJob, getUserName?: (userId: string) => string | undefined) {
  const executorUserId = job.executorUserId ?? job.userId
  return {
    id: job.id,
    orgId: job.orgId,
    userId: job.userId,
    // Resolved server-side (org-agnostic) so owners outside the viewer's org
    // roster — e.g. a super_admin who created the job while switched into this
    // org — still display by name instead of falling back to the raw id.
    userName: getUserName?.(job.userId),
    coOwnerIds: job.coOwnerIds,
    coOwnerNames: job.coOwnerIds.map(id => getUserName?.(id) ?? id),
    // Executor for scheduled runs; defaults to the creator when unset.
    executorUserId,
    executorName: getUserName?.(executorUserId),
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

// Read capability: same org AND (owner OR admin-cron OR, for a dept_admin with
// cron:list:subtree, the job owner is in the actor's department subtree). The
// subtree set is resolved from *current* department membership at request time
// (never frozen), so a member moving out of the subtree drops out immediately.
export function canReadJob(
  auth: { orgId: string; userId: string; scopes?: string[] },
  job: CronJob,
  subtreeUserIds?: Set<string> | null,
): boolean {
  const scopes = auth.scopes ?? []
  if (job.orgId !== auth.orgId) return false
  if (job.userId === auth.userId) return true
  // Co-owners have flat parity with the creator: they can view (and manage).
  if (job.coOwnerIds?.includes(auth.userId)) return true
  if (hasScope(scopes, 'admin:cron') || hasScope(scopes, 'cron:list:any')) return true
  if (hasScope(scopes, 'cron:list:subtree') && subtreeUserIds?.has(job.userId)) return true
  return false
}

// Management capability (update/delete/trigger): the owner, an admin actor, or a
// dept_admin with cron:manage:subtree whose subtree contains the job owner.
// Admins can manage org jobs even while clientCronEnabled=false (#85).
export function canManageJob(
  auth: { orgId: string; userId: string; scopes?: string[] },
  job: CronJob,
  subtreeUserIds?: Set<string> | null,
): boolean {
  const scopes = auth.scopes ?? []
  if (job.orgId !== auth.orgId) return false
  if (job.userId === auth.userId) return true
  // Co-owners have flat parity: view + edit + delete + trigger + manage co-owners.
  if (job.coOwnerIds?.includes(auth.userId)) return true
  if (hasScope(scopes, 'admin:cron') || hasScope(scopes, 'cron:disable:any')) return true
  if (hasScope(scopes, 'cron:manage:subtree') && subtreeUserIds?.has(job.userId)) return true
  return false
}

/**
 * Validate a proposed co-owner set + executor for a job. Enforces:
 *  - every co-owner id is a member of the job's org (fail closed on unknown/foreign),
 *  - the executor (when set) is the creator or one of the co-owners
 *    (executor ∈ {creator} ∪ co_owners).
 * Returns null when valid, or an error message. `isOrgUser` may be undefined
 * (membership check skipped) so unit tests can exercise the constraint logic
 * without a user store.
 */
export function validateCoOwnersAndExecutor(params: {
  orgId: string
  creatorUserId: string
  coOwnerIds?: string[]
  executorUserId?: string | null
  isOrgUser?: (userId: string, orgId: string) => boolean
}): string | null {
  const { orgId, creatorUserId, coOwnerIds, executorUserId, isOrgUser } = params

  const normalizedCoOwners = coOwnerIds ? Array.from(new Set(coOwnerIds)) : undefined

  if (normalizedCoOwners && isOrgUser) {
    for (const id of normalizedCoOwners) {
      if (!isOrgUser(id, orgId)) {
        return `Co-owner ${id} is not a member of this organization`
      }
    }
  }

  if (executorUserId != null) {
    if (isOrgUser && !isOrgUser(executorUserId, orgId)) {
      return `Executor ${executorUserId} is not a member of this organization`
    }
    // The effective co-owner set for the constraint is the proposed set when
    // one is given, else nothing extra beyond the creator (update may change
    // only the executor). The creator is always a valid executor.
    const effectiveCoOwners = normalizedCoOwners ?? []
    const allowed = executorUserId === creatorUserId || effectiveCoOwners.includes(executorUserId)
    if (!allowed) {
      return 'Executor must be the creator or one of the co-owners'
    }
  }

  return null
}

export interface CronApiConfig {
  cronService: CronService
  /** Resolve a user id to a display name for job responses (org-agnostic). */
  getUserName?: (userId: string) => string | undefined
  /**
   * True when `userId` is a member of `orgId` (so it may be a co-owner or
   * executor). Backed by authService.getUserOrNull. When omitted, membership
   * validation is skipped (tests may pass a stub or leave it unset).
   */
  isOrgUser?: (userId: string, orgId: string) => boolean
}

export function createCronApi(db: DatabaseSync, config: CronApiConfig) {
  const store = new CronStore(db)
  const mapJob = (job: CronJob) => mapJobToResponse(job, config.getUserName)

  return {
    /**
     * List all cron jobs for the current user
     */
    listJobs: async (
      auth: { orgId: string; userId: string; scopes?: string[] },
      subtreeUserIds?: Set<string> | null,
    ) => {
      try {
        // A dept_admin with cron:list:subtree sees every job owned by a member
        // of their department subtree; everyone else sees only their own. Admins
        // use the separate /admin/cron/jobs route for the org-wide view.
        const canListSubtree =
          !!subtreeUserIds && subtreeUserIds.size > 0 && hasScope(auth.scopes ?? [], 'cron:list:subtree')
        const jobs = canListSubtree
          ? store.listBySubtree(auth.orgId, Array.from(subtreeUserIds))
          : store.listByUser(auth.orgId, auth.userId)
        return {
          success: true,
          data: jobs.map(mapJob),
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
    getJob: async (
      auth: { orgId: string; userId: string; scopes?: string[] },
      jobId: string,
      subtreeUserIds?: Set<string> | null,
    ) => {
      try {
        const job = store.getById(jobId)
        if (!job) {
          return { success: false, message: 'Job not found' }
        }
        if (!canReadJob(auth, job, subtreeUserIds)) {
          return { success: false, message: 'Access denied' }
        }
        return {
          success: true,
          data: mapJob(job),
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
    createJob: async (auth: CronAuth, input: Omit<CreateCronJobInput, 'orgId' | 'userId'>) => {
      try {
        const blocked = cronDisabledError(auth)
        if (blocked) return blocked
        // Executor defaults to the creator; validate any co-owners/executor the
        // caller supplied (org membership + executor ∈ {creator} ∪ co_owners).
        const validationError = validateCoOwnersAndExecutor({
          orgId: auth.orgId,
          creatorUserId: auth.userId,
          coOwnerIds: input.coOwnerIds,
          executorUserId: input.executorUserId,
          isOrgUser: config.isOrgUser,
        })
        if (validationError) return { success: false, message: validationError }
        const job = store.insert({
          ...input,
          orgId: auth.orgId,
          userId: auth.userId,
          executorUserId: input.executorUserId ?? auth.userId,
        })
        config.cronService.addJob(job)
        return {
          success: true,
          data: mapJob(job),
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
    updateJob: async (auth: CronAuth, jobId: string, updates: UpdateCronJobInput, subtreeUserIds?: Set<string> | null) => {
      try {
        const blocked = cronDisabledError(auth)
        if (blocked) return blocked
        const existing = store.getById(jobId)
        if (!existing) {
          return { success: false, message: 'Job not found' }
        }
        // Owner, an admin actor, or a dept_admin managing a subtree member's job
        // may fully update it (canManageJob). Admins/super_admins hold cron
        // management via `*`, so the admin console can edit any org job's
        // schedule/payload/enabled state, not just disable it (#85).
        if (!canManageJob(auth, existing, subtreeUserIds)) {
          return { success: false, message: 'Access denied' }
        }

        // Resolve the effective co-owner set + executor after this update, so the
        // constraint is checked against the post-update state (a caller may edit
        // only one of the two). If the executor is being removed from the
        // co-owner set (and is not the creator), repoint it to the creator
        // rather than leaving a dangling executor.
        if (updates.coOwnerIds !== undefined || updates.executorUserId !== undefined) {
          const nextCoOwners =
            updates.coOwnerIds !== undefined
              ? Array.from(new Set(updates.coOwnerIds))
              : existing.coOwnerIds
          let nextExecutor =
            updates.executorUserId !== undefined
              ? updates.executorUserId
              : existing.executorUserId ?? existing.userId
          // If the executor became invalid only as a SIDE EFFECT of removing it
          // from the co-owner set (the caller didn't set executor explicitly),
          // repoint to the creator rather than failing the whole update. An
          // explicitly-set invalid executor still falls through to validation
          // below and is rejected.
          if (
            updates.executorUserId === undefined &&
            nextExecutor != null &&
            nextExecutor !== existing.userId &&
            !nextCoOwners.includes(nextExecutor)
          ) {
            nextExecutor = existing.userId
          }
          const validationError = validateCoOwnersAndExecutor({
            orgId: existing.orgId,
            creatorUserId: existing.userId,
            coOwnerIds: nextCoOwners,
            executorUserId: nextExecutor,
            isOrgUser: config.isOrgUser,
          })
          if (validationError) return { success: false, message: validationError }
          updates = { ...updates, coOwnerIds: nextCoOwners, executorUserId: nextExecutor }
        }

        const job = store.update(jobId, updates)
        if (!job) {
          return { success: false, message: 'Failed to update job' }
        }
        config.cronService.updateJob(job)
        return {
          success: true,
          data: mapJob(job),
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
    deleteJob: async (auth: CronAuth, jobId: string, subtreeUserIds?: Set<string> | null) => {
      try {
        const blocked = cronDisabledError(auth)
        if (blocked) return blocked
        const existing = store.getById(jobId)
        if (!existing) {
          return { success: false, message: 'Job not found' }
        }
        if (!canManageJob(auth, existing, subtreeUserIds)) {
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
    triggerJob: async (auth: CronAuth, jobId: string, subtreeUserIds?: Set<string> | null) => {
      try {
        const blocked = cronDisabledError(auth)
        if (blocked) return blocked
        const existing = store.getById(jobId)
        if (!existing) {
          return { success: false, message: 'Job not found' }
        }
        if (!canManageJob(auth, existing, subtreeUserIds)) {
          return { success: false, message: 'Access denied' }
        }

        // Manual runs execute under the identity of whoever clicked (auth),
        // not the job's scheduled executor. canManageJob above guarantees the
        // actor is the creator, a co-owner, or an admin.
        const run = await config.cronService.triggerJob(jobId, {
          userId: auth.userId,
          orgId: auth.orgId,
        })
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
    listRuns: async (auth: { orgId: string; userId: string; scopes?: string[] }, jobId: string, limit = 50, subtreeUserIds?: Set<string> | null) => {
      try {
        const existing = store.getById(jobId)
        if (!existing) {
          return { success: false, message: 'Job not found' }
        }
        if (!canReadJob(auth, existing, subtreeUserIds)) {
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
          return mapJob({
            id: String(row.id),
            orgId: String(row.org_id),
            userId: String(row.user_id),
            coOwnerIds: parseCoOwnerIdsRow(row.co_owner_ids),
            executorUserId: typeof row.executor_user_id === 'string' ? row.executor_user_id : null,
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
