import { authClient, getToken } from './client'

// ===== Types =====

export interface McpServer {
  id: string
  org_id: string
  name: string
  display_name: string | null
  description: string | null
  icon: string | null
  category: string | null
  risk_level: 'low' | 'medium' | 'high'
  responsible_person: string | null
  scope: 'org' | 'department' | 'user'
  owner_type: 'system' | 'department' | 'user'
  owner_id: string
  mcp_type: 'http' | 'sse' | 'stdio'
  url: string | null
  command: string | null
  args_json: string | null
  env_json: string | null
  timeout_ms: number
  health_check_url: string | null
  use_proxy: boolean
  auth_type: 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth' | 'custom_header' | 'secret_ref'
  secret_ref: string | null
  auth_config_json: string | null
  visible_to: { department_ids?: string[]; user_ids?: string[] } | null
  bound_assistants: string[] | null
  bound_skills: string[] | null
  allow_read: boolean
  allow_write: boolean
  require_confirmation_for_write: boolean
  allow_read_sensitive_fields: boolean
  allow_outbound_network: boolean
  allow_scheduled_task: boolean
  audit_request: boolean
  audit_response_summary: boolean
  redact_sensitive_fields: boolean
  allow_user_disable: boolean
  enabled: boolean
  status: 'enabled' | 'pending' | 'disabled' | 'error' | 'deleted'
  last_invocation_at: number | null
  created_by: string
  updated_by: string | null
  created_at: number
  updated_at: number
  template_id: string | null
}

export interface McpPolicy {
  allow_personal_mcp: boolean
  allow_stdio_mcp: boolean
  allow_http_sse_mcp: boolean
  allow_local_file_access: boolean
  allow_external_network: boolean
  domain_whitelist_json: string[] | null
  require_approval: boolean
  allow_auto_task_call_personal_mcp: boolean
  allow_enterprise_assistant_call_personal_mcp: boolean
  allow_enterprise_context_in_personal_mcp: boolean
  require_confirmation_for_high_risk: boolean
  require_confirmation_for_write: boolean
  audit_request_params: boolean
  audit_response_summary: boolean
  redact_audit_logs: boolean
  limit_concurrency_and_rate: boolean
  restrict_callable_models: boolean
}

export interface McpAuditLog {
  id: string
  org_id: string
  mcp_server_id: string | null
  mcp_server_name: string | null
  action: string
  tool_name: string | null
  user_id: string
  user_name: string | null
  session_id: string | null
  status: 'success' | 'error' | null
  request_params_json: string | null
  response_summary: string | null
  error_message: string | null
  ip_address: string | null
  created_at: number
}

export interface McpApprovalRequest {
  id: string
  org_id: string
  user_id: string
  user_name: string | null
  mcp_server_id: string
  mcp_server_snapshot: string | null
  status: 'pending' | 'approved' | 'rejected'
  reviewed_by: string | null
  reviewer_name: string | null
  review_note: string | null
  reviewed_at: number | null
  created_at: number
}

export interface McpTemplate {
  id: string
  org_id: string
  name: string
  description: string | null
  icon: string
  category: string | null
  tags_json: string[] | null
  mcp_type: 'http' | 'sse' | 'stdio'
  url: string | null
  command: string | null
  args_json: string | null
  env_json: string | null
  timeout_ms: number
  auth_type: 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth' | 'custom_header' | 'secret_ref'
  scope: 'org' | 'department'
  risk_level: 'low' | 'medium' | 'high'
  config_json: string | null
  downloads: number
  rating: number
  created_by: string
  created_at: number
  updated_at: number
}

export type McpServerFormData = Partial<Omit<McpServer, 'id' | 'org_id' | 'created_by' | 'created_at' | 'updated_at' | 'status' | 'last_invocation_at'>>

export type McpTemplateFormData = Partial<Omit<McpTemplate, 'id' | 'org_id' | 'created_by' | 'created_at' | 'updated_at' | 'downloads' | 'rating'>>

export interface UserConfigItem {
  name: string
  target: 'env' | 'headers'
  key: string
  description?: string
  required?: boolean
}

export interface McpConfigParseResult {
  success: boolean
  mcp_type?: 'stdio' | 'http' | 'sse'
  data?: {
    name?: string | null
    mcp_type: 'stdio' | 'http' | 'sse'
    url?: string | null
    command?: string | null
    args_json?: string | null
    env_json?: string | null
    auth_config_json?: string | null
    timeout_ms?: number
  }
  error?: string
  warnings?: string[]
}

