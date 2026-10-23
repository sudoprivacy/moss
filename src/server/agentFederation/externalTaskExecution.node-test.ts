import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { SqliteDriver, PgDriver, type DbDriver } from '../db/driver.js'
import { ExternalTaskExecution } from './externalTaskExecution.js'
import type { ProductRegistryClient } from './registryClient.js'
import type { AssetRecord, ExecutionGrant, IssueExecutionGrant } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import type { AgentVersionManifest, TaskGrantProfile } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import type { ExternalTask } from '../../../contracts/external-provider/v1/contract.js'

const digest = 'sha256:' + 'a'.repeat(64)
const actor = { orgId: 'org-a', userId: 'user-a' }
const profile: TaskGrantProfile = { profile: 'sudo-task-grant/v1', model_resource: 'model:lab', tool_resources: ['mcp:server/add_numbers'], max_model_calls: 2 }
function deferred() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve }), release: () => release() } }
async function fixture(t: TestContext, driver?: DbDriver) {
  const db = driver ?? new SqliteDriver(new DatabaseSync(':memory:'))
  if (!driver) t.after(() => db.close())
  await db.exec('CREATE TABLE IF NOT EXISTS external_tasks(id TEXT PRIMARY KEY,status TEXT,deadline_at BIGINT)')
  const asset = { id: 'asset-a', metadata_digest: digest, metadata: { hosting: 'external_hosted', model_paths: ['model:lab'], tool_refs: ['mcp:server/add_numbers'] } } as AssetRecord
  const version = { version: 'v1', spec_digest: digest, principal: { trust_domain: 'agents.example', agent_name: 'a' }, registry: {}, snapshot: { source_digest: digest, sourceManifest: { execution_context: profile } } } as AgentVersionManifest
  const task = { id: randomUUID(), attempt_id: randomUUID(), session_id: randomUUID(), source_digest: digest, deadline_at: Date.now() + 120000 } as ExternalTask
  const state = { issued: 0, authorizations: 0, revokes: 0, cleanups: 0, fresh: 0, ownerDown: false, routerPending: false,
    beforeIssue: async () => {}, afterIssue: async () => {}, duringAuthorize: async () => {}, commands: [] as IssueExecutionGrant[], fences: new Set<string>() }
  let grant!: ExecutionGrant
  const registry: Pick<ProductRegistryClient, 'admittedAsset' | 'executionIssue' | 'executionAuthorize' | 'executionRevokeRequest'> = {
    admittedAsset: async () => asset,
    executionIssue: async (_org, request) => {
      state.issued++; state.commands.push(request); await state.beforeIssue()
      if (state.fences.has(request.request_id)) throw new Error('EXECUTION_REQUEST_REVOKED')
      grant = { id: 'grant-' + randomUUID(), request, status: 'active', expires_at: Date.now() + 60000 } as ExecutionGrant
      await state.afterIssue()
      return { grant, api_key: 'sk-synthetic-ephemeral-only', kind: 'ExecutionGrantResult', api_version: 'agent-registry.sudo.dev/v1alpha1' }
    },
    executionAuthorize: async () => { state.authorizations++; await state.duringAuthorize(); return { grant, authorized_at: Date.now(), cacheable: false, kind: 'ExecutionAuthorization', api_version: 'agent-registry.sudo.dev/v1alpha1' } },
    executionRevokeRequest: async (_org, requestId, taskId) => {
      state.revokes++
      if (state.ownerDown) throw new Error('owner outage')
      state.fences.add(requestId)
      return { request_id: requestId, task_id: taskId, cleanup_pending: false } as Awaited<ReturnType<ProductRegistryClient['executionRevokeRequest']>>
    },
  }
  const gateway = { stopTaskCalls: async () => { state.cleanups++; return { calls: 1, pending: Number(state.routerPending) } } }
  const manager = new ExternalTaskExecution(db, registry, gateway, 'http://127.0.0.1:43138')
  await manager.ready
  const prepare = () => manager.prepare(actor, task, version, profile, new AbortController().signal, async () => { state.fresh++ })
  return { db, asset, version, task, state, registry, gateway, manager, prepare }
}
void test('one reviewed task receives a scoped run grant; only non-secret lifecycle is durable and repeat prepare is refused', async t => {
  const f = await fixture(t), context = await f.prepare()
  assert.equal(context.task_id, f.task.id); assert.equal(context.access_token, 'sk-synthetic-ephemeral-only')
  assert.equal(f.state.commands[0].mode, 'run'); assert.equal(f.state.commands[0].version, 'v1')
  assert.deepEqual(f.state.commands[0].permissions, [{ operation: 'model.invoke', resource: 'model:lab' }, { operation: 'tool.invoke', resource: 'mcp:server/add_numbers' }])
  assert.equal(f.state.commands[0].initiated_by, actor.userId)
  assert(!JSON.stringify(await f.db.all('SELECT * FROM external_task_execution')).includes(context.access_token))
  await assert.rejects(f.prepare(), /TASK_CONTEXT_ALREADY_ISSUED/); assert.equal(f.state.issued, 1)
  assert.equal(await f.manager.finish('org-b', f.task.id), true); assert.equal(f.state.revokes, 0)
  assert.equal(await f.manager.finish(actor.orgId, f.task.id), true)
  const calls = f.state.revokes
  assert.equal(await f.manager.finish(actor.orgId, f.task.id), true); assert.equal(f.state.revokes, calls)
})
void test('unreviewed resources, unpublished profile and expired task cannot issue a grant', async t => {
  const f = await fixture(t)
  f.asset.metadata.tool_refs = []
  await assert.rejects(f.prepare(), /TASK_CONTEXT_ASSET_SCOPE_MISMATCH/)
  f.asset.metadata.tool_refs = ['mcp:server/add_numbers']; f.version.snapshot.sourceManifest!.execution_context = undefined
  await assert.rejects(f.prepare(), /TASK_CONTEXT_RELEASE_REQUIRED/)
  f.version.snapshot.sourceManifest!.execution_context = profile; f.task.deadline_at = 0
  await assert.rejects(f.prepare(), /TASK_CONTEXT_RELEASE_REQUIRED/)
  assert.equal(f.state.issued, 0)
})
void test('task cleanup fences a late owner issuance before it is reserved', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  f.state.beforeIssue = async () => { entered.release(); await release.promise }
  const pending = assert.rejects(f.prepare(), /EXECUTION_REQUEST_REVOKED/)
  await entered.promise
  assert.equal(await f.manager.finish(actor.orgId, f.task.id), true)
  release.release(); await pending
  assert.equal(f.state.authorizations, 0)
  assert.equal((await f.db.get('SELECT state FROM external_task_execution'))?.state, 'closed')
})
void test('already issued delayed response cannot reactivate a closed controller', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  f.state.afterIssue = async () => { entered.release(); await release.promise }
  const pending = assert.rejects(f.prepare(), /TASK_CONTEXT_CLOSED/)
  await entered.promise; await f.manager.finish(actor.orgId, f.task.id); release.release(); await pending
  assert.equal(f.state.authorizations, 0)
})
void test('stop followed by restore changes the generation; stale issuing task stays rejected', async t => {
  const f = await fixture(t)
  f.state.afterIssue = async () => { await f.db.run('UPDATE agent_asset_gates SET generation=generation+1') }
  await assert.rejects(f.prepare(), /TASK_CONTEXT_GENERATION_CHANGED/)
  assert.equal(await f.manager.finish(actor.orgId, f.task.id), true)
})
void test('finish wins over an in-flight final authorization and cleanup independently retries Router and owner', async t => {
  const f = await fixture(t)
  f.state.duringAuthorize = async () => { await f.manager.finish(actor.orgId, f.task.id) }
  await assert.rejects(f.prepare(), /TASK_CONTEXT_CLOSED/)
  const g = await fixture(t); await g.prepare(); g.state.ownerDown = true; g.state.routerPending = true
  assert.equal(await g.manager.finish(actor.orgId, g.task.id), false)
  assert.equal(g.state.cleanups, 1)
  g.state.ownerDown = false; g.state.routerPending = false
  const restarted = new ExternalTaskExecution(g.db, g.registry, g.gateway, 'http://127.0.0.1:43138')
  await restarted.maintain()
  assert.equal((await g.db.get('SELECT state FROM external_task_execution'))?.state, 'closed')
  assert.equal(g.state.issued, 1)
})
void test('maintenance rotates past permanently failed tasks and continues independent cleanup', async t => {
  const f = await fixture(t); await f.prepare(); f.state.ownerDown = true
  const row = (await f.db.get('SELECT document FROM external_task_execution'))!, template = JSON.parse(String(row.document))
  await f.db.run('DELETE FROM external_task_execution')
  for (let n = 0; n < 40; n++) {
    const id = 'task-' + String(n).padStart(3, '0'), record = { ...template, taskId: id, attemptId: id, requestId: id }
    await f.db.run('INSERT INTO external_task_execution(task_id,org_id,attempt_id,state,document) VALUES (?,?,?,?,?)', [id, actor.orgId, id, 'cleanup_pending', JSON.stringify(record)])
  }
  await f.manager.maintain(); await f.manager.maintain()
  assert.equal((await f.db.get('SELECT count(*) AS count FROM external_task_execution WHERE last_cleanup_at > 0'))?.count, 40)
  assert.equal(f.state.issued, 1)
})
void test('PostgreSQL independent controllers cannot activate a task after closure', { skip: !process.env.MOSS_PG_TEST_URL }, async t => {
  const pg = await import('pg'), schema = 'external_context_' + randomUUID().replaceAll('-', '')
  const admin = new pg.default.Pool({ connectionString: process.env.MOSS_PG_TEST_URL })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const dbs = [0, 1].map(() => new PgDriver(new pg.default.Pool({ connectionString: process.env.MOSS_PG_TEST_URL, options: `-c search_path=${schema}` }) as never))
  try {
    const f = await fixture(t, dbs[0]), other = new ExternalTaskExecution(dbs[1], f.registry, f.gateway, 'http://127.0.0.1:43138')
    const entered = deferred(), release = deferred()
    f.state.afterIssue = async () => { entered.release(); await release.promise }
    const pending = assert.rejects(f.prepare(), /TASK_CONTEXT_CLOSED/)
    await entered.promise; await other.finish(actor.orgId, f.task.id); release.release(); await pending
    assert.equal((await dbs[0].get('SELECT state FROM external_task_execution'))?.state, 'closed')
  } finally {
    await Promise.all(dbs.map(db => db.close())); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})
