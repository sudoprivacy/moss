import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AGENT_REGISTRY_API } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import type { AgentVersionsPage } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import type { ExternalActor } from '../externalProviders/store.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { contentDigest } from './provider/protocol.js'
import { RegistryReleases, type RegistryLink } from './registryReleases.js'
import { installRegistryFences } from './registryState.js'

export interface RegistryMigrationOptions { maintenance: boolean; backupDirectory?: string }
function fail(code: string, status = 409): never { throw new ExternalProviderError(status, code) }

/** Explicit per-Agent cutover. Old data remains intact; interrupted imports resume idempotently. */
export class RegistryMigration {
  constructor(readonly releases: RegistryReleases, readonly options: RegistryMigrationOptions) {}
  async status(actor: ExternalActor, id: string) {
    const binding = await this.releases.store.binding(actor, id)
    const link = await this.releases.link(actor, id)
    return { authority: link || binding.registryRequired ? 'nexus_registry' : 'moss_legacy', state: link?.state ?? (binding.registryRequired ? 'preparing' : 'legacy'),
      configured: Boolean(this.releases.client), maintenance: this.options.maintenance,
      principal: link?.principal ?? null }
  }
  async plan(actor: ExternalActor, id: string) {
    const { store, client, local } = this.releases
    if (!client) fail('REGISTRY_UNAVAILABLE', 503)
    const binding = await store.binding(actor, id)
    const items: AgentVersionsPage['items'] = []
    let after = '', channels: AgentVersionsPage['channels'] = []
    for (let count = 0; count < 100; count++) {
      const page = await local.list(actor, id, after)
      items.push(...page.items); channels = page.channels
      if (!page.next_cursor) break
      if (count === 99) fail('REGISTRY_MIGRATION_CAPACITY')
      after = page.next_cursor
    }
    const decisions = await store.db.all('SELECT id, version, decision, actor_id, note, expires_at, created_at FROM agent_version_decisions WHERE catalog_id = ? ORDER BY created_at DESC, id DESC LIMIT 10001', [id])
    const channel_events = await store.db.all('SELECT * FROM agent_channel_events WHERE catalog_id = ? ORDER BY channel, revision LIMIT 10001', [id])
    if (decisions.length > 10000 || channel_events.length > 10000) fail('REGISTRY_MIGRATION_CAPACITY')
    for (const item of items) item.decisions = decisions.filter(row => row.version === item.version).map(row => ({
      id: String(row.id), decision: row.decision as 'approved' | 'revoked', actor_id: String(row.actor_id), note: String(row.note), expires_at: Number(row.expires_at), created_at: Number(row.created_at),
    }))
    const source = { catalog_id: id, org_id: actor.orgId, name: binding.name, binding_revision: binding.revision ?? 1,
      principal: client.principal(actor.orgId, id), authority_id: client.identity(actor.orgId), items, channels, channel_events }
    const count = await store.db.get(`SELECT COUNT(*) AS total FROM external_tasks t WHERE t.org_id = ?
      AND ${store.db.kind === 'postgres' ? "t.document::jsonb ->> 'agent_id'" : "json_extract(t.document, '$.agent_id')"} = ?
      AND (t.status NOT IN ('succeeded', 'failed', 'rejected', 'unknown') OR (t.status = 'unknown'
        AND NOT EXISTS (SELECT 1 FROM external_pilot_reconciliations r WHERE r.task_id = t.id)))`, [actor.orgId, id])
    return { source, plan_digest: contentDigest(source), active_tasks: Number(count?.total ?? 0) }
  }
  async enrollNew(actor: ExternalActor, id: string): Promise<void> {
    if (!this.releases.client) return
    const existing = await this.releases.link(actor, id)
    if (existing?.state === 'active') return
    const plan = await this.plan(actor, id)
    // Automatic enrollment is restricted to an explicit new-Agent action with no legacy releases/tasks.
    if (plan.source.items.length || plan.active_tasks) fail('REGISTRY_MIGRATION_REQUIRED')
    await this.apply(actor, id, { plan_digest: plan.plan_digest, old_writers_stopped: true }, true)
  }
  async apply(actor: ExternalActor, id: string, input: { plan_digest: string; old_writers_stopped: boolean }, newAgent = false) {
    if (!newAgent && (!this.options.maintenance || !this.options.backupDirectory || !input.old_writers_stopped)) fail('REGISTRY_MAINTENANCE_REQUIRED')
    const { store, client } = this.releases
    if (!client) fail('REGISTRY_UNAVAILABLE', 503)
    const original = await this.plan(actor, id)
    if (original.plan_digest !== input.plan_digest) fail('REGISTRY_MIGRATION_PLAN_CHANGED')
    if (original.active_tasks) fail('REGISTRY_ACTIVE_TASKS')
    if (newAgent && original.source.items.length) fail('REGISTRY_MIGRATION_REQUIRED')
    const existing = await this.releases.link(actor, id)
    if (existing?.state === 'active') return { state: 'active', plan_digest: existing.plan_digest }
    // The backup is an immutable export of every affected record. Cutover never deletes these originals.
    if (!newAgent) {
      const directory = resolve(this.options.backupDirectory!)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const filename = join(directory, `${id}-${original.plan_digest.slice(7)}.json`)
      try { await writeFile(filename, JSON.stringify(original.source, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (contentDigest(JSON.parse(await readFile(filename, 'utf8'))) !== original.plan_digest) fail('REGISTRY_BACKUP_MISMATCH')
      }
    }
    await store.db.transaction(async () => {
      await store.db.run('UPDATE external_pilot_bindings SET document = document WHERE id = ? AND org_id = ?', [id, actor.orgId])
      await store.db.run('UPDATE agent_principals SET catalog_id = catalog_id WHERE catalog_id = ?', [id])
      const current = await this.plan(actor, id)
      if (current.plan_digest !== original.plan_digest || current.active_tasks) fail('REGISTRY_MIGRATION_PLAN_CHANGED')
      await installRegistryFences(store.db)
      const link: Omit<RegistryLink, 'state'> = { principal: original.source.principal, authority_id: original.source.authority_id, plan_digest: original.plan_digest }
      await store.db.run(`INSERT INTO agent_registry_links(catalog_id, org_id, state, document) VALUES (?, ?, 'preparing', ?)
        ON CONFLICT(catalog_id) DO UPDATE SET document = excluded.document WHERE agent_registry_links.org_id = excluded.org_id AND agent_registry_links.state = 'preparing'`, [id, actor.orgId, JSON.stringify(link)])
      for (const version of original.source.items) await this.releases.cache(id, version)
    })
    const principal = original.source.principal
    await this.releases.command(actor, id, { api_version: AGENT_REGISTRY_API, kind: 'RegisterPrincipal', principal, display_name: original.source.name })
    for (const version of original.source.items) {
      await client.putSnapshot(actor.orgId, this.releases.specRef(actor, id, version.version, version.spec_digest), version.snapshot)
      await this.releases.command(actor, id, { api_version: AGENT_REGISTRY_API, kind: 'PublishVersion', principal, version: version.version,
        spec_ref: this.releases.specRef(actor, id, version.version, version.spec_digest), spec_digest: version.spec_digest, source_evidence_refs: [] })
      const revoked = version.decisions.find(decision => decision.decision === 'revoked')
      const approval = version.decisions.filter(decision => decision.decision === 'approved' && decision.expires_at > Date.now()).sort((a, b) => b.expires_at - a.expires_at)[0]
      if (revoked || approval) await this.releases.command(actor, id, { api_version: AGENT_REGISTRY_API, kind: 'DecideVersion', principal,
        version: version.version, decision: revoked ? 'revoked' : 'approved', reason: revoked?.note || approval?.note || 'Explicit legacy publication import',
        ...(!revoked ? { expires_at: approval!.expires_at } : {}) })
    }
    for (const channel of original.source.channels.filter(channel => channel.enabled)) {
      const version = original.source.items.find(item => item.version === channel.version)
      if (!version || version.decisions.some(decision => decision.decision === 'revoked') || !version.decisions.some(decision => decision.decision === 'approved' && decision.expires_at > Date.now())) continue
      await this.releases.command(actor, id, { api_version: AGENT_REGISTRY_API, kind: 'MoveChannel', principal, channel: channel.name,
        version: channel.version, expected_revision: 0, reason: 'Explicit legacy channel import' })
    }
    // Validate the complete remote set before exposing it. A partially copied principal stays fenced.
    const imported: string[] = []
    let after = ''
    const cursors = new Set<string>()
    do {
      if (cursors.has(after) || cursors.size >= 100) fail('REGISTRY_MIGRATION_VERIFICATION_FAILED')
      cursors.add(after)
      const page = await client.versions(actor.orgId, principal, after)
      for (const item of page.items) {
        const source = original.source.items.find(version => version.version === item.version.manifest.version)
        if (!source || source.spec_digest !== item.version.manifest.spec_digest
          || contentDigest(item.version.manifest.spec_ref) !== contentDigest(this.releases.specRef(actor, id, source.version, source.spec_digest))) fail('REGISTRY_MIGRATION_VERIFICATION_FAILED')
        const revoked = source.decisions.some(decision => decision.decision === 'revoked')
        const expiry = Math.max(0, ...source.decisions.filter(decision => decision.decision === 'approved').map(decision => decision.expires_at))
        if (revoked ? item.decision?.decision !== 'revoked'
          : expiry > Date.now() ? item.decision?.decision !== 'approved' || item.decision.expires_at !== expiry
          : item.decision?.decision === 'approved' && (item.decision.expires_at ?? 0) > Date.now()) fail('REGISTRY_MIGRATION_VERIFICATION_FAILED')
        imported.push(source.version)
      }
      for (const channel of page.channels.filter(channel => channel.enabled)) {
        const expected = original.source.channels.find(item => item.name === channel.name && item.enabled)
        if (!expected || expected.version !== channel.version) fail('REGISTRY_MIGRATION_VERIFICATION_FAILED')
      }
      for (const expected of original.source.channels.filter(channel => channel.enabled)) {
        const source = original.source.items.find(item => item.version === expected.version)
        if (source && !source.decisions.some(decision => decision.decision === 'revoked') && source.decisions.some(decision => decision.decision === 'approved' && decision.expires_at > Date.now())
          && !page.channels.some(channel => channel.name === expected.name && channel.enabled && channel.version === expected.version)) fail('REGISTRY_MIGRATION_VERIFICATION_FAILED')
      }
      after = page.next_cursor ?? ''
      if (imported.length > original.source.items.length) fail('REGISTRY_MIGRATION_VERIFICATION_FAILED')
    } while (after)
    if (imported.length !== original.source.items.length) fail('REGISTRY_MIGRATION_VERIFICATION_FAILED')
    await store.db.transaction(async () => {
      await store.db.run('UPDATE external_pilot_bindings SET document = document WHERE id = ? AND org_id = ?', [id, actor.orgId])
      const current = await this.plan(actor, id)
      if (current.plan_digest !== original.plan_digest || current.active_tasks) fail('REGISTRY_MIGRATION_PLAN_CHANGED')
      await store.db.run("UPDATE agent_registry_links SET state = 'active' WHERE catalog_id = ? AND org_id = ? AND state = 'preparing'", [id, actor.orgId])
    })
    return { state: 'active', plan_digest: original.plan_digest }
  }
}
