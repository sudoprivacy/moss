import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { PgDriver, type PgPoolLike } from '../db/driver.js'
import { seedExternalTaskMigration } from '../testing/externalTaskMigrationFixture.js'
import { migrateExternalTaskPersistence, initializeExternalTaskPersistence } from './taskPersistence.js'

void test('PostgreSQL migration preserves historical order and event bytes, seals legacy writers and permits concurrent restart', { skip: !process.env.MOSS_PG_TEST_URL }, async () => {
  const connectionString = process.env.MOSS_PG_TEST_URL!, schema = `migration_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`)
  const drivers = [0, 1].map(() => new PgDriver(new pg.Pool({ connectionString, options: `-c search_path=${schema}` }) as unknown as PgPoolLike))
  try {
    const { db, document, event } = await seedExternalTaskMigration(drivers[0])
    const second = JSON.stringify({ ...JSON.parse(document), id: 'aaa-second-task', attempt_id: 'attempt-2', session_sequence: 2, created_at: 250, updated_at: 300 })
    await db.run("INSERT INTO external_pilot_tasks VALUES ('aaa-second-task', 'org-1', 'user-1', 'session-1', 'request-2', 'hash-2', 'succeeded', 9999999999999, 1, ?)", [second])
    await db.run("INSERT INTO external_pilot_attempts VALUES ('attempt-2', 'aaa-second-task', 250, 300)")
    await assert.rejects(initializeExternalTaskPersistence(drivers[1]), /EXTERNAL_TASK_MIGRATION_REQUIRED/)
    await drivers[1].run("UPDATE external_pilot_sessions SET title = 'Old writer still running' WHERE id = 'session-1'")
    assert.equal(Number((await db.get('SELECT COUNT(*) AS count FROM external_pilot_tasks'))?.count), 2)
    assert.equal((await db.get("SELECT to_regclass(current_schema() || '.tasks') AS relation"))?.relation, null)
    await migrateExternalTaskPersistence(db, { oldWritersStopped: true, backupSha256: '0'.repeat(64) })
    assert.deepEqual((await db.all('SELECT attempt_id FROM session_attempts ORDER BY generation')).map(r => r.attempt_id), ['attempt-1', 'attempt-2'])
    assert.equal((await db.get("SELECT payload_json FROM session_events WHERE task_id = 'task-1'"))?.payload_json, event)
    assert.equal((await db.get("SELECT document FROM tasks WHERE id = 'task-1'"))?.document, document)
    for (const table of ['external_pilot_tasks', 'external_pilot_sessions', 'external_pilot_events', 'external_pilot_attempts']) {
      assert.equal(Number((await db.get(`SELECT COUNT(*) AS count FROM ${table}`))?.count), 0)
      await assert.rejects(db.run(`INSERT INTO ${table} DEFAULT VALUES`), /legacy writes are disabled/)
    }
    await Promise.all(drivers.map(initializeExternalTaskPersistence))
    assert.equal(Number((await db.get('SELECT COUNT(*) AS count FROM tasks'))?.count), 2)
  } finally {
    await Promise.all(drivers.map(d => d.close())); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})
