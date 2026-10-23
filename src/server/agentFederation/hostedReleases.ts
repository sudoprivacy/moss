import { AGENT_REGISTRY_API, type AssetRecord, type HostedArtifact, type NativeConversion, type SignedVersion } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import type { CatalogAgent, CatalogRepository } from '../catalog/catalogRepository.js'
import type { ExternalActor } from '../externalProviders/store.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { contentDigest } from './provider/protocol.js'
import type { RegistryReleases } from './registryReleases.js'

function fail(code: string, status = 409): never { throw new ExternalProviderError(status, code) }
const same = (a: unknown, b: unknown) => contentDigest(a) === contentDigest(b)
const versionId = (value: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) fail('INVALID_RELEASE_INPUT', 400); return value }

/** Product orchestration over the existing Registry; it never grants a management level. */
export class HostedReleases {
  constructor(private readonly catalog: CatalogRepository, private readonly releases: Pick<RegistryReleases, 'client' | 'command'>) {}
  private client() { return this.releases.client ?? fail('REGISTRY_NOT_CONFIGURED', 503) }
  catalogId(orgId: string, assetId: string) { return `hosted-${contentDigest([orgId, assetId]).slice(7, 39)}` }
  private binding(orgId: string, assetId: string) {
    return { executionMode: 'internal_hosted', assetId, registryAuthorityId: this.client().identity(orgId) }
  }
  private checkAsset(asset: AssetRecord, admitted: boolean) {
    if (asset.metadata.hosting !== 'internal_hosted' || asset.external_domain || !asset.metadata.owner_user_id) fail('HOSTED_ASSET_NOT_ADMITTED')
    if (admitted && (asset.status !== 'approved' || !['L2', 'L3'].includes(asset.actual_level)
      || (asset.metadata.source_platform === 'native' && asset.actual_level !== 'L3'))) fail('HOSTED_ASSET_NOT_ADMITTED')
  }
  async catalogFor(actor: ExternalActor, assetId: string): Promise<CatalogAgent | null> {
    const item = await this.catalog.getAgent(this.catalogId(actor.orgId, assetId), actor.orgId)
    if (item && (item.providerType !== 'moss_runtime' || !same(item.providerBinding, this.binding(actor.orgId, assetId)))) fail('HOSTED_CATALOG_IDENTITY_CONFLICT')
    return item
  }
  async enroll(actor: ExternalActor, assetId: string) {
    const client = this.client(), asset = await client.inventoryGet(actor.orgId, assetId)
    this.checkAsset(asset, false)
    const catalogId = this.catalogId(actor.orgId, assetId), principal = client.principal(actor.orgId, catalogId)
    if (asset.principal && !same(asset.principal, principal)) fail('HOSTED_ASSET_LINK_MIGRATION_REQUIRED')
    let item = await this.catalogFor(actor, assetId)
    if (!item) {
      // Enrolment has no execution effect. Publication and visibility are separate explicit actions.
      try {
        item = await this.catalog.createAgent({ id: catalogId, orgId: actor.orgId, name: asset.metadata.name,
          authorId: actor.userId, description: asset.metadata.purpose, providerType: 'moss_runtime',
          providerBinding: this.binding(actor.orgId, assetId), sourceProvider: asset.metadata.source_platform,
          sourceResourceId: assetId, supportedModes: 'cloud', availability: 'organization',
          status: 'pending', enabled: false, visibleTo: { user_ids: [] } })
      } catch (error) { item = await this.catalogFor(actor, assetId); if (!item) throw error }
    }
    await this.releases.command(actor, catalogId, { api_version: AGENT_REGISTRY_API, kind: 'RegisterPrincipal', principal, display_name: asset.metadata.name })
    if (!asset.principal) await client.inventoryCommand(actor.orgId, { api_version: AGENT_REGISTRY_API, kind: 'LinkAsset',
      asset_id: asset.id, expected_revision: asset.revision, initiated_by: actor.userId, principal,
      request_id: `hosted-link-${contentDigest([actor.orgId, actor.userId, asset.id, asset.revision, principal]).slice(7)}` })
    return { catalog_id: catalogId, principal, enabled: item.enabled }
  }
  async list(actor: ExternalActor, assetId: string, after = '') {
    const item = await this.catalogFor(actor, assetId)
    if (!item) return { catalog: null, registry: null, linked: false }
    const client = this.client(), principal = client.principal(actor.orgId, item.id)
    const asset = await client.inventoryGet(actor.orgId, assetId)
    let registry: Awaited<ReturnType<typeof client.versions>> | null = null
    try { registry = await client.versions(actor.orgId, principal, after) }
    catch (error) { if (!(error instanceof ExternalProviderError) || error.code !== 'AGENT_PRINCIPAL_NOT_FOUND') throw error }
    return { catalog: { id: item.id, enabled: item.enabled, status: item.status, visible_to: item.visibleTo },
      registry, linked: !!asset.principal && same(asset.principal, principal) }
  }
  specRef(orgId: string, catalogId: string, artifact: HostedArtifact | NativeConversion) {
    return { api_version: 'common.sudo.dev/v1' as const, kind: 'ResourceRef' as const, zone_id: this.client().scope(orgId).zoneId,
      path: `/agent-snapshots/${artifact.kind === 'NativeConversion' ? 'native' : 'hosted'}/${catalogId}/${artifact.id}/${artifact.spec_digest.slice(7)}.json`, digest: artifact.spec_digest }
  }
  async artifactFor(actor: ExternalActor, item: CatalogAgent, signed: SignedVersion): Promise<HostedArtifact | NativeConversion> {
    const client = this.client(), ref = signed.manifest.spec_ref
    const match = typeof ref.path === 'string' ? /^\/agent-snapshots\/(hosted|native)\/([\w-]+)\/([\w-]+)\/([a-f0-9]{64})\.json$/.exec(ref.path) : null
    if (!match || match[2] !== item.id || !same(signed.manifest.principal, client.principal(actor.orgId, item.id))) fail('HOSTED_RELEASE_ARTIFACT_MISMATCH')
    const artifact = match[1] === 'native' ? await client.nativeGet(actor.orgId, match[3]) : await client.hostedGet(actor.orgId, match[3])
    if (artifact.asset_id !== item.providerBinding?.assetId || artifact.spec_digest !== signed.manifest.spec_digest
      || !same(ref, this.specRef(actor.orgId, item.id, artifact))) fail('HOSTED_RELEASE_ARTIFACT_MISMATCH')
    // Content service verifies the digest of original bytes, including cross-language numeric serialization.
    await client.readSnapshot(actor.orgId, ref)
    return artifact
  }
  async publish(actor: ExternalActor, assetId: string, artifactId: string, version: string) {
    versionId(version)
    const client = this.client(), asset = await client.inventoryGet(actor.orgId, assetId)
    this.checkAsset(asset, true)
    const item = await this.catalogFor(actor, assetId)
    if (!item || !asset.principal || !same(asset.principal, client.principal(actor.orgId, item.id))) fail('HOSTED_ENROLLMENT_REQUIRED')
    const artifact = asset.metadata.source_platform === 'native' ? await client.nativeGet(actor.orgId, artifactId) : await client.hostedGet(actor.orgId, artifactId)
    if (artifact.asset_id !== assetId || artifact.metadata_digest !== asset.metadata_digest) fail('HOSTED_RELEASE_ARTIFACT_MISMATCH')
    const spec_ref = this.specRef(actor.orgId, item.id, artifact)
    await client.putHostedSnapshot(actor.orgId, spec_ref, artifact)
    // Nexus rechecks current acceptance for this exact spec; a local L2 display is insufficient.
    return this.releases.command(actor, item.id, { api_version: AGENT_REGISTRY_API, kind: 'PublishVersion',
      principal: client.principal(actor.orgId, item.id), version, spec_ref, spec_digest: artifact.spec_digest, source_evidence_refs: [] })
  }
  async decide(actor: ExternalActor, assetId: string, version: string, decision: 'approved' | 'revoked', reason: string, expiresAt?: number) {
    versionId(version)
    if (!reason.trim() || reason.length > 2000 || !['approved', 'revoked'].includes(decision)) fail('INVALID_RELEASE_INPUT', 400)
    const client = this.client(), item = await this.catalogFor(actor, assetId)
    if (!item) fail('HOSTED_ENROLLMENT_REQUIRED')
    const principal = client.principal(actor.orgId, item.id)
    if (decision === 'approved') {
      this.checkAsset(await client.inventoryGet(actor.orgId, assetId), true)
      if (!Number.isSafeInteger(expiresAt) || expiresAt! <= Date.now() || expiresAt! > Date.now() + 7 * 86400000) fail('INVALID_RELEASE_INPUT', 400)
      await this.artifactFor(actor, item, (await client.version(actor.orgId, principal, version)).version)
    }
    return this.releases.command(actor, item.id, { api_version: AGENT_REGISTRY_API, kind: 'DecideVersion', principal,
      version, decision, reason, ...(decision === 'approved' ? { expires_at: expiresAt } : {}) })
  }
  async promote(actor: ExternalActor, assetId: string, version: string, channel: 'stable' | 'canary', revision: number, reason: string) {
    versionId(version)
    if (!['stable', 'canary'].includes(channel) || !Number.isSafeInteger(revision) || revision < 0 || !reason.trim() || reason.length > 2000) fail('INVALID_RELEASE_INPUT', 400)
    const client = this.client(), item = await this.catalogFor(actor, assetId)
    if (!item) fail('HOSTED_ENROLLMENT_REQUIRED')
    this.checkAsset(await client.inventoryGet(actor.orgId, assetId), true)
    const principal = client.principal(actor.orgId, item.id)
    await this.artifactFor(actor, item, (await client.resolve(actor.orgId, principal, { version })).version)
    return this.releases.command(actor, item.id, { api_version: AGENT_REGISTRY_API, kind: 'MoveChannel', principal,
      version, channel, expected_revision: revision, reason })
  }
  async visibility(actor: ExternalActor, assetId: string, enabled: boolean, users: string[]) {
    const client = this.client(), item = await this.catalogFor(actor, assetId)
    if (!item) fail('HOSTED_ENROLLMENT_REQUIRED')
    if (enabled) {
      this.checkAsset(await client.inventoryGet(actor.orgId, assetId), true)
      await this.artifactFor(actor, item, (await client.resolve(actor.orgId, client.principal(actor.orgId, item.id))).version)
    }
    return this.catalog.updateAgentConfiguration(item.id, actor.orgId, { enabled, status: enabled ? 'approved' : item.status, visibleTo: { user_ids: users } })
  }
}
