import { strict as assert } from 'node:assert'
import { test, type TestContext } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SqliteDriver } from '../db/driver.js'
import { AssetSuspensions } from './assetSuspension.js'
import { assertAssetOpen, lockAssetGate } from './assetControlStore.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import type { ProductRegistryClient } from './registryClient.js'
import type { AssetRecord, InventoryWire } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { AgentInventoryService } from './inventoryService.js'
import { dispatchAgentInventory } from './inventoryRoutes.js'
import type { AuthContext } from '../auth/token.js'

type ExternalActorWithSession = { orgId: string; userId: string; rawToken: string; jti: string }
const actor = { orgId: 'org-a', userId: 'admin-a' }
const asset = { id: 'asset-a', revision: 3, status: 'approved', metadata: { owner_user_id: 'owner-a' }, principal: null } as AssetRecord
const command = { api_version: 'agent-registry.sudo.dev/v1alpha1', kind: 'SuspendAsset', asset_id: asset.id,
  expected_revision: 3, initiated_by: actor.userId, request_id: 'suspend-request-a', reason: 'Test controlled suspension' } as Extract<InventoryWire, { kind: 'SuspendAsset' }>
async function fixture(t: TestContext) {
  const db = new SqliteDriver(new DatabaseSync(':memory:'))
  t.after(() => db.close())
  let current = asset
  const state = { unavailable: false, identityPending: true, modelPending: true, hostedPending: true, commands: 0, revokes: 0, calls: 0, tasks: 0 }
  const registry = {
    inventoryCommand: async () => { state.commands++; if (state.unavailable) throw new ExternalProviderError(503, 'REGISTRY_UNAVAILABLE'); current = { ...asset, status: 'suspended', revision: 4 }; return current },
    inventoryGet: async () => current,
    executionList: async () => ({ items: [{ id: 'grant-a' }], next_cursor: null }),
    executionRevoke: async () => { state.revokes++; return { cleanup_pending: state.identityPending } },
  } as unknown as ProductRegistryClient
  const ports = {
    gateway: { suspendAsset: async () => { state.calls++; return { calls: 1, pending: Number(state.modelPending) } } },
    tasks: { suspendAsset: async () => { state.tasks++; return { tasks: 1, pending: Number(state.hostedPending) } } },
  }
  const service = new AssetSuspensions(db, registry, ports)
  await service.ready
  return { db, service, state, registry, ports }
}
void test('suspension persists gate before authority I/O, survives restart and never repeats successful owner command', async t => {
  const f = await fixture(t)
  f.state.unavailable = true
  await assert.rejects(f.service.request(actor, command, asset), /REGISTRY_UNAVAILABLE/)
  await assert.rejects(assertAssetOpen(f.db, actor.orgId, asset.id), /AGENT_SUSPENSION_ACTIVE/)
  assert.equal((await f.service.get(actor.orgId, asset.id))?.entry, 'closed_locally')
  f.state.unavailable = false
  const restarted = new AssetSuspensions(f.db, f.registry, f.ports)
  await restarted.ready
  let report = await restarted.retry(actor.orgId, asset.id)
  assert.equal(report?.entry, 'confirmed'); assert.equal(report?.status, 'pending')
  const before = JSON.stringify(await f.db.all('SELECT * FROM agent_asset_suspensions'))
  await restarted.get(actor.orgId, asset.id)
  assert.equal(JSON.stringify(await f.db.all('SELECT * FROM agent_asset_suspensions')), before)
  await assert.rejects(restarted.assertRestorable(actor.orgId, asset.id), /AGENT_SUSPENSION_PENDING/)
  assert.equal(await restarted.get('org-b', asset.id), null)
  f.state.identityPending = f.state.modelPending = f.state.hostedPending = false
  report = await restarted.retry(actor.orgId, asset.id)
  assert.equal(report?.status, 'confirmed'); assert.equal(report?.external_cancellation, 'unsupported')
  assert.equal(f.state.commands, 2) // first request failed; only one successful authority command
  await restarted.request({ ...actor, rawToken: 'refreshed-session-must-not-change-idempotency', jti: 'new-session' } as ExternalActorWithSession, command, asset)
  assert.equal(f.state.commands, 2)
  await assert.rejects(restarted.request({ ...actor, userId: 'another-admin' }, { ...command, initiated_by: 'another-admin' }, asset), /IDEMPOTENCY_CONFLICT/)
  await assert.rejects(assertAssetOpen(f.db, actor.orgId, asset.id), /AGENT_SUSPENSION_ACTIVE/)
  await restarted.restored(actor.orgId, asset.id, await restarted.assertRestorable(actor.orgId, asset.id))
  await assertAssetOpen(f.db, actor.orgId, asset.id)
  // All historical operation evidence remains persisted after explicit restoration.
  assert.equal((await f.db.all('SELECT id FROM agent_asset_suspensions')).length, 1)
})
void test('asset gate isolates organizations and serializes model reservation with stop', async t => {
  const f = await fixture(t)
  await f.service.request(actor, command, asset)
  await assert.rejects(f.db.transaction(() => lockAssetGate(f.db, actor.orgId, asset.id)), /AGENT_SUSPENSION_ACTIVE/)
  await f.db.transaction(() => lockAssetGate(f.db, 'org-b', asset.id))
  await assert.rejects(f.service.request(actor, { ...command, request_id: 'new-request' }, asset), /AGENT_SUSPENSION_ACTIVE/)
})
void test('missing runtime configuration cannot turn orphaned model records into cleanup confirmation', async t => {
  const f = await fixture(t)
  await f.db.exec('CREATE TABLE agent_model_calls(id TEXT, org_id TEXT, document TEXT)')
  await f.db.run('INSERT INTO agent_model_calls VALUES (?, ?, ?)', ['call-a', actor.orgId, JSON.stringify({ assetId: asset.id })])
  f.state.identityPending = false
  const service = new AssetSuspensions(f.db, f.registry, {})
  await service.request(actor, command, asset)
  assert.equal((await service.get(actor.orgId, asset.id))?.model, 'pending')
})
void test('failed revision precondition releases only its own local gate and keeps failed audit', async t => {
  const f = await fixture(t)
  f.registry.inventoryCommand = async () => { throw new ExternalProviderError(409, 'AGENT_ASSET_REVISION_CONFLICT') }
  await assert.rejects(f.service.request(actor, command, asset), /AGENT_ASSET_REVISION_CONFLICT/)
  await assertAssetOpen(f.db, actor.orgId, asset.id)
  assert.equal((await f.db.get('SELECT status FROM agent_asset_suspensions'))?.status, 'failed')
})
void test('suspension routes deny members and reject forged owner overrides before side effects', async t => {
  const f = await fixture(t)
  const service = new AgentInventoryService({ registry: f.registry, suspensions: f.service,
    authorize: async () => ({ canManage: false }) } as never)
  const member: AuthContext = { ...actor, role: 'member', scopes: [], rawToken: 'synthetic', keyId: 'test', jti: 'test', exp: Date.now() / 1000 + 60 }
  await assert.rejects(service.suspension(member, asset.id), /ADMIN_REQUIRED/)
  const response = await dispatchAgentInventory(service, member, 'POST', new URL('http://localhost/api/v1/agent-inventory/assets/asset-a/suspension'), { user_id: 'other' })
  assert.equal(response.status, 400)
  assert.equal(f.state.commands, 0)
})

