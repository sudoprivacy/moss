import { toMossOperationsApiPath } from './api-paths'

export interface OperationsHttpClient {
  get(path: string): Promise<unknown>
  post(path: string, body?: unknown): Promise<unknown>
  put(path: string, body?: unknown): Promise<unknown>
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
  bonus_points?: number
  quota?: number
  payment_method?: string
  status: number
  status_text?: string
  created_at: string
  [key: string]: unknown
}

export interface RechargeRecordItem {
  id: number
  type: string
  order_no?: string | null
  user_phone?: string | null
  user_nickname?: string | null
  points: number
  quota?: number
  amount_cny?: number | null
  payment_method?: string | null
  admin_nickname?: string | null
  source?: string | null
  source_text?: string | null
  reason?: string | null
  created_at: string
  [key: string]: unknown
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
  enterprise_name?: string | null
  reviewed_at?: string | null
  sudorouter_error?: string | null
  status: string | number
  created_at: string
  [key: string]: unknown
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
  ip_address?: string | null
  user_agent?: string | null
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
  const operationsClient: OperationsHttpClient = {
    get: path => client.get(toMossOperationsApiPath(path)),
    post: (path, body) => client.post(toMossOperationsApiPath(path), body),
    put: (path, body) => client.put(toMossOperationsApiPath(path), body),
    delete: path => client.delete(toMossOperationsApiPath(path)),
  }
  return {
    getAdminStats() {
      return operationsClient.get('/api/v1/admin/stats') as Promise<LegacyEnvelope<Record<string, unknown>>>
    },
    listLegacyUsers(input: {
      keyword?: string
      enterpriseId?: number
      status?: number
      role?: string
    } = {}) {
      return operationsClient.get(withQuery('/api/v1/admin/users', {
        keyword: input.keyword,
        enterprise_id: input.enterpriseId,
        status: input.status,
        role: input.role,
      })) as Promise<LegacyEnvelope<unknown[]>>
    },
    approvePendingUser(legacyUserId: number) {
      return operationsClient.post('/api/v1/admin/approve', { userId: legacyUserId }) as Promise<LegacyEnvelope<unknown>>
    },
    rejectPendingUser(legacyUserId: number) {
      return operationsClient.post('/api/v1/admin/reject', { userId: legacyUserId }) as Promise<LegacyEnvelope<unknown>>
    },
    deletePendingUser(legacyUserId: number) {
      return operationsClient.post('/api/v1/admin/delete', { userId: legacyUserId }) as Promise<LegacyEnvelope<unknown>>
    },
    rechargeUser(legacyUserId: number, input: {
      points: number
      reason: string
      paymentReference?: string
    }) {
      return operationsClient.post(`/api/v1/admin/users/${legacyUserId}/recharge`, {
        points: input.points,
        reason: input.reason,
        ...(input.paymentReference ? { payment_reference: input.paymentReference } : {}),
      }) as Promise<LegacyEnvelope<unknown>>
    },
    adjustUserPoints(legacyUserId: number, input: {
      amount: number
      operation: 'add' | 'subtract'
      reason?: string
      syncSudorouter?: boolean
    }) {
      return operationsClient.post(`/api/v1/admin/users/${legacyUserId}/points`, {
        amount: input.amount,
        operation: input.operation,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.syncSudorouter === undefined ? {} : { sync_sudorouter: input.syncSudorouter }),
      }) as Promise<LegacyEnvelope<unknown>>
    },
    syncUserQuota(legacyUserId: number) {
      return operationsClient.post(`/api/v1/admin/users/${legacyUserId}/sync-quota`) as Promise<LegacyEnvelope<unknown>>
    },
    listUserLedger(legacyUserId: number, limit = 100) {
      return operationsClient.get(withQuery(`/api/v1/admin/users/${legacyUserId}/ledger`, { limit })) as Promise<LegacyEnvelope<unknown[]>>
    },
    listInvitations(input: { page: number; pageSize: number; status?: 0 | 1 | 2 }) {
      return operationsClient.get(withQuery('/api/v1/admin/invitation-codes', {
        page: input.page, page_size: input.pageSize, status: input.status,
      })) as Promise<LegacyEnvelope<LegacyPage<InvitationCodeItem>>>
    },
    createInvitations(input: { count: number; initialQuotaUsd?: number | null }) {
      return operationsClient.post('/api/v1/admin/invitation-codes', {
        count: input.count,
        ...(input.initialQuotaUsd == null ? {} : { initial_quota_usd: input.initialQuotaUsd }),
      }) as Promise<LegacyEnvelope<{ codes: string[]; count: number }>>
    },
    deleteInvitation(id: number) {
      return operationsClient.delete(`/api/v1/admin/invitation-codes/${id}`) as Promise<LegacyEnvelope<never>>
    },
    listBillingOrders(input: {
      page: number
      pageSize: number
      status?: string
      orderNo?: string
      userPhone?: string
      startDate?: string
      endDate?: string
    }) {
      return operationsClient.get(withQuery('/api/v1/admin/recharge/orders', {
        page: input.page, pageSize: input.pageSize, status: input.status,
        order_no: input.orderNo, user_phone: input.userPhone,
        start_date: input.startDate, end_date: input.endDate,
      })) as Promise<LegacyEnvelope<LegacyPage<BillingOrderItem>>>
    },
    listRechargeRecords(input: {
      page: number
      pageSize: number
      keyword?: string
      type?: string
      paymentMethod?: string
    }) {
      return operationsClient.get(withQuery('/api/v1/admin/recharge-records', {
        page: input.page, pageSize: input.pageSize, keyword: input.keyword,
        type: input.type, payment_method: input.paymentMethod,
      })) as Promise<LegacyEnvelope<LegacyPage<RechargeRecordItem>>>
    },
    getRechargeStats() {
      return operationsClient.get('/api/v1/admin/recharge/stats') as Promise<LegacyEnvelope<Record<string, unknown>>>
    },
    getBillingOrder(orderNo: string) {
      return operationsClient.get(`/api/v1/admin/recharge/orders/${encodeURIComponent(orderNo)}`) as Promise<LegacyEnvelope<BillingOrderItem>>
    },
    retryBillingOrder(legacyOrderId: number) {
      return operationsClient.post(`/api/v1/admin/recharge/orders/${legacyOrderId}/retry`) as Promise<LegacyEnvelope<unknown>>
    },
    syncPendingBillingOrders() {
      return operationsClient.post('/api/v1/admin/recharge/sync') as Promise<LegacyEnvelope<unknown>>
    },
    getRefundCalculation(orderNo: string) {
      return operationsClient.get(`/api/v1/admin/recharge/refund-calc/${encodeURIComponent(orderNo)}`) as Promise<LegacyEnvelope<Record<string, unknown>>>
    },
    refundBillingOrder(orderNo: string, reason: string) {
      return operationsClient.post(`/api/v1/admin/recharge/orders/${encodeURIComponent(orderNo)}/refund`, { reason }) as Promise<LegacyEnvelope<unknown>>
    },
    syncBillingOrder(orderNo: string) {
      return operationsClient.post(`/api/v1/admin/recharge/orders/${encodeURIComponent(orderNo)}/sync`) as Promise<LegacyEnvelope<unknown>>
    },
    listCreditApplications(input: { page: number; pageSize: number; status?: string; keyword?: string }) {
      return operationsClient.get(withQuery('/api/v1/admin/credit-applications', {
        page: input.page, pageSize: input.pageSize, status: input.status, keyword: input.keyword,
      })) as Promise<LegacyEnvelope<LegacyPage<CreditApplicationItem>>>
    },
    approveCreditApplication(id: number, input: { approvedPoints?: number; adminComment?: string }) {
      return operationsClient.post(`/api/v1/admin/credit-applications/${id}/approve`, {
        ...(input.approvedPoints === undefined ? {} : { approved_points: input.approvedPoints }),
        ...(input.adminComment === undefined ? {} : { admin_comment: input.adminComment }),
      }) as Promise<LegacyEnvelope<unknown>>
    },
    rejectCreditApplication(id: number, adminComment?: string) {
      return operationsClient.post(`/api/v1/admin/credit-applications/${id}/reject`, {
        ...(adminComment === undefined ? {} : { admin_comment: adminComment }),
      }) as Promise<LegacyEnvelope<unknown>>
    },
    getCreditApplication(id: number) {
      return operationsClient.get(`/api/v1/admin/credit-applications/${id}`) as Promise<LegacyEnvelope<CreditApplicationItem>>
    },
    retryCreditApplicationSync(id: number) {
      return operationsClient.post(`/api/v1/admin/credit-applications/${id}/retry-sync`) as Promise<LegacyEnvelope<unknown>>
    },
    getSudoworkSystemConfig() {
      return operationsClient.get('/api/v1/admin/system-config') as Promise<LegacyEnvelope<Record<string, unknown>>>
    },
    updateSudoworkSystemConfig(input: Record<string, unknown>) {
      return operationsClient.put('/api/v1/admin/system-config', input) as Promise<LegacyEnvelope<Record<string, unknown>>>
    },
    listAuditEvents(input: { page: number; pageSize: number; action?: string; userId?: number; dateFrom?: number; dateTo?: number }) {
      return operationsClient.get(withQuery('/api/v1/admin/logs', {
        page: input.page, page_size: input.pageSize, action: input.action, user_id: input.userId,
        date_from: input.dateFrom, date_to: input.dateTo,
      })) as Promise<LegacyEnvelope<LegacyPage<AuditEventItem>>>
    },
    getQualityOverview(input: { startTime?: number; endTime?: number } = {}) {
      return operationsClient.get(withQuery('/api/v1/qms/dashboard/overview', {
        start_time: input.startTime, end_time: input.endTime,
      })) as Promise<{ success: boolean; data: Record<string, unknown> }>
    },
    getQualityLeaderboard(type: 'conversations' | 'turns' | 'steps', input: { limit?: number } = {}) {
      return operationsClient.get(withQuery(`/api/v1/qms/user-stats/leaderboard/${type}`, {
        limit: input.limit,
      })) as Promise<{ success: boolean; data: unknown[] }>
    },
    getQualitySystemHealth() {
      return operationsClient.get('/api/v1/qms/system/health') as Promise<Record<string, unknown>>
    },
    listQualityAlerts(input: { limit?: number; offset?: number } = {}) {
      return operationsClient.get(withQuery('/api/v1/qms/alerts/history', input)) as Promise<{ success: boolean; data: unknown }>
    },
    acknowledgeQualityAlert(id: number) {
      return operationsClient.post(`/api/v1/qms/alerts/history/${id}/acknowledge`) as Promise<{ success: boolean; data: unknown }>
    },
    listCrashIssues(input: { limit?: number; offset?: number; status?: string } = {}) {
      return operationsClient.get(withQuery('/api/v1/qms/crash/issues', input)) as Promise<{ success: boolean; data: unknown[]; total: number }>
    },
    resolveCrashIssue(id: number) {
      return operationsClient.post(`/api/v1/qms/crash/issues/${id}/resolve`) as Promise<{ success: boolean; data: unknown }>
    },
    runQualityAggregation() {
      return operationsClient.post('/api/v1/qms/system/aggregation/run') as Promise<{ success: boolean; data: unknown }>
    },
    getConversationTrend(input: { startTime?: number; endTime?: number; dimension?: string } = {}) {
      return operationsClient.get(withQuery('/api/v1/qms/dashboard/conversations/trend', { start_time: input.startTime, end_time: input.endTime, dimension: input.dimension })) as Promise<{ success: boolean; data: unknown }>
    },
    getConversationDimensions(input: { startTime?: number; endTime?: number } = {}) {
      return operationsClient.get(withQuery('/api/v1/qms/dashboard/conversations/dimensions', { start_time: input.startTime, end_time: input.endTime })) as Promise<{ success: boolean; data: unknown }>
    },
    getConversationErrorTrend(input: { startTime?: number; endTime?: number; errorCode?: string } = {}) {
      return operationsClient.get(withQuery('/api/v1/qms/dashboard/conversations/errors/trend', { start_time: input.startTime, end_time: input.endTime, error_code: input.errorCode })) as Promise<{ success: boolean; data: unknown }>
    },
    getInstallTrend(input: { startTime?: number; endTime?: number; dimension?: string } = {}) {
      return operationsClient.get(withQuery('/api/v1/qms/dashboard/installs/trend', { start_time: input.startTime, end_time: input.endTime, dimension: input.dimension })) as Promise<{ success: boolean; data: unknown }>
    },
    getInstallDimensions(input: { startTime?: number; endTime?: number } = {}) {
      return operationsClient.get(withQuery('/api/v1/qms/dashboard/installs/dimensions', { start_time: input.startTime, end_time: input.endTime })) as Promise<{ success: boolean; data: unknown }>
    },
    getPerformanceTrend(input: { metric?: string; platform?: string; version?: string; startTime?: number; endTime?: number } = {}) {
      return operationsClient.get(withQuery('/api/v1/qms/dashboard/perf/trend', { metric: input.metric, platform: input.platform, version: input.version, start_time: input.startTime, end_time: input.endTime })) as Promise<{ success: boolean; data: unknown }>
    },
    getPerformanceDimensions(input: { startTime?: number; endTime?: number } = {}) {
      return operationsClient.get(withQuery('/api/v1/qms/dashboard/perf/dimensions', { start_time: input.startTime, end_time: input.endTime })) as Promise<{ success: boolean; data: unknown }>
    },
    listQualityUserStats(type: 'conversations' | 'turns' | 'steps', input: { startTime?: number; endTime?: number; limit?: number; offset?: number } = {}) {
      return operationsClient.get(withQuery(`/api/v1/qms/user-stats/${type}`, { start_time: input.startTime, end_time: input.endTime, limit: input.limit, offset: input.offset })) as Promise<{ success: boolean; data: unknown }>
    },
    getQualityUserRealtime(input: { startTime?: number; endTime?: number } = {}) {
      return operationsClient.get(withQuery('/api/v1/qms/user-stats/realtime', { start_time: input.startTime, end_time: input.endTime })) as Promise<{ success: boolean; data: unknown }>
    },
    getQualityUserDetail(userId: string, input: { startTime?: number; endTime?: number } = {}) {
      return operationsClient.get(withQuery(`/api/v1/qms/user-stats/users/${encodeURIComponent(userId)}`, { start_time: input.startTime, end_time: input.endTime })) as Promise<{ success: boolean; data: unknown }>
    },
    getCrashIssue(id: number) { return operationsClient.get(`/api/v1/qms/crash/issues/${id}`) as Promise<{ success: boolean; data: unknown }> },
    listCrashEvents(input: { issueId?: number; limit?: number; offset?: number } = {}) { return operationsClient.get(withQuery('/api/v1/qms/crash/events', { issue_id: input.issueId, limit: input.limit, offset: input.offset })) as Promise<{ success: boolean; data: unknown }> },
    getCrashStatsSummary() { return operationsClient.get('/api/v1/qms/crash/stats/summary') as Promise<{ success: boolean; data: unknown }> },
    getCrashStatsTrend(days?: number) { return operationsClient.get(withQuery('/api/v1/qms/crash/stats/trend', { days })) as Promise<{ success: boolean; data: unknown }> },
    getCrashStatsDistribution(by?: string) { return operationsClient.get(withQuery('/api/v1/qms/crash/stats/distribution', { by })) as Promise<{ success: boolean; data: unknown }> },
    updateCrashIssue(id: number, input: Record<string, unknown>) { return operationsClient.put(`/api/v1/qms/crash/issues/${id}`, input) as Promise<{ success: boolean; data: unknown }> },
    ignoreCrashIssue(id: number) { return operationsClient.post(`/api/v1/qms/crash/issues/${id}/ignore`) as Promise<{ success: boolean; data: unknown }> },
    listAlertConfigs() { return operationsClient.get('/api/v1/qms/alerts/configs') as Promise<{ success: boolean; data: unknown }> },
    getAlertConfig(id: string) { return operationsClient.get(`/api/v1/qms/alerts/configs/${encodeURIComponent(id)}`) as Promise<{ success: boolean; data: unknown }> },
    createAlertConfig(input: Record<string, unknown>) { return operationsClient.post('/api/v1/qms/alerts/configs', input) as Promise<{ success: boolean; data: unknown }> },
    updateAlertConfig(id: string, input: Record<string, unknown>) { return operationsClient.put(`/api/v1/qms/alerts/configs/${encodeURIComponent(id)}`, input) as Promise<{ success: boolean; data: unknown }> },
    deleteAlertConfig(id: string) { return operationsClient.delete(`/api/v1/qms/alerts/configs/${encodeURIComponent(id)}`) as Promise<{ success: boolean }> },
    testAlertConfig(id: string) { return operationsClient.post(`/api/v1/qms/alerts/configs/${encodeURIComponent(id)}/test`) as Promise<{ success: boolean; data: unknown }> },
    getQmsSystemStats() { return operationsClient.get('/api/v1/qms/system/stats') as Promise<{ success: boolean; data: unknown }> },
    getQmsSystemConfig() { return operationsClient.get('/api/v1/qms/system/config') as Promise<{ success: boolean; data: unknown }> },
    updateQmsSystemConfig(key: string, value: unknown) { return operationsClient.put(`/api/v1/qms/system/config/${encodeURIComponent(key)}`, { value }) as Promise<{ success: boolean; data: unknown }> },
    getQmsNotifications() { return operationsClient.get('/api/v1/qms/system/notifications') as Promise<{ success: boolean; data: unknown }> },
    updateQmsNotifications(input: Record<string, unknown>) { return operationsClient.put('/api/v1/qms/system/notifications', input) as Promise<{ success: boolean; data: unknown }> },
    testQmsNotification(channel: string) { return operationsClient.post(`/api/v1/qms/system/notifications/test/${encodeURIComponent(channel)}`) as Promise<{ success: boolean; data: unknown }> },
    getQmsTasks() { return operationsClient.get('/api/v1/qms/system/tasks') as Promise<{ success: boolean; data: unknown }> },
    getQmsRawStats() { return operationsClient.get('/api/v1/qms/system/raw-stats') as Promise<{ success: boolean; data: unknown }> },
    getQmsAggregationInfo() { return operationsClient.get('/api/v1/qms/system/aggregation-info') as Promise<{ success: boolean; data: unknown }> },
  }
}