export interface UploadIconResponse {
  success: boolean
  data: {
    url: string
  }
}

// Backend MCP endpoints return { success, data, ... } envelope
// while other endpoints return data directly. We must unwrap here.
interface Envelope<T> {
  success: boolean
  data: T
  total?: number
  page?: number
  page_size?: number
}

// ===== API functions =====

export function uploadMcpIcon(file: File): Promise<UploadIconResponse> {
  return authClient.post<UploadIconResponse>('/api/v1/upload/mcp-icon', file, {
    headers: {
      'Content-Type': file.type,
    },
  })
}

export async function fetchMcpServers(params?: Record<string, string>): Promise<{ items: McpServer[]; total: number }> {
  const query = new URLSearchParams(params).toString()
  const path = `/api/v1/admin/mcp-servers${query ? `?${query}` : ''}`
  const res = await authClient.get<Envelope<McpServer[]>>(path)
  return { items: res.data, total: res.total ?? 0 }
}

export async function fetchMcpServer(id: string): Promise<McpServer> {
  const res = await authClient.get<Envelope<McpServer>>(`/api/v1/admin/mcp-servers/${id}`)
  return res.data
}

export async function createMcpServer(data: McpServerFormData): Promise<McpServer> {
  const res = await authClient.post<Envelope<McpServer>>('/api/v1/admin/mcp-servers', data)
  return res.data
}

export async function updateMcpServer(id: string, data: McpServerFormData): Promise<McpServer> {
  const res = await authClient.patch<Envelope<McpServer>>(`/api/v1/admin/mcp-servers/${id}`, data)
  return res.data
}

export async function deleteMcpServer(id: string): Promise<void> {
  await authClient.delete(`/api/v1/admin/mcp-servers/${id}`)
}

export async function testMcpConnection(id: string): Promise<{ success: boolean; message: string; latency_ms?: number }> {
  const res = await authClient.post<Envelope<{ ok: boolean; message: string; latency_ms: number }>>(`/api/v1/admin/mcp-servers/${id}/test`, {})
  return { success: res.data.ok, message: res.data.message, latency_ms: res.data.latency_ms }
}

export async function fetchMcpPolicy(): Promise<McpPolicy> {
  const res = await authClient.get<Envelope<McpPolicy>>('/api/v1/tenant/mcp-policy')
  return res.data
}

export async function updateMcpPolicy(data: Partial<McpPolicy>): Promise<McpPolicy> {
  const res = await authClient.patch<Envelope<McpPolicy>>('/api/v1/admin/mcp-policy', data)
  return res.data
}

export async function fetchMcpAuditLogs(params?: Record<string, string>): Promise<{ items: McpAuditLog[]; total: number }> {
  const query = new URLSearchParams(params).toString()
  const path = `/api/v1/admin/mcp-audit-logs${query ? `?${query}` : ''}`
  const res = await authClient.get<Envelope<McpAuditLog[]>>(path)
  return { items: res.data, total: res.total ?? 0 }
}

// ===== Approval API =====

export async function fetchMcpApprovals(status?: string): Promise<McpApprovalRequest[]> {
  const query = status ? `?status=${status}` : ''
  const res = await authClient.get<Envelope<McpApprovalRequest[]>>(`/api/v1/admin/mcp-approvals${query}`)
  return res.data
}

export async function approveMcpRequest(id: string): Promise<McpApprovalRequest> {
  const res = await authClient.post<Envelope<McpApprovalRequest>>(`/api/v1/admin/mcp-approvals/${id}/approve`, {})
  return res.data
}

export async function rejectMcpRequest(id: string, reviewNote: string): Promise<McpApprovalRequest> {
  const res = await authClient.post<Envelope<McpApprovalRequest>>(`/api/v1/admin/mcp-approvals/${id}/reject`, { review_note: reviewNote })
  return res.data
}

// ===== Template API =====

export async function fetchMcpTemplates(params?: Record<string, string>): Promise<{ items: McpTemplate[]; total: number }> {
  const query = new URLSearchParams(params).toString()
  const path = `/api/v1/admin/mcp-templates${query ? `?${query}` : ''}`
  const res = await authClient.get<Envelope<McpTemplate[]>>(path)
  return { items: res.data, total: res.total ?? 0 }
}

