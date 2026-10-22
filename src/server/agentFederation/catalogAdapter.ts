import type {
  CatalogCapabilities,
  CatalogSnapshot,
} from '../../../contracts/agent-catalog/v1alpha1/contract.js'
import type { Binding, ExternalActor } from '../externalProviders/store.js'
import type { ExternalProviderAdministration } from '../externalProviders/administration.js'
import { parseNexusSecretRef } from '../dify/difyConnectionService.js'
import {
  assertPilot,
  ExternalProviderError,
} from '../externalProviders/policy.js'
import { providerDefinition } from '../externalProviders/providerDefinition.js'
import { customManifestDigest, parseCustomManifest } from './manifest.js'
import { createRuntimeRegistry } from './runtimeRegistry.js'
import {
  discoverStandardManifest,
  isStandardProtocol,
} from './standardHttpAdapter.js'
import { readProviderJson } from './customHttpAdapter.js'
import type { SourceRecord } from './catalogStore.js'
import type { ProviderAdapter, ProviderInvocation } from './adapter.js'

export const CATALOG_RULE_VERSION = 'catalog-query-only@1'
export interface CatalogFetchedAgent {
  binding: Binding
  snapshot: CatalogSnapshot
}
export interface AgentProviderCatalogAdapter {
  discoverSources(): {
    scope: 'configured_agent'
    catalog_id: string
    external_agent_id: string
  }[]
  fetchAgent(signal: AbortSignal): Promise<CatalogFetchedAgent>
  normalize(binding: Binding, adapter: ProviderAdapter): CatalogSnapshot
  validate(snapshot: CatalogSnapshot): {
    checks: string[]
    warnings: string[]
    unsupported: string[]
  }
  getCapabilities(adapter: ProviderAdapter): CatalogCapabilities
  invoke(
    input: ProviderInvocation,
    observe: Parameters<ProviderAdapter['invoke']>[1],
  ): ReturnType<ProviderAdapter['invoke']>
}

