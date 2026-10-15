import type { CustomAgentManifest, ExternalRunBinding, ProviderCapabilities, ProviderObservation, TaskCorrelation } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import { AGENT_FEDERATION_API } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import { assertPilot, canonicalEndpoint, ExternalProviderError, type PilotPolicy } from '../externalProviders/policy.js'
import { parseExternalRunBinding, parseProviderObservation } from './manifest.js'

export interface ProviderInvocation extends TaskCorrelation {
  binding_id: string
  external_agent_id: string
  source_digest: string
  endpoint: string
  org_id: string
  policy: PilotPolicy
  key: string
  query: string
  end_user: string
  provider_session_id: string | null
  signal: AbortSignal
  /** Persist the dispatch intent and recheck governance under the caller's lock. */
  authorize_dispatch: () => Promise<void>
}
export interface ProviderResult {
  text: string
  status: 'succeeded' | 'failed'
  binding: ExternalRunBinding
}
export interface ProviderAdapter {
  readonly kind: 'dify' | 'custom_http'
  readonly version: string
  readonly capabilities: Readonly<ProviderCapabilities>
  invoke(input: ProviderInvocation, observe: (event: ProviderObservation) => Promise<void>): Promise<ProviderResult>
}

/** Only configured adapters are available. A provider label is not an implementation. */
export class ProviderAdapterRegistry<T extends Pick<ProviderAdapter, 'kind' | 'capabilities'> = ProviderAdapter> {
  private readonly adapters = new Map<string, T>()
  constructor(adapters: T[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.kind)) throw new Error(`Duplicate provider adapter: ${adapter.kind}`)
      this.adapters.set(adapter.kind, adapter)
    }
  }
  get(kind: string): T {
    const adapter = this.adapters.get(kind)
    if (!adapter) throw new ExternalProviderError(409, 'PROVIDER_NOT_IMPLEMENTED')
    return adapter
  }
}

export function invocationContext(input: ProviderInvocation) {
  const endpoint = canonicalEndpoint(input.endpoint)
  assertPilot(input.policy, input.org_id, endpoint)
  input.signal.throwIfAborted()
  const ids = [input.task_id, input.attempt_id, input.session_id, input.binding_id, input.external_agent_id, input.end_user]
  if (ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(id))
    || !/^sha256:[a-f0-9]{64}$/.test(input.source_digest)
    || typeof input.query !== 'string' || !input.query.trim() || input.query.length > 8000
    || !Number.isSafeInteger(input.policy.timeoutMs) || input.policy.timeoutMs < 1 || input.policy.timeoutMs > 120_000
    || typeof input.authorize_dispatch !== 'function'
    || typeof input.key !== 'string' || !input.key || input.key.length > 1024 || /[\r\n]/.test(input.key)
    || (input.provider_session_id !== null && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(input.provider_session_id))) {
    throw new ExternalProviderError(400, 'INVALID_PROVIDER_INVOCATION')
  }
  return { endpoint, signal: AbortSignal.any([input.signal, AbortSignal.timeout(input.policy.timeoutMs)]) }
}

export function createObserver(adapter: ProviderAdapter, input: ProviderInvocation, observe: (event: ProviderObservation) => Promise<void>) {
  let sequence = 0
  return async (text: string, refs: ProviderObservation['provider_refs'], status: ProviderObservation['status']) => observe(parseProviderObservation({
    api_version: AGENT_FEDERATION_API, kind: 'ProviderObservation',
    task_id: input.task_id, attempt_id: input.attempt_id, session_id: input.session_id,
    provider_kind: adapter.kind, adapter_version: adapter.version, sequence: ++sequence,
    type: status === 'running' ? 'output_snapshot' : 'result', status, text,
    provider_refs: { ...refs }, observed_at: new Date().toISOString(),
  }))
}

export function runBinding(adapter: ProviderAdapter, input: ProviderInvocation, runId: string, sessionId: string | undefined, startedAt: string): ExternalRunBinding {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(runId)) throw new ExternalProviderError(502, 'PROVIDER_RUN_ID_MISSING')
  return parseExternalRunBinding({
    api_version: AGENT_FEDERATION_API, kind: 'ExternalRunBinding',
    task_id: input.task_id, attempt_id: input.attempt_id, session_id: input.session_id,
    binding_id: input.binding_id, provider_kind: adapter.kind, external_agent_id: input.external_agent_id,
    source_identity_evidence: 'unverified', source_digest: input.source_digest, provider_run_id: runId,
    ...(sessionId ? { provider_session_id: sessionId } : {}), adapter_version: adapter.version,
    observability: 'partial', replay: 'unsupported', resume: 'unsupported', version_evidence: 'source_snapshot_only',
    started_at: startedAt, completed_at: new Date().toISOString(),
  })
}

export interface ReviewedHttpManifest { manifest: CustomAgentManifest; digest: string }
