import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { SqliteDriver } from '../db/driver.js'
import { seedExternalTaskMigration } from '../testing/externalTaskMigrationFixture.js'

const run = promisify(execFile)
void test('maintenance CLI refuses unconfirmed/live writers, backs up before migration, and protects an existing backup', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'external-maintenance-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, 'old.sqlite'), destination = join(directory, 'backup.sqlite')
  const db = new SqliteDriver(new DatabaseSync(source))
  await seedExternalTaskMigration(db)
  const args = ['--import', 'tsx', resolve('scripts/migrate-external-tasks.ts'), '--sqlite', source, '--backup', destination]
  await assert.rejects(run(process.execPath, args), /Usage:/)
  // A separate CLI process must detect this still-open old writer, even while idle.
  await assert.rejects(run(process.execPath, [...args, '--confirm-old-writers-stopped']), /SQLite is open/)
  assert.equal((await db.get('SELECT COUNT(*) AS total FROM external_pilot_tasks'))?.total, 1)
  await db.close()
  await run(process.execPath, [...args, '--confirm-old-writers-stopped'])
  const receipt = JSON.parse(await readFile(`${destination}.receipt.json`, 'utf8'))
  assert.equal(receipt.completed, true)
  assert.equal(receipt.backup_sha256, createHash('sha256').update(await readFile(destination)).digest('hex'))
  assert.equal((await stat(destination)).mode & 0o777, 0o600)
  const backup = new DatabaseSync(destination, { readOnly: true }), migrated = new DatabaseSync(source, { readOnly: true })
  try {
    assert.equal(backup.prepare('SELECT COUNT(*) AS total FROM external_pilot_tasks').get()?.total, 1)
    assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'tasks'").get(), undefined)
    assert.equal(migrated.prepare('SELECT COUNT(*) AS total FROM tasks').get()?.total, 1)
    assert.equal(migrated.prepare('SELECT COUNT(*) AS total FROM external_pilot_tasks').get()?.total, 0)
  } finally { backup.close(); migrated.close() }
  const originalBackup = await readFile(destination)
  await assert.rejects(run(process.execPath, [...args, '--confirm-old-writers-stopped']))
  assert.deepEqual(await readFile(destination), originalBackup)
})
