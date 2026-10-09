import { authClient } from './client'

export interface ModelToken {
  user_id: string | null
  purpose: 'member' | 'service'
  provisioning_status: string
  token_name?: string
  token_id?: number
  key_masked?: string
  unlimited?: boolean
  remaining_limit_usd?: string | null
  used_amount_usd?: string
  admin_status?: 'enabled' | 'disabled'
  effective_status?: string
}
export interface ModelAccount {
  org_id: string
  router_user_id?: number
  account_status: string
  model_balance_usd?: string
  used_amount_usd?: string
  default_member_limit_usd?: string | null
  can_manage: boolean
}
export interface OrganizationRechargeOrder {
  source: 'online' | 'manual'
  order_no: string
  org_id: string
  router_user_id: number
  payer_user_id: string
  payer_username: string | null
  payer_nickname: string | null
  purchase_amount_usd: string
  bonus_amount_usd: string
  amount_cny_fen: number | null
  payment_method: 'ALIPAY' | 'WECHAT' | null
  payment_status: 'pending' | 'paying' | 'paid' | 'cancelled' | 'not_required'
  credit_status: 'pending' | 'sending' | 'credited' | 'needs_review' | 'failed'
  payment_test_mode: boolean
  created_at: number
  expires_at: number | null
  paid_at: number | null
  credited_at: number | null
  reason?: string
  related_order_no?: string | null
  attempts?: Array<{ reference: string; status: string; created_at: number }>
  audit?: Array<{ actor_user_id: string; action: string; evidence: string; created_at: number }>
  resolution?: {
    is_manual: boolean; status: string; original_outcome: string; expected_amount_usd: string
    original_credited_usd: string; manual_credited_usd: string; difference_usd: string; unsettled_count: number
    related_credits: Array<{ credit_no: string; amount_usd: string; status: string }>
    audit: Array<{ actor_user_id: string; action: string; evidence: string; created_at: number }>
  }
}
export interface ModelUsage {
  member: ModelToken | null
  items: Array<{ id: string; created_at: number; model_name: string; input_tokens: number; output_tokens: number; amount_usd: string; duration: number | null }>
  total: number
}
export const modelBillingApi = {
  orders: (page = 1, source = 'all') => authClient.get<{ data: { items: OrganizationRechargeOrder[]; total: number; page: number; page_size: number } }>(`/api/v1/model-billing/admin/orders?page=${page}&page_size=20&source=${source}`).then(r => r.data),
  manualCredit: (input: { amount_usd: string; reason: string; related_order_no: string | null }, reference: string) => authClient.post('/api/v1/model-billing/admin/credits', input, { headers: { 'Idempotency-Key': reference } }),
  reconcile: (kind: 'credits' | 'orders', no: string, action: 'resolve' | 'retry' | 'resolution', input: Record<string, unknown>, reference: string) => authClient.post(`/api/v1/model-billing/admin/${kind}/${encodeURIComponent(no)}/${action}`, input, { headers: { 'Idempotency-Key': reference } }),
  usage: (userId: string, page = 1) => authClient.get<{ data: ModelUsage }>(`/api/v1/model-account/members/${encodeURIComponent(userId)}/usage?page=${page}`).then(r => r.data),
  limitMode: (userId: string, limit: string | null, reference: string) => authClient.patch(`/api/v1/model-account/members/${encodeURIComponent(userId)}/limit-mode`, { unlimited: limit === null, remaining_limit_usd: limit }, { headers: { 'Idempotency-Key': reference } }),
  account: () => authClient.get<{ data: ModelAccount }>('/api/v1/model-account').then(r => r.data),
  members: () => authClient.get<{ data: { items: ModelToken[] } }>('/api/v1/model-account/members').then(r => r.data.items),
  serviceLimit: (amount: string, direction: 'increase' | 'decrease', reference: string) => authClient.post('/api/v1/model-account/service/limit', { amount_usd: amount, direction }, { headers: { 'Idempotency-Key': reference } }),
  serviceStatus: (status: 'enabled' | 'disabled', reference: string) => authClient.patch('/api/v1/model-account/service/status', { status }, { headers: { 'Idempotency-Key': reference } }),
  accountStatus: (status: 'enabled' | 'disabled', reference: string) => authClient.patch('/api/v1/model-account/status', { status }, { headers: { 'Idempotency-Key': reference } }),
  defaults: (limit: string | null) => authClient.patch('/api/v1/model-account/defaults', { member_limit_usd: limit }),
  retry: () => authClient.post('/api/v1/model-account/retry'),
  provision: (userId: string) => authClient.post(`/api/v1/model-account/members/${encodeURIComponent(userId)}/provision`),
  status: (userId: string, status: 'enabled' | 'disabled', reference: string) => authClient.patch(`/api/v1/model-account/members/${encodeURIComponent(userId)}/status`, { status }, { headers: { 'Idempotency-Key': reference } }),
  limit: (userId: string, amount: string, direction: 'increase' | 'decrease', reference: string) => authClient.post(`/api/v1/model-account/members/${encodeURIComponent(userId)}/limit`, { amount_usd: amount, direction }, { headers: { 'Idempotency-Key': reference } }),
}
