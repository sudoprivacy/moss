/** MCP Server definition */
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

  visible_to: import('../visibilityFilter.js').VisibleTo

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

  status: 'pending' | 'enabled' | 'disabled' | 'error' | 'deleted'
  enabled: boolean
  last_invocation_at: number | null

  template_id: string | null

  created_by: string
  updated_by: string | null
  created_at: number
  updated_at: number
}

/** MCP Policy (one per org) */
export interface McpPolicy {
  id: string
  org_id: string

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

  created_by: string
  updated_by: string | null
  created_at: number
  updated_at: number
}

/** MCP Audit Log entry */
export interface McpAuditLog {
  id: string
  org_id: string
  mcp_server_id: string | null
  mcp_server_name: string | null
  session_id: string | null
  user_id: string
  user_name: string | null
  action: string
  tool_name: string | null
  request_params_json: string | null
  response_summary: string | null
  status: 'success' | 'error' | null
  error_message: string | null
  ip_address: string | null
  created_at: number
}

/** MCP Approval Request (Phase 2) */
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

/** Input for creating/updating an MCP Server */
export interface McpServerInput {
  name: string
  display_name?: string | null
  description?: string | null
  icon?: string | null
  category?: string | null
  risk_level?: 'low' | 'medium' | 'high'
  responsible_person?: string | null

  scope: 'org' | 'department' | 'user'
  owner_type: 'system' | 'department' | 'user'
  owner_id: string

  mcp_type: 'http' | 'sse' | 'stdio'
  url?: string | null
  command?: string | null
  args_json?: string | null
  env_json?: string | null
  timeout_ms?: number
  health_check_url?: string | null
  use_proxy?: boolean

  auth_type?: 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth' | 'custom_header' | 'secret_ref'
  secret_ref?: string | null
  auth_config_json?: string | null

  visible_to?: import('../visibilityFilter.js').VisibleTo
  bound_assistants?: string[] | null
  bound_skills?: string[] | null

  allow_read?: boolean
  allow_write?: boolean
  require_confirmation_for_write?: boolean
  allow_read_sensitive_fields?: boolean
  allow_outbound_network?: boolean
  allow_scheduled_task?: boolean
  audit_request?: boolean
  audit_response_summary?: boolean
  redact_sensitive_fields?: boolean
  allow_user_disable?: boolean

  template_id?: string | null
}

/** Input for creating/updating an MCP Policy */
export interface McpPolicyInput {
  allow_personal_mcp?: boolean
  allow_stdio_mcp?: boolean
  allow_http_sse_mcp?: boolean
  allow_local_file_access?: boolean
  allow_external_network?: boolean
  domain_whitelist_json?: string[] | null
  require_approval?: boolean
  allow_auto_task_call_personal_mcp?: boolean
  allow_enterprise_assistant_call_personal_mcp?: boolean
  allow_enterprise_context_in_personal_mcp?: boolean

  require_confirmation_for_high_risk?: boolean
  require_confirmation_for_write?: boolean
  audit_request_params?: boolean
  audit_response_summary?: boolean
  redact_audit_logs?: boolean
  limit_concurrency_and_rate?: boolean
  restrict_callable_models?: boolean
}

/** List filter parameters for MCP Servers */
export interface McpServerListFilter {
  scope?: 'org' | 'department' | 'user'
  department_id?: string
  status?: 'enabled' | 'disabled' | 'error' | 'pending' | 'deleted'
  risk_level?: 'low' | 'medium' | 'high'
  mcp_type?: 'http' | 'sse' | 'stdio'
  audit_enabled?: boolean
  bound_assistant?: string
  created_by?: string
  /** When set, only return org-scope MCPs or department-scope MCPs whose owner_id matches.
   *  Used for dept_admin SQL-level visibility filtering so pagination total stays correct. */
  dept_admin_department_id?: string
  page?: number
  page_size?: number
}

/** List filter parameters for MCP Audit Log */
export interface McpAuditLogFilter {
  mcp_server_id?: string
  mcp_server_name?: string
  user_id?: string
  action?: string
  status?: 'success' | 'error'
  since?: number
  until?: number
  page?: number
  page_size?: number
}

/** MCP Template (Phase 2, §4.6 模板市场) */
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
  responsible_person?: string | null
  visible_to_json?: string | null
  bound_assistants_json?: string | null
  bound_skills_json?: string | null
  auth_config_json?: string | null
  security_policy_json?: string | null
}

/** Input for creating an MCP Template */
export interface McpTemplateInput {
  name: string
  description?: string | null
  icon?: string | null
  category?: string | null
  tags_json?: string[] | null
  mcp_type: 'http' | 'sse' | 'stdio'
  url?: string | null
  command?: string | null
  args_json?: string | null
  env_json?: string | null
  timeout_ms?: number
  auth_type?: 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth' | 'custom_header' | 'secret_ref'
  scope?: 'org' | 'department'
  risk_level?: 'low' | 'medium' | 'high'
  config_json?: string | null
  responsible_person?: string | null
  visible_to_json?: string | null
  bound_assistants_json?: string | null
  bound_skills_json?: string | null
  auth_config_json?: string | null
  security_policy_json?: string | null
}

/** List filter for MCP Templates */
export interface McpTemplateListFilter {
  category?: string
  search?: string
  page?: number
  page_size?: number
}

// ==================== Template Auth Config Types ====================

/** A user-fillable config item in template auth config */
export interface TemplateAuthConfigItem {
  name: string
  key: string
  description?: string
  required: boolean
}

/** An OAuth admin pre-fill field (custom label/key/default_value) */
export interface TemplateOauthField {
  label: string
  key: string
  default_value?: string
}

/** Template-layered auth config (stored in auth_config_json column) */
export interface TemplateAuthConfig {
  auth_type: 'none' | 'bearer' | 'basic' | 'api_key' | 'oauth' | 'custom_header' | 'secret_ref'
  pre_filled?: Record<string, string>
  user_items?: TemplateAuthConfigItem[]
  oauth_fields?: TemplateOauthField[]
  custom_header_items?: TemplateAuthConfigItem[]
  secret_ref?: string | null
}

/** Template security policy (stored in security_policy_json column) */
export interface TemplateSecurityPolicy {
  allow_read?: boolean
  allow_write?: boolean
  require_confirmation_for_write?: boolean
  allow_read_sensitive_fields?: boolean
  allow_outbound_network?: boolean
  allow_scheduled_task?: boolean
  audit_request?: boolean
  audit_response_summary?: boolean
  redact_sensitive_fields?: boolean
}

/** Auth credentials provided by user/admin during template installation */
export type AuthCredentials = Record<string, string>

/** User-facing auth user item schema (exposed via sanitizeTemplateForUser) */
export interface AuthUserItem {
  name: string
  key: string
  description?: string
  required: boolean
}

/** Connection test result */
export interface McpConnectionTestResult {
  ok: boolean
  message: string
  latency_ms: number
}

/** SSE event types */
export type McpEventType = 'mcp.changed' | 'mcp.policy.changed'

export interface McpSseEvent {
  org_id: string
  type: McpEventType
}

/** MCP 配置解析结果 */
export type { McpConfigParseResult } from './mcpConfigParser.js'
