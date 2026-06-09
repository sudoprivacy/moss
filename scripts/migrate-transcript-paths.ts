#!/usr/bin/env bun
/**
 * A3 transcript path migration.
 *
 * Before: <configDir>/projects/<sanitized-cwd>/<tsid>.jsonl
 * After:  <runtimeDir>/sessions/<sid>/transcript/<tsid>.jsonl
 *
 * The post-A3 code path writes only to the new location, so this script
 * walks every session row, copies the historical transcript over, verifies,
 * updates `sessions.transcript_path`, then removes the old file. The
 * operations are conservative — any step that fails leaves the old DB
 * value + old file intact so a future re-run can finish the job.
 *
 * Usage:
 *   bun run scripts/migrate-transcript-paths.ts                 # apply
 *   bun run scripts/migrate-transcript-paths.ts --dry-run       # plan only
 *   bun run scripts/migrate-transcript-paths.ts --db <path>     # explicit DB
 *   bun run scripts/migrate-transcript-paths.ts --runtime-dir <p> [--batch-size N]
 *
 * Defaults read from MOSS_DB_PATH / MOSS_RUNTIME_DIR if set; otherwise the
 * caller must pass --db and --runtime-dir explicitly.
 *
 * Exit codes:
 *   0 — finished (with or without per-session warnings)
 *   2 — bad args / cannot open DB
 */

import { existsSync, statSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import { getTranscriptPath } from '../src/server/runtimePaths.js'

/**
 * Minimal DB handle. Production wires up node:sqlite (lazy imported below so
 * bun can build this file without resolving the Node-only module); tests
 * pass a bun:sqlite-backed shim with the same surface.
 */
export type DbHandle = {
  prepareAll: <T = unknown>(sql: string, params: unknown[]) => T[]
  prepareRun: (sql: string, params: unknown[]) => void
  close: () => void
}

async function openNodeSqlite(dbPath: string): Promise<DbHandle> {
  // Dynamic import keeps the bun bundler happy; node:sqlite resolves at run
  // time on Node 22+. If you point this script at older Node, install
  // better-sqlite3 and swap implementations here.
  const mod = (await import('node:sqlite')) as {
    DatabaseSync: new (p: string) => {
      prepare: (sql: string) => {
        all: (...args: unknown[]) => unknown[]
        run: (...args: unknown[]) => unknown
      }
      close: () => void
    }
  }
  const db = new mod.DatabaseSync(dbPath)
  return {
    prepareAll: <T = unknown>(sql: string, params: unknown[]) =>
      db.prepare(sql).all(...params) as T[],
    prepareRun: (sql: string, params: unknown[]) => {
      db.prepare(sql).run(...params)
    },
    close: () => db.close(),
  }
}

type Args = {
  db?: string
  runtimeDir?: string
  dryRun: boolean
  batchSize: number
  removeOld: boolean
  statePath?: string
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    db: process.env.MOSS_DB_PATH,
    runtimeDir: process.env.MOSS_RUNTIME_DIR,
    dryRun: false,
    batchSize: 200,
    removeOld: true,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    switch (a) {
      case '--db':
        out.db = argv[++i]
        break
      case '--runtime-dir':
        out.runtimeDir = argv[++i]
        break
      case '--dry-run':
        out.dryRun = true
        break
      case '--batch-size':
        out.batchSize = Number(argv[++i]) || 200
        break
      case '--keep-old':
        out.removeOld = false
        break
      case '--state':
        out.statePath = argv[++i]
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
      default:
        process.stderr.write(`Unknown arg: ${a}\n`)
        printHelp()
        process.exit(2)
    }
  }
  return out
}

function printHelp(): void {
  process.stderr.write(`Usage: bun run scripts/migrate-transcript-paths.ts [options]

Options:
  --db <path>           Path to moss sqlite db (or env MOSS_DB_PATH)
  --runtime-dir <path>  Runtime root (or env MOSS_RUNTIME_DIR)
  --dry-run             Print plan, do not modify anything
  --batch-size N        SELECT page size (default 200)
  --keep-old            Do not unlink old transcript after copy
  --state <path>        Write summary JSON here (default stdout only)
`)
}

