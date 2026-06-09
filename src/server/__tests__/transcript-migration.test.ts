import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runMigration } from '../../../scripts/migrate-transcript-paths.js'
import type { DbHandle } from '../../../scripts/migrate-transcript-paths.js'
import { getTranscriptPath } from '../runtimePaths.js'

/**
 * bun:sqlite-backed DbHandle so we can exercise the migration script under
 * bun test (the script itself uses node:sqlite at runtime, but bun cannot
 * resolve that module). Surface matches what migrateOne / runMigration call.
 */
const openBunSqlite = async (dbPath: string): Promise<DbHandle> => {
  const db = new Database(dbPath)
  return {
    prepareAll: <T = unknown>(sql: string, params: unknown[]) =>
      db.prepare(sql).all(...params) as T[],
    prepareRun: (sql: string, params: unknown[]) => {
      db.prepare(sql).run(...params)
    },
    close: () => db.close(),
  }
}

/**
 * Spin up a minimal SQLite database matching the columns that the migration
 * script reads/writes. We don't run the full createDirectConnectStore schema
 * — only what the script touches.
 */
async function buildFixture(): Promise<{
  dir: string
  dbPath: string
  runtimeDir: string
  cleanup: () => Promise<void>
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'moss-tx-migrate-'))
  const dbPath = path.join(dir, 'moss.sqlite')
  const runtimeDir = path.join(dir, 'runtime')
  await mkdir(runtimeDir, { recursive: true })

  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      transcript_session_id TEXT NOT NULL,
      transcript_path TEXT NOT NULL,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
  `)
  db.close()
  return {
    dir,
    dbPath,
    runtimeDir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

function insertSession(
  dbPath: string,
  row: {
    sessionId: string
    transcriptSessionId: string
    transcriptPath: string
    cwd: string
    deleted?: boolean
  },
): void {
  const db = new Database(dbPath)
  db.prepare(`
    INSERT INTO sessions
      (session_id, transcript_session_id, transcript_path, cwd, created_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    row.sessionId,
    row.transcriptSessionId,
    row.transcriptPath,
    row.cwd,
    Date.now(),
    row.deleted ? Date.now() : null,
  )
  db.close()
}

function readTranscriptPath(dbPath: string, sessionId: string): string {
  const db = new Database(dbPath)
  try {
    const row = db.prepare('SELECT transcript_path FROM sessions WHERE session_id = ?')
      .get(sessionId) as { transcript_path: string } | undefined
    return row?.transcript_path ?? ''
  } finally {
    db.close()
  }
}

