import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { AuthCenterDb } from '../authCenter/db.js'
import {
  AsyncTransactionCallbackError,
  runInTransaction,
} from './sqliteUnitOfWork.js'

describe('SQLite UnitOfWork', () => {
  test('commits outer work and isolates a handled nested failure with SAVEPOINT', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE values_log (value TEXT NOT NULL)')

    runInTransaction(db, () => {
      db.prepare('INSERT INTO values_log VALUES (?)').run('before')
      assert.throws(() => runInTransaction(db, () => {
        db.prepare('INSERT INTO values_log VALUES (?)').run('discarded')
        throw new Error('nested')
      }), /nested/)
      db.prepare('INSERT INTO values_log VALUES (?)').run('after')
    })

    const rows = db.prepare('SELECT value FROM values_log ORDER BY rowid').all() as Array<{ value: string }>
    assert.deepEqual(rows.map((row) => row.value), ['before', 'after'])
    assert.equal(db.isTransaction, false)
    db.close()
  })

  test('rejects asynchronous callbacks and restores connection state', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE values_log (value TEXT NOT NULL)')
    assert.throws(() => runInTransaction(db, async () => {
      db.prepare('INSERT INTO values_log VALUES (?)').run('discarded')
      await Promise.resolve()
    }), AsyncTransactionCallbackError)
    assert.deepEqual(db.prepare('SELECT * FROM values_log').all(), [])
    assert.equal(db.isTransaction, false)
    db.close()
  })

  test('allows AuthCenter bootstrap inside a caller-owned transaction', () => {
    const db = new DatabaseSync(':memory:')
    const authDb = new AuthCenterDb(db)

    runInTransaction(db, () => {
      const result = authDb.bootstrap({ username: 'root', password: 'StrongPass123' })
      assert.equal(result.created, true)
      assert.equal(db.isTransaction, true)
    })

    assert.equal(authDb.listOrganizations().length, 1)
    assert.equal(authDb.listUsersByRole('super_admin').length, 1)
    assert.equal(db.isTransaction, false)
    db.close()
  })

  test('allows AuthCenter JSON migration inside a caller-owned transaction', () => {
    const db = new DatabaseSync(':memory:')
    const authDb = new AuthCenterDb(db)
    runInTransaction(db, () => authDb.migrateFromJson({
      version: 3,
      issuer: 'legacy-moss',
      jwtSecret: 'secret',
      organizations: [{ id: 'org-1', name: 'Org', extOrgId: null, createdAt: 1 }],
      users: [{
        id: 'user-1',
        orgId: 'org-1',
        email: 'user@example.test',
        name: 'user',
        displayName: null,
        departmentId: null,
        role: 'user',
        status: 'active',
        localAuth: true,
        tokenLimit: null,
        createdAt: 1,
        passwordHash: null,
        passwordUpdatedAt: null,
        lastLoginAt: null,
        extUserId: null,
      }],
      apiKeys: [],
    }))
    assert.equal(authDb.getIssuer(), 'legacy-moss')
    assert.equal(db.isTransaction, false)
    db.close()
  })

  test('在另一个 DatabaseSync 连接短暂持有写锁时只重试 BEGIN 并最终提交', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'moss-uow-busy-'))
    const dbPath = join(directory, 'shared.db')
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE values_log (value TEXT NOT NULL)')
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads')
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(workerData.dbPath)
      db.exec('BEGIN IMMEDIATE')
      parentPort.postMessage('locked')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
      db.exec("INSERT INTO values_log VALUES ('worker')")
      db.exec('COMMIT')
      db.close()
    `, { eval: true, workerData: { dbPath } })

    try {
      await once(worker, 'message')
      runInTransaction(db, () => {
        db.prepare("INSERT INTO values_log VALUES ('main')").run()
      })
      await once(worker, 'exit')
      const rows = db.prepare('SELECT value FROM values_log ORDER BY rowid').all() as Array<{ value: string }>
      assert.deepEqual(rows.map(row => row.value), ['worker', 'main'])
      assert.equal(db.isTransaction, false)
    } finally {
      await worker.terminate()
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
