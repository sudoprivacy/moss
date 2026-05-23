import { dcClient } from './client'
import type {
  BudgetStatsResponse,
  DashboardStatsResponse,
  SessionsListResponse,
  GetSessionResponse,
  GetSessionContextResponse,
  HealthResponse,
  UserSessionsResponse,
} from './types'

export async function getHealth(): Promise<HealthResponse> {
  return dcClient.get<HealthResponse>('/healthz')
}

export async function getSessions(activeOnly = false): Promise<SessionsListResponse> {
  const query = activeOnly ? '?active_only=true' : ''
  return dcClient.get<SessionsListResponse>(`/api/v1/sessions${query}`)
}

export async function getDashboardStats(params?: {
  from?: number
  to?: number
}): Promise<DashboardStatsResponse> {
  const search = new URLSearchParams()
  if (params?.from !== undefined) {
    search.set('from', String(params.from))
  }
  if (params?.to !== undefined) {
    search.set('to', String(params.to))
  }
  const query = search.toString()
  return dcClient.get<DashboardStatsResponse>(
    `/api/v1/dashboard/stats${query ? `?${query}` : ''}`
  )
}

export async function getBudgetStats(): Promise<BudgetStatsResponse> {
  return dcClient.get<BudgetStatsResponse>('/api/v1/budget/stats')
}

export async function getSession(sessionId: string): Promise<GetSessionResponse> {
  return dcClient.get<GetSessionResponse>(`/api/v1/sessions/${sessionId}`)
}

export async function getSessionContext(
  sessionId: string
): Promise<GetSessionContextResponse> {
  return dcClient.get<GetSessionContextResponse>(`/api/v1/sessions/${sessionId}/context`)
}

export async function terminateSession(
  sessionId: string
): Promise<{ ok: boolean }> {
  return dcClient.post<{ ok: boolean }>(`/api/v1/sessions/${sessionId}/terminate`)
}

export async function getUserSessions(
  userId: string
): Promise<UserSessionsResponse> {
  return dcClient.get<UserSessionsResponse>(`/api/v1/users/${userId}/sessions`)
}

export async function resumeSession(
  sessionId: string
): Promise<GetSessionResponse> {
  return dcClient.post<GetSessionResponse>(`/api/v1/sessions/${sessionId}/resume`)
}
