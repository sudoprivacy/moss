import type { ExternalAgent } from '../../../contracts/external-provider/v1/contract.js'
import { describeCapabilities } from '../agentFederation/runtimeRegistry.js'
import type { Binding } from './store.js'

/** Shared, side-effect-free directory/admin projection. Never probes or publishes on GET. */
export function describeExternalAgent(binding: Binding, now = Date.now()): ExternalAgent {
  return {
    id: binding.id, name: binding.name, provider: binding.provider_kind ?? 'dify',
    execution_mode: 'external_hosted', profile: 'synthetic_pilot',
    source_identity_evidence: 'unverified', source_digest: binding.source_digest,
    decoder: binding.decoder, approved: binding.approved, review_expires_at: binding.review_expires_at,
    capabilities: describeCapabilities(binding),
    usage: {
      data_scope: 'synthetic_only', input: 'text_query_only',
      attachments: 'unsupported', resource_refs: 'unsupported', tools: 'unsupported',
      content_classification: 'caller_declared_only', capability_basis: 'adapter_contract',
      evaluated_at: now,
      reviewed_at: binding.approved ? binding.reviewedAt ?? null : null,
      review_state: !binding.approved ? 'not_approved' : binding.review_expires_at <= now ? 'expired' : 'current',
    },
  }
}
