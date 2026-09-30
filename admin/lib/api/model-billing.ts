import { authClient } from './client'

export interface ModelToken {
  user_id: string | null
  purpose: 'member' | 'service'
  provisioning_status: string
  token_id?: number
  key_masked?: string
  unlimited?: boolean
  remaining_limit_usd?: string | null
  used_amount_usd?: string
  admin_status?: 'enabled' | 'disabled'
  effective_status?: string
}
export interface ModelAccount {
  account_status: string
  model_balance_usd?: string
  used_amount_usd?: string
  default_member_limit_usd?: string | null
  can_manage: boolean
}
export const modelBillingApi = {
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
