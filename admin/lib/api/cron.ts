import { dcClient } from './client'

export interface CronJob {
  id: string
  orgId: string
  userId: string
  /** Owner name resolved server-side (works for owners outside this org's roster). */
  userName?: string
  /** Co-owners: flat parity with the creator (view/edit/delete/trigger/manage). */
  coOwnerIds: string[]
  /** Co-owner display names, resolved server-side (index-aligned with coOwnerIds). */
  coOwnerNames?: string[]
  /** Executor for scheduled runs (its credentials are used); defaults to creator. */
  executorUserId: string | null
  /** Executor display name, resolved server-side. */
  executorName?: string
  name: string
  enabled: boolean
  schedule: {
    kind: 'at' | 'every' | 'cron'
    value: string
    tz?: string
    description?: string
  }
  payloadMessage: string
  conversationMode: 'new' | 'reuse'
  boundSessionId: string | null
  lastSessionId: string | null
  assistantId: string | null
  assistantName: string | null
  workspace: string | null
  runtimeJson: string | null
  nextRunAt: number | null
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
  status: 'queued' | 'running' | 'ok' | 'error' | 'skipped' | 'missed'
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  summary: string | null
  createdAt: number
  session?: {
    id: string
    status: string | null
    title: string | null
    assistantName: string | null
    cwd: string | null
    deletedAt: number | null
  } | null
}

export interface CronJobsListResponse {
  success: boolean
  data?: CronJob[]
  message?: string
}

export interface CronJobRunsListResponse {
  success: boolean
  data?: CronJobRun[]
  message?: string
}

export async function getAdminCronJobs(): Promise<CronJobsListResponse> {
  return dcClient.get<CronJobsListResponse>('/api/v1/admin/cron/jobs')
}

/**
 * The org-wide admin list requires admin:cron. A dept_admin/user uses the
 * regular list, which the server scopes to their own jobs (plus the dept
 * subtree for a dept_admin with cron:list:subtree).
 */
export async function getCronJobs(): Promise<CronJobsListResponse> {
  return dcClient.get<CronJobsListResponse>('/api/v1/cron/jobs')
}

export async function getCronJobRuns(jobId: string, limit?: number): Promise<CronJobRunsListResponse> {
  const query = limit ? `?limit=${limit}` : ''
  return dcClient.get<CronJobRunsListResponse>(`/api/v1/cron/jobs/${jobId}/runs${query}`)
}

export async function disableCronJob(jobId: string): Promise<{ success: boolean; data?: CronJob; message?: string }> {
  return dcClient.patch<{ success: boolean; data?: CronJob; message?: string }>(
    `/api/v1/cron/jobs/${jobId}`,
    { enabled: false }
  )
}

export async function enableCronJob(jobId: string): Promise<{ success: boolean; data?: CronJob; message?: string }> {
  return dcClient.patch<{ success: boolean; data?: CronJob; message?: string }>(
    `/api/v1/cron/jobs/${jobId}`,
    { enabled: true }
  )
}

// ---- Job workspace files ----
// Uploaded against the JOB, not a session: 'new' mode gives every run a fresh
// session and 'reuse' keeps one across many runs, so a session-scoped file
// would either vanish next run or be unreachable before the first.

/** Mirrors the server's MossWorkspaceNode. */
export interface CronWorkspaceEntry {
  name: string
  relativePath: string
  fullPath?: string
  isFile: boolean
  isDir: boolean
  size?: number
  mtime?: number
  children?: CronWorkspaceEntry[]
}

export interface CronWorkspaceTreeResponse {
  success: boolean
  message?: string
  workspace?: string
  tree?: CronWorkspaceEntry
}

export async function getCronJobWorkspaceTree(jobId: string): Promise<CronWorkspaceTreeResponse> {
  return dcClient.get<CronWorkspaceTreeResponse>(`/api/v1/cron/jobs/${jobId}/workspace/tree`)
}

