import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { createCatalogTestRepository } from '../testing/compatibilityRepositories.js'
import { SqliteDriver } from '../db/driver.js'
import { HostedTaskStore } from './hostedTaskStore.js'
import { HostedTaskService } from './hostedTaskService.js'
import { HostedReleases } from './hostedReleases.js'
import type { HostedTaskCoordinator } from './hostedTaskCoordinator.js'
import type { ProductRegistryClient } from './registryClient.js'
import { TASK_API } from './taskContract.js'
import { dispatchHostedTask } from './hostedTaskRoutes.js'

const actor = { userId: 'member-a', orgId: 'org-a' }, hash = 'sha256:' + 'a'.repeat(64)
async function fixture(t: { after: (fn: () => void) => void }) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  const catalog = createCatalogTestRepository(db), driver = new SqliteDriver(db)
  const store = new HostedTaskStore(driver); await store.ready
  const state = { starts: 0, active: true, level: 'L2' }
  const client = {
    identity: () => hash, scope: () => ({ zoneId: 'zone-a' }),
    principal: (_org: string, id: string) => ({ trust_domain: 'agents.example', agent_name: `external-${id}` }),
    inventoryGet: async () => ({ id: 'asset:a@example.org', status: 'approved', actual_level: state.level, metadata_digest: hash,
      metadata: { hosting: 'internal_hosted', owner_user_id: actor.userId } }),
    hostedGet: async () => artifact, readSnapshot: async () => ({}),
    resolve: async () => ({ version: { digest: hash, key_id: hash, manifest: { principal: client.principal(actor.orgId, id),
      version: 'v1', spec_digest: hash, spec_ref: releases.specRef(actor.orgId, id, artifact as never) } } }),
  }
  const releases = new HostedReleases(catalog, { client: client as unknown as ProductRegistryClient, command: async () => ({} as never) })
  const id = releases.catalogId(actor.orgId, 'asset:a@example.org')
  const artifact = { id: 'artifact-a', asset_id: 'asset:a@example.org', metadata_digest: hash, spec_digest: hash,
    image: { source_digest: hash, image_id: hash, dependency_lock_digest: hash, profile: 'langgraph-stdio-v1' } }
  await catalog.createAgent({ id, orgId: actor.orgId, name: 'Synthetic hosted', authorId: 'admin-a', enabled: true, status: 'approved',
    visibleTo: { user_ids: [actor.userId] }, providerType: 'moss_runtime', supportedModes: 'cloud',
    providerBinding: { executionMode: 'internal_hosted', assetId: 'asset:a@example.org', registryAuthorityId: hash } })
  const coordinator = { store, runtimeIdentity: async () => hash,
    start: async (_actor: unknown, _id: string, authorize: () => Promise<void>) => { await authorize(); state.starts++ } } as unknown as HostedTaskCoordinator
  const service = new HostedTaskService(coordinator, { catalog, registry: client as unknown as ProductRegistryClient, releases,
    activeMember: async a => state.active && a.orgId === actor.orgId && a.userId === actor.userId })
  const request = () => ({ api_version: TASK_API, kind: 'SubmitTask', agent: { catalog_id: id, requested_version: 'v1' },
    request_source: 'interactive', input: { instruction: '6 * 7', resource_refs: [] }, workspace_refs: [], requested_mode: 'auto',
    data_classification: 'synthetic', required_capabilities: [], constraints: { idempotency_key: randomUUID() } })
  return { db, driver, catalog, id, state, store, service, request }
}
void test('hosted service binds the fixed artifact, keeps replay before mutable policy and rejects other data without dispatch', async t => {
  const f = await fixture(t), request = f.request()
  const task = await f.service.create(actor, request)
  assert.equal(task.status, 'accepted'); assert.equal(f.state.starts, 1)
  const record = await f.store.record(actor, task.id)
  assert.equal(record.resolution.status, 'accepted')
  if (record.resolution.status === 'accepted') { assert.equal(record.resolution.execution_mode, 'internal_hosted'); assert.equal(record.resolution.agent.version, 'v1') }
  await f.catalog.updateAgentConfiguration(f.id, actor.orgId, { enabled: false })
  assert.equal((await f.service.create(actor, request)).id, task.id)
  assert.equal(f.state.starts, 1)
  assert.equal((await f.service.create(actor, f.request())).status, 'rejected')
  await assert.rejects(f.service.create(actor, { ...request, input: { instruction: 'changed', resource_refs: [] } }), { code: 'IDEMPOTENCY_CONFLICT' })
  await f.catalog.updateAgentConfiguration(f.id, actor.orgId, { enabled: true })
  const rejected = await f.service.create(actor, { ...f.request(), data_classification: 'internal' })
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.attempt_id, null)
  assert.equal(f.state.starts, 1)
})
void test('unified Task routing uses existing runtime even after catalog changes and does not expose foreign history', async t => {
  const f = await fixture(t), request = f.request(), url = new URL('http://localhost/api/v1/tasks')
  const accepted = await dispatchHostedTask(f.service, f.driver, actor, 'POST', url, request)
  assert.equal(accepted?.status, 202)
  const task = await f.store.existing(actor, request as never)
  assert.ok(task)
  await f.catalog.updateAgentConfiguration(f.id, actor.orgId, { providerBinding: { executionMode: 'external_hosted' } })
  const replay = await dispatchHostedTask(f.service, f.driver, actor, 'POST', url, request)
  assert.equal(replay?.status, 202); assert.equal(f.state.starts, 1)
  const read = await dispatchHostedTask(f.service, f.driver, actor, 'GET', new URL(`http://localhost/api/v1/tasks/${task.id}/specification`), {})
  assert.equal(read?.status, 200)
  assert.equal(await dispatchHostedTask(f.service, f.driver, { ...actor, userId: 'foreign' }, 'GET', new URL(`http://localhost/api/v1/tasks/${task.id}`), {}), null)
  const unavailable = await dispatchHostedTask(undefined, f.driver, actor, 'POST', url, request)
  assert.equal(unavailable?.status, 503)
  f.state.active = false
  assert.equal((await dispatchHostedTask(f.service, f.driver, actor, 'GET', new URL('http://localhost/api/v1/hosted-sessions'), {}))?.status, 403)
})
