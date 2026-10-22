/** Moss-owned experimental Catalog governance. Does not grant runtime authority. */
export const AGENT_CATALOG_API = 'agent-catalog.sudo.dev/v1alpha1' as const
export type CatalogCapability = 'supported' | 'unsupported' | 'partial' | 'provider_dependent' | 'unknown'
export interface CatalogCapabilities {
  streaming: CatalogCapability; cancel: CatalogCapability; resume: CatalogCapability
  idempotency: CatalogCapability; trace_export: 'full' | 'partial' | 'none' | 'unknown'
  version_pin: CatalogCapability; human_approval: CatalogCapability
}
export interface CatalogSource {
  api_version: typeof AGENT_CATALOG_API
  id: string; catalog_id: string; org_id: string; zone_id: string | null; owner_id: string
  name: string; provider: 'dify' | 'custom_http'; protocol: string; external_agent_id: string
  allowed_user_ids: string[]; review_note: string
  endpoint: string; connection_id: string; credential_reference: string
  revision: number; enabled: boolean; availability: 'unknown' | 'available' | 'unavailable'
  adapter_version: string; definition_available: boolean
  last_sync_at: number | null; last_sync_status: 'never' | 'running' | 'succeeded' | 'failed'
  last_error: string | null; warning_count: number; created_at: number; updated_at: number
}
export interface CatalogSnapshot {
  name: string; protocol: string; external_agent_id: string
  source_revision: string | null; revision_basis: 'provider_declared' | 'content_digest'
  source_digest: string; parameters_digest: string; adapter_version: string
  endpoint: string; input_profile: string; output_profile: string
  capabilities: CatalogCapabilities; user_ids: string[]; data_scope: 'synthetic_only'
  requested_permissions: { profile: 'sudo-task-grant/v1'; model_resource: string; tool_resources: string[]; max_model_calls: number } | null
}
export interface CatalogValidationReport {
  id: string; rule_version: string; source_revision: number; binding_revision: number
  policy_digest: string; snapshot_digest: string; validated_at: number
  status: 'valid'; checks: string[]; warnings: string[]; unsupported: string[]
}
export interface CatalogChange { field: string; before: string | null; after: string | null }
export interface CatalogDecision { action: 'submitted' | 'approved' | 'rejected' | 'archived'; actor_id: string; note: string; at: number }
export interface ImportCandidate {
  api_version: typeof AGENT_CATALOG_API
  id: string; source_id: string; catalog_id: string; org_id: string; revision: number
  status: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'publishing' | 'publication_unknown' | 'published' | 'archived'
  snapshot: CatalogSnapshot; validation: CatalogValidationReport; changes: CatalogChange[]
  decisions: CatalogDecision[]; created_at: number; published_version: string | null
  publication_error: string | null; publication_started_at: number | null
}
export interface SourceSyncResult {
  api_version: typeof AGENT_CATALOG_API
  id: string; source_id: string; org_id: string; started_at: number; completed_at: number | null
  status: 'running' | 'succeeded' | 'failed'; candidate_id: string | null
  reused: boolean; error: string | null
}
export interface CatalogAuditEvent {
  api_version: typeof AGENT_CATALOG_API
  id: string; org_id: string; zone_id: string | null; actor_id: string; at: number
  action: string; catalog_id: string | null; source_id: string | null
  candidate_id: string | null; version: string | null; task_id: string | null
  result: 'succeeded' | 'failed' | 'unknown'; reason: string | null
  context: Pick<CatalogSnapshot, 'protocol' | 'adapter_version' | 'source_revision' | 'source_digest' | 'capabilities'> | null
  provider_run_id: string | null; provider_response_id: string | null
}
export interface CatalogVersionState {
  catalog_id: string; version: string; source_id: string; candidate_id: string | null
  spec_digest: string; source_digest: string; lifecycle: 'published' | 'deprecated' | 'archived'
  provenance: 'candidate' | 'legacy_adopted'
}
export interface CatalogPage<T> { api_version: typeof AGENT_CATALOG_API; items: T[]; next_cursor: string | null }

/** Administrator correlation view deliberately excludes user input and output text. */
export interface CatalogRun {
  task_id: string; session_id: string; attempt_id: string | null; user_id: string
  status: string; output_status: string; error_code: string | null; created_at: number; updated_at: number
  version: string | null; source_digest: string; source_revision: string | null; adapter_version: string | null
  protocol: string | null; capabilities: CatalogCapabilities | null
  provider_run_id: string | null; provider_response_id: string | null
  observability: string | null; version_evidence: string | null
}

/** Read models are computed from authoritative releases; never authorize dispatch. */
export type CatalogDisplayStatus = 'draft' | 'pending_approval' | 'approved' | 'published' | 'active' | 'deprecated' | 'revoked' | 'archived' | 'unavailable'
export interface CatalogVersionDetail {
  version: string; source_revision: string | null; source_digest: string; adapter_version: string | null
  status: CatalogDisplayStatus; approval_status: 'approved' | 'expired' | 'withdrawn' | 'revoked' | 'unapproved'
  channels: { name: 'stable' | 'canary'; enabled: boolean; revision: number }[]
  revoke_reason: string | null; can_promote: boolean; promotion_block: string | null
  evidence_level: 'source_snapshot_only' | 'provider_revision_fenced'; source_identity: 'unverified'
}
export interface CatalogEntry {
  catalog_id: string; name: string; provider: 'dify' | 'http' | 'openai_compatible' | 'mcp' | 'a2a'
  protocol: string; source: CatalogSource | null; external_agent_id: string; owner_id: string | null
  org_id: string; zone_id: string | null; execution_mode: 'external_hosted'
  status: CatalogDisplayStatus; approval_status: CatalogVersionDetail['approval_status'] | 'pending_approval'; admission_error: string | null; is_selectable: boolean
  published_version: string | null; source_revision: string | null; source_digest: string; adapter_version: string | null
  capabilities: CatalogCapabilities; observability: 'full' | 'partial' | 'none' | 'unknown'
  last_run_at: number | null; warning_count: number; has_drift: boolean
  channels: { name: 'stable' | 'canary'; version: string; enabled: boolean; revision: number }[]
}
export interface CatalogRunEvent {
  sequence: number; at: number; type: string; status: string | null; error_code: string | null
}
