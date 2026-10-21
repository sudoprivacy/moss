import type { HostedTask, HostedTaskEvidence, TaskRecord } from '../../../contracts/task/v1alpha1/contract.js'
import type { ExternalActor } from '../externalProviders/store.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import type { ExecutionModelCall } from './executionModelGateway.js'
import type { RouterConsumption } from './routerAgentClient.js'
import { parseHostedTaskEvidence, TASK_API } from './taskContract.js'

function invalid(): never { throw new ExternalProviderError(503, 'HOSTED_TASK_EVIDENCE_INVALID') }
/** Explicit allowlist: no request, response, credential, token or private resource is exposed. */
export function projectHostedTaskEvidence(actor: ExternalActor, task: HostedTask, record: TaskRecord,
  calls: ExecutionModelCall[], trace: Pick<HostedTaskEvidence, 'trace' | 'trace_next_cursor' | 'trace_has_more'>): HostedTaskEvidence {
  const resolution = record.resolution
  if (record.spec.task_id !== task.id || resolution.task_id !== task.id
    || (resolution.status === 'accepted' && (resolution.execution_mode !== 'internal_hosted' || resolution.asset_id !== task.asset_id))) invalid()
  const accepted = resolution.status === 'accepted' && resolution.execution_mode === 'internal_hosted' ? resolution : null
  const ledger = new Map<string, RouterConsumption>(), seenCalls = new Set<string>(), seenTokens = new Set<string>()
  let pending = 0
  const projected = calls.map(call => {
    if (!accepted || call.orgId !== actor.orgId || call.taskId !== task.id || call.assetId !== task.asset_id
      || call.specDigest !== accepted.artifact.spec_digest || call.mode !== 'run' || seenCalls.has(call.id)) invalid()
    seenCalls.add(call.id)
    if (call.routerToken) {
      const key = `${call.routerToken.accountId}:${call.routerToken.id}`
      if (seenTokens.has(key)) invalid()
      seenTokens.add(key)
    }
    const verified = call.ledgerStatus === 'router_verified' && call.consumption.length > 0
    const notDispatched = call.status === 'rejected' && !call.routerToken && !call.tokenCleanupPending
    if (!verified && !notDispatched) pending++
    const entries = new Set<string>()
    if (verified) for (const item of call.consumption) {
      if (!call.routerToken || item.tokenId !== call.routerToken.id || item.accountId !== call.routerToken.accountId
        || item.model !== call.model || ![item.id, item.tokenId, item.accountId, item.createdAt, item.quota, item.promptTokens, item.completionTokens]
          .every(value => Number.isSafeInteger(value) && value >= 0)) invalid()
      const key = `${item.accountId}:${item.id}`, previous = ledger.get(key)
      if (previous && (previous.tokenId !== item.tokenId || previous.model !== item.model || previous.createdAt !== item.createdAt
        || previous.quota !== item.quota || previous.promptTokens !== item.promptTokens || previous.completionTokens !== item.completionTokens)) invalid()
      ledger.set(key, item); entries.add(key)
    }
    return { id: call.id, model: call.model, status: call.status,
      ledger_status: verified ? 'router_verified' as const : 'pending' as const,
      token_cleanup: call.tokenCleanupPending ? 'pending' as const : 'confirmed' as const, ledger_entries: entries.size }
  })
  const totals = { verified_quota: 0, verified_prompt_tokens: 0, verified_completion_tokens: 0 }
  for (const item of ledger.values()) {
    totals.verified_quota += item.quota; totals.verified_prompt_tokens += item.promptTokens; totals.verified_completion_tokens += item.completionTokens
    if (!Object.values(totals).every(Number.isSafeInteger)) invalid()
  }
  const finished = ['succeeded', 'failed', 'rejected', 'cancelled'].includes(task.status)
  const status = pending > 0 || !finished ? 'pending' : ledger.size > 0 ? 'verified' : 'not_invoked'
  return parseHostedTaskEvidence({ api_version: TASK_API, kind: 'HostedTaskEvidence', task_id: task.id,
    task_sequence: task.sequence, captured_at: Date.now(), cleanup: task.cleanup,
    ...(task.native_verification ? { native_verification: task.native_verification } : {}),
    release: accepted ? { version: accepted.agent.version, artifact_id: accepted.artifact_id, spec_digest: accepted.artifact.spec_digest,
      image_id: accepted.artifact.image_id, registration_digest: accepted.agent.registry.registration_digest } : null,
    usage: { authority: 'sudorouter', unit: 'router_quota', status, ...totals, pending_calls: pending, calls: projected }, ...trace })
}
