/** Durable remote execution. Moss owns this experimental transport contract. */
export const DURABLE_AGENT_HTTP_API = 'agent-http.sudo.dev/v1alpha2' as const

export interface SubmitAgentRun {
  api_version: typeof DURABLE_AGENT_HTTP_API
  kind: 'SubmitAgentRun'
  invocation_id: string
  external_agent_id: string
  /** Digest of the provider executable artifact and immutable execution configuration. */
  execution_revision: string
  query: string
  provider_session_id: string | null
  end_user: string
  /** Absolute deadline is part of the idempotent request, never refreshed on recovery. */
  deadline_at: number
}

export type AgentRunStatus = 'accepted' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'cancelled'
export interface AgentRun {
  api_version: typeof DURABLE_AGENT_HTTP_API
  kind: 'AgentRun'
  invocation_id: string
  request_digest: string
  external_agent_id: string
  execution_revision: string
  provider_run_id: string
  provider_session_id: string
  status: AgentRunStatus
  sequence: number
  output: { text: string }
  error_code: string | null
  created_at: number
  updated_at: number
}

/** Querying/resuming observation never creates a new run or repeats model dispatch. */
export const DURABLE_HTTP_CAPABILITIES = Object.freeze({
  supports_streaming: false, supports_cancel: false, supports_resume: true,
  supports_idempotency: true, supports_tool_events: false, supports_trace_export: false,
  supports_version_pin: true, supports_human_approval: false,
})
