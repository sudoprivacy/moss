import type { ProviderAdapter } from './adapter.js'
import { ProviderAdapterRegistry } from './adapter.js'
import { DifyGatewayAdapter } from './difyAdapter.js'
import { isStandardProtocol, StandardHttpAdapter } from './standardHttpAdapter.js'
import { CustomHttpAdapter } from './customHttpAdapter.js'
import { DurableHttpAdapter } from './durableHttpAdapter.js'
import { DURABLE_AGENT_HTTP_API, DURABLE_HTTP_CAPABILITIES } from '../../../contracts/agent-http/v1alpha2/contract.js'
import { DIFY_CAPABILITIES, HTTP_CAPABILITIES } from './manifest.js'
import type { AdministrationOptions } from '../externalProviders/administration.js'
import type { Binding } from '../externalProviders/store.js'
import { ExternalProviderError } from '../externalProviders/policy.js'

export function describeCapabilities(binding: Binding) {
  const kind = binding.provider_kind ?? 'dify'
  if (!['dify', 'custom_http'].includes(kind)) throw new ExternalProviderError(409, 'PROVIDER_NOT_IMPLEMENTED')
  const capabilities = kind === 'dify' ? DIFY_CAPABILITIES : binding.sourceManifest?.protocol === DURABLE_AGENT_HTTP_API ? DURABLE_HTTP_CAPABILITIES : HTTP_CAPABILITIES
  const status = (enabled: boolean) => enabled ? 'supported' as const : 'unsupported' as const
  return { streaming: status(capabilities.supports_streaming), cancel: status(capabilities.supports_cancel), resume: status(capabilities.supports_resume), version_pin: status(capabilities.supports_version_pin) }
}

interface Registration extends Pick<ProviderAdapter, 'kind' | 'capabilities'> {
  create(binding: Binding): ProviderAdapter
}

/** Admission and dispatch resolve capabilities and implementations from the same registrations. */
export function createRuntimeRegistry(options: AdministrationOptions) {
  return new ProviderAdapterRegistry<Registration>([
    { kind: 'dify', capabilities: DIFY_CAPABILITIES, create(binding) {
      if (!binding.parametersDigest) throw new ExternalProviderError(409, 'DEFINITION_REVIEW_REQUIRED')
      return new DifyGatewayAdapter(binding.parametersDigest, options.transport)
    } },
    { kind: 'custom_http', capabilities: HTTP_CAPABILITIES, create(binding) {
      if (!binding.sourceManifest) throw new ExternalProviderError(409, 'DEFINITION_REVIEW_REQUIRED')
      if (isStandardProtocol(binding.sourceManifest)) return new StandardHttpAdapter({ manifest: binding.sourceManifest, digest: binding.source_digest }, options.httpRequest)
      if (binding.sourceManifest.protocol === DURABLE_AGENT_HTTP_API) return new DurableHttpAdapter({ manifest: binding.sourceManifest, digest: binding.source_digest }, options.httpRequest)
      return new CustomHttpAdapter({ manifest: binding.sourceManifest, digest: binding.source_digest }, options.httpRequest)
    } },
  ])
}
