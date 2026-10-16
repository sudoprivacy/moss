import { randomUUID } from 'node:crypto'
import type { DbDriver } from '../db/driver.js'
import type { Binding, ExternalActor } from '../externalProviders/store.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { catalogPrincipal } from './taskContract.js'
import { contentDigest } from './provider/protocol.js'
import { parseAgentVersion, parseAgentVersionsPage, parseAgentReleaseOptions } from './manifest.js'
import { AGENT_FEDERATION_API, type AgentExecutionSnapshot, type AgentVersionManifest, type AgentChannel, type AgentVersionsPage, type AgentVersionDecision } from '../../../contracts/agent-federation/v1alpha1/contract.js'

/** Immutable execution settings only. Credentials and mutable authorization are never copied into a release. */
export type AgentVersion = AgentVersionManifest
export interface AgentReleaseSelection { manifest: AgentVersion; channel?: AgentChannel }
function fail(code: string): never { throw new ExternalProviderError(409, code) }

/** Product identity and publication facts in the Moss shared store; not a Nexus certificate issuer. */
export class AgentReleaseStore {
  readonly ready: Promise<void>
  constructor(readonly db: DbDriver) {
    this.ready = db.exec(`
      CREATE TABLE IF NOT EXISTS agent_principals (
        catalog_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, trust_domain TEXT NOT NULL, agent_name TEXT NOT NULL,
        created_at BIGINT NOT NULL, UNIQUE(trust_domain, agent_name)
      );
      CREATE INDEX IF NOT EXISTS agent_principals_org ON agent_principals(org_id, catalog_id);
      CREATE TABLE IF NOT EXISTS agent_versions (
        catalog_id TEXT NOT NULL REFERENCES agent_principals(catalog_id), version TEXT NOT NULL,
        spec_digest TEXT NOT NULL, manifest TEXT NOT NULL, created_at BIGINT NOT NULL,
        PRIMARY KEY(catalog_id, version)
      );
      CREATE TABLE IF NOT EXISTS agent_version_decisions (
        id TEXT PRIMARY KEY, catalog_id TEXT NOT NULL, version TEXT NOT NULL, decision TEXT NOT NULL,
        actor_id TEXT NOT NULL, note TEXT NOT NULL, expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL,
        FOREIGN KEY(catalog_id, version) REFERENCES agent_versions(catalog_id, version)
      );
      CREATE INDEX IF NOT EXISTS agent_version_decisions_version ON agent_version_decisions(catalog_id, version, created_at, id);
      CREATE TABLE IF NOT EXISTS agent_channels (
        catalog_id TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL, revision INTEGER NOT NULL,
        updated_at BIGINT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY(catalog_id, name),
        FOREIGN KEY(catalog_id, version) REFERENCES agent_versions(catalog_id, version)
      );
      CREATE TABLE IF NOT EXISTS agent_channel_events (
        id TEXT PRIMARY KEY, catalog_id TEXT NOT NULL, channel TEXT NOT NULL, from_version TEXT, to_version TEXT NOT NULL,
        revision INTEGER NOT NULL, actor_id TEXT NOT NULL, created_at BIGINT NOT NULL,
        UNIQUE(catalog_id, channel, revision)
      );
    `)
  }
  snapshot(binding: Binding): AgentExecutionSnapshot {
    return JSON.parse(JSON.stringify({ provider_kind: binding.provider_kind ?? 'dify', endpoint: binding.endpoint,
      app_id: binding.app_id, workspace_id: binding.workspace_id, source_digest: binding.source_digest,
      ...(binding.sourceManifest ? { sourceManifest: binding.sourceManifest } : {}), parametersDigest: binding.parametersDigest,
      decoder: binding.decoder, definitionProfileVersion: binding.definitionProfileVersion })) as AgentExecutionSnapshot
  }
  defaultVersion(binding: Binding): string { return `release-${contentDigest(this.snapshot(binding)).slice(7)}` }

