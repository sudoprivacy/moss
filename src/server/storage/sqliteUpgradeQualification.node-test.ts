import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { DirectConnectStore } from '../db.js'
import { qualifySqliteUpgrade } from './sqliteUpgradeQualification.js'

void test('qualification migrates only its backup and preserves typed private rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'moss-upgrade-source-'))
  const path = join(root, 'moss.db')
  try {
    const store = new DirectConnectStore(path)
    store.db!.exec('CREATE TABLE private_fixture (id INTEGER PRIMARY KEY, value BLOB, text TEXT)')
    store.db!.prepare('INSERT INTO private_fixture VALUES (?,?,?)').run(1, new Uint8Array([0, 255, 0]), '研发\0🧪')
    await store.close()
    const before = readFileSync(path)
    const result = await qualifySqliteUpgrade(path)
    assert.equal(result.sourceTables.private_fixture.rows, 1)
    assert.equal(result.existingRowsPreserved, true)
    assert.equal(result.idempotentReopen, true)
    assert.equal(result.runtimeStarted, false)
    assert.equal(result.authenticatedReady, false)
    assert(!JSON.stringify(result).includes('研发'))
    assert.deepEqual(readFileSync(path), before)
    const writable = new DatabaseSync(path)
    try { writable.prepare('INSERT INTO private_fixture VALUES (?,?,?)').run(2, null, 'later') }
    finally { writable.close() }
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true })
  }
})

void test('qualification includes committed WAL rows while the original stays open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'moss-upgrade-wal-'))
  const path = join(root, 'moss.db')
  let store: DirectConnectStore | undefined
  try {
    store = new DirectConnectStore(path)
    store.db!.exec("CREATE TABLE wal_fixture (id INTEGER PRIMARY KEY); INSERT INTO wal_fixture VALUES (1)")
    const result = await qualifySqliteUpgrade(path)
    assert.equal(result.sourceTables.wal_fixture.rows, 1)
    store.db!.exec('INSERT INTO wal_fixture VALUES (2)')
    assert.equal(store.db!.prepare('SELECT count(*) AS n FROM wal_fixture').get()!.n, 2)
  } finally {
    await store?.close()
    assert.equal(dirname(root), resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true })
  }
})

void test('an invalid source is refused without repairing or writing the original', async () => {
  const root = mkdtempSync(join(tmpdir(), 'moss-upgrade-invalid-'))
  const path = join(root, 'moss.db')
  try {
    const store = new DirectConnectStore(path)
    store.db!.exec(`PRAGMA foreign_keys=OFF;
      CREATE TABLE qualification_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE qualification_child (parent INTEGER REFERENCES qualification_parent(id));
      INSERT INTO qualification_child VALUES (123);`)
    await store.close()
    const before = readFileSync(path)
    await assert.rejects(qualifySqliteUpgrade(path), /Foreign-key violations require review/)
    assert.deepEqual(readFileSync(path), before)
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true })
  }
})