type SessionRow = {
  session_id: string
  transcript_session_id: string
  transcript_path: string
  cwd: string
}

type Outcome =
  | 'migrated'
  | 'already_new'
  | 'old_missing'
  | 'copy_failed'
  | 'verify_failed'
  | 'db_update_failed'
  | 'skipped_already_in_runtime'

type Summary = {
  totalSessions: number
  byOutcome: Record<Outcome, number>
  failures: Array<{ sessionId: string; outcome: Outcome; error?: string }>
  startedAt: number
  finishedAt?: number
  dryRun: boolean
}

function bumpOutcome(summary: Summary, outcome: Outcome): void {
  summary.byOutcome[outcome] = (summary.byOutcome[outcome] ?? 0) + 1
}

async function sameFileBytes(a: string, b: string): Promise<boolean> {
  // Quick check by size first.
  const [sa, sb] = await Promise.all([stat(a), stat(b)])
  if (sa.size !== sb.size) return false
  if (sa.size === 0) return true
  // Compare a head + tail slice; cheaper than full hash and catches truncation.
  const HEAD = 4096
  const fdA = await open(a, 'r')
  const fdB = await open(b, 'r')
  try {
    const bufA = Buffer.alloc(Math.min(HEAD, sa.size))
    const bufB = Buffer.alloc(bufA.length)
    await fdA.read(bufA, 0, bufA.length, 0)
    await fdB.read(bufB, 0, bufB.length, 0)
    if (!bufA.equals(bufB)) return false
    if (sa.size > HEAD) {
      const tailA = Buffer.alloc(Math.min(HEAD, sa.size - HEAD))
      const tailB = Buffer.alloc(tailA.length)
      const offset = sa.size - tailA.length
      await fdA.read(tailA, 0, tailA.length, offset)
      await fdB.read(tailB, 0, tailB.length, offset)
      if (!tailA.equals(tailB)) return false
    }
    return true
  } finally {
    await fdA.close().catch(() => {})
    await fdB.close().catch(() => {})
  }
}

/**
 * Migrate one session. Returns the outcome and never throws — callers
 * collect outcomes for the final summary.
 */
async function migrateOne(
  db: DbHandle,
  row: SessionRow,
  args: Args,
): Promise<{ outcome: Outcome; error?: string }> {
  const expectedNewPath = getTranscriptPath(
    args.runtimeDir!,
    row.session_id,
    row.transcript_session_id,
  )
  const current = row.transcript_path

  // Already migrated (DB points at the new path).
  if (current === expectedNewPath) {
    return { outcome: 'already_new' }
  }

  // Idempotency: DB still points at the old location, but the new file is
  // already present. This can happen if a previous run crashed after copy
  // but before the DB update. Just update the DB pointer and (optionally)
  // remove the stale old file.
  if (existsSync(expectedNewPath)) {
    if (args.dryRun) {
      return { outcome: 'skipped_already_in_runtime' }
    }
    try {
      db.prepareRun(
        'UPDATE sessions SET transcript_path = ? WHERE session_id = ?',
        [expectedNewPath, row.session_id],
      )
    } catch (err) {
      return {
        outcome: 'db_update_failed',
        error: err instanceof Error ? err.message : String(err),
      }
    }
    if (args.removeOld && existsSync(current) && current !== expectedNewPath) {
      await rm(current, { force: true }).catch(() => {})
    }
    return { outcome: 'skipped_already_in_runtime' }
  }

  // Source missing — the session got destroyed under the old behavior and
  // lost its transcript. Record but do nothing.
  if (!existsSync(current)) {
    return { outcome: 'old_missing' }
  }

  if (args.dryRun) {
    return { outcome: 'migrated' }
  }

  await mkdir(path.dirname(expectedNewPath), { recursive: true })
  // Copy to a sibling .partial file first so a crash leaves an obvious
  // marker rather than a half-written transcript at the final name.
  const partial = `${expectedNewPath}.partial`
  try {
    await copyFile(current, partial)
  } catch (err) {
    await rm(partial, { force: true }).catch(() => {})
    return {
      outcome: 'copy_failed',
      error: err instanceof Error ? err.message : String(err),
    }
  }
  // Verify bytes match.
  let verified = false
  try {
    verified = await sameFileBytes(current, partial)
  } catch {
    verified = false
  }
  if (!verified) {
    await rm(partial, { force: true }).catch(() => {})
    return { outcome: 'verify_failed' }
  }
  try {
    await rename(partial, expectedNewPath)
  } catch (err) {
    await rm(partial, { force: true }).catch(() => {})
    return {
      outcome: 'copy_failed',
      error: err instanceof Error ? err.message : String(err),
    }
  }
  try {
    db.prepareRun(
      'UPDATE sessions SET transcript_path = ? WHERE session_id = ?',
      [expectedNewPath, row.session_id],
    )
  } catch (err) {
    return {
      outcome: 'db_update_failed',
      error: err instanceof Error ? err.message : String(err),
    }
  }
  if (args.removeOld && existsSync(current) && current !== expectedNewPath) {
    await rm(current, { force: true }).catch(() => {})
  }
  return { outcome: 'migrated' }
}

