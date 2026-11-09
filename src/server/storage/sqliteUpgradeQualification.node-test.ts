import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { DirectConnectStore } from '../db.js'
import { inspectSqliteController, prepareControllerConfiguration, qualifySqliteUpgrade } from './sqliteUpgradeQualification.js'

void test('streaming inventory matches typed multiset hashes and detects changes without exposing values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'moss-upgrade-stream-'))
  const path = join(root, 'moss.db')
  try {
    const initial = new DirectConnectStore(path)
    await initial.close()
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE private_fixture (value, text TEXT)')
    const insert = db.prepare('INSERT INTO private_fixture VALUES (?, ?)')
    for (const value of [null, 9007199254740993n, 1.25, new Uint8Array([0, 255]), 'private-value']) {
      insert.run(value, 'private-text')
      insert.run(value, 'private-text')
    }
    db.close()
    const before = readFileSync(path)
    const bounded = await qualifySqliteUpgrade(path)
    const streaming = await qualifySqliteUpgrade(path, 'streaming')
    assert.deepEqual(streaming.sourceTables, bounded.sourceTables)
    assert.equal(streaming.inventoryMode, 'streaming')
    assert(!JSON.stringify(streaming).includes('private-value'))
    assert(!JSON.stringify(streaming).includes('private-text'))
    assert.deepEqual(readFileSync(path), before)
    const changed = new DatabaseSync(path)
    // Reordering the same typed multiset must not change its hash.
    changed.exec('CREATE TABLE reordered AS SELECT * FROM private_fixture ORDER BY rowid DESC; DELETE FROM private_fixture; INSERT INTO private_fixture SELECT * FROM reordered; DROP TABLE reordered')
    changed.close()
    const reordered = await qualifySqliteUpgrade(path, 'streaming')
    assert.deepEqual(reordered.sourceTables.private_fixture, streaming.sourceTables.private_fixture)
    const mutation = new DatabaseSync(path)
    mutation.exec("UPDATE private_fixture SET text='changed' WHERE rowid=1")
    mutation.close()
    const mutated = await qualifySqliteUpgrade(path, 'streaming')
    assert.equal(mutated.sourceTables.private_fixture.rows, streaming.sourceTables.private_fixture.rows)
    assert.notEqual(mutated.sourceTables.private_fixture.sha256, streaming.sourceTables.private_fixture.sha256)
    const duplicate = new DatabaseSync(path)
    duplicate.exec('DELETE FROM private_fixture WHERE rowid=2; INSERT INTO private_fixture SELECT * FROM private_fixture WHERE rowid=3')
    duplicate.close()
    const duplicated = await qualifySqliteUpgrade(path, 'streaming')
    assert.equal(duplicated.sourceTables.private_fixture.rows, mutated.sourceTables.private_fixture.rows)
    assert.notEqual(duplicated.sourceTables.private_fixture.sha256, mutated.sourceTables.private_fixture.sha256)
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true })
  }
})

void test('large inventory preserves every WAL row while the default bound still refuses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'moss-upgrade-large-'))
  const path = join(root, 'moss.db')
  const initial = new DirectConnectStore(path)
  await initial.close()
  const db = new DatabaseSync(path)
  try {
    db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE audit_fixture (id INTEGER PRIMARY KEY, value TEXT);
      WITH RECURSIVE ids(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM ids WHERE id<103073)
      INSERT INTO audit_fixture SELECT id, 'retained-' || id FROM ids`)
    const before = db.prepare('SELECT count(*) AS n, sum(id) AS total FROM audit_fixture').get()
    await assert.rejects(qualifySqliteUpgrade(path), /Qualification row bound exceeded: audit_fixture/)
    const result = await qualifySqliteUpgrade(path, 'streaming')
    assert.equal(result.sourceTables.audit_fixture.rows, 103073)
    assert.equal(result.existingRowsPreserved, true)
    assert.equal(result.idempotentReopen, true)
    assert.equal(result.runtimeStarted, false)
    assert.deepEqual(db.prepare('SELECT count(*) AS n, sum(id) AS total FROM audit_fixture').get(), before)
    const limited = new DatabaseSync(path)
    limited.exec('DELETE FROM audit_fixture WHERE id=103073')
    limited.close()
    const changed = await qualifySqliteUpgrade(path, 'streaming')
    assert.equal(changed.sourceTables.audit_fixture.rows, 103072)
    assert.notEqual(changed.sourceTables.audit_fixture.sha256, result.sourceTables.audit_fixture.sha256)
  } finally {
    db.close()
    assert.equal(dirname(root), resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true })
  }
})

void test('native configuration preparation preserves original settings and refuses stale pins or output reuse', async () => {
  const root = mkdtempSync(join(tmpdir(), 'moss-upgrade-config-'))
  const path = join(root, 'moss.db'), config = join(root, 'server.json'), output = join(root, 'prepared.json')
  const store = new DirectConnectStore(path)
  try {
    const instance = await store.registerServerInstance('127.0.0.1', 12345)
    const original = JSON.stringify({ server: { port: 43127 }, storage: { dbPath: path }, productAdapter: { preserved: true } })
    writeFileSync(config, original)
    const hash = createHash('sha256').update(original).digest('hex')
    const result = prepareControllerConfiguration(config, path, 12345, hash, output)
    assert.equal(result.instanceId, instance.instanceId)
    assert.equal(result.installed, false)
    assert.equal(readFileSync(config, 'utf8'), original)
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), {
      server: { port: 43127, instanceId: instance.instanceId }, storage: { dbPath: path }, productAdapter: { preserved: true },
    })
    assert.throws(() => prepareControllerConfiguration(config, path, 12345, hash, output), /EEXIST/)
    assert.throws(() => prepareControllerConfiguration(config, path, 12345, '0'.repeat(64), join(root, 'wrong.json')), /configuration changed/)
  } finally {
    await store.close()
    assert.equal(dirname(root), resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true })
  }
})

void test('controller inspection binds the service PID and refuses ambiguous or stale ownership without writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'moss-upgrade-controller-'))
  const path = join(root, 'moss.db')
  const store = new DirectConnectStore(path)
  try {
    const registered = await store.registerServerInstance('127.0.0.1', 12345)
    const before = store.db!.prepare('SELECT * FROM server_instances').all()
    const result = inspectSqliteController(path, 12345, 30_000)
    assert.equal(result.instanceId, registered.instanceId)
    assert.equal(result.authenticationClaimed, false)
    assert.equal(result.databaseChanged, false)
    assert.throws(() => inspectSqliteController(path, 67890, 30_000), /does not match/)
    assert.deepEqual(store.db!.prepare('SELECT * FROM server_instances').all(), before)
    await store.registerServerInstance('127.0.0.1', 67890)
    assert.throws(() => inspectSqliteController(path, 12345, 30_000), /exactly one fresh/)
    store.db!.exec('UPDATE server_instances SET heartbeat_at=0')
    assert.throws(() => inspectSqliteController(path, 12345, 30_000), /exactly one fresh/)
  } finally {
    await store.close()
    assert.equal(dirname(root), resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true })
  }
})

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
