import { dcClient } from './client'

export interface CronJob {
  id: string
  orgId: string
  userId: string
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