export type RunMigrationArgs = Args & {
  openDb?: (dbPath: string) => Promise<DbHandle>
}

export async function runMigration(args: RunMigrationArgs): Promise<Summary> {
  if (!args.db) throw new Error('missing --db or MOSS_DB_PATH')
  if (!args.runtimeDir) throw new Error('missing --runtime-dir or MOSS_RUNTIME_DIR')
  if (!existsSync(args.db)) throw new Error(`db not found: ${args.db}`)
  if (!statSync(args.db).isFile()) throw new Error(`db is not a file: ${args.db}`)

  const openDb = args.openDb ?? openNodeSqlite
  const db = await openDb(args.db)
  const summary: Summary = {
    totalSessions: 0,
    byOutcome: {
      migrated: 0,
      already_new: 0,
      old_missing: 0,
      copy_failed: 0,
      verify_failed: 0,
      db_update_failed: 0,
      skipped_already_in_runtime: 0,
    },
    failures: [],
    startedAt: Date.now(),
    dryRun: args.dryRun,
  }

  try {
    let offset = 0
    while (true) {
      const rows = db.prepareAll<{
        session_id: unknown
        transcript_session_id: unknown
        transcript_path: unknown
        cwd: unknown
      }>(`
        SELECT session_id, transcript_session_id, transcript_path, cwd
        FROM sessions
        WHERE deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT ? OFFSET ?
      `, [args.batchSize, offset])
      if (rows.length === 0) break

      for (const r of rows) {
        const row: SessionRow = {
          session_id: String(r.session_id),
          transcript_session_id: String(r.transcript_session_id),
          transcript_path: String(r.transcript_path),
          cwd: String(r.cwd),
        }
        summary.totalSessions += 1
        const result = await migrateOne(db, row, args)
        bumpOutcome(summary, result.outcome)
        if (
          result.outcome === 'copy_failed' ||
          result.outcome === 'verify_failed' ||
          result.outcome === 'db_update_failed'
        ) {
          summary.failures.push({
            sessionId: row.session_id,
            outcome: result.outcome,
            error: result.error,
          })
        }
      }
      offset += rows.length
      if (rows.length < args.batchSize) break
    }
  } finally {
    db.close()
  }
  summary.finishedAt = Date.now()
  return summary
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  try {
    const summary = await runMigration(args)
    const json = JSON.stringify(summary, null, 2)
    process.stdout.write(json + '\n')
    if (args.statePath) {
      await writeFile(args.statePath, json + '\n', 'utf8')
    }
  } catch (err) {
    process.stderr.write(
      `migrate-transcript-paths failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(2)
  }
}

void readFile // silence dead-import lint if any
if (import.meta.main) {
  void main()
}
