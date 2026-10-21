/** Read-only management projection. Amounts are Router quota, never a currency estimate. */
export interface AgentUsageWindow { from: number; to: number; mode: 'run' | 'evaluation' }
export interface AgentUsageTotals {
  calls: number
  pending_calls: number
  unknown_calls: number
  missing_attribution_calls: number
  not_invoked_calls: number
  verified_entries: number
  verified_quota: number
  input_tokens: number
  output_tokens: number
}
export interface AgentUsageCall {
  id: string; task_id: string; asset_id: string; owner_user_id: string; department_id: string | null
  platform: string | null; asset_name: string | null; router_authority_id: string | null
  model: string; status: string; created_at: number; updated_at: number
  ledger_status: 'verified' | 'pending' | 'not_invoked'
  token_cleanup: 'pending' | 'confirmed'
  entries: { id: number; account_id: number; created_at: number; quota: number; input_tokens: number; output_tokens: number }[]
}
export interface AgentUsageGroup extends AgentUsageTotals {
  department_id: string | null; department_name: string | null
  platform: string | null; asset_id: string; asset_name: string | null
  router_authority_id: string | null
}
export interface AgentUsageReport {
  kind: 'AgentUsageReport'; authority: 'sudorouter'; unit: 'router_quota'
  window: AgentUsageWindow; captured_at: number
  coverage: 'execution_model_gateway_only'; historical_attribution: 'captured_at_call'
  status: 'verified' | 'partial' | 'no_records'
  authorities: (AgentUsageTotals & { router_authority_id: string | null })[]
  groups: AgentUsageGroup[]
  calls: AgentUsageCall[]
}
