import { AGENT_REGISTRY_API, type Channel, type PrincipalRef, type SignedVersion, type Decision } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { AGENT_FEDERATION_API, type AgentChannel, type AgentRegistryEvidence, type AgentVersionManifest, type AgentVersionsPage, type AgentReleaseOptions } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import type { Binding, ExternalActor, ExternalTaskStore } from '../externalProviders/store.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import type { AgentReleaseSelection } from './releases.js'
import { contentDigest } from './provider/protocol.js'
import { parseAgentVersion } from './manifest.js'
import { ProductRegistryClient, type RegistryCommand } from './registryClient.js'

export interface RegistryLink {
  principal: PrincipalRef
  authority_id: string
  state: 'preparing' | 'active'
  plan_digest: string
}
function fail(code: string, status = 409): never { throw new ExternalProviderError(status, code) }
const channelView = (channel: Channel): AgentChannel => ({ name: channel.name, version: channel.version, revision: channel.revision, enabled: channel.enabled, updated_at: channel.updated_at })
export function registryEvidence(version: SignedVersion): AgentRegistryEvidence {
  return { authority: 'nexus_registry', principal: version.manifest.principal, registration_digest: version.digest,
    signing_key_id: version.key_id, evidence: 'signed_registration_only' }
}

/** Routes each Agent to exactly one authority. Local snapshots are execution caches, not approval replicas. */
export class RegistryReleases {
  readonly ready: Promise<void>
  constructor(readonly store: ExternalTaskStore, readonly client?: ProductRegistryClient) { this.ready = store.ready }
  get local() { return this.store.releases }
  defaultVersion(binding: Binding): string { return this.local.defaultVersion(binding) }
  async link(actor: ExternalActor, id: string): Promise<RegistryLink | undefined> {
    await this.ready
    const row = await this.store.db.get('SELECT state, document FROM agent_registry_links WHERE catalog_id = ? AND org_id = ?', [id, actor.orgId])
    if (!row) return undefined
    const result = { ...JSON.parse(String(row.document)), state: row.state } as RegistryLink
    if (!this.client || result.authority_id !== this.client.identity(actor.orgId)
      || contentDigest(result.principal) !== contentDigest(this.client.principal(actor.orgId, id))) fail('REGISTRY_AUTHORITY_CONFIGURATION_REQUIRED', 503)
    return result
  }
  private async active(actor: ExternalActor, id: string) {
    const link = await this.link(actor, id)
    if (!link && (await this.store.binding(actor, id)).registryRequired) fail('REGISTRY_ENROLLMENT_REQUIRED', 503)
    if (link && link.state !== 'active') fail('REGISTRY_MIGRATION_IN_PROGRESS', 503)
    return link
  }
  async isRegistry(actor: ExternalActor, id: string): Promise<boolean> { return Boolean(await this.active(actor, id)) }
  async command(actor: ExternalActor, id: string, input: Omit<RegistryCommand, 'request_id'> & Record<string, unknown>) {
    if (!this.client) fail('REGISTRY_UNAVAILABLE', 503)
    // The caller owns authorization. Record the actual Moss actor separately from the Nexus service credential.
    const operation = { actor, catalog_id: id, command: input }
    const request_id = `moss-${contentDigest({ org_id: actor.orgId, catalog_id: id, command: input }).slice(7)}`
    const command = { ...input, request_id } as RegistryCommand
    const document = JSON.stringify(operation)
    await this.store.db.run('INSERT INTO agent_registry_commands(id, catalog_id, document, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING', [request_id, id, document, Date.now()])
    const saved = await this.store.db.get('SELECT document FROM agent_registry_commands WHERE id = ?', [request_id])
    const prior = saved ? JSON.parse(String(saved.document)) : null
    if (!prior || prior.actor.orgId !== actor.orgId || prior.catalog_id !== id || contentDigest(prior.command) !== contentDigest(input)) fail('REGISTRY_OPERATION_CONFLICT')
    // No local database transaction spans this network request. Nexus provides command idempotency.
    const result = await this.client.command(actor.orgId, command)
    await this.store.db.run('UPDATE agent_registry_commands SET result = ? WHERE id = ?', [JSON.stringify(result), request_id])
    return result
  }
  specRef(actor: ExternalActor, id: string, version: string, digest: string) {
    if (!this.client) fail('REGISTRY_UNAVAILABLE', 503)
    return { api_version: 'common.sudo.dev/v1', kind: 'ResourceRef', zone_id: this.client.scope(actor.orgId).zoneId,
      path: `/agent-snapshots/${id}/${version}.json`, digest }
  }
  async cache(id: string, version: AgentVersionManifest): Promise<void> {
    const document = JSON.stringify(version.snapshot)
    if (contentDigest(version.snapshot) !== version.spec_digest) fail('AGENT_VERSION_DIGEST_MISMATCH')
    await this.store.db.run('INSERT INTO agent_registry_snapshots(catalog_id, version, spec_digest, document) VALUES (?, ?, ?, ?) ON CONFLICT(catalog_id, version) DO NOTHING', [id, version.version, version.spec_digest, document])
    const saved = await this.store.db.get('SELECT spec_digest, document FROM agent_registry_snapshots WHERE catalog_id = ? AND version = ?', [id, version.version])
    if (saved?.spec_digest !== version.spec_digest || contentDigest(JSON.parse(String(saved.document))) !== version.spec_digest) fail('IMMUTABLE_VERSION_CONFLICT')
  }
  private async project(actor: ExternalActor, id: string, version: SignedVersion): Promise<AgentVersionManifest> {
    const manifest = version.manifest
    let row = await this.store.db.get('SELECT spec_digest, document FROM agent_registry_snapshots WHERE catalog_id = ? AND version = ?', [id, manifest.version])
    if (contentDigest(manifest.spec_ref) !== contentDigest(this.specRef(actor, id, manifest.version, manifest.spec_digest))) fail('REGISTRY_SNAPSHOT_UNAVAILABLE', 503)
    if (!row) {
      const snapshot = await this.client!.readSnapshot(actor.orgId, manifest.spec_ref)
      const projected = parseAgentVersion({ api_version: AGENT_FEDERATION_API, kind: 'AgentVersionManifest', principal: manifest.principal, version: manifest.version,
        spec_digest: manifest.spec_digest, snapshot, created_at: manifest.created_at, created_by: manifest.created_by })
      await this.cache(id, projected)
      row = await this.store.db.get('SELECT spec_digest, document FROM agent_registry_snapshots WHERE catalog_id = ? AND version = ?', [id, manifest.version])
    }
    if (!row || row.spec_digest !== manifest.spec_digest) fail('REGISTRY_SNAPSHOT_UNAVAILABLE', 503)
    const snapshot = JSON.parse(String(row.document))
    if (contentDigest(snapshot) !== manifest.spec_digest) fail('AGENT_VERSION_DIGEST_MISMATCH')
    return parseAgentVersion({ api_version: AGENT_FEDERATION_API, kind: 'AgentVersionManifest', principal: manifest.principal,
      version: manifest.version, spec_digest: manifest.spec_digest, snapshot, created_by: manifest.created_by, created_at: manifest.created_at, registry: registryEvidence(version) })
  }
  async publish(actor: ExternalActor, binding: Binding, version: string, note: string): Promise<AgentVersionManifest> {
    const link = await this.active(actor, binding.id)
    if (!link) return this.local.publish(actor, binding, version, note)
    if (!binding.approved || !binding.parametersDigest || binding.orgId !== actor.orgId || binding.review_expires_at <= Date.now()) fail('CANDIDATE_APPROVAL_REQUIRED')
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version) || !note.trim() || note.length > 2000) fail('INVALID_RELEASE_INPUT')
    const snapshot = this.local.snapshot(binding), spec_digest = contentDigest(snapshot)
    await this.cache(binding.id, { api_version: AGENT_FEDERATION_API, kind: 'AgentVersionManifest', principal: link.principal, version, spec_digest, snapshot, created_by: actor.userId, created_at: Date.now() })
    await this.client!.putSnapshot(actor.orgId, this.specRef(actor, binding.id, version, spec_digest), snapshot)
    const published = await this.command(actor, binding.id, { api_version: AGENT_REGISTRY_API, kind: 'PublishVersion', principal: link.principal,
      version, spec_ref: this.specRef(actor, binding.id, version, spec_digest), spec_digest, source_evidence_refs: [] })
    if (!published.version) fail('REGISTRY_RESPONSE_INVALID', 503)
    await this.command(actor, binding.id, { api_version: AGENT_REGISTRY_API, kind: 'DecideVersion', principal: link.principal,
      version, decision: 'approved', reason: note, expires_at: binding.review_expires_at })
    return this.project(actor, binding.id, published.version)
  }
  async version(actor: ExternalActor, id: string, version: string, requireApproved = true): Promise<AgentVersionManifest> {
    const link = await this.active(actor, id)
    if (!link) return this.local.version(actor, id, version, requireApproved)
    const result = requireApproved ? await this.client!.resolve(actor.orgId, link.principal, { version }) : await this.client!.version(actor.orgId, link.principal, version)
    return this.project(actor, id, result.version)
  }
  async resolve(actor: ExternalActor, id: string, version?: string, channel?: string): Promise<AgentReleaseSelection> {
    const link = await this.active(actor, id)
    if (!link) return this.local.resolve(actor, id, version, channel)
    const selected = await this.client!.resolve(actor.orgId, link.principal, { version, channel })
    return { manifest: await this.project(actor, id, selected.version), ...(selected.channel ? { channel: channelView(selected.channel) } : {}) }
  }
  async moveChannel(actor: ExternalActor, id: string, name: 'stable' | 'canary', version: string, expectedRevision: number): Promise<AgentChannel> {
    const link = await this.active(actor, id)
    if (!link) return this.local.moveChannel(actor, id, name, version, expectedRevision)
    const result = await this.command(actor, id, { api_version: AGENT_REGISTRY_API, kind: 'MoveChannel', principal: link.principal,
      channel: name, version, expected_revision: expectedRevision, reason: 'Moss administrator channel promotion or rollback' })
    if (!result.channel) fail('REGISTRY_RESPONSE_INVALID', 503)
    return channelView(result.channel)
  }
  async revoke(actor: ExternalActor, id: string, version: string, note: string): Promise<void> {
    const link = await this.active(actor, id)
    if (!link) return this.local.revoke(actor, id, version, note)
    if (!note.trim() || note.length > 2000) fail('INVALID_RELEASE_INPUT')
    const current = await this.client!.version(actor.orgId, link.principal, version)
    if (current.decision?.decision === 'revoked') return
    await this.command(actor, id, { api_version: AGENT_REGISTRY_API, kind: 'DecideVersion', principal: link.principal, version, decision: 'revoked', reason: note })
  }
  private decision(value: Decision | null) {
    return value ? [{ id: value.id, decision: value.decision,
      actor_id: value.actor, note: value.reason, expires_at: value.decision === 'approved' ? value.expires_at ?? 0 : 0, created_at: value.created_at }] : []
  }
  async list(actor: ExternalActor, id: string, after = ''): Promise<AgentVersionsPage> {
    const link = await this.active(actor, id)
    if (!link) return this.local.list(actor, id, after)
    const page = await this.client!.versions(actor.orgId, link.principal, after)
    return { api_version: AGENT_FEDERATION_API, kind: 'AgentVersionsPage', principal: page.principal.principal,
      items: await Promise.all(page.items.map(async item => ({ ...await this.project(actor, id, item.version), decisions: this.decision(item.decision) }))),
      channels: page.channels.map(channelView), next_cursor: page.next_cursor }
  }
  async options(actor: ExternalActor, id: string, after = ''): Promise<AgentReleaseOptions> {
    const link = await this.active(actor, id)
    if (!link) return this.local.options(actor, id, after)
    const page = await this.client!.versions(actor.orgId, link.principal, after)
    const items: AgentReleaseOptions['items'] = [], channels: AgentChannel[] = []
    if (page.principal.status === 'active') {
      for (const item of page.items) if (item.decision?.decision === 'approved' && (item.decision.expires_at ?? 0) > Date.now()) {
        const manifest = await this.project(actor, id, item.version)
        items.push({ version: manifest.version, spec_digest: manifest.spec_digest, source_digest: manifest.snapshot.source_digest,
          approval_expires_at: item.decision.expires_at!, registry: manifest.registry,
          ...(manifest.snapshot.sourceManifest?.execution_revision ? { execution_revision: manifest.snapshot.sourceManifest.execution_revision } : {}) })
      }
      for (const channel of page.channels.filter(item => item.enabled)) {
        try { const selected = await this.client!.resolve(actor.orgId, link.principal, { channel: channel.name }); if (selected.channel) channels.push(channelView(selected.channel)) }
        catch (error) { if (!(error instanceof ExternalProviderError) || ![404, 409].includes(error.status)) throw error }
      }
    }
    return { api_version: AGENT_FEDERATION_API, kind: 'AgentReleaseOptions', catalog_id: id, principal: link.principal, items, channels, next_cursor: page.next_cursor }
  }
}
