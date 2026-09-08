import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, test } from 'node:test'
import {
  AsyncTransactionCallbackError,
  runInTransaction,
  runWithBusyRetry,
} from './unitOfWork.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function memoryDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
  return db
}

function values(db: DatabaseSync): string[] {
  return (db.prepare('SELECT value FROM entries ORDER BY id').all() as Array<{ value: string }>)
    .map((row) => row.value)
}

describe('SQLite UnitOfWork spike', () => {
  test('commits an outer transaction and uses unique nested savepoints', () => {
    const db = memoryDatabase()
    const boundaries: Array<string | undefined> = []

    runInTransaction(db, (outer) => {
      assert.equal(db.isTransaction, true)
      assert.equal(outer.depth, 1)
      db.prepare('INSERT INTO entries (value) VALUES (?)').run('outer')
      runInTransaction(db, (inner) => {
        boundaries.push(inner.savepoint)
        assert.equal(inner.depth, 2)
        db.prepare('INSERT INTO entries (value) VALUES (?)').run('inner-1')
      })
      runInTransaction(db, (inner) => {
        boundaries.push(inner.savepoint)
        db.prepare('INSERT INTO entries (value) VALUES (?)').run('inner-2')
      })
    })

    assert.equal(db.isTransaction, false)
    assert.equal(new Set(boundaries).size, 2)
    assert.deepEqual(values(db), ['outer', 'inner-1', 'inner-2'])
    db.close()
  })

  test('rolls back only a failed nested boundary when the caller handles the error', () => {
    const db = memoryDatabase()
    runInTransaction(db, () => {
      db.prepare('INSERT INTO entries (value) VALUES (?)').run('before')
      assert.throws(() => runInTransaction(db, () => {
        db.prepare('INSERT INTO entries (value) VALUES (?)').run('discarded')
        throw new Error('nested failure')
      }), /nested failure/)
      db.prepare('INSERT INTO entries (value) VALUES (?)').run('after')
    })
    assert.deepEqual(values(db), ['before', 'after'])
    db.close()
  })

  test('rolls back the complete outer transaction on failure', () => {
    const db = memoryDatabase()
    assert.throws(() => runInTransaction(db, () => {
      db.prepare('INSERT INTO entries (value) VALUES (?)').run('discarded')
      throw new Error('outer failure')
    }), /outer failure/)
    assert.equal(db.isTransaction, false)
    assert.deepEqual(values(db), [])
    db.close()
  })

  test('rejects Promise-like callbacks immediately and rolls back synchronous writes', () => {
    const db = memoryDatabase()
    assert.throws(() => runInTransaction(db, async () => {
      db.prepare('INSERT INTO entries (value) VALUES (?)').run('discarded')
      await Promise.resolve()
    }), AsyncTransactionCallbackError)
    assert.equal(db.isTransaction, false)
    assert.deepEqual(values(db), [])
    db.close()
  })

  test('uses a savepoint when called inside a transaction owned by existing code', () => {
    const db = memoryDatabase()
    db.exec('BEGIN IMMEDIATE')
    runInTransaction(db, (context) => {
      assert.match(context.savepoint ?? '', /^moss_uow_/)
      db.prepare('INSERT INTO entries (value) VALUES (?)').run('inside-existing')
    })
    assert.equal(db.isTransaction, true)
    db.exec('ROLLBACK')
    assert.deepEqual(values(db), [])
    db.close()
  })

  test('surfaces SQLITE_BUSY and retries the complete command after lock release', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'moss-uow-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'concurrency.sqlite')
    const db = new DatabaseSync(databasePath)
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 10;
      CREATE TABLE wallets (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL);
      INSERT INTO wallets (id, balance) VALUES (1, 0);
    `)

    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.databasePath);
      db.exec('PRAGMA busy_timeout = 10; BEGIN IMMEDIATE; UPDATE wallets SET balance = balance + 1 WHERE id = 1');
      parentPort.postMessage('locked');
      setTimeout(() => {
        db.exec('COMMIT');
        db.close();
        parentPort.postMessage('released');
      }, 120);
    `, { eval: true, workerData: { databasePath } })

    await new Promise<void>((resolve, reject) => {
      worker.once('message', (message) => message === 'locked' && resolve())
      worker.once('error', reject)
    })
    assert.throws(() => runInTransaction(db, () => {
      db.prepare('UPDATE wallets SET balance = balance + 1 WHERE id = 1').run()
    }), (error: unknown) => (error as { code?: string }).code === 'ERR_SQLITE_ERROR')

    let retries = 0
    runWithBusyRetry(() => runInTransaction(db, () => {
      db.prepare('UPDATE wallets SET balance = balance + 1 WHERE id = 1').run()
    }), {
      maxAttempts: 10,
      delayMs: 20,
      onRetry: () => { retries += 1 },
    })
    assert(retries > 0)
    await new Promise<void>((resolve, reject) => {
      worker.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)))
      worker.once('error', reject)
    })
    const wallet = db.prepare('SELECT balance FROM wallets WHERE id = 1').get() as { balance: number }
    assert.equal(wallet.balance, 2)
    db.close()
  })

  test('enforces numeric alias uniqueness at the database boundary', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE legacy_aliases (entity_type TEXT, legacy_id INTEGER, target_id TEXT, UNIQUE(entity_type, legacy_id))')
    db.prepare('INSERT INTO legacy_aliases VALUES (?, ?, ?)').run('user', 42, 'user-a')
    assert.throws(() => {
      db.prepare('INSERT INTO legacy_aliases VALUES (?, ?, ?)').run('user', 42, 'user-b')
    }, /UNIQUE constraint failed/)
    db.close()
  })
})