export async function fetchMcpTemplate(id: string): Promise<McpTemplate> {
  const res = await authClient.get<Envelope<McpTemplate>>(`/api/v1/admin/mcp-templates/${id}`)
  return res.data
}

export async function installMcpTemplate(id: string, overrides?: Partial<McpServerFormData>): Promise<McpServer> {
  const res = await authClient.post<Envelope<McpServer>>(`/api/v1/admin/mcp-templates/${id}/install`, overrides ?? {})
  return res.data
}

export async function createMcpTemplate(data: McpTemplateFormData): Promise<McpTemplate> {
  const res = await authClient.post<Envelope<McpTemplate>>('/api/v1/admin/mcp-templates', data)
  return res.data
}

export async function updateMcpTemplate(id: string, data: McpTemplateFormData): Promise<McpTemplate> {
  const res = await authClient.patch<Envelope<McpTemplate>>(`/api/v1/admin/mcp-templates/${id}`, data)
  return res.data
}

export async function deleteMcpTemplate(id: string): Promise<void> {
  await authClient.delete(`/api/v1/admin/mcp-templates/${id}`)
}

// ===== User Config API =====

export async function fetchUserConfig(serverId: string): Promise<{ schema: UserConfigItem[]; values: Record<string, string> }> {
  const res = await authClient.get<Envelope<{ schema: UserConfigItem[]; values: Record<string, string> }>>(`/api/v1/me/mcp-servers/${serverId}/user-config`)
  return res.data
}

export async function setUserConfigValue(serverId: string, key: string, value: string): Promise<void> {
  await authClient.put(`/api/v1/me/mcp-servers/${serverId}/user-config/${encodeURIComponent(key)}`, { value })
}

export async function deleteUserConfigValue(serverId: string, key: string): Promise<void> {
  await authClient.delete(`/api/v1/me/mcp-servers/${serverId}/user-config/${encodeURIComponent(key)}`)
}

// ===== MCP 配置解析 =====

export async function parseMcpConfig(json: string): Promise<McpConfigParseResult> {
  return authClient.post<McpConfigParseResult>('/api/v1/admin/mcp-config/parse', { json })
    .catch((err) => ({
      success: false,
      error: err instanceof Error ? err.message : 'Parse failed',
    }))
}

// ===== SSE: live update subscription (plan §2.5) =====

export type McpSseEventType = 'mcp.changed' | 'mcp.policy.changed'

/**
 * Subscribe to MCP server-side events. Server emits `mcp.changed` on any MCP
 * write (create/update/delete/enable/disable) and `mcp.policy.changed` on policy
 * updates; the frontend should re-fetch the relevant resource on receipt.
 *
 * EventSource cannot send Authorization headers, so the bearer token is appended
 * as `?token=` — the server route `/api/v1/mcp/events` accepts this as documented
 * in plan §2.5.
 */
export function subscribeMcpEvents(handlers: {
  onMcpChanged?: () => void
  onPolicyChanged?: () => void
  onError?: (err: Event) => void
}): () => void {
  const token = getToken()
  const url = `/api/v1/mcp/events${token ? `?token=${encodeURIComponent(token)}` : ''}`
  let es: EventSource | null
  try {
    es = new EventSource(url, { withCredentials: true })
  } catch {
    return () => undefined
  }
  if (handlers.onMcpChanged) {
    es.addEventListener('mcp.changed', () => handlers.onMcpChanged?.())
  }
  if (handlers.onPolicyChanged) {
    es.addEventListener('mcp.policy.changed', () => handlers.onPolicyChanged?.())
  }
  if (handlers.onError) {
    es.onerror = handlers.onError
  }
  return () => {
    es?.close()
  }
}

// ============================================================
// 鉴权配置类型（与后端 authResolver.ts 中的类型保持一致）
// ============================================================

export interface BearerAuthConfig {
  header_name: string
  prefix: string
  token: string
}

export interface BasicAuthConfig {
  header_name: string
  username: string
  password: string
}

export interface ApiKeyAuthConfig {
  header_name: string
  api_key: string
}

export interface OAuthAuthConfig {
  client_id: string
  client_secret: string
  authorization_url: string
  token_url: string
  scopes?: string
}
