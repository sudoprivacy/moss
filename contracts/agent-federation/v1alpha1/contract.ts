/** Moss-owned federation boundary. Experimental; ADR-003/004 remain Proposed. */
export const AGENT_FEDERATION_API = 'agent-federation.sudo.dev/v1alpha1' as const
export const AGENT_HTTP_API = 'agent-http.sudo.dev/v1alpha1' as const

export interface ProviderCapabilities {
  supports_streaming: boolean
  supports_cancel: boolean
  supports_resume: boolean
  supports_idempotency: boolean
  supports_tool_events: boolean
  supports_trace_export: boolean
  supports_version_pin: boolean
  supports_human_approval: boolean
}

/** A source declaration, never executable code, credentials or an endpoint policy. */
export interface CustomAgentManifest {
  api_version: typeof AGENT_FEDERATION_API
  kind: 'CustomAgentManifest'
  provider_kind: 'custom_http'
  external_agent_id: string
  name: string
  description?: string
  source_revision: string
  execution_mode: 'external_hosted'
  protocol: typeof AGENT_HTTP_API
  input_profile: 'query_only_v1'
  output_profile: 'text_v1'
  capabilities: ProviderCapabilities
}

/** Created by authenticated ingress; provider identifiers never populate these fields. */
export interface TaskCorrelation {
  task_id: string
  attempt_id: string
  session_id: string
}

export interface ExternalRunBinding extends TaskCorrelation {
  api_version: typeof AGENT_FEDERATION_API
  kind: 'ExternalRunBinding'
  binding_id: string
  provider_kind: 'dify' | 'custom_http'
  /** Claimed provider identity; missing evidence on legacy rows is not verification. */
  external_agent_id: string
  source_identity_evidence?: 'unverified'
  source_digest: string
  provider_run_id: string
  provider_session_id?: string
  adapter_version: string
  observability: 'partial'
  replay: 'unsupported'
  resume: 'unsupported'
  version_evidence: 'source_snapshot_only'
  started_at: string
  completed_at?: string
}

export interface ProviderObservation extends TaskCorrelation {
  api_version: typeof AGENT_FEDERATION_API
  kind: 'ProviderObservation'
  sequence: number
  provider_kind: 'dify' | 'custom_http'
  adapter_version: string
  type: 'output_snapshot' | 'result'
  text: string
  status: 'running' | 'succeeded' | 'failed'
  provider_refs: { run_id?: string; session_id?: string; message_id?: string; provider_task_id?: string; provider_workflow_run_id?: string }
  observed_at: string
}

export interface InvokeHttpAgent {
  api_version: typeof AGENT_HTTP_API
  kind: 'InvokeAgent'
  invocation_id: string
  external_agent_id: string
  query: string
  provider_session_id: string | null
  end_user: string
}

export interface HttpAgentResult {
  api_version: typeof AGENT_HTTP_API
  kind: 'AgentResult'
  invocation_id: string
  provider_run_id: string
  provider_session_id?: string
  status: 'succeeded' | 'failed'
  output: { text: string }
}
