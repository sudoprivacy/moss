export interface OperationsHttpClient {
  get(path: string): Promise<unknown>
  post(path: string, body?: unknown): Promise<unknown>
  delete(path: string): Promise<unknown>
}

export interface LegacyEnvelope<T> {
  success: boolean
  data: T
  msg?: string
}

export interface LegacyPage<T> {
  list?: T[]
  items?: T[]
  total: number
  page: number
  pageSize?: number
  page_size?: number
}

export interface InvitationCodeItem {
  id: number
  code: string
  enterprise_id: number
  enterprise_name: string
  initial_quota_usd: number
  status: 0 | 1 | 2
  used_by_user_id?: number | null
  used_at?: string | null
  created_at: string
}

export interface BillingOrderItem {
  id: number
  order_no: string
  user_phone?: string | null
  user_nickname?: string | null
  amount_usd?: number
  amount_cny?: number
  points?: number
  payment_method?: string
  status: number
  status_text?: string
  created_at: string
}

export interface RechargeRecordItem {
  id: number
  type: string
  order_no?: string | null
  user_phone?: string | null
  user_nickname?: string | null
  points: number
  amount_cny?: number | null
  reason?: string | null
  created_at: string
}

export interface CreditApplicationItem {
  id: number
  application_no?: string
  user_phone?: string | null
  user_nickname?: string | null
  requested_points?: number
  approved_points?: number | null
  reason?: string | null
  admin_comment?: string | null
  status: string | number
  created_at: string
}

export interface AuditEventItem {
  id: number | string
  user_id?: number | null
  user_nickname?: string | null
  user_phone?: string | null
  action: string
  resource?: string | null
  resource_id?: string | number | null
  method?: string | null
  path?: string | null
  ip?: string | null
  detail?: unknown
  request_data?: string | null
  response_data?: string | null
  response_status?: number | null
  duration_ms?: number | null
  error_message?: string | null
  created_at: string
}

type QueryValue = string | number | boolean | undefined | null

function withQuery(path: string, query: Record<string, QueryValue>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const suffix = params.toString()
  return suffix ? `${path}?${suffix}` : path
}

export function createOperationsApi(client: OperationsHttpClient) {
  return {
    listInvitations(input: { page: number; pageSize: number; status?: 0 | 1 | 2 }) {
      return client.get(withQuery('/api/v1/admin/invitation-codes', {
        page: input.page, page_size: input.pageSize, status: input.status,
      })) as Promise<LegacyEnvelope<LegacyPage<InvitationCodeItem>>>
    },
    createInvitations(input: { count: number; initialQuotaUsd?: number | null }) {
      return client.post('/api/v1/admin/invitation-codes', {
        count: input.count,
        ...(input.initialQuotaUsd == null ? {} : { initial_quota_usd: input.initialQuotaUsd }),
      }) as Promise<LegacyEnvelope<{ codes: string[]; count: number }>>
    },
    deleteInvitation(id: number) {
      return client.delete(`/api/v1/admin/invitation-codes/${id}`) as Promise<LegacyEnvelope<never>>
    },
    listBillingOrders(input: { page: number; pageSize: number; status?: string; keyword?: string }) {
      return client.get(withQuery('/api/v1/admin/recharge/orders', {
        page: input.page, pageSize: input.pageSize, status: input.status, order_no: input.keyword,
      })) as Promise<LegacyEnvelope<LegacyPage<BillingOrderItem>>>
    },
    listRechargeRecords(input: { page: number; pageSize: number; keyword?: string; type?: string }) {
      return client.get(withQuery('/api/v1/admin/recharge-records', {
        page: input.page, pageSize: input.pageSize, keyword: input.keyword, type: input.type,
      })) as Promise<LegacyEnvelope<LegacyPage<RechargeRecordItem>>>
    },
    getRechargeStats() {
      return client.get('/api/v1/admin/recharge/stats') as Promise<LegacyEnvelope<Record<string, unknown>>>
    },
    syncBillingOrder(orderNo: string) {
      return client.post(`/api/v1/admin/recharge/orders/${encodeURIComponent(orderNo)}/sync`) as Promise<LegacyEnvelope<unknown>>
    },
    listCreditApplications(input: { page: number; pageSize: number; status?: string }) {
      return client.get(withQuery('/api/v1/admin/credit-applications', {
        page: input.page, pageSize: input.pageSize, status: input.status,
      })) as Promise<LegacyEnvelope<LegacyPage<CreditApplicationItem>>>
    },
    approveCreditApplication(id: number, input: { approvedPoints?: number; adminComment?: string }) {
      return client.post(`/api/v1/admin/credit-applications/${id}/approve`, {
        ...(input.approvedPoints === undefined ? {} : { approved_points: input.approvedPoints }),
        ...(input.adminComment === undefined ? {} : { admin_comment: input.adminComment }),
      }) as Promise<LegacyEnvelope<unknown>>
    },
    rejectCreditApplication(id: number, adminComment?: string) {
      return client.post(`/api/v1/admin/credit-applications/${id}/reject`, {
        ...(adminComment === undefined ? {} : { admin_comment: adminComment }),
      }) as Promise<LegacyEnvelope<unknown>>
    },
    listAuditEvents(input: { page: number; pageSize: number; action?: string; userId?: number }) {
      return client.get(withQuery('/api/v1/admin/logs', {
        page: input.page, page_size: input.pageSize, action: input.action, user_id: input.userId,
      })) as Promise<LegacyEnvelope<LegacyPage<AuditEventItem>>>
    },
    getQualityOverview(input: { startTime?: number; endTime?: number } = {}) {
      return client.get(withQuery('/api/v1/qms/dashboard/overview', {
        start_time: input.startTime, end_time: input.endTime,
      })) as Promise<{ success: boolean; data: Record<string, unknown> }>
    },
    getQualityLeaderboard(type: 'conversations' | 'turns' | 'steps', input: { limit?: number } = {}) {
      return client.get(withQuery(`/api/v1/qms/user-stats/leaderboard/${type}`, {
        limit: input.limit,
      })) as Promise<{ success: boolean; data: unknown[] }>
    },
    getQualitySystemHealth() {
      return client.get('/api/v1/qms/system/health') as Promise<Record<string, unknown>>
    },
    listQualityAlerts(input: { limit?: number; offset?: number } = {}) {
      return client.get(withQuery('/api/v1/qms/alerts/history', input)) as Promise<{ success: boolean; data: unknown }>
    },
    acknowledgeQualityAlert(id: number) {
      return client.post(`/api/v1/qms/alerts/history/${id}/acknowledge`) as Promise<{ success: boolean; data: unknown }>
    },
    listCrashIssues(input: { limit?: number; offset?: number; status?: string } = {}) {
      return client.get(withQuery('/api/v1/qms/crash/issues', input)) as Promise<{ success: boolean; data: unknown[]; total: number }>
    },
    resolveCrashIssue(id: number) {
      return client.post(`/api/v1/qms/crash/issues/${id}/resolve`) as Promise<{ success: boolean; data: unknown }>
    },
    runQualityAggregation() {
      return client.post('/api/v1/qms/system/aggregation/run') as Promise<{ success: boolean; data: unknown }>
    },
  }
}
