import { verifyTaskRuntimeIsolation } from '../testing/taskRuntimeIsolationFixture.js'
import { seedExternalTaskMigration } from '../testing/externalTaskMigrationFixture.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SqliteDriver } from '../db/driver.js'
import { migrateExternalTaskPersistence, initializeExternalTaskPersistence } from './taskPersistence.js'
import { SESSION_SCHEMA } from '../storage/sessionSchema.js'
import { DirectConnectStore } from '../db.js'
import { ExternalTaskStore } from '../externalProviders/store.js'

async function legacy(t: { after: (fn: () => Promise<void>) => void }) {
  const db = new SqliteDriver(new DatabaseSync(':memory:'))
  t.after(() => db.close())
  return seedExternalTaskMigration(db)
}

void test('canonical migration preserves IDs, checkpoint/delta bytes, ownership and immutable request keys', async t => {
  const { db, document, event } = await legacy(t)
  await migrateExternalTaskPersistence(db, { oldWritersStopped: true, backupSha256: '0'.repeat(64) })
  assert.deepEqual({ ...await db.get('SELECT session_id, runtime_type, current_attempt_id FROM sessions') }, { session_id: 'session-1', runtime_type: 'external', current_attempt_id: 'attempt-1' })
  assert.deepEqual({ ...await db.get('SELECT attempt_id, backend_type, runtime_state FROM session_attempts') }, { attempt_id: 'attempt-1', backend_type: 'external', runtime_state: 'running' })
  assert.deepEqual({ ...await db.get('SELECT id, document, request_hash, attempt_id FROM tasks') }, { id: 'task-1', document, request_hash: 'hash-1', attempt_id: 'attempt-1' })
  assert.equal((await db.get('SELECT payload_json FROM session_events'))?.payload_json, event)
  assert.equal((await db.get('SELECT document FROM task_events'))?.document, event)
  assert.equal((await db.get('SELECT conversation_id FROM external_sessions'))?.conversation_id, 'remote-session')
  await migrateExternalTaskPersistence(db, { oldWritersStopped: true, backupSha256: '0'.repeat(64) })
  assert.equal((await db.get('SELECT COUNT(*) AS count FROM tasks'))?.count, 1)
  for (const table of ['external_pilot_tasks', 'external_pilot_sessions', 'external_pilot_attempts', 'external_pilot_events']) {
    assert.equal((await db.get(`SELECT COUNT(*) AS count FROM ${table}`))?.count, 0)
    await assert.rejects(db.run(`INSERT INTO ${table} DEFAULT VALUES`), /legacy writes are disabled/)
  }
})

void test('migration collision rolls back all adopted facts and leaves legacy writers available for repair', async t => {
  const { db } = await legacy(t)
  await db.exec(SESSION_SCHEMA)
  await db.run(`INSERT INTO sessions(session_id, transcript_session_id, org_id, user_id, role, scopes_json, cwd, runtime_type, status, desired_state, transcript_path, created_at, last_active_at)
    VALUES ('session-1', 'native-transcript', 'native-org', 'native-user', 'user', '[]', '/native', 'host', 'active', 'active', '/native/transcript', 1, 1)`)
  await assert.rejects(migrateExternalTaskPersistence(db, { oldWritersStopped: true, backupSha256: '0'.repeat(64) }), /identity collision/)
  assert.equal((await db.get('SELECT runtime_type FROM sessions WHERE session_id = ?', ['session-1']))?.runtime_type, 'host')
  assert.equal(await db.get("SELECT name FROM sqlite_master WHERE name = 'federation_task_migrations'"), undefined)
  await db.run("UPDATE external_pilot_sessions SET title = 'Repair pending' WHERE id = 'session-1'")
  assert.equal((await db.get('SELECT title FROM external_pilot_sessions'))?.title, 'Repair pending')
})

