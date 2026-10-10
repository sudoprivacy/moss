import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { DirectConnectStore } from '../db.js'
import { ensureSqliteCompatibilityDomainSchemas } from '../db/compatibilitySchema.js'

void test('a new SQLite store retains FULL durability and facts after reopening', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-bootstrap-durable-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'store.db')
  const store = new DirectConnectStore(path)
  try {
    const db = store.requireSqliteDb()
    assert.equal(db.prepare('PRAGMA synchronous').get()?.synchronous, 2)
    assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1)
    assert.equal(db.isTransaction, false)
    await store.updateEnterprise('default', { app_name: 'Durable bootstrap' })
  } finally { await store.close() }
  const reopened = new DirectConnectStore(path)
  try { assert.equal((await reopened.getEnterprise('default')).app_name, 'Durable bootstrap') }
  finally { await reopened.close() }
})

void test('failed fresh bootstrap rolls back the schema and releases its database connection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-bootstrap-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'store.db')
  const execute = DatabaseSync.prototype.exec
  const failure = new Error('injected late schema failure')
  let bootstrapDb: DatabaseSync | undefined
  const mock = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql.includes('CREATE TABLE IF NOT EXISTS mcp_servers')) {
      bootstrapDb = this
      throw failure
    }
    return execute.call(this, sql)
  })
  assert.throws(() => new DirectConnectStore(path), error => error === failure)
  mock.mock.restore()
  const failedDb = bootstrapDb
  assert.ok(failedDb)
  assert.throws(() => failedDb.prepare('SELECT 1'))
  const db = new DatabaseSync(path)
  try {
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sessions'").get(), undefined)
    db.exec('CREATE TABLE retry_probe (id TEXT PRIMARY KEY)')
  } finally { db.close() }
})

void test('compatibility schemas join the caller transaction and disappear on its rollback', async () => {
  const store = new DirectConnectStore(':memory:')
  const db = store.requireSqliteDb()
  try {
    db.exec('BEGIN IMMEDIATE')
    ensureSqliteCompatibilityDomainSchemas(db)
    assert.equal(db.isTransaction, true)
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'organization_profiles'").get())
    db.exec('ROLLBACK')
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'organization_profiles'").get(), undefined)
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sessions'").get())
  } finally { await store.close() }
})
