import { customManifestDigest, parseCustomManifest } from '../agentFederation/manifest.js'
import { definitionDigest, DEFINITION_PROFILE_VERSION } from './definition.js'
import { ExternalProviderError } from './policy.js'

export function providerDefinition(provider: unknown, source: unknown, externalId?: string) {
  if (provider === undefined || provider === 'dify') return { source_digest: definitionDigest(source), definitionProfileVersion: DEFINITION_PROFILE_VERSION }
  if (provider !== 'custom_http') throw new ExternalProviderError(400, 'PROVIDER_NOT_IMPLEMENTED')
  const sourceManifest = parseCustomManifest(source)
  if (externalId !== undefined && sourceManifest.external_agent_id !== externalId) throw new ExternalProviderError(409, 'MANIFEST_BINDING_MISMATCH')
  return { source_digest: customManifestDigest(sourceManifest), sourceManifest, definitionProfileVersion: DEFINITION_PROFILE_VERSION }
}
