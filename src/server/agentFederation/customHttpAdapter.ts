import { AGENT_HTTP_API, type InvokeHttpAgent, type ProviderObservation } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { createObserver, invocationContext, runBinding, type ProviderAdapter, type ProviderInvocation, type ReviewedHttpManifest } from './adapter.js'
import { customManifestDigest, HTTP_CAPABILITIES, parseCustomManifest, parseHttpAgentResult } from './manifest.js'

export const MAX_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024
export type ProviderRequest = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>

async function readJson(response: Response, limit: number): Promise<unknown> {
  if (!response.headers.get('content-type')?.match(/^application\/json(?:\s*;|$)/i) || !response.body) {
    await response.body?.cancel()
    throw new ExternalProviderError(502, 'INVALID_PROVIDER_RESPONSE')
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let text = '', size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return JSON.parse(text + decoder.decode())
      size += chunk.value.byteLength
      if (size > limit) throw new ExternalProviderError(502, 'PROVIDER_RESPONSE_LIMIT')
      text += decoder.decode(chunk.value, { stream: true })
    }
  } catch (error) {
    if (error instanceof ExternalProviderError) throw error
    throw new ExternalProviderError(502, 'INVALID_PROVIDER_RESPONSE')
  } finally { await reader.cancel().catch(() => {}) }
}

export class CustomHttpAdapter implements ProviderAdapter {
  readonly kind = 'custom_http' as const
  readonly version = 'custom-http/query-only-v1@0.1.0'
  readonly capabilities = HTTP_CAPABILITIES
  private readonly reviewed: ReviewedHttpManifest
  constructor(reviewed: ReviewedHttpManifest, private readonly request: ProviderRequest = fetch) {
    const manifest = parseCustomManifest(JSON.stringify(reviewed.manifest))
    if (customManifestDigest(manifest) !== reviewed.digest) throw new ExternalProviderError(409, 'MANIFEST_DIGEST_MISMATCH')
    this.reviewed = { manifest, digest: reviewed.digest }
  }

  async inspect(endpoint: string, key: string, signal: AbortSignal) {
    const remote = await this.request(`${endpoint}/agents/${encodeURIComponent(this.reviewed.manifest.external_agent_id)}/manifest`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, redirect: 'error', signal,
    })
    if (!remote.ok) { await remote.body?.cancel(); throw new ExternalProviderError(502, 'PROVIDER_PREFLIGHT_FAILED') }
    const current = parseCustomManifest(JSON.stringify(await readJson(remote, 64 * 1024)))
    if (customManifestDigest(current) !== this.reviewed.digest) throw new ExternalProviderError(409, 'PROVIDER_SOURCE_CHANGED')
    return { name: current.name, parameters_digest: this.reviewed.digest, checked_at: Date.now() }
  }

  async invoke(input: ProviderInvocation, observe: (event: ProviderObservation) => Promise<void>) {
    const { endpoint, signal } = invocationContext(input)
    if (input.external_agent_id !== this.reviewed.manifest.external_agent_id || input.source_digest !== this.reviewed.digest) throw new ExternalProviderError(409, 'MANIFEST_BINDING_MISMATCH')
    const headers = { Authorization: `Bearer ${input.key}`, Accept: 'application/json' }
    // Fetch source metadata only. An import never follows endpoints or executes source content.
    await this.inspect(endpoint, input.key, signal)
    signal.throwIfAborted()
    const body: InvokeHttpAgent = {
      api_version: AGENT_HTTP_API, kind: 'InvokeAgent', invocation_id: input.attempt_id,
      external_agent_id: input.external_agent_id, query: input.query,
      provider_session_id: input.provider_session_id, end_user: input.end_user,
    }
    const startedAt = new Date().toISOString()
    // No retry: the initial profile makes no remote idempotency or cancellation promise.
    await input.authorize_dispatch()
    signal.throwIfAborted()
    const response = await this.request(`${endpoint}/invoke`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new ExternalProviderError(502, 'EXECUTION_UNCONFIRMED')
    }
    const result = parseHttpAgentResult(await readJson(response, MAX_HTTP_RESPONSE_BYTES), input.attempt_id)
    if (input.provider_session_id && result.provider_session_id !== input.provider_session_id) throw new ExternalProviderError(502, 'PROVIDER_SESSION_CHANGED')
    const binding = runBinding(this, input, result.provider_run_id, result.provider_session_id, startedAt)
    await createObserver(this, input, observe)(result.output.text, { run_id: result.provider_run_id, ...(result.provider_session_id ? { session_id: result.provider_session_id } : {}) }, result.status)
    return { text: result.output.text, status: result.status, binding }
  }
}
