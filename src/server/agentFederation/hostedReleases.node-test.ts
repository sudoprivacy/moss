import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createCatalogTestRepository } from '../testing/compatibilityRepositories.js'
import type { AssetRecord, HostedArtifact, PrincipalRef, SignedVersion } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import type { ProductRegistryClient, RegistryCommand } from './registryClient.js'
import { HostedReleases } from './hostedReleases.js'
import { AgentInventoryService } from './inventoryService.js'
import type { AuthContext } from '../auth/token.js'
import { ExternalProviderError } from '../externalProviders/policy.js'

const actor = { userId: 'admin-a', orgId: 'org-a' }, hash = `sha256:${'a'.repeat(64)}`
function fixture(t: { after: (fn: () => void) => void }) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  const catalog = createCatalogTestRepository(db)
  const asset = { id: 'asset-a', revision: 1, metadata_digest: hash, status: 'draft', actual_level: 'L0', external_domain: false,
    metadata: { hosting: 'internal_hosted', owner_user_id: 'owner-a', name: 'Hosted helper', purpose: 'Synthetic checks', source_platform: 'langgraph' }, principal: null } as unknown as AssetRecord
  const artifact = { id: 'artifact-a', asset_id: asset.id, spec_digest: hash, metadata_digest: hash } as HostedArtifact
  const commands: Array<Omit<RegistryCommand, 'request_id'> & Record<string, any>> = [], writes: string[] = []
  let registered = false, signed: SignedVersion | undefined
  const client = {
    identity: () => hash, scope: () => ({ zoneId: 'zone-a' }),
    principal: (_org: string, id: string) => ({ trust_domain: 'agents.example', agent_name: `external-${id}` }),
    inventoryGet: async (org: string) => { if (org !== actor.orgId) throw new ExternalProviderError(404, 'AGENT_ASSET_NOT_FOUND'); return structuredClone(asset) },
    inventoryCommand: async (_org: string, command: { principal: PrincipalRef }) => { asset.principal = command.principal; asset.revision++; return structuredClone(asset) },
    hostedGet: async () => structuredClone(artifact),
    putHostedSnapshot: async (_org: string, ref: { digest: string }) => { assert.equal(ref.digest, artifact.spec_digest); writes.push(ref.digest) },
    readSnapshot: async () => ({ opaque: 'original owner bytes already verified by SDK' }),
    versions: async () => {
      if (!registered) throw new ExternalProviderError(404, 'AGENT_PRINCIPAL_NOT_FOUND')
      return { principal: { status: 'active' }, items: [], channels: [], next_cursor: null }
    },
    version: async () => ({ version: signed }), resolve: async () => ({ version: signed }),
  } as unknown as ProductRegistryClient
  const releases = new HostedReleases(catalog, { client, command: async (_actor, _id, command) => {
    commands.push(command)
    if (command.kind === 'RegisterPrincipal') registered = true
    if (command.kind === 'PublishVersion') signed = { manifest: { principal: command.principal, version: command.version,
      spec_ref: command.spec_ref, spec_digest: command.spec_digest } } as unknown as SignedVersion
    return {} as never
  } })
  return { catalog, asset, artifact, commands, writes, client, releases }
}
void test('hosted enrolment stays disabled, GET stays read-only, publication and channel decisions remain separate', async t => {
  const f = fixture(t)
  assert.equal((await f.releases.list(actor, f.asset.id)).catalog, null)
  assert.equal(f.commands.length, 0)
  const result = await f.releases.enroll(actor, f.asset.id)
  assert.equal(result.enabled, false); assert.equal(f.asset.actual_level, 'L0')
  const first = await f.releases.list(actor, f.asset.id)
  assert.equal(first.linked, true); assert.deepEqual(first.catalog?.visible_to, { user_ids: [] })
  assert.deepEqual(f.commands.map(c => c.kind), ['RegisterPrincipal'])
  await assert.rejects(f.releases.publish(actor, f.asset.id, f.artifact.id, 'v1'), { code: 'HOSTED_ASSET_NOT_ADMITTED' })
  assert.equal(f.writes.length, 0)
  f.asset.status = 'approved'; f.asset.actual_level = 'L2'
  await f.releases.publish(actor, f.asset.id, f.artifact.id, 'v1')
  assert.deepEqual(f.commands.map(c => c.kind), ['RegisterPrincipal', 'PublishVersion'])
  assert.equal((await f.catalog.getAgent(result.catalog_id, actor.orgId))?.enabled, false)
  await f.releases.decide(actor, f.asset.id, 'v1', 'approved', 'Reviewed synthetic version', Date.now() + 60000)
  await f.releases.promote(actor, f.asset.id, 'v1', 'stable', 0, 'First reviewed release')
  await f.releases.visibility(actor, f.asset.id, true, ['member-a'])
  assert.equal((await f.catalog.getAgent(result.catalog_id, actor.orgId))?.enabled, true)
  assert.deepEqual(f.commands.map(c => c.kind), ['RegisterPrincipal', 'PublishVersion', 'DecideVersion', 'MoveChannel'])
  const before = f.commands.length
  await f.releases.list(actor, f.asset.id)
  assert.equal(f.commands.length, before)
})
void test('hosted release rejects stale metadata, foreign linked identity and unsafe versions; cleanup stays available', async t => {
  const f = fixture(t)
  await f.releases.enroll(actor, f.asset.id)
  f.asset.status = 'approved'; f.asset.actual_level = 'L2'
  f.artifact.metadata_digest = 'sha256:' + 'b'.repeat(64)
  await assert.rejects(f.releases.publish(actor, f.asset.id, f.artifact.id, 'v1'), { code: 'HOSTED_RELEASE_ARTIFACT_MISMATCH' })
  await assert.rejects(f.releases.publish(actor, f.asset.id, f.artifact.id, '../v1'), { code: 'INVALID_RELEASE_INPUT' })
  assert.equal(f.writes.length, 0)
  f.asset.principal = { trust_domain: 'agents.example', agent_name: 'external-another' }
  await assert.rejects(f.releases.enroll(actor, f.asset.id), { code: 'HOSTED_ASSET_LINK_MIGRATION_REQUIRED' })
  f.asset.status = 'suspended'; f.asset.actual_level = 'L0'
  await f.releases.visibility(actor, f.asset.id, false, [])
  await f.releases.decide(actor, f.asset.id, 'v1', 'revoked', 'Withdrawn during review')
  assert.equal(f.commands.at(-1)?.kind, 'DecideVersion')
})
void test('inventory release actions require organization administration and cannot authorize inactive members', async t => {
  const f = fixture(t), access = { canManage: false }, member = { active: true }
  const service = new AgentInventoryService({ registry: f.client, releases: f.releases, catalog: f.catalog,
    authorize: async () => access, member: async (_org, id) => member.active && id === 'owner-a' ? { id, departmentId: null } : null,
    members: async () => [], labels: async () => ({ users: new Map(), departments: new Map() }) })
  const auth = actor as AuthContext
  await assert.rejects(service.hostedReleaseAction(auth, f.asset.id, { action: 'enroll' }), { code: 'ADMIN_REQUIRED' })
  assert.equal(f.commands.length, 0)
  access.canManage = true
  await service.hostedReleaseAction(auth, f.asset.id, { action: 'enroll' })
  await assert.rejects(service.hostedReleaseAction(auth, f.asset.id, { action: 'visibility', enabled: true, user_ids: ['foreign-user'] }), { code: 'INVALID_MEMBER' })
  member.active = false
  await service.hostedReleaseAction(auth, f.asset.id, { action: 'visibility', enabled: false, user_ids: [] })
  await service.hostedReleaseAction(auth, f.asset.id, { action: 'decide', version: 'v1', decision: 'revoked', reason: 'The owner has left' })
})