void test('PostgreSQL suspension coordinates independent controllers and asset admission locks', { skip: !process.env.MOSS_PG_TEST_URL }, async () => {
  const pg = await import('pg')
  const { PgDriver } = await import('../db/driver.js')
  const { randomUUID } = await import('node:crypto')
  const schema = `suspension_${randomUUID().replaceAll('-', '')}`, connectionString = process.env.MOSS_PG_TEST_URL!
  const admin = new pg.default.Pool({ connectionString })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const dbs = [0, 1].map(() => new PgDriver(new pg.default.Pool({ connectionString, options: `-c search_path=${schema}` }) as never))
  try {
    let commands = 0
    const suspended = { ...asset, status: 'suspended', revision: 4 } as AssetRecord
    const registry = { inventoryCommand: async () => { commands++; return suspended }, inventoryGet: async () => suspended,
      executionList: async () => ({ items: [], next_cursor: null }) } as unknown as ProductRegistryClient
    const a = new AssetSuspensions(dbs[0], registry, {})
    const b = new AssetSuspensions(dbs[1], registry, {})
    await Promise.all([a.ready, b.ready])
    let release!: () => void, locked!: () => void
    const holding = new Promise<void>(resolve => { release = resolve }), began = new Promise<void>(resolve => { locked = resolve })
    const reservation = dbs[0].transaction(async () => { await lockAssetGate(dbs[0], actor.orgId, asset.id); locked(); await holding })
    await began
    const stop = b.request(actor, command, asset)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(commands, 0)
    release(); await reservation; await stop
    assert.equal((await a.get(actor.orgId, asset.id))?.status, 'confirmed')
    await a.request(actor, command, asset)
    assert.equal(commands, 1)
    await assert.rejects(dbs[0].transaction(() => lockAssetGate(dbs[0], actor.orgId, asset.id)), /AGENT_SUSPENSION_ACTIVE/)
    await dbs[0].transaction(() => lockAssetGate(dbs[0], 'org-b', asset.id))
  } finally {
    await Promise.all(dbs.map(db => db.close()))
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})
