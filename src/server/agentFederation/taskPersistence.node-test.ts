import { seedExternalTaskMigration } from '../testing/externalTaskMigrationFixture.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SqliteDriver } from '../db/driver.js'
import { migrateExternalTaskPersistence } from './taskPersistence.js'
import { SESSION_SCHEMA } from '../storage/sessionSchema.js'
import { DirectConnectStore } from '../db.js'

async function legacy(t: { after: (fn: () => Promise<void>) => void }) {
  const db = new SqliteDriver(new DatabaseSync(':memory:'))
  t.after(() => db.close())
  return seedExternalTaskMigration(db)
}

void test('canonical migration preserves IDs, checkpoint/delta bytes, ownership and immutable request keys', async t => {
  const { db, document, event } = await legacy(t)
  await migrateExternalTaskPersistence(db)
  assert.deepEqual({ ...await db.get('SELECT session_id, runtime_type, current_attempt_id FROM sessions') }, { session_id: 'session-1', runtime_type: 'external', current_attempt_id: 'attempt-1' })
  assert.deepEqual({ ...await db.get('SELECT attempt_id, backend_type, runtime_state FROM session_attempts') }, { attempt_id: 'attempt-1', backend_type: 'external', runtime_state: 'running' })
  assert.deepEqual({ ...await db.get('SELECT id, document, request_hash, attempt_id FROM tasks') }, { id: 'task-1', document, request_hash: 'hash-1', attempt_id: 'attempt-1' })
  assert.equal((await db.get('SELECT payload_json FROM session_events'))?.payload_json, event)
  assert.equal((await db.get('SELECT document FROM task_events'))?.document, event)
  assert.equal((await db.get('SELECT conversation_id FROM external_sessions'))?.conversation_id, 'remote-session')
  await migrateExternalTaskPersistence(db)
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
  await assert.rejects(migrateExternalTaskPersistence(db), /identity collision/)
  assert.equal((await db.get('SELECT runtime_type FROM sessions WHERE session_id = ?', ['session-1']))?.runtime_type, 'host')
  assert.equal((await db.get('SELECT completed FROM federation_task_migrations'))?.completed, undefined)
  await db.run("UPDATE external_pilot_sessions SET title = 'Repair pending' WHERE id = 'session-1'")
  assert.equal((await db.get('SELECT title FROM external_pilot_sessions'))?.title, 'Repair pending')
})

void test('canonical external sessions cannot fall through into native recovery, listing or runner launch', async t => {
  const { db } = await legacy(t)
  await migrateExternalTaskPersistence(db)
  const canonical = new DirectConnectStore('driver-backed-test', db)
  const session = await canonical.getSession('session-1'); assert(session)
  assert.equal(session.runtime.type, 'external'); assert.equal(session.runtime.engine, 'external_provider')
  assert.deepEqual(await canonical.listSessionsToRecover(), [])
  assert.deepEqual(await canonical.listSessions({ orgId: 'org-1', userId: 'user-1' }), [])
  assert.deepEqual(await canonical.listAttemptsByRuntimeState(['starting', 'running', 'detached']), [])
})
