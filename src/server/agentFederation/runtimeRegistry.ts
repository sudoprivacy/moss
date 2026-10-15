import type { ProviderAdapter } from './adapter.js'
import { ProviderAdapterRegistry } from './adapter.js'
import { DifyGatewayAdapter } from './difyAdapter.js'
import { CustomHttpAdapter } from './customHttpAdapter.js'
import { DIFY_CAPABILITIES, HTTP_CAPABILITIES } from './manifest.js'
import type { AdministrationOptions } from '../externalProviders/administration.js'
import type { Binding } from '../externalProviders/store.js'
import { ExternalProviderError } from '../externalProviders/policy.js'

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
      return new CustomHttpAdapter({ manifest: binding.sourceManifest, digest: binding.source_digest }, options.httpRequest)
    } },
  ])
}
