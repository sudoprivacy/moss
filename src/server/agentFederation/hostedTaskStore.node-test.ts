import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { SqliteDriver, PgDriver, type DbDriver, type PgPoolLike } from '../db/driver.js'
import { ExternalTaskStore, digest, type Binding } from '../externalProviders/store.js'
import { canonicalTaskJson, TASK_API } from './taskContract.js'
import { HostedTaskStore, type HostedTaskAdmission } from './hostedTaskStore.js'
import type { HostedTask, SubmitTask, TaskExecutionResolution } from '../../../contracts/task/v1alpha1/contract.js'

const actor = { orgId: 'org-a', userId: 'user-a' }, hash = `sha256:${'a'.repeat(64)}`
const principal = { trust_domain: 'agents.example', agent_name: 'hosted-helper' }, policy = { profile: 'hosted-text-v1' }
function request(sessionId?: string): SubmitTask {
  return { api_version: TASK_API, kind: 'SubmitTask', agent: { catalog_id: 'catalog-a', requested_version: 'v1' },
    ...(sessionId ? { session_id: sessionId } : {}), request_source: 'interactive',
    input: { instruction: '6 * 7', resource_refs: [] }, workspace_refs: [], requested_mode: 'private',
    data_classification: 'synthetic', required_capabilities: [], constraints: { idempotency_key: randomUUID() } }
}
function admission(rejected = false, version = 'v1'): HostedTaskAdmission {
  return { assetId: 'asset-a', principal, policySnapshot: policy, timeoutMs: 120000,
    resolution: (task: HostedTask): TaskExecutionResolution => {
      const base = { api_version: TASK_API, kind: 'TaskExecutionResolution' as const, resolution_id: randomUUID(), task_id: task.id,
        reason_code: rejected ? 'ASSET_NOT_ADMITTED' : 'ALLOWED', reason: 'Synthetic storage fixture only', policy_version: 'hosted-text-v1',
        policy_snapshot_digest: digest(canonicalTaskJson(policy)), decided_at: new Date(task.created_at).toISOString() }
      if (rejected) return { ...base, status: 'rejected' }
      return { ...base, status: 'accepted', attempt_id: task.attempt_id!, execution_mode: 'internal_hosted', resolved_runtime: 'hosted_artifact', runtime_authority_id: hash,
        resolution_mode: 'default', governance_org_id: actor.orgId, catalog_id: task.catalog_id, asset_id: task.asset_id,
        artifact_id: 'artifact-a', metadata_digest: hash, agent: { principal, version, source_digest: hash,
          version_evidence: 'immutable_hosted_artifact', release_digest: hash, registry: { authority: 'nexus_registry', principal,
            registration_digest: hash, signing_key_id: hash, evidence: 'signed_registration_only' } },
        artifact: { spec_digest: hash, image_id: hash, dependency_lock_digest: hash, profile: 'langgraph-stdio-v1' },
        limits: { timeout_ms: 120000, max_model_calls: 2 } }
    } }
}
async function fixture(db: DbDriver) {
  const store = new HostedTaskStore(db); await store.ready
  await db.run("INSERT INTO server_instances(instance_id, host, pid, started_at, heartbeat_at, status) VALUES ('owner-a', 'test', ?, ?, ?, 'running')", [process.pid, Date.now(), Date.now()])
  return store
}
async function lifecycle(db: DbDriver, peerDb = db): Promise<void> {
  const store = await fixture(db), peer = new HostedTaskStore(peerDb), input = request()
  const tasks = await Promise.all([store.create(actor, input, admission()), peer.create(actor, input, admission())])
  assert.equal(tasks[0].id, tasks[1].id)
  const task = tasks[0]
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM tasks'))?.n), 1)
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM session_attempts'))?.n), 1)
  assert.equal((await peer.record(actor, task.id)).resolution.status, 'accepted')
  await assert.rejects(peer.get({ ...actor, userId: 'other' }, task.id), { code: 'TASK_NOT_FOUND' })
  await assert.rejects(peer.get({ ...actor, orgId: 'other' }, task.id), { code: 'TASK_NOT_FOUND' })
  await assert.rejects(peer.create(actor, { ...input, input: { ...input.input, instruction: 'different' } }, admission()), { code: 'IDEMPOTENCY_CONFLICT' })
  await assert.rejects(peer.create(actor, request(task.session_id), admission()), { code: 'SESSION_BUSY_OR_AGENT_MISMATCH' })
  const claims = await Promise.all([store.claim(actor, task.id, 'owner-a'), peer.claim(actor, task.id, 'owner-a')])
  assert.equal(claims.filter(Boolean).length, 1)
  const claim = claims.find(Boolean)!
  assert.equal(claim.task.status, 'dispatching')
  assert.equal(await peer.update(actor, task.id, { ...claim.fence, token: 'stale-token' }, { status: 'running' }), null)
  assert.equal(await store.bindGrant(actor, task.id, claim.fence, 'grant-a'), true)
  assert.equal(await peer.bindGrant(actor, task.id, claim.fence, 'grant-a'), true)
  await assert.rejects(peer.bindGrant(actor, task.id, claim.fence, 'grant-b'), { code: 'EXECUTION_GRANT_CONFLICT' })
  await assert.rejects(peer.update(actor, task.id, claim.fence, { id: 'altered' } as never), { code: 'INVALID_HOSTED_TASK_UPDATE' })
  await assert.rejects(peer.update(actor, task.id, claim.fence, { status: 'succeeded' }), { code: 'HOSTED_TASK_COMPLETION_UNCONFIRMED' })
  assert.equal((await store.update(actor, task.id, claim.fence, { status: 'running', answer: '4' }))?.status, 'running')
  assert.equal(await peer.renew(actor, task.id, claim.fence), true)
  const result = await peer.update(actor, task.id, claim.fence, { status: 'succeeded', answer: '42', cleanup: 'confirmed' })
  assert.equal(result?.answer, '42')
  assert.equal(await store.update(actor, task.id, claim.fence, { answer: 'late overwrite' }), null)
  assert.equal((await store.events(actor, task.id, 1)).events.length, 3)
  assert.equal((await peer.record(actor, task.id)).spec.input.instruction, '6 * 7')
  const switched = request(task.session_id); switched.agent.requested_version = 'v2'
  await assert.rejects(peer.create(actor, switched, admission(false, 'v2')), { code: 'VERSION_CHANGE_REQUIRES_NEW_SESSION' })
  const next = await peer.create(actor, request(task.session_id), admission())
  assert.equal(next.session_sequence, 2)
  const cancelled = await peer.cancel(actor, next.id)
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.cleanup, 'not_started')
  assert.equal(await store.claim(actor, next.id, 'owner-a'), null)
  const rejectedInput = request(), denied = await store.create(actor, rejectedInput, admission(true))
  assert.equal(denied.attempt_id, null)
  assert.equal((await peer.create(actor, rejectedInput, admission())).id, denied.id, 'a later policy change cannot turn rejection replay into execution')
  const external = new ExternalTaskStore(db); await external.ready
  await assert.rejects(external.existingRequest(actor, input.constraints.idempotency_key, digest(canonicalTaskJson(input))), { code: 'TASK_RUNTIME_MISMATCH' })
  const ext = await external.create(actor, { agent_id: 'external-a', query: 'test', idempotency_key: 'external-key' }, { id: 'external-a', source_digest: hash } as Binding, 1000)
  const collide = request(); collide.constraints.idempotency_key = 'external-key'
  await assert.rejects(store.create(actor, collide, admission()), { code: 'IDEMPOTENCY_CONFLICT' })
  await assert.rejects(store.get(actor, ext.id), { code: 'TASK_NOT_FOUND' })
}
async function interrupted(db: DbDriver): Promise<void> {
  const store = await fixture(db), input = request(), task = await store.create(actor, input, admission())
  const claim = (await store.claim(actor, task.id, 'owner-a'))!
  await store.update(actor, task.id, claim.fence, { status: 'running', answer: 'partial' })
  await store.cancel(actor, task.id)
  assert.equal((await store.get(actor, task.id)).status, 'running', 'requesting cancellation is not proof of container cleanup')
  assert.equal(await store.renew(actor, task.id, claim.fence), false)
  await assert.rejects(store.update(actor, task.id, claim.fence, { status: 'succeeded', cleanup: 'confirmed' }), { code: 'HOSTED_TASK_COMPLETION_UNCONFIRMED' })
  await db.run('UPDATE hosted_attempt_leases SET lease_until = 0 WHERE attempt_id = ?', [task.attempt_id])
  const recovered = new HostedTaskStore(db)
  assert.equal(await recovered.recoverExpired(), 1)
  const unknown = await recovered.get(actor, task.id)
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.cleanup, 'unknown'); assert.equal(unknown.answer, 'partial')
  assert.equal(await recovered.claim(actor, task.id, 'owner-a'), null)
  assert.equal(await store.update(actor, task.id, claim.fence, { status: 'cancelled', cleanup: 'confirmed' }), null)
  assert.equal((await recovered.create(actor, input, admission())).id, task.id)
  await assert.rejects(recovered.create(actor, request(task.session_id), admission()), { code: 'SESSION_BUSY_OR_AGENT_MISMATCH' })
  assert.equal(await recovered.recoverExpired(), 0)
  const fresh = await store.create(actor, request(), admission())
  const active = (await store.claim(actor, fresh.id, 'owner-a'))!
  await store.cancel(actor, fresh.id)
  assert.equal((await store.update(actor, fresh.id, active.fence, { status: 'cancelled', cleanup: 'confirmed' }))?.status, 'cancelled')
}
for (const [name, check] of [['atomic admission, idempotency, ownership, version pin and terminal fencing', lifecycle], ['restart and cancellation retain ambiguous outcomes without redispatch', interrupted]] as const) {
  void test(`hosted tasks: ${name}`, async t => {
    const db = new SqliteDriver(new DatabaseSync(':memory:')); t.after(() => db.close())
    await check(db)
  })
  void test(`PostgreSQL hosted tasks: ${name}`, { skip: !process.env.MOSS_PG_TEST_URL }, async () => {
    const connectionString = process.env.MOSS_PG_TEST_URL!, schema = `hosted_${randomUUID().replaceAll('-', '')}`
    const admin = new pg.Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`)
    const dbs = [0, 1].map(() => new PgDriver(new pg.Pool({ connectionString, options: `-c search_path=${schema}` }) as unknown as PgPoolLike))
    try { await check(dbs[0], dbs[1]) }
    finally { await Promise.all(dbs.map(db => db.close())); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() }
  })
}

// Controlled owner/gateway/runner tests; real platform qualification is separate.
async function coordinatorFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const { HostedTaskCoordinator } = await import('./hostedTaskCoordinator.js')
  const db = new SqliteDriver(new DatabaseSync(':memory:')); t.after(() => db.close())
  const store = await fixture(db), input = request(), task = await store.create(actor, input, admission())
  const control = { runs: 0, grants: 0, revokes: 0, authorized: 0, reconciled: 0,
    level: 'L2', source: hash, ledger: 'router_verified', cleanupPending: false, issueLost: false, lostVisible: true, runnerFails: false, workerCleanup: true,
    beforeModel: async () => {} }
  const issued: Record<string, any> = {}
  const artifact = { id: 'artifact-a', asset_id: 'asset-a', metadata_digest: hash, spec_digest: hash,
    image: { image_id: hash, source_digest: hash, dependency_lock_digest: hash, profile: 'langgraph-stdio-v1', model_resource: 'model-resource', model_name: 'model' } }
  const registry = {
    hostedGet: async () => ({ ...artifact, image: { ...artifact.image, source_digest: control.source } }),
    inventoryGet: async () => ({ id: 'asset-a', status: 'approved', actual_level: control.level, principal, metadata_digest: hash, metadata: { hosting: 'internal_hosted' } }),
    resolve: async () => ({ version: { digest: hash, key_id: hash, manifest: { spec_digest: hash } } }),
    executionIssue: async (_org: string, command: Record<string, any>) => {
      control.grants++; issued.request = command
      assert.equal(command.mode, 'run'); assert.equal(command.version, 'v1'); assert.equal(command.dataset_digest, null)
      assert.equal(command.task_id, task.id); assert.equal(command.initiated_by, actor.userId)
      assert.equal((await store.get(actor, task.id)).status, 'dispatching')
      if (control.issueLost) throw new Error('controlled lost response')
      return { grant: { id: 'grant-a' }, api_key: 'synthetic-one-time-key' }
    },
    executionAuthorize: async () => { control.authorized++ },
    executionList: async () => ({ items: control.lostVisible ? [{ id: 'grant-a', request: issued.request }] : [], next_cursor: null }),
    executionRevokeRequest: async (_org: string, requestId: string, taskId: string) => {
      control.revokes++; assert.equal(requestId, `hosted-${task.attempt_id}`); assert.equal(taskId, task.id)
      if (!control.lostVisible) throw new Error('controlled fence response loss')
      return { cleanup_pending: control.cleanupPending }
    },
  }
  const gateway = {
    invoke: async () => { await control.beforeModel(); return { status: 'completed', answer: '42' } },
    taskCalls: async () => control.runs ? [{ id: 'model-call-a' }] : [],
    reconcile: async () => { control.reconciled++; return { tokenCleanupPending: false, ledgerStatus: control.ledger } },
  }
  const runner = { identity: async () => hash, reconcile: async (_artifact: unknown, executionId: string) => {
    assert.equal(executionId, task.attempt_id!.replaceAll('-', ''))
    if (!control.workerCleanup) throw new Error('controlled cleanup uncertainty')
  }, run: async (options: import('./hostedRunner.js').HostedRunOptions) => {
    control.runs++
    assert.equal((await store.get(actor, task.id)).status, 'running')
    assert.equal((await store.record(actor, task.id)).resolution.status, 'accepted')
    assert.equal(control.authorized, 1)
    assert.equal(JSON.stringify(options).includes('synthetic-one-time-key'), false)
    await options.trace({ node: 'llm', phase: 'started', origin: 'worker_reported' })
    const answer = await options.model(1, { messages: [{ role: 'user', content: '6 * 7' }] })
    if (control.runnerFails) throw new Error('controlled runner uncertainty')
    await options.trace({ node: 'llm', phase: 'completed', origin: 'worker_reported' })
    return { answer, modelCalls: 1 }
  } }
  const coordinator = new HostedTaskCoordinator(store, 'owner-a', registry as unknown as import('./registryClient.js').ProductRegistryClient,
    gateway as unknown as import('./executionModelGateway.js').ExecutionModelGateway, runner, () => true)
  t.after(() => coordinator.close())
  return { store, task, control, coordinator }
}
void test('hosted coordinator binds run IAM and durable trace, then requires worker, ledger and credential cleanup', async t => {
  const f = await coordinatorFixture(t)
  await f.coordinator.start(actor, f.task.id, async () => {})
  await f.coordinator.wait(f.task.id)
  const task = await f.store.get(actor, f.task.id)
  assert.equal(task.status, 'succeeded'); assert.equal(task.answer, '42'); assert.equal(task.cleanup, 'confirmed')
  assert.equal(f.control.runs, 1); assert.equal(f.control.grants, 1); assert.equal(f.control.revokes, 1); assert.equal(f.control.reconciled, 1)
  assert.equal((await f.store.events(actor, f.task.id, 1)).events.filter(e => e.type === 'trace').length, 2)
  await f.coordinator.start(actor, f.task.id, async () => {})
  assert.equal(f.control.runs, 1)
})
void test('hosted coordinator refuses low grade, changed source and withdrawn caller before container launch', async t => {
  for (const scenario of ['L1', 'changed-source', 'caller-revoked']) {
    const f = await coordinatorFixture(t)
    if (scenario === 'L1') f.control.level = 'L1'
    if (scenario === 'changed-source') f.control.source = `sha256:${'b'.repeat(64)}`
    let checks = 0
    await f.coordinator.start(actor, f.task.id, async () => { if (scenario === 'caller-revoked' && ++checks > 1) throw new Error('revoked') })
    await f.coordinator.wait(f.task.id)
    assert.equal(f.control.runs, 0); assert.equal(f.control.grants, 0)
    assert.equal((await f.store.get(actor, f.task.id)).status, 'failed')
  }
})
void test('hosted coordinator fences ambiguous issuance without retry and retains unknown when the fence response is lost', async t => {
  for (const visible of [true, false]) {
    const f = await coordinatorFixture(t); f.control.issueLost = true; f.control.lostVisible = visible
    await f.coordinator.start(actor, f.task.id, async () => {}); await f.coordinator.wait(f.task.id)
    assert.equal(f.control.grants, 1); assert.equal(f.control.runs, 0)
    assert.equal(f.control.revokes, 1)
    assert.equal((await f.store.get(actor, f.task.id)).status, visible ? 'failed' : 'unknown')
  }
})
void test('hosted coordinator keeps unconfirmed worker, metering or IAM cleanup unknown and revokes independently', async t => {
  for (const scenario of ['worker', 'metering', 'iam']) {
    const f = await coordinatorFixture(t)
    if (scenario === 'worker') { f.control.runnerFails = true; f.control.workerCleanup = false }
    if (scenario === 'metering') f.control.ledger = 'pending'
    if (scenario === 'iam') f.control.cleanupPending = true
    await f.coordinator.start(actor, f.task.id, async () => {}); await f.coordinator.wait(f.task.id)
    const result = await f.store.get(actor, f.task.id)
    assert.equal(result.status, 'unknown'); assert.equal(result.cleanup, 'unknown')
    assert.equal(f.control.revokes, 1); assert.equal(f.control.reconciled, 1)
    assert.equal(await f.store.claim(actor, f.task.id, 'owner-a'), null)
  }
})
void test('cancelling a running hosted coordinator aborts further callbacks without claiming the remote container stopped', async t => {
  const f = await coordinatorFixture(t)
  f.control.workerCleanup = false
  f.control.beforeModel = async () => { await f.coordinator.cancel(actor, f.task.id) }
  await f.coordinator.start(actor, f.task.id, async () => {}); await f.coordinator.wait(f.task.id)
  const result = await f.store.get(actor, f.task.id)
  assert.equal(result.status, 'unknown'); assert.equal(result.cleanup, 'unknown')
  assert.notEqual(result.cancel_requested_at, null)
  assert.equal(f.control.revokes, 1)
})

void test('confirmed worker cleanup allows cancellation without inventing a successful answer', async t => {
  const f = await coordinatorFixture(t)
  f.control.beforeModel = async () => { await f.coordinator.cancel(actor, f.task.id) }
  await f.coordinator.start(actor, f.task.id, async () => {}); await f.coordinator.wait(f.task.id)
  const result = await f.store.get(actor, f.task.id)
  assert.equal(result.status, 'cancelled'); assert.equal(result.cleanup, 'confirmed'); assert.equal(result.answer, '')
  assert.equal(f.control.revokes, 1)
})

void test('reconciliation preserves unknown output and closes only after all authorities confirm cleanup', async t => {
  const f = await coordinatorFixture(t)
  f.control.ledger = 'pending'
  await f.coordinator.start(actor, f.task.id, async () => {}); await f.coordinator.wait(f.task.id)
  assert.equal((await f.coordinator.reconcile(actor, f.task.id)).cleanup, 'unknown')
  await assert.rejects(f.store.closeUnknown(actor, f.task.id, 'Checked the controlled task outcome'), { code: 'HOSTED_CLEANUP_UNCONFIRMED' })
  f.control.ledger = 'router_verified'
  const result = await f.coordinator.reconcile(actor, f.task.id)
  assert.equal(result.status, 'unknown'); assert.equal(result.cleanup, 'confirmed'); assert.equal(result.answer, '42')
  await f.store.closeUnknown(actor, f.task.id, 'Checked the controlled task outcome')
  await f.store.closeUnknown(actor, f.task.id, 'Checked the controlled task outcome')
  assert.equal((await f.store.history(actor, f.task.session_id))[0].status, 'unknown')
  await assert.rejects(f.store.create(actor, request(f.task.session_id), admission()), { code: 'SESSION_BUSY_OR_AGENT_MISMATCH' })
  assert.equal(f.control.runs, 1); assert.equal(f.control.grants, 1)
})

void test('restart before visible IAM issuance can close only after a durable request fence, without creating a grant', async t => {
  const f = await coordinatorFixture(t)
  await f.store.claim(actor, f.task.id, 'owner-a')
  await f.store.db.run('UPDATE hosted_attempt_leases SET lease_until = 0 WHERE attempt_id = ?', [f.task.attempt_id])
  await f.store.recoverExpired()
  f.control.lostVisible = false
  assert.equal((await f.coordinator.reconcile(actor, f.task.id)).cleanup, 'unknown')
  f.control.lostVisible = true
  const recovered = await f.coordinator.reconcile(actor, f.task.id)
  assert.equal(recovered.status, 'unknown'); assert.equal(recovered.cleanup, 'confirmed')
  assert.equal(f.control.grants, 0); assert.equal(f.control.runs, 0)
  await f.store.closeUnknown(actor, f.task.id, 'Request fence confirmed; outcome remains unknown')
  assert.equal((await f.store.get(actor, f.task.id)).status, 'unknown')
})