void test('canonical external sessions cannot fall through into native recovery, listing or runner launch', async t => {
  const { db } = await legacy(t)
  await migrateExternalTaskPersistence(db, { oldWritersStopped: true, backupSha256: '0'.repeat(64) })
  const canonical = new DirectConnectStore('driver-backed-test', db)
  const session = await canonical.getSession('session-1'); assert(session)
  assert.equal(session.runtime.type, 'external'); assert.equal(session.runtime.engine, 'external_provider')
  assert.deepEqual(await canonical.listSessionsToRecover(), [])
  assert.deepEqual(await canonical.listSessions({ orgId: 'org-1', userId: 'user-1' }), [])
  assert.deepEqual(await canonical.listAttemptsByRuntimeState(['starting', 'running', 'detached']), [])
})

void test('startup refuses legacy databases without copying, deleting or fencing old writers, even when empty', async t => {
  for (const empty of [false, true]) {
    const { db } = await legacy(t)
    if (empty) for (const table of ['external_pilot_events', 'external_pilot_attempts', 'external_pilot_tasks', 'external_pilot_sessions']) await db.run(`DELETE FROM ${table}`)
    const before = await db.all('SELECT * FROM external_pilot_tasks')
    const store = new ExternalTaskStore(db)
    await assert.rejects(store.ready, /EXTERNAL_TASK_MIGRATION_REQUIRED/)
    await store.releases.ready
    assert.deepEqual(await db.all('SELECT * FROM external_pilot_tasks'), before)
    assert.equal(await db.get("SELECT name FROM sqlite_master WHERE name = 'tasks'"), undefined)
    assert.deepEqual(await db.all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sealed_%'"), [])
    await db.run("UPDATE external_pilot_tasks SET request_hash = 'old-writer-still-works'")
    if (!empty) assert.equal((await db.get('SELECT request_hash FROM external_pilot_tasks'))?.request_hash, 'old-writer-still-works')
  }
})

void test('new databases initialize without legacy write fences and restart idempotently', async t => {
  const db = new SqliteDriver(new DatabaseSync(':memory:')); t.after(() => db.close())
  await new ExternalTaskStore(db).ready
  assert.equal((await db.get("SELECT completed FROM federation_task_migrations WHERE id = 'canonical-v1'"))?.completed, 1)
  assert.deepEqual(await db.all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sealed_%'"), [])
  await new ExternalTaskStore(db).ready
})

void test('migration requires explicit stopped-writer and backup evidence before any schema change', async t => {
  const { db } = await legacy(t)
  for (const authorization of [undefined, {}, { oldWritersStopped: false, backupSha256: '0'.repeat(64) }, { oldWritersStopped: true, backupSha256: '' }]) {
    await assert.rejects(migrateExternalTaskPersistence(db, authorization as never), /Maintenance window confirmation/)
    assert.equal(await db.get("SELECT name FROM sqlite_master WHERE name = 'federation_task_migrations'"), undefined)
  }
})

void test('explicit migration preserves legacy reconciliation before deleting old checkpoints', async t => {
  const { db, document } = await legacy(t)
  const reconciliation = { action: 'closed', note: 'Verified remote result in maintenance window', reconciled_by: 'admin', reconciled_at: 200 }
  await db.run('UPDATE external_pilot_tasks SET document = ?', [JSON.stringify({ ...JSON.parse(document), reconciliation })])
  await migrateExternalTaskPersistence(db, { oldWritersStopped: true, backupSha256: '0'.repeat(64) })
  assert.deepEqual(JSON.parse(String((await db.get('SELECT document FROM external_pilot_reconciliations'))?.document)), reconciliation)
  await initializeExternalTaskPersistence(db)
})

void test('external and native maintenance cannot read, dispatch, mutate or retire hosted tasks', async t => {
  const db = new SqliteDriver(new DatabaseSync(':memory:')); t.after(() => db.close())
  await verifyTaskRuntimeIsolation(db)
})
