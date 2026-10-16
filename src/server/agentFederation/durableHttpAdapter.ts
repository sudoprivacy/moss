import { setTimeout as delay } from 'node:timers/promises'
import { DURABLE_AGENT_HTTP_API, DURABLE_HTTP_CAPABILITIES, type AgentRun, type SubmitAgentRun } from '../../../contracts/agent-http/v1alpha2/contract.js'
import type { ProviderObservation } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { createObserver, invocationContext, runBinding, type ProviderAdapter, type ProviderInvocation, type ProviderResult, type ReviewedHttpManifest } from './adapter.js'
import { CustomHttpAdapter, type ProviderRequest } from './customHttpAdapter.js'
import { parseExternalRunBinding } from './manifest.js'
import { contentDigest, parseAgentRun } from './provider/protocol.js'
import { boundedJson } from './provider/runtime.js'

/** Durable profile uses one invocation ID and body for submit, recovery and polling. */
export class DurableHttpAdapter implements ProviderAdapter {
  readonly kind = 'custom_http' as const
  readonly version = 'custom-http/durable-v2@0.2.0'
  readonly capabilities = DURABLE_HTTP_CAPABILITIES
  private readonly inspector: CustomHttpAdapter
  constructor(private readonly reviewed: ReviewedHttpManifest, private readonly request: ProviderRequest = fetch) {
    this.inspector = new CustomHttpAdapter(reviewed, request)
    if (reviewed.manifest.protocol !== DURABLE_AGENT_HTTP_API || !reviewed.manifest.execution_revision) throw new ExternalProviderError(409, 'DURABLE_PROFILE_REQUIRED')
  }
  async invoke(input: ProviderInvocation, observe: (event: ProviderObservation) => Promise<void>): Promise<ProviderResult> {
    const { endpoint, signal } = invocationContext(input)
    if (input.external_agent_id !== this.reviewed.manifest.external_agent_id || input.source_digest !== this.reviewed.digest
      || !Number.isSafeInteger(input.deadline_at)) throw new ExternalProviderError(409, 'MANIFEST_BINDING_MISMATCH')
    const body: SubmitAgentRun = {
      api_version: DURABLE_AGENT_HTTP_API, kind: 'SubmitAgentRun', invocation_id: input.attempt_id,
      external_agent_id: input.external_agent_id, execution_revision: this.reviewed.manifest.execution_revision!,
      query: input.query, end_user: input.end_user, provider_session_id: input.provider_session_id, deadline_at: input.deadline_at!,
    }
    const expected = contentDigest(body), headers = { Authorization: `Bearer ${input.key}`, Accept: 'application/json', 'Content-Type': 'application/json' }
    const observed = createObserver(this, input, observe)
    let next: 'query' | 'submit' = input.recovery ? 'query' : 'submit', sequence = 0
    let runId = input.known_provider_run_id, sessionId: string | undefined
    // Reading an existing run does not depend on a mutable default manifest still being current.
    while (true) {
      signal.throwIfAborted()
      if (next === 'submit') {
        await this.inspector.inspect(endpoint, input.key, signal)
        await input.authorize_dispatch()
      }
      const action = next; next = 'query'
      let response: Response
      try {
        response = await this.request(action === 'submit' ? `${endpoint}/runs` : `${endpoint}/runs/${encodeURIComponent(input.attempt_id)}`, {
          method: action === 'submit' ? 'POST' : 'GET', headers, ...(action === 'submit' ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal,
        })
      } catch {
        signal.throwIfAborted()
        await delay(500, undefined, { signal }); continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 404 && action === 'query') {
          if (runId) throw new ExternalProviderError(502, 'PROVIDER_RUN_LOST')
          next = 'submit'
        }
        else if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) throw new ExternalProviderError(502, 'DURABLE_PROVIDER_REQUEST_REJECTED')
        await delay(500, undefined, { signal }); continue
      }
      let result: AgentRun
      try { result = parseAgentRun(await boundedJson(response, 2 * 1024 * 1024)) }
      catch { throw new ExternalProviderError(502, 'INVALID_PROVIDER_RESULT') }
      if (result.invocation_id !== input.attempt_id || result.request_digest !== expected
        || result.external_agent_id !== input.external_agent_id || result.execution_revision !== body.execution_revision
        || (input.provider_session_id && result.provider_session_id !== input.provider_session_id)
        || (runId && result.provider_run_id !== runId) || (sessionId && result.provider_session_id !== sessionId)
        || result.sequence < sequence) throw new ExternalProviderError(502, 'PROVIDER_RUN_IDENTITY_MISMATCH')
      runId = result.provider_run_id; sessionId = result.provider_session_id
      if (result.status === 'unknown') throw new ExternalProviderError(502, 'EXECUTION_UNCONFIRMED')
      if (result.error_code === 'RUN_PAYLOAD_RETIRED') throw new ExternalProviderError(410, 'PROVIDER_RESULT_RETIRED')
      const status = result.status === 'succeeded' ? 'succeeded' : ['failed', 'cancelled'].includes(result.status) ? 'failed' : 'running'
      if (result.sequence > sequence) {
        await observed(result.output.text, { run_id: runId, session_id: sessionId }, status)
        sequence = result.sequence
      }
      if (status !== 'running') {
        const base = runBinding(this, input, runId, sessionId, new Date(result.created_at).toISOString())
        const binding = parseExternalRunBinding({ ...base, resume: 'query_only', version_evidence: 'provider_revision_fenced', execution_revision: result.execution_revision, completed_at: new Date(result.updated_at).toISOString() })
        return { text: result.output.text, status, binding }
      }
      await delay(500, undefined, { signal })
    }
  }
}