  async registerPrincipal(binding: Pick<Binding, 'id' | 'orgId'>): Promise<void> {
    await this.ready
    const principal = catalogPrincipal(binding.id)
    await this.db.run(`INSERT INTO agent_principals(catalog_id, org_id, trust_domain, agent_name, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(catalog_id) DO NOTHING`, [binding.id, binding.orgId, principal.trust_domain, principal.agent_name, Date.now()])
    await this.principal({ orgId: binding.orgId, userId: 'system' }, binding.id)
  }

  private async principal(actor: ExternalActor, catalogId: string) {
    const row = await this.db.get('SELECT * FROM agent_principals WHERE catalog_id = ? AND org_id = ?', [catalogId, actor.orgId])
    if (!row) throw new ExternalProviderError(404, 'AGENT_PRINCIPAL_NOT_FOUND')
    return { trust_domain: String(row.trust_domain), agent_name: String(row.agent_name) }
  }
  private async lock(actor: ExternalActor, catalogId: string) {
    const changed = await this.db.run('UPDATE agent_principals SET catalog_id = catalog_id WHERE catalog_id = ? AND org_id = ?', [catalogId, actor.orgId])
    if (!changed) throw new ExternalProviderError(404, 'AGENT_PRINCIPAL_NOT_FOUND')
  }
  async publish(actor: ExternalActor, binding: Binding, version: string, note: string): Promise<AgentVersion> {
    await this.ready
    if (binding.orgId !== actor.orgId || !binding.approved || !binding.parametersDigest || binding.review_expires_at <= Date.now()) fail('CANDIDATE_APPROVAL_REQUIRED')
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version) || !note.trim() || note.length > 2000) fail('INVALID_RELEASE_INPUT')
    return this.db.transaction(async () => {
      await this.registerPrincipal(binding)
      await this.lock(actor, binding.id)
      const principal = await this.principal(actor, binding.id), snapshot = this.snapshot(binding), specDigest = contentDigest(snapshot)
      const existing = await this.db.get('SELECT manifest, spec_digest FROM agent_versions WHERE catalog_id = ? AND version = ?', [binding.id, version])
      if (existing) {
        if (existing.spec_digest !== specDigest) fail('IMMUTABLE_VERSION_CONFLICT')
        if (await this.isRevoked(binding.id, version)) fail('AGENT_VERSION_REVOKED')
        await this.db.run(`INSERT INTO agent_version_decisions(id, catalog_id, version, decision, actor_id, note, expires_at, created_at)
          VALUES (?, ?, ?, 'approved', ?, ?, ?, ?)`, [randomUUID(), binding.id, version, actor.userId, note, binding.review_expires_at, Date.now()])
        return parseAgentVersion(JSON.parse(String(existing.manifest)))
      }
      const manifest = parseAgentVersion({ api_version: AGENT_FEDERATION_API, kind: 'AgentVersionManifest', principal, version, spec_digest: specDigest, snapshot, created_by: actor.userId, created_at: Date.now() })
      await this.db.run('INSERT INTO agent_versions(catalog_id, version, spec_digest, manifest, created_at) VALUES (?, ?, ?, ?, ?)', [binding.id, version, specDigest, JSON.stringify(manifest), manifest.created_at])
      await this.db.run(`INSERT INTO agent_version_decisions(id, catalog_id, version, decision, actor_id, note, expires_at, created_at)
        VALUES (?, ?, ?, 'approved', ?, ?, ?, ?)`, [randomUUID(), binding.id, version, actor.userId, note, binding.review_expires_at, Date.now()])
      return manifest
    })
  }
  private async isRevoked(catalogId: string, version: string): Promise<boolean> {
    return Boolean(await this.db.get("SELECT id FROM agent_version_decisions WHERE catalog_id = ? AND version = ? AND decision = 'revoked' LIMIT 1", [catalogId, version]))
  }
  async version(actor: ExternalActor, catalogId: string, version: string, requireApproved = true): Promise<AgentVersion> {
    await this.ready; const principal = await this.principal(actor, catalogId)
    const row = await this.db.get('SELECT manifest, spec_digest FROM agent_versions WHERE catalog_id = ? AND version = ?', [catalogId, version])
    if (!row) throw new ExternalProviderError(404, 'AGENT_VERSION_NOT_FOUND')
    const manifest = parseAgentVersion(JSON.parse(String(row.manifest)))
    if (contentDigest(manifest.snapshot) !== row.spec_digest || manifest.spec_digest !== row.spec_digest || manifest.version !== version
      || contentDigest(manifest.principal) !== contentDigest(principal)) throw new ExternalProviderError(500, 'AGENT_VERSION_DIGEST_MISMATCH')
    if (requireApproved) {
      if (await this.isRevoked(catalogId, version)) fail('AGENT_VERSION_REVOKED')
      if (!await this.db.get("SELECT id FROM agent_version_decisions WHERE catalog_id = ? AND version = ? AND decision = 'approved' AND expires_at > ? LIMIT 1", [catalogId, version, Date.now()])) fail('AGENT_VERSION_APPROVAL_EXPIRED')
    }
    return manifest
  }
  async moveChannel(actor: ExternalActor, catalogId: string, name: 'stable' | 'canary', version: string, expectedRevision: number): Promise<AgentChannel> {
    await this.ready
    if (!['stable', 'canary'].includes(name) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('INVALID_CHANNEL_INPUT')
    return this.db.transaction(async () => {
      await this.lock(actor, catalogId); await this.version(actor, catalogId, version)
      const before = await this.db.get('SELECT version, revision FROM agent_channels WHERE catalog_id = ? AND name = ?', [catalogId, name])
      if (Number(before?.revision ?? 0) !== expectedRevision) fail('CHANNEL_REVISION_CONFLICT')
      const channel: AgentChannel = { name, version, revision: expectedRevision + 1, updated_at: Date.now(), enabled: true }
      await this.db.run(`INSERT INTO agent_channels(catalog_id, name, version, revision, updated_at, enabled) VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(catalog_id, name) DO UPDATE SET version = excluded.version, revision = excluded.revision, updated_at = excluded.updated_at, enabled = 1`, [catalogId, name, version, channel.revision, channel.updated_at])
      await this.db.run('INSERT INTO agent_channel_events(id, catalog_id, channel, from_version, to_version, revision, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [randomUUID(), catalogId, name, before ? String(before.version) : null, version, channel.revision, actor.userId, channel.updated_at])
      return channel
    })
  }
  async resolve(actor: ExternalActor, catalogId: string, requestedVersion?: string, requestedChannel?: string): Promise<AgentReleaseSelection> {
    await this.ready
    if (requestedVersion && requestedChannel) fail('AMBIGUOUS_AGENT_SELECTOR')
    return this.db.transaction(async () => {
      await this.lock(actor, catalogId)
      if (requestedVersion) return { manifest: await this.version(actor, catalogId, requestedVersion) }
      const name = requestedChannel ?? 'stable'
      if (!['stable', 'canary'].includes(name)) fail('AGENT_CHANNEL_UNAVAILABLE')
      const row = await this.db.get('SELECT * FROM agent_channels WHERE catalog_id = ? AND name = ?', [catalogId, name])
      if (!row) fail('AGENT_CHANNEL_UNAVAILABLE')
      if (!Number(row.enabled)) fail('AGENT_CHANNEL_DISABLED')
      return { manifest: await this.version(actor, catalogId, String(row.version)), channel: { name: name as AgentChannel['name'], version: String(row.version), revision: Number(row.revision), updated_at: Number(row.updated_at), enabled: true } }
    })
  }
  async revoke(actor: ExternalActor, catalogId: string, version: string, note: string): Promise<void> {
    await this.ready
    if (!note.trim() || note.length > 2000) fail('INVALID_RELEASE_INPUT')
    await this.db.transaction(async () => {
      await this.lock(actor, catalogId); await this.version(actor, catalogId, version, false)
      if (await this.isRevoked(catalogId, version)) return
      await this.db.run("INSERT INTO agent_version_decisions(id, catalog_id, version, decision, actor_id, note, expires_at, created_at) VALUES (?, ?, ?, 'revoked', ?, ?, 0, ?)", [randomUUID(), catalogId, version, actor.userId, note, Date.now()])
      await this.db.run('UPDATE agent_channels SET enabled = 0 WHERE catalog_id = ? AND version = ?', [catalogId, version])
    })
  }
  async list(actor: ExternalActor, catalogId: string, after = ''): Promise<AgentVersionsPage> {
    await this.ready; await this.principal(actor, catalogId)
    const rows = await this.db.all('SELECT version FROM agent_versions WHERE catalog_id = ? AND version > ? ORDER BY version LIMIT 51', [catalogId, after])
    const items = await Promise.all(rows.slice(0, 50).map(async row => {
      const version = String(row.version), manifest = await this.version(actor, catalogId, version, false)
      const decisions = await this.db.all('SELECT id, decision, actor_id, note, expires_at, created_at FROM agent_version_decisions WHERE catalog_id = ? AND version = ? ORDER BY created_at DESC, id DESC LIMIT 100', [catalogId, version])
      return { ...manifest, decisions: decisions.map(row => ({ id: String(row.id), decision: row.decision as AgentVersionDecision['decision'], actor_id: String(row.actor_id), note: String(row.note), expires_at: Number(row.expires_at), created_at: Number(row.created_at) })) }
    }))
    const channels = (await this.db.all('SELECT name, version, revision, updated_at, enabled FROM agent_channels WHERE catalog_id = ? ORDER BY name', [catalogId])).map(row => ({ name: row.name as AgentChannel['name'], version: String(row.version), revision: Number(row.revision), updated_at: Number(row.updated_at), enabled: Boolean(Number(row.enabled)) }))
    return parseAgentVersionsPage({ api_version: AGENT_FEDERATION_API, kind: 'AgentVersionsPage', principal: await this.principal(actor, catalogId), items, channels, next_cursor: rows.length > 50 ? items.at(-1)!.version : null })
  }

  async options(actor: ExternalActor, catalogId: string, after = '') {
    await this.ready
    const principal = await this.principal(actor, catalogId), now = Date.now()
    const rows = await this.db.all(`SELECT v.version, MAX(d.expires_at) AS approval_expires_at FROM agent_versions v
      JOIN agent_version_decisions d ON d.catalog_id = v.catalog_id AND d.version = v.version
      WHERE v.catalog_id = ? AND v.version > ? AND d.decision = 'approved' AND d.expires_at > ?
      AND NOT EXISTS (SELECT 1 FROM agent_version_decisions r WHERE r.catalog_id = v.catalog_id AND r.version = v.version AND r.decision = 'revoked')
      GROUP BY v.version ORDER BY v.version LIMIT 51`, [catalogId, after, now])
    const items = await Promise.all(rows.slice(0, 50).map(async row => {
      const manifest = await this.version(actor, catalogId, String(row.version), false)
      return { version: manifest.version, spec_digest: manifest.spec_digest, source_digest: manifest.snapshot.source_digest,
        ...(manifest.snapshot.sourceManifest?.execution_revision ? { execution_revision: manifest.snapshot.sourceManifest.execution_revision } : {}),
        approval_expires_at: Number(row.approval_expires_at) }
    }))
    const channels = (await this.db.all(`SELECT c.* FROM agent_channels c WHERE c.catalog_id = ? AND c.enabled = 1
      AND EXISTS (SELECT 1 FROM agent_version_decisions d WHERE d.catalog_id = c.catalog_id AND d.version = c.version AND d.decision = 'approved' AND d.expires_at > ?)
      AND NOT EXISTS (SELECT 1 FROM agent_version_decisions d WHERE d.catalog_id = c.catalog_id AND d.version = c.version AND d.decision = 'revoked') ORDER BY c.name`, [catalogId, now]))
      .map(row => ({ name: row.name, version: row.version, revision: Number(row.revision), updated_at: Number(row.updated_at), enabled: true }))
    return parseAgentReleaseOptions({ api_version: AGENT_FEDERATION_API, kind: 'AgentReleaseOptions', catalog_id: catalogId, principal, items, channels, next_cursor: rows.length > 50 ? items.at(-1)!.version : null })
  }
}
