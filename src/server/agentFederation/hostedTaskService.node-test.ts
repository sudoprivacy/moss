import { nativeExecutionProfile } from './nativeExecution.js'
import { contentDigest } from './provider/protocol.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { createCatalogTestRepository } from '../testing/compatibilityRepositories.js'
import { SqliteDriver } from '../db/driver.js'
import { HostedTaskStore } from './hostedTaskStore.js'
import { HostedTaskService } from './hostedTaskService.js'
import { HostedReleases } from './hostedReleases.js'
import type { ExecutionModelCall } from './executionModelGateway.js'
import type { HostedTaskCoordinator } from './hostedTaskCoordinator.js'
import type { ProductRegistryClient } from './registryClient.js'
import { TASK_API } from './taskContract.js'
import { dispatchHostedTask } from './hostedTaskRoutes.js'

const actor = { userId: 'member-a', orgId: 'org-a' }, hash = 'sha256:' + 'a'.repeat(64)
async function fixture(t: { after: (fn: () => void) => void }, native = false) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  const catalog = createCatalogTestRepository(db), driver = new SqliteDriver(db)
  const store = new HostedTaskStore(driver); await store.ready
  const state = { starts: 0, active: true, level: native ? 'L3' : 'L2', calls: [] as ExecutionModelCall[] }
  const client = {
    identity: () => hash, scope: () => ({ zoneId: 'zone-a' }),
    principal: (_org: string, id: string) => ({ trust_domain: 'agents.example', agent_name: `external-${id}` }),
    inventoryGet: async () => ({ id: 'asset:a@example.org', status: 'approved', actual_level: state.level, metadata_digest: hash,
      metadata: { hosting: 'internal_hosted', owner_user_id: actor.userId },
      ...(native ? { acceptance: { native_binding: { conversion_id: artifact.id, profile_digest: contentDigest(nativeExecutionProfile(artifact as never)) } } } : {}) }),
    hostedGet: async () => artifact, nativeGet: async () => artifact, readSnapshot: async () => ({}),
    resolve: async () => ({ version: { digest: hash, key_id: hash, manifest: { principal: client.principal(actor.orgId, id),
      version: 'v1', spec_digest: hash, spec_ref: releases.specRef(actor.orgId, id, artifact as never) } } }),
  }
  const releases = new HostedReleases(catalog, { client: client as unknown as ProductRegistryClient, command: async () => ({} as never) })
  const id = releases.catalogId(actor.orgId, 'asset:a@example.org')
  const artifact = { kind: native ? 'NativeConversion' : 'HostedArtifact', id: 'artifact-a', asset_id: 'asset:a@example.org', metadata_digest: hash, spec_digest: hash,
    image: { source_digest: hash, image_id: hash, dependency_lock_digest: hash, profile: native ? 'sudocode-dify-independent-text-v1alpha1' : 'langgraph-stdio-v1', definition_digest: hash,
      runtime: { kind: 'sudocode', commit: 'a'.repeat(40), executable_digest: hash, runner_digest: hash, platform: 'linux/amd64' } } }
  await catalog.createAgent({ id, orgId: actor.orgId, name: 'Synthetic hosted', authorId: 'admin-a', enabled: true, status: 'approved',
    visibleTo: { user_ids: [actor.userId] }, providerType: 'moss_runtime', supportedModes: 'cloud',
    providerBinding: { executionMode: 'internal_hosted', assetId: 'asset:a@example.org', registryAuthorityId: hash } })
  const coordinator = { store, evidenceCalls: async () => state.calls, runtimeIdentity: async () => hash,
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

function modelCall(task: { id: string; asset_id: string }): ExecutionModelCall {
  return { id: 'call-1', callId: `${task.id}:1`, orgId: actor.orgId, grantId: 'grant-private', assetId: task.asset_id, taskId: task.id,
    specDigest: hash, grantExpiresAt: Date.now() + 10000, ownerUserId: actor.userId, departmentId: null, resource: 'private-model-resource',
    model: 'test-model', mode: 'run', status: 'completed', createdAt: 1, updatedAt: 2, answer: 'private-model-answer',
    tokenCleanupPending: false, ledgerStatus: 'router_verified', routerToken: { id: 1, accountId: 2, name: 'private-token-name', model: 'test-model', expiresAt: 10000, quotaLimit: 50 },
    consumption: [{ id: 3, accountId: 2, tokenId: 1, createdAt: 1, model: 'test-model', quota: 15, promptTokens: 2, completionTokens: 1 }] }
}
void test('hosted evidence reads stored release and scoped ledger without mutations or leaking credentials', async t => {
  const f = await fixture(t), task = await f.service.create(actor, f.request()), call = modelCall(task)
  f.state.calls = [{ ...call, consumption: [...call.consumption, ...call.consumption] }]
  await f.store.failUndispatched(actor, task.id, 'TEST_FINISHED')
  await f.catalog.updateAgentConfiguration(f.id, actor.orgId, { enabled: false })
  const before = f.db.prepare('SELECT total_changes() AS n').get()!.n
  const response = await dispatchHostedTask(f.service, f.driver, actor, 'GET', new URL(`http://localhost/api/v1/tasks/${task.id}/evidence`), {})
  assert.equal(response?.status, 200)
  const evidence = await f.service.evidence(actor, task.id)
  assert.equal(evidence.release?.version, 'v1')
  assert.equal(evidence.usage.status, 'verified'); assert.equal(evidence.usage.verified_quota, 15)
  assert.equal(evidence.usage.calls[0].ledger_entries, 1)
  assert.doesNotMatch(JSON.stringify(evidence), /private-|routerToken|grantId|tokenId|accountId|request|answer/)
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, before)
  await assert.rejects(f.service.evidence({ ...actor, userId: 'other' }, task.id), { code: 'USER_NOT_ACTIVE' })
  await assert.rejects(f.store.tracePage({ ...actor, orgId: 'other' }, task.id, 0, task.sequence), { code: 'TASK_NOT_FOUND' })
  f.state.calls = [{ ...call, orgId: 'other' }]
  await assert.rejects(f.service.evidence(actor, task.id), { code: 'HOSTED_TASK_EVIDENCE_INVALID' })
  f.state.calls = [{ ...call, consumption: [...call.consumption, { ...call.consumption[0], quota: 30 }] }]
  await assert.rejects(f.service.evidence(actor, task.id), { code: 'HOSTED_TASK_EVIDENCE_INVALID' })
  f.state.calls = [{ ...call, consumption: [{ ...call.consumption[0], tokenId: 99 }] }]
  await assert.rejects(f.service.evidence(actor, task.id), { code: 'HOSTED_TASK_EVIDENCE_INVALID' })
})
void test('unverified consumption and unknown dispatch remain pending; traces paginate without full task snapshots', async t => {
  const f = await fixture(t), task = await f.service.create(actor, f.request())
  f.state.calls = [{ ...modelCall(task), status: 'unknown', ledgerStatus: 'pending' }]
  let evidence = await f.service.evidence(actor, task.id)
  assert.equal(evidence.usage.status, 'pending'); assert.equal(evidence.usage.pending_calls, 1); assert.equal(evidence.usage.verified_quota, 0)
  f.state.calls = []
  assert.equal((await f.service.evidence(actor, task.id)).usage.status, 'pending')
  // Seed contiguous durable trace fixtures, including the canonical sequence horizon.
  for (let i = 2; i <= 102; i++) {
    const snapshot = { ...task, sequence: i }, event = { api_version: TASK_API, kind: 'HostedTaskEvent', task_id: task.id,
      sequence: i, created_at: task.updated_at, type: 'trace', task: snapshot, trace: { node: `node-${i}`, phase: 'started', origin: 'worker_reported' } }
    await f.driver.run('INSERT INTO session_events(event_id, session_id, event_type, payload_json, created_at, task_id, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [`task:${task.id}:${i}`, task.session_id, 'task.trace', JSON.stringify(event), task.updated_at, task.id, i])
  }
  await f.driver.run('UPDATE tasks SET sequence = ?, document = ? WHERE id = ?', [102, JSON.stringify({ ...task, sequence: 102 }), task.id])
  evidence = await f.service.evidence(actor, task.id)
  assert.equal(evidence.trace.length, 100); assert.equal(evidence.trace_has_more, true); assert.equal(evidence.trace_next_cursor, 101)
  assert.equal('task' in evidence.trace[0], false)
  const last = await f.service.evidence(actor, task.id, evidence.trace_next_cursor)
  assert.equal(last.trace.length, 1); assert.equal(last.trace_has_more, false); assert.equal(last.trace_next_cursor, 102)
  await assert.rejects(f.service.evidence(actor, task.id, 103), { code: 'INVALID_CURSOR' })
  await assert.rejects(f.service.evidence(actor, task.id, -1), { code: 'INVALID_CURSOR' })
})

void test('organization admin can close a departed owner unknown task with separate operator audit, never granting execution', async t => {
  const { AgentInventoryService } = await import('./inventoryService.js')
  const { dispatchAgentInventory } = await import('./inventoryRoutes.js')
  const f = await fixture(t), task = await f.service.create(actor, f.request())
  await f.driver.run('UPDATE tasks SET status = ?, document = ? WHERE id = ?', ['unknown', JSON.stringify({ ...task, status: 'unknown', cleanup: 'unknown' }), task.id])
  f.state.active = false
  const admin = { ...actor, userId: 'admin-a', role: 'admin', scopes: ['admin:users'] } as import('../auth/token.js').AuthContext
  const inventory = new AgentInventoryService({ tasks: f.service, catalog: f.catalog, authorize: async a => ({ canManage: a.role === 'admin' }),
    member: async () => null, members: async () => [], labels: async () => ({ users: new Map(), departments: new Map() }) })
  const url = (suffix: string) => new URL(`http://localhost/api/v1/agent-inventory/hosted/tasks/${suffix}`)
  assert.equal((await dispatchAgentInventory(inventory, { ...admin, role: 'user' } as never, 'GET', url('unknown'), {})).status, 403)
  assert.equal((await inventory.hostedUnknown(admin)).items[0].user_id, actor.userId)
  await assert.rejects(inventory.hostedTaskAction({ ...admin, orgId: 'foreign' }, task.id, 'close', { note: 'Reviewed unknown result and cleanup.' }), { code: 'TASK_NOT_FOUND' })
  await assert.rejects(inventory.hostedTaskAction(admin, task.id, 'close', { note: 'Reviewed unknown result and cleanup.' }), { code: 'HOSTED_CLEANUP_UNCONFIRMED' })
  await assert.rejects(inventory.hostedTaskAction(admin, task.id, 'close', { note: 'Reviewed unknown result and cleanup.', user_id: 'other' }), { code: 'INVALID_ADMIN_INPUT' })
  await f.store.confirmCleanup(actor, task.id, task.attempt_id!)
  const response = await dispatchAgentInventory(inventory, admin, 'POST', url(`${task.id}/close`), { note: 'Reviewed unknown result and cleanup.' })
  assert.equal(response.status, 200)
  assert.equal((await f.store.get(actor, task.id)).status, 'unknown')
  assert.equal((await inventory.hostedUnknown(admin)).items.length, 0)
  const audit = JSON.parse(String((await f.driver.get("SELECT payload_json FROM session_events WHERE event_type = 'hosted.reconciled'"))!.payload_json))
  assert.equal(audit.user_id, admin.userId); assert.equal(audit.task_user_id, actor.userId); assert.equal(audit.performed_as, 'org_admin')
  assert.equal(f.state.starts, 1)
})


void test('native catalog selects its immutable snapshot and enforces one-call synthetic independent tasks', async t => {
  const f = await fixture(t, true), task = await f.service.create(actor, f.request())
  const record = await f.store.record(actor, task.id), r = record.resolution
  assert.ok(r.status === 'accepted' && r.execution_mode === 'internal_hosted' && r.resolved_runtime === 'native_sudocode')
  assert.equal(r.limits.max_model_calls, 1)
  assert.equal(r.agent.version_evidence, 'immutable_native_artifact')
  assert.match(r.native_profile_digest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(f.state.starts, 1)
  for (const change of [{ required_capabilities: ['tools'] }, { data_classification: 'internal' }]) {
    assert.equal((await f.service.create(actor, { ...f.request(), ...change })).status, 'rejected')
  }
  await assert.rejects(f.service.create(actor, { ...f.request(), input: { instruction: 'test', resource_refs: [], parameters: { memory: true } } }), { code: 'INVALID_TASK_SPEC' })
  f.state.level = 'L2'
  assert.equal((await f.service.create(actor, f.request())).status, 'rejected')
  assert.equal(f.state.starts, 1)
})