/** Catalog reads reuse the same approved transport and execution adapter; never invoke for discovery. */
export class ConfiguredAgentProviderAdapter implements AgentProviderCatalogAdapter {
  constructor(
    readonly admin: ExternalProviderAdministration,
    readonly actor: ExternalActor,
    readonly source: SourceRecord,
    readonly current: Binding,
  ) {}
  discoverSources() {
    return [
      {
        scope: 'configured_agent' as const,
        catalog_id: this.current.id,
        external_agent_id: this.current.app_id,
      },
    ]
  }
  async fetchAgent(signal: AbortSignal): Promise<CatalogFetchedAgent> {
    const { admin, actor, source, current } = this
    await admin.assertCredentialUsable(actor, current, true)
    const binding = { ...current, ...source.proposed }
    assertPilot(
      await admin.effectivePolicy(actor),
      actor.orgId,
      binding.endpoint,
    )
    const ref = parseNexusSecretRef(binding.credential_ref)
    const secret = await admin.options.secrets.getSecret(
      ref.namespace,
      ref.key,
      `org:${actor.orgId}`,
    )
    if (!secret?.value || secret.status !== 'enabled')
      throw new ExternalProviderError(503, 'CREDENTIAL_UNAVAILABLE')
    if (source.definition !== null)
      Object.assign(
        binding,
        providerDefinition(
          binding.provider_kind,
          source.definition,
          binding.app_id,
        ),
      )
    if (binding.sourceManifest) {
      let manifest = binding.sourceManifest
      if (isStandardProtocol(manifest)) {
        manifest = await discoverStandardManifest(
          {
            endpoint: binding.endpoint,
            key: secret.value,
            protocol: manifest.protocol,
            target: manifest.target,
            agentId: manifest.external_agent_id,
            name: manifest.name,
          },
          signal,
          admin.options.httpRequest,
        )
        // Preserve the separately reviewed task grant profile; discovery cannot add authority.
        if (binding.sourceManifest.execution_context)
          manifest.execution_context = binding.sourceManifest.execution_context
      } else {
        const revision = manifest.execution_revision
        const response = await (admin.options.httpRequest ?? fetch)(
          `${binding.endpoint}/agents/${encodeURIComponent(binding.app_id)}/manifest${revision ? `?revision=${encodeURIComponent(revision)}` : ''}`,
          {
            headers: {
              Authorization: `Bearer ${secret.value}`,
              Accept: 'application/json',
            },
            redirect: 'error',
            signal,
          },
        )
        if (!response.ok) {
          await response.body?.cancel()
          throw new ExternalProviderError(502, 'PROVIDER_PREFLIGHT_FAILED')
        }
        manifest = parseCustomManifest(
          JSON.stringify(await readProviderJson(response, 64 * 1024)),
        )
        if (
          manifest.external_agent_id !== binding.app_id ||
          manifest.protocol !== binding.sourceManifest.protocol
        )
          throw new ExternalProviderError(409, 'MANIFEST_BINDING_MISMATCH')
      }
      binding.sourceManifest = manifest
      binding.source_digest = customManifestDigest(manifest)
    }
    binding.parametersDigest = await admin.parameters(
      binding,
      secret.value,
      signal,
    )
    binding.credentialVersion = secret.version
    const adapter = createRuntimeRegistry(admin.options)
      .get(binding.provider_kind ?? 'dify')
      .create(binding)
    return { binding, snapshot: this.normalize(binding, adapter) }
  }
  normalize(binding: Binding, adapter: ProviderAdapter): CatalogSnapshot {
    const manifest = binding.sourceManifest
    const declared = manifest && !isStandardProtocol(manifest)
    return {
      name: binding.name,
      protocol: manifest?.protocol ?? 'dify/chat-messages',
      external_agent_id: binding.app_id,
      source_revision: declared ? manifest.source_revision : null,
      revision_basis: declared ? 'provider_declared' : 'content_digest',
      source_digest: binding.source_digest,
      parameters_digest: binding.parametersDigest!,
      adapter_version: adapter.version,
      endpoint: binding.endpoint,
      input_profile: manifest?.input_profile ?? 'query_only_v1',
      output_profile: manifest?.output_profile ?? 'text_v1',
      requested_permissions: manifest?.execution_context ?? null,
      capabilities: this.getCapabilities(adapter),
      user_ids: [...binding.allowed_user_ids].sort(),
      data_scope: 'synthetic_only',
    }
  }
  getCapabilities(adapter: ProviderAdapter): CatalogCapabilities {
    const caps = adapter.capabilities,
      state = (flag: boolean) =>
        flag ? ('supported' as const) : ('unsupported' as const)
    return {
      streaming: state(caps.supports_streaming),
      cancel: state(caps.supports_cancel),
      resume: state(caps.supports_resume),
      idempotency: state(caps.supports_idempotency),
      trace_export: 'partial',
      version_pin: state(caps.supports_version_pin),
      human_approval: state(caps.supports_human_approval),
    }
  }
  validate(snapshot: CatalogSnapshot) {
    return {
      checks: [
        'manifest_schema',
        'protocol_profile',
        'approved_endpoint',
        'credential_reference',
        'provider_descriptor',
        'query_only_input',
      ],
      warnings: [
        'SOURCE_IDENTITY_UNVERIFIED',
        ...(snapshot.capabilities.version_pin !== 'supported'
          ? ['REMOTE_VERSION_NOT_IMMUTABLE']
          : []),
        ...(snapshot.source_revision === null
          ? ['SOURCE_REVISION_UNAVAILABLE']
          : []),
        ...(this.current.provider_kind !== 'custom_http'
          ? ['DIFY_REMOTE_PROMPT_NOT_OBSERVABLE']
          : []),
      ],
      unsupported: Object.entries(snapshot.capabilities)
        .filter(([, value]) => value === 'unsupported')
        .map(([name]) => name),
    }
  }
  invoke(
    input: ProviderInvocation,
    observe: Parameters<ProviderAdapter['invoke']>[1],
  ) {
    return createRuntimeRegistry(this.admin.options)
      .get(this.current.provider_kind ?? 'dify')
      .create(this.current)
      .invoke(input, observe)
  }
}
