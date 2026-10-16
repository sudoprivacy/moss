#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, open, realpath, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import { parseArgs, promisify } from 'node:util'
import pg from 'pg'
import { PgDriver, SqliteDriver, type DbDriver, type PgPoolLike } from '../src/server/db/driver.js'
import { migrateExternalTaskPersistence } from '../src/server/agentFederation/taskPersistence.js'

const run = promisify(execFile)
const { values } = parseArgs({ options: {
  sqlite: { type: 'string' }, postgres: { type: 'boolean' }, backup: { type: 'string' },
  'confirm-old-writers-stopped': { type: 'boolean' },
} })

async function assertSqliteOffline(path: string): Promise<void> {
  try {
    const { stdout } = await run('lsof', ['-t', '--', path])
    if (stdout.trim()) throw new Error('SQLite is open in another process; stop all writers and disable automatic restart first')
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string }
    if (failure.code === 1 && !failure.stdout?.trim() && !failure.stderr?.trim()) return
    throw error
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function main() {
  if (!values['confirm-old-writers-stopped'] || !values.backup || Boolean(values.sqlite) === Boolean(values.postgres)) {
    throw new Error('Usage: node --import tsx scripts/migrate-external-tasks.ts (--sqlite PATH | --postgres) --backup NEW_PATH --confirm-old-writers-stopped; PostgreSQL uses MOSS_MIGRATION_DATABASE_URL. See docs/external-task-migration.md')
  }
  const backupPath = resolve(values.backup)
  let db: DbDriver | undefined
  try {
    if (values.sqlite) {
      const sourcePath = await realpath(values.sqlite)
      if (!(await stat(sourcePath)).isFile()) throw new Error('SQLite source must be an existing database file')
      await assertSqliteOffline(sourcePath)
      const reservation = await open(backupPath, 'wx', 0o600); await reservation.close()
      const sqlite = new DatabaseSync(sourcePath)
      db = new SqliteDriver(sqlite)
      await backup(sqlite, backupPath)
      const saved = new DatabaseSync(backupPath, { readOnly: true })
      try {
        if (saved.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('SQLite backup integrity check failed')
      } finally { saved.close() }
    } else {
      const connectionString = process.env.MOSS_MIGRATION_DATABASE_URL
      if (!connectionString) throw new Error('MOSS_MIGRATION_DATABASE_URL is required')
      const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 })
      db = new PgDriver(pool as unknown as PgPoolLike)
      const assertOffline = async () => {
        const others = await db!.get("SELECT COUNT(*) AS total FROM pg_stat_activity WHERE datname = current_database() AND pid != pg_backend_pid() AND backend_type = 'client backend'")
        if (Number(others?.total)) throw new Error('Other PostgreSQL client sessions are connected; stop all application instances and other clients first')
      }
      await assertOffline()
      const reservation = await open(backupPath, 'wx', 0o600); await reservation.close()
      const url = new URL(connectionString)
      const password = decodeURIComponent(url.password); url.password = ''
      if (url.searchParams.has('password')) throw new Error('Use the URL password field, not a password query parameter')
      // The password is passed only through the child environment, never argv or logs.
      await run('pg_dump', ['--dbname', url.toString(), '--format=custom', '--file', backupPath], {
        env: { ...process.env, PGPASSWORD: password }, maxBuffer: 1024 * 1024,
      }).catch(() => { throw new Error('pg_dump failed; no migration was attempted') })
      await run('pg_restore', ['--list', backupPath]).catch(() => { throw new Error('PostgreSQL backup archive verification failed') })
      await assertOffline()
    }
    await chmod(backupPath, 0o600)
    const backupSha256 = await sha256(backupPath)
    const receipt = { backup: backupPath, backup_sha256: backupSha256, database_kind: db.kind,
      old_writers_stopped_confirmed: true, started_at: new Date().toISOString(), completed: false }
    const receiptPath = `${backupPath}.receipt.json`
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await migrateExternalTaskPersistence(db, { oldWritersStopped: true, backupSha256 })
    if (Number((await db.get("SELECT completed FROM federation_task_migrations WHERE id = 'canonical-v1'"))?.completed) !== 1) throw new Error('Migration completion verification failed')
    await writeFile(receiptPath, JSON.stringify({ ...receipt, completed: true, completed_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
    console.log(`Migration verified. Backup and receipt: ${receiptPath}. Start only the new Moss version.`)
  } finally { await db?.close() }
}

main().catch(error => {
  // Database errors can include row contents or connection details; never print them.
  const message = error instanceof Error && /^(Usage:|SQLite |MOSS_MIGRATION_|Other PostgreSQL|Use the URL|pg_dump failed|PostgreSQL backup|Migration completion|EXTERNAL_TASK_|Legacy external|Maintenance window|Canonical external)/.test(error.message)
    ? error.message : 'Migration failed. Keep services stopped; inspect the local backup/receipt and maintenance procedure. No automatic retry was performed.'
  console.error(message)
  process.exitCode = 1
})