describe('migrate-transcript-paths (A3 backfill)', () => {
  it('migrates a session with an old transcript_path, updates DB, removes old file', async () => {
    const fx = await buildFixture()
    try {
      const sid = 'sid-1'
      const tsid = 'tsid-A'
      const cwd = '/workspace/sid-1'

      // Old layout: configDir/projects/<sanitized-cwd>/<tsid>.jsonl
      const oldDir = path.join(fx.dir, 'configdir', 'projects', '-workspace-sid-1')
      await mkdir(oldDir, { recursive: true })
      const oldPath = path.join(oldDir, `${tsid}.jsonl`)
      const content = JSON.stringify({ type: 'user', text: 'hello' }) + '\n'
      await writeFile(oldPath, content)

      insertSession(fx.dbPath, {
        sessionId: sid,
        transcriptSessionId: tsid,
        transcriptPath: oldPath,
        cwd,
      })

      const summary = await runMigration({
        db: fx.dbPath,
        runtimeDir: fx.runtimeDir,
        dryRun: false,
        batchSize: 100,
        removeOld: true,
        openDb: openBunSqlite,
      })
      expect(summary.totalSessions).toBe(1)
      expect(summary.byOutcome.migrated).toBe(1)
      expect(summary.failures).toEqual([])

      const newPath = getTranscriptPath(fx.runtimeDir, sid, tsid)
      expect(readTranscriptPath(fx.dbPath, sid)).toBe(newPath)
      expect(existsSync(newPath)).toBe(true)
      expect(await readFile(newPath, 'utf8')).toBe(content)
      // Old file removed.
      expect(existsSync(oldPath)).toBe(false)
    } finally {
      await fx.cleanup()
    }
  })

  it('is idempotent: re-running on an already-migrated session is a no-op', async () => {
    const fx = await buildFixture()
    try {
      const sid = 'sid-2'
      const tsid = 'tsid-B'
      const newPath = getTranscriptPath(fx.runtimeDir, sid, tsid)
      await mkdir(path.dirname(newPath), { recursive: true })
      await writeFile(newPath, 'already-here')
      insertSession(fx.dbPath, {
        sessionId: sid,
        transcriptSessionId: tsid,
        transcriptPath: newPath,
        cwd: '/some/cwd',
      })

      const summary = await runMigration({
        db: fx.dbPath,
        runtimeDir: fx.runtimeDir,
        dryRun: false,
        batchSize: 100,
        removeOld: true,
        openDb: openBunSqlite,
      })
      expect(summary.byOutcome.already_new).toBe(1)
      expect(summary.byOutcome.migrated).toBe(0)
      expect(await readFile(newPath, 'utf8')).toBe('already-here')
    } finally {
      await fx.cleanup()
    }
  })

  it('records old_missing when the source file is gone (preserves DB pointer)', async () => {
    const fx = await buildFixture()
    try {
      const sid = 'sid-3'
      const tsid = 'tsid-C'
      const phantom = path.join(fx.dir, 'gone', `${tsid}.jsonl`)
      insertSession(fx.dbPath, {
        sessionId: sid,
        transcriptSessionId: tsid,
        transcriptPath: phantom,
        cwd: '/whatever',
      })
      const summary = await runMigration({
        db: fx.dbPath,
        runtimeDir: fx.runtimeDir,
        dryRun: false,
        batchSize: 100,
        removeOld: true,
        openDb: openBunSqlite,
      })
      expect(summary.byOutcome.old_missing).toBe(1)
      // DB pointer is unchanged so a future fix-up can repoint it.
      expect(readTranscriptPath(fx.dbPath, sid)).toBe(phantom)
    } finally {
      await fx.cleanup()
    }
  })

  it('resumes from a crash that left the new file already in place', async () => {
    const fx = await buildFixture()
    try {
      const sid = 'sid-4'
      const tsid = 'tsid-D'
      const oldDir = path.join(fx.dir, 'configdir', 'projects', '-w')
      await mkdir(oldDir, { recursive: true })
      const oldPath = path.join(oldDir, `${tsid}.jsonl`)
      await writeFile(oldPath, 'still here')

      // Simulate previous run: new path already exists but DB not updated.
      const newPath = getTranscriptPath(fx.runtimeDir, sid, tsid)
      await mkdir(path.dirname(newPath), { recursive: true })
      await writeFile(newPath, 'still here')

      insertSession(fx.dbPath, {
        sessionId: sid,
        transcriptSessionId: tsid,
        transcriptPath: oldPath, // DB still points at old
        cwd: '/w',
      })

      const summary = await runMigration({
        db: fx.dbPath,
        runtimeDir: fx.runtimeDir,
        dryRun: false,
        batchSize: 100,
        removeOld: true,
        openDb: openBunSqlite,
      })
      expect(summary.byOutcome.skipped_already_in_runtime).toBe(1)
      expect(readTranscriptPath(fx.dbPath, sid)).toBe(newPath)
      // Old file cleared because removeOld=true.
      expect(existsSync(oldPath)).toBe(false)
    } finally {
      await fx.cleanup()
    }
  })

  it('dry-run mode does not touch the DB or filesystem', async () => {
    const fx = await buildFixture()
    try {
      const sid = 'sid-5'
      const tsid = 'tsid-E'
      const oldDir = path.join(fx.dir, 'oldcfg', 'projects', '-c')
      await mkdir(oldDir, { recursive: true })
      const oldPath = path.join(oldDir, `${tsid}.jsonl`)
      await writeFile(oldPath, 'dry')
      insertSession(fx.dbPath, {
        sessionId: sid,
        transcriptSessionId: tsid,
        transcriptPath: oldPath,
        cwd: '/c',
      })

      const summary = await runMigration({
        db: fx.dbPath,
        runtimeDir: fx.runtimeDir,
        dryRun: true,
        batchSize: 100,
        removeOld: true,
        openDb: openBunSqlite,
      })
      expect(summary.dryRun).toBe(true)
      expect(summary.byOutcome.migrated).toBe(1)
      // Nothing actually moved.
      expect(readTranscriptPath(fx.dbPath, sid)).toBe(oldPath)
      expect(existsSync(oldPath)).toBe(true)
      const newPath = getTranscriptPath(fx.runtimeDir, sid, tsid)
      expect(existsSync(newPath)).toBe(false)
    } finally {
      await fx.cleanup()
    }
  })

  it('keeps the old file when --keep-old (removeOld=false) is used', async () => {
    const fx = await buildFixture()
    try {
      const sid = 'sid-6'
      const tsid = 'tsid-F'
      const oldDir = path.join(fx.dir, 'oldcfg', 'projects', '-k')
      await mkdir(oldDir, { recursive: true })
      const oldPath = path.join(oldDir, `${tsid}.jsonl`)
      await writeFile(oldPath, 'keep')
      insertSession(fx.dbPath, {
        sessionId: sid,
        transcriptSessionId: tsid,
        transcriptPath: oldPath,
        cwd: '/k',
      })
      const summary = await runMigration({
        db: fx.dbPath,
        runtimeDir: fx.runtimeDir,
        dryRun: false,
        batchSize: 100,
        removeOld: false,
        openDb: openBunSqlite,
      })
      expect(summary.byOutcome.migrated).toBe(1)
      // Both exist after migration.
      expect(existsSync(oldPath)).toBe(true)
      const newPath = getTranscriptPath(fx.runtimeDir, sid, tsid)
      expect(existsSync(newPath)).toBe(true)
    } finally {
      await fx.cleanup()
    }
  })
})