/**
 * Upload one file into the job's workspace. Same `path` overwrites — re-uploading
 * a corrected file is the common case, and leaving the stale copy would let the
 * job keep running against it.
 */
export async function uploadCronJobWorkspaceFile(
  jobId: string,
  path: string,
  contentBase64: string,
): Promise<{ success: boolean; relativePath?: string; size?: number; message?: string }> {
  return dcClient.post(`/api/v1/cron/jobs/${jobId}/workspace/file`, {
    path,
    content_base64: contentBase64,
  })
}

export async function deleteCronJobWorkspaceFile(
  jobId: string,
  path: string,
): Promise<{ success: boolean; message?: string }> {
  return dcClient.delete(
    `/api/v1/cron/jobs/${jobId}/workspace/file?path=${encodeURIComponent(path)}`,
  )
}

export interface CronJobFormInput {
  name: string
  /** Cron expression (kind is fixed to 'cron' for console-created jobs) */
  scheduleValue: string
  scheduleDescription?: string
  payloadMessage: string
  /** 'new' spawns a fresh conversation each run; 'reuse' appends to a bound session */
  conversationMode: 'new' | 'reuse'
  /** Optional session to bind to in 'reuse' mode */
  boundSessionId?: string
  /** Assistant to run the task as (stable name/id; '' = default) */
  assistantName?: string
  /** User ids granted co-ownership (view/edit/delete/trigger parity). */
  coOwnerIds?: string[]
  /** Executor for scheduled runs; must be the creator or a co-owner. */
  executorUserId?: string | null
}

/** Create an admin-owned job — it runs under the creating admin's identity,
 * so it keeps firing even while client cron is disabled (#83/#85). */
export async function createCronJob(input: CronJobFormInput): Promise<{ success: boolean; data?: CronJob; message?: string }> {
  return dcClient.post<{ success: boolean; data?: CronJob; message?: string }>('/api/v1/cron/jobs', {
    name: input.name,
    enabled: true,
    schedule: { kind: 'cron', value: input.scheduleValue, description: input.scheduleDescription || undefined },
    payloadMessage: input.payloadMessage,
    conversationMode: input.conversationMode,
    boundSessionId: input.conversationMode === 'reuse' && input.boundSessionId ? input.boundSessionId : undefined,
    // assistantId and assistantName both carry the assistant's stable name; the
    // server resolves it (name or UUID) to a display name at execution time.
    assistantId: input.assistantName || undefined,
    assistantName: input.assistantName || undefined,
    coOwnerIds: input.coOwnerIds ?? undefined,
    executorUserId: input.executorUserId ?? undefined,
  })
}

export async function updateCronJob(jobId: string, input: CronJobFormInput): Promise<{ success: boolean; data?: CronJob; message?: string }> {
  return dcClient.patch<{ success: boolean; data?: CronJob; message?: string }>(`/api/v1/cron/jobs/${jobId}`, {
    name: input.name,
    schedule: { kind: 'cron', value: input.scheduleValue, description: input.scheduleDescription || undefined },
    payloadMessage: input.payloadMessage,
    conversationMode: input.conversationMode,
    // Clear the binding when not in reuse mode; null explicitly unsets it server-side.
    boundSessionId: input.conversationMode === 'reuse' ? (input.boundSessionId || null) : null,
    assistantId: input.assistantName || '',
    assistantName: input.assistantName || '',
    coOwnerIds: input.coOwnerIds ?? [],
    executorUserId: input.executorUserId ?? null,
  })
}

export async function deleteCronJob(jobId: string): Promise<{ success: boolean; message?: string }> {
  return dcClient.delete<{ success: boolean; message?: string }>(`/api/v1/cron/jobs/${jobId}`)
}

export async function triggerCronJob(jobId: string): Promise<{ success: boolean; data?: CronJobRun; message?: string }> {
  return dcClient.post<{ success: boolean; data?: CronJobRun; message?: string }>(`/api/v1/cron/jobs/${jobId}/trigger`)
}
