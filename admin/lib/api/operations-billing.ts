import { authClient } from './client'

type ApiResponse<T> = {
  success: boolean
  msg?: string
  data: T
}

export type RechargeSyncStatus = 'NONE' | 'PROCESSING' | 'SYNCED' | 'SYNC_FAILED' | 'SYNC_UNKNOWN' | 'SYNC_INVALID'

export type RechargeOrder = {
  id: number
  order_no: string
  user_id: string
  user_phone: string | null
  user_nickname: string | null
  amount_usd: number
  amount_cny: number
  exchange_rate: number
  points: number
  bonus_points: number
  quota: number
  payment_method: 'ALIPAY' | 'WECHAT'
  status: number
  status_text: string
  sync_status: RechargeSyncStatus
  sync_error: string | null
  created_at: string | null
  callback_time: string | null
  expired_at: string | null
  remark: string | null
  fuiou_order_info?: string | null
}

export type RechargeRecord = {
  id: string
  source: 'CLIENT_RECHARGE' | 'REFUND' | string
  source_text: string
  order_no: string
  user_id: string
  user_phone: string | null
  amount_usd: number | null
  amount_cny: number
  points: number
  bonus_points: number
  payment_method: 'ALIPAY' | 'WECHAT' | null
  status: number
  status_text: string
  sync_status: RechargeSyncStatus
  sync_error: string | null
  created_at: string | null
}

export type RechargeStats = {
  total: {
    orders: number
    amount_usd: number
    amount_cny: number
    points: number
    bonus: number
    success_count: number
    failed_count: number
    pending_count: number
  }
  today: {
    orders: number
    amount_usd: number
    amount_cny: number
    points: number
  }
  by_payment: Record<string, { count: number; amount_usd: number; amount_cny: number }>
  daily: unknown[]
}

export type RechargeListResponse<T> = {
  list: T[]
  total: number
  page: number
  pageSize: number
}

export type SyncPendingResponse = {
  total: number
  success: number
  failed: number
  skipped: number
  results: Array<{ order_no: string; success: boolean; error?: string }>
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') search.set(key, String(value))
  })
  const qs = search.toString()
  return qs ? `?${qs}` : ''
}

export async function getRechargeStats(): Promise<RechargeStats> {
  const response = await authClient.get<ApiResponse<RechargeStats>>('/api/v1/admin/recharge/stats')
  return response.data
}

export async function getRechargeOrders(params: {
  page?: number
  pageSize?: number
  status?: string
  sync_status?: string
  order_no?: string
  user_phone?: string
  start_date?: string
  end_date?: string
}): Promise<RechargeListResponse<RechargeOrder>> {
  const response = await authClient.get<ApiResponse<RechargeListResponse<RechargeOrder>>>(
    `/api/v1/admin/recharge/orders${buildQuery(params)}`,
  )
  return response.data
}

export async function getRechargeRecords(params: {
  page?: number
  pageSize?: number
  order_no?: string
  user_phone?: string
  start_date?: string
  end_date?: string
}): Promise<RechargeListResponse<RechargeRecord>> {
  const response = await authClient.get<ApiResponse<RechargeListResponse<RechargeRecord>>>(
    `/api/v1/admin/recharge-records${buildQuery(params)}`,
  )
  return response.data
}

export async function retryRechargeOrder(orderNoOrId: string | number): Promise<RechargeOrder> {
  const response = await authClient.post<ApiResponse<RechargeOrder>>(
    `/api/v1/admin/recharge/orders/${encodeURIComponent(String(orderNoOrId))}/retry`,
  )
  return response.data
}

export async function syncRechargeOrder(orderNo: string): Promise<RechargeOrder> {
  const response = await authClient.post<ApiResponse<RechargeOrder>>(
    `/api/v1/admin/recharge/orders/${encodeURIComponent(orderNo)}/sync`,
  )
  return response.data
}

export async function syncPendingRechargeOrders(): Promise<SyncPendingResponse> {
  const response = await authClient.post<ApiResponse<SyncPendingResponse>>('/api/v1/admin/recharge/sync')
  return response.data
}
