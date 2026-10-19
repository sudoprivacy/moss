import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SqliteDriver, PgDriver, type DbDriver, type PgPoolLike } from '../db/driver.js'
import { ExternalTaskStore, type Binding } from '../externalProviders/store.js'
import { ProductRegistryClient } from './registryClient.js'
import { RegistryReleases } from './registryReleases.js'
import { RegistryMigration } from './registryMigration.js'
import { registryHttpFixture } from '../testing/registryHttpFixture.js'
import { admitExternalTask } from './taskIngress.js'
import { DIFY_CAPABILITIES } from './manifest.js'

const actor = { orgId: 'org-1', userId: 'reviewer' }
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  let db: DbDriver
  if (process.env.MOSS_REGISTRY_TEST_DATABASE_URL) {
    const { Pool } = await import('pg')
    const schema = `registry_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: process.env.MOSS_REGISTRY_TEST_DATABASE_URL })
    await admin.query(`CREATE SCHEMA ${schema}`)
    const pool = new Pool({ connectionString: process.env.MOSS_REGISTRY_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 4 })
    db = new PgDriver(pool as unknown as PgPoolLike)
    t.after(async () => { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() })
  } else db = new SqliteDriver(new DatabaseSync(':memory:'))
  const store = new ExternalTaskStore(db)
  await store.ready
  const remote = registryHttpFixture()
  const client = new ProductRegistryClient({ endpoint: 'http://127.0.0.1:12345', token: 'test-key', publicKeys: [remote.publicPem], organizations: { 'org-1': { trustDomain: 'agents.example', zoneId: 'zone-1' } }, request: remote.request })
  const releases = new RegistryReleases(store, client)
  const backup = await mkdtemp(join(tmpdir(), 'moss-registry-'))
  t.after(async () => { await db.close(); await rm(backup, { recursive: true, force: true }) })
  const binding: Binding = { id: 'catalog-1', orgId: actor.orgId, connectionId: 'connection-1', name: 'Fixture',
    provider_kind: 'dify', endpoint: 'http://127.0.0.1:8089/v1', app_id: 'app-1', workspace_id: 'workspace-1',
    source_digest: `sha256:${'1'.repeat(64)}`, decoder: 'text', credential_ref: 'nexus://org:org-1:external:catalog-1/app-key',
    allowed_user_ids: ['reviewer'], credentialVersion: 1, parametersDigest: `sha256:${'2'.repeat(64)}`, definitionProfileVersion: 1,
    revision: 1, approved: true, reviewedBy: actor.userId, review_note: 'Synthetic fixture', review_expires_at: Date.now() + 86400_000 }
  await store.saveBinding(binding)
  let depth = 0
  const transaction = db.transaction.bind(db)
  db.transaction = async fn => transaction(async () => { depth++; try { return await fn() } finally { depth-- } })
  remote.state.beforeRequest = method => { if (method === 'POST') assert.equal(depth, 0, 'remote mutation must not occur inside a Moss transaction') }
  return { db, store, releases, remote, binding, backup, migration: new RegistryMigration(releases, { maintenance: true, backupDirectory: backup }) }
}
void test('new enrollment persists actual snapshot bytes, uses Registry decisions and restores a lost local cache', async t => {
  const f = await fixture(t)
  await f.migration.enrollNew(actor, f.binding.id)
  const version = await f.releases.publish(actor, f.binding, 'v1', 'Approve version')
  assert.equal(version.registry?.authority, 'nexus_registry')
  assert.equal(f.remote.files.size, 1)
  await f.releases.moveChannel(actor, f.binding.id, 'stable', 'v1', 0)
  assert.equal((await f.releases.resolve(actor, f.binding.id)).manifest.version, 'v1')
  await f.db.run('DELETE FROM agent_registry_snapshots')
  assert.equal((await f.releases.resolve(actor, f.binding.id)).manifest.spec_digest, version.spec_digest)
  await f.releases.revoke(actor, f.binding.id, 'v1', 'Withdraw compromised version')
  await assert.rejects(f.releases.resolve(actor, f.binding.id), { code: 'AGENT_CHANNEL_UNAVAILABLE' })
  await assert.rejects(f.store.releases.publish(actor, f.binding, 'v2', 'Old publisher'), { code: 'REGISTRY_AUTHORITY_REQUIRED' })
  await assert.rejects(new RegistryReleases(f.store).options(actor, f.binding.id), { code: 'REGISTRY_AUTHORITY_CONFIGURATION_REQUIRED' })
})
void test('legacy migration resumes after network failure and preserves IDs while fencing both old writers and old admissions', async t => {
  const f = await fixture(t)
  const old = await f.store.releases.publish(actor, f.binding, 'legacy-v1', 'Initial release')
  await f.store.releases.moveChannel(actor, f.binding.id, 'stable', old.version, 0)
  await f.store.releases.publish(actor, f.binding, 'legacy-revoked', 'Old release')
  await f.store.releases.revoke(actor, f.binding.id, 'legacy-revoked', 'Retired version')
  const plan = await f.migration.plan(actor, f.binding.id)
  assert.equal(plan.active_tasks, 0)
  f.remote.state.failNextKind = 'MoveChannel'
  await assert.rejects(f.migration.apply(actor, f.binding.id, { plan_digest: plan.plan_digest, old_writers_stopped: true }), { code: 'REGISTRY_UNAVAILABLE' })
  assert.equal((await f.migration.status(actor, f.binding.id)).state, 'preparing')
  await assert.rejects(f.releases.options(actor, f.binding.id), { code: 'REGISTRY_MIGRATION_IN_PROGRESS' })
  await assert.rejects(f.db.run("UPDATE agent_channels SET version = 'legacy-revoked'"), /REGISTRY_AUTHORITY_REQUIRED/)
  await f.migration.apply(actor, f.binding.id, { plan_digest: plan.plan_digest, old_writers_stopped: true })
  assert.equal((await f.releases.resolve(actor, f.binding.id)).manifest.version, 'legacy-v1')
  const page = await f.releases.list(actor, f.binding.id)
  assert.equal(page.items.find(item => item.version === 'legacy-revoked')?.decisions[0].decision, 'revoked')
  assert.equal((await readdir(f.backup)).length, 1)
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS total FROM agent_versions'))?.total), 2)
  await assert.rejects(f.db.transaction(async () => {
    await f.db.run("INSERT INTO tasks(id,org_id,user_id,session_id,idempotency_key,request_hash,status,deadline_at,sequence,document) VALUES ('legacy-task','org-1','reviewer','unused','legacy-key','hash','accepted',9999999999999,1,?)", [JSON.stringify({ agent_id: f.binding.id })])
    await f.db.run("INSERT INTO product_task_records(task_id,org_id,user_id,document,policy_snapshot) VALUES ('legacy-task','org-1','reviewer',?,'{}')", [JSON.stringify({ resolution: { status: 'accepted', agent: {} } })])
  }), /REGISTRY_AUTHORITY_REQUIRED/)
  const task = await admitExternalTask(f.store, actor, { api_version: 'task.sudo.dev/v1alpha1', kind: 'SubmitTask', agent: { catalog_id: f.binding.id }, request_source: 'interactive',
    input: { instruction: 'Synthetic example', resource_refs: [] }, workspace_refs: [], requested_mode: 'cloud', data_classification: 'synthetic', required_capabilities: [], constraints: { idempotency_key: 'registry-new-task-key' } }, {
    lockPolicy: async () => {}, policy: async () => ({ enabled: true, endpoints: [f.binding.endpoint], revision: 1 }), executable: async () => {},
    capabilities: () => DIFY_CAPABILITIES, resolveRelease: (binding, version, channel) => f.releases.resolve(actor, binding.id, version, channel), timeoutMs: 30000,
  })
  assert.equal(task.status, 'accepted')
  const record = await f.store.taskRecord(actor, task.id)
  assert(record?.resolution.status === 'accepted')
  assert.equal(record.resolution.agent.registry?.authority, 'nexus_registry')
  assert.equal(record.resolution.agent.principal.trust_domain, 'agents.example')
  const altered = structuredClone(record)
  if (altered.resolution.status === 'accepted') delete altered.resolution.agent.registry
  await f.db.run('UPDATE product_task_records SET document = ? WHERE task_id = ?', [JSON.stringify(altered), task.id])
  await assert.rejects(f.store.taskRecord(actor, task.id), { code: 'TASK_RECORD_MISMATCH' })
})
void test('migration checks maintenance, exact plan and active task boundaries before writing', async t => {
  const f = await fixture(t)
  await f.store.releases.publish(actor, f.binding, 'v1', 'Initial')
  const plan = await f.migration.plan(actor, f.binding.id)
  await assert.rejects(new RegistryMigration(f.releases, { maintenance: false }).apply(actor, f.binding.id, { plan_digest: plan.plan_digest, old_writers_stopped: true }), { code: 'REGISTRY_MAINTENANCE_REQUIRED' })
  await assert.rejects(f.migration.apply(actor, f.binding.id, { plan_digest: 'changed', old_writers_stopped: true }), { code: 'REGISTRY_MIGRATION_PLAN_CHANGED' })
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS total FROM agent_registry_links'))?.total), 0)
  assert.equal(f.remote.files.size, 0)
})
void test('Registry read paths never publish and reject corrupted snapshot bytes or registration signatures', async t => {
  const f = await fixture(t)
  await f.migration.enrollNew(actor, f.binding.id)
  await f.releases.publish(actor, f.binding, 'v1', 'Approve')
  await f.releases.moveChannel(actor, f.binding.id, 'stable', 'v1', 0)
  f.remote.state.beforeRequest = method => assert.equal(method, 'GET')
  await f.releases.list(actor, f.binding.id)
  await f.releases.options(actor, f.binding.id)
  await f.releases.resolve(actor, f.binding.id)
  await f.db.run('DELETE FROM agent_registry_snapshots')
  const path = [...f.remote.files.keys()][0]
  const bytes = f.remote.files.get(path)!
  f.remote.files.set(path, Buffer.from('{}').toString('base64'))
  await assert.rejects(f.releases.resolve(actor, f.binding.id), { code: 'REGISTRY_RESOURCE_DIGEST_MISMATCH' })
  f.remote.files.set(path, bytes)
  await f.releases.resolve(actor, f.binding.id)
  const version = f.remote.versions.get('v1')!
  version.signature_base64 = Buffer.alloc(64).toString('base64')
  await assert.rejects(f.releases.resolve(actor, f.binding.id), { code: 'REGISTRY_SIGNATURE_INVALID' })
})
void test('migration rejects live or unreconciled tasks, changed source and corrupted backup without activating', async t => {
  const f = await fixture(t)
  await f.store.releases.publish(actor, f.binding, 'v1', 'Initial')
  const original = await f.migration.plan(actor, f.binding.id)
  await f.store.saveBinding({ ...f.binding, revision: 2 })
  await assert.rejects(f.migration.apply(actor, f.binding.id, { plan_digest: original.plan_digest, old_writers_stopped: true }), { code: 'REGISTRY_MIGRATION_PLAN_CHANGED' })
  await f.db.run("INSERT INTO sessions(session_id,transcript_session_id,org_id,user_id,role,scopes_json,cwd,runtime_type,status,desired_state,transcript_path,created_at,last_active_at) VALUES ('session-1','session-1','org-1','reviewer','user','[]','','external_provider','running','running','',1,1)")
  await f.db.run("INSERT INTO tasks(id,org_id,user_id,session_id,idempotency_key,request_hash,status,deadline_at,sequence,document) VALUES ('active-task','org-1','reviewer','session-1','active-key','hash','running',9999999999999,1,?)", [JSON.stringify({ agent_id: f.binding.id })])
  const plan = await f.migration.plan(actor, f.binding.id)
  assert.equal(plan.active_tasks, 1)
  await assert.rejects(f.migration.apply(actor, f.binding.id, { plan_digest: plan.plan_digest, old_writers_stopped: true }), { code: 'REGISTRY_ACTIVE_TASKS' })
  await f.db.run("UPDATE tasks SET status = 'unknown'")
  assert.equal((await f.migration.plan(actor, f.binding.id)).active_tasks, 1)
  await f.db.run("INSERT INTO external_pilot_reconciliations(task_id,document) VALUES ('active-task','{}')")
  assert.equal((await f.migration.plan(actor, f.binding.id)).active_tasks, 0)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(f.backup, `${f.binding.id}-${plan.plan_digest.slice(7)}.json`), '{}')
  await assert.rejects(f.migration.apply(actor, f.binding.id, { plan_digest: plan.plan_digest, old_writers_stopped: true }), { code: 'REGISTRY_BACKUP_MISMATCH' })
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS total FROM agent_registry_links'))?.total), 0)
})
void test('an incomplete new enrollment cannot silently publish through the legacy authority', async t => {
  const f = await fixture(t)
  await f.store.saveBinding({ ...f.binding, registryRequired: true })
  assert.equal((await f.migration.status(actor, f.binding.id)).state, 'preparing')
  await assert.rejects(f.releases.options(actor, f.binding.id), { code: 'REGISTRY_ENROLLMENT_REQUIRED' })
  await assert.rejects(new RegistryReleases(f.store).publish(actor, { ...f.binding, registryRequired: true }, 'v1', 'Approve'), { code: 'REGISTRY_ENROLLMENT_REQUIRED' })
  await f.migration.enrollNew(actor, f.binding.id)
  await f.releases.publish(actor, f.binding, 'v1', 'Approve')
  assert.equal((await f.migration.status(actor, f.binding.id)).state, 'active')
})
