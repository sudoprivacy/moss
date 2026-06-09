import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { getTranscriptPath } from '../runtimePaths.js'

/**
 * End-to-end CLI smoke test. The previous in-process test stubs openDb;
 * this one actually runs `bun run scripts/migrate-transcript-paths.ts ...`
 * with a real SQLite file so the default openBunSqlite path is exercised.
 */
const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'migrate-transcript-paths.ts')

function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn('bun', ['run', SCRIPT, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', d => { stdout += d.toString('utf8') })
    child.stderr?.on('data', d => { stderr += d.toString('utf8') })
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

async function buildFixture(): Promise<{
  dir: string
  dbPath: string
  runtimeDir: string
  cleanup: () => Promise<void>
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'moss-tx-cli-'))
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
  return { dir, dbPath, runtimeDir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

function insertOne(
  dbPath: string,
  row: { sessionId: string; transcriptSessionId: string; transcriptPath: string; cwd: string },
): void {
  const db = new Database(dbPath)
  db.prepare(`
    INSERT INTO sessions (session_id, transcript_session_id, transcript_path, cwd, created_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(row.sessionId, row.transcriptSessionId, row.transcriptPath, row.cwd, Date.now())
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

describe('migrate-transcript-paths CLI (real subprocess)', () => {
  it('--help prints usage and exits 0', async () => {
    const r = await runCli(['--help'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('Usage: bun run scripts/migrate-transcript-paths.ts')
    expect(r.stderr).toContain('--db <path>')
    expect(r.stderr).toContain('--dry-run')
  })

  it('exits 2 when required flags are missing', async () => {
    const r = await runCli([], { MOSS_DB_PATH: '', MOSS_RUNTIME_DIR: '' })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('missing')
  })

  it('dry-run on a real SQLite DB does not modify anything (default openDb = bun:sqlite)', async () => {
    const fx = await buildFixture()
    try {
      const sid = 'cli-dry-1'
      const tsid = 'tsid-D'
      const oldDir = path.join(fx.dir, 'configdir', 'projects', '-w-cli-dry-1')
      await mkdir(oldDir, { recursive: true })
      const oldPath = path.join(oldDir, `${tsid}.jsonl`)
      await writeFile(oldPath, 'cli-dry-content')
      insertOne(fx.dbPath, {
        sessionId: sid,
        transcriptSessionId: tsid,
        transcriptPath: oldPath,
        cwd: '/w/cli-dry-1',
      })

      const r = await runCli([
        '--db', fx.dbPath,
        '--runtime-dir', fx.runtimeDir,
        '--dry-run',
      ])
      expect(r.code).toBe(0)
      const summary = JSON.parse(r.stdout)
      expect(summary.dryRun).toBe(true)
      expect(summary.totalSessions).toBe(1)
      expect(summary.byOutcome.migrated).toBe(1)

      // Nothing actually changed.
      expect(readTranscriptPath(fx.dbPath, sid)).toBe(oldPath)
      const expectedNewPath = getTranscriptPath(fx.runtimeDir, sid, tsid)
      expect(existsSync(expectedNewPath)).toBe(false)
      expect(existsSync(oldPath)).toBe(true)
    } finally {
      await fx.cleanup()
    }
  })

  it('apply mode: copies file, updates DB, removes old (default openDb = bun:sqlite)', async () => {
    const fx = await buildFixture()
    try {
      const sid = 'cli-apply-1'
      const tsid = 'tsid-A'
      const oldDir = path.join(fx.dir, 'configdir', 'projects', '-w-cli-apply-1')
      await mkdir(oldDir, { recursive: true })
      const oldPath = path.join(oldDir, `${tsid}.jsonl`)
      const content = JSON.stringify({ type: 'user', text: 'cli-apply' }) + '\n'
      await writeFile(oldPath, content)
      insertOne(fx.dbPath, {
        sessionId: sid,
        transcriptSessionId: tsid,
        transcriptPath: oldPath,
        cwd: '/w/cli-apply-1',
      })

      const r = await runCli([
        '--db', fx.dbPath,
        '--runtime-dir', fx.runtimeDir,
      ])
      expect(r.code).toBe(0)
      const summary = JSON.parse(r.stdout)
      expect(summary.dryRun).toBe(false)
      expect(summary.byOutcome.migrated).toBe(1)
      expect(summary.failures).toEqual([])

      const expectedNewPath = getTranscriptPath(fx.runtimeDir, sid, tsid)
      expect(readTranscriptPath(fx.dbPath, sid)).toBe(expectedNewPath)
      expect(existsSync(expectedNewPath)).toBe(true)
      expect(await readFile(expectedNewPath, 'utf8')).toBe(content)
      expect(existsSync(oldPath)).toBe(false)
    } finally {
      await fx.cleanup()
    }
  })

  it('writes summary JSON to --state path when provided', async () => {
    const fx = await buildFixture()
    try {
      const statePath = path.join(fx.dir, 'state.json')
      const r = await runCli([
        '--db', fx.dbPath,
        '--runtime-dir', fx.runtimeDir,
        '--dry-run',
        '--state', statePath,
      ])
      expect(r.code).toBe(0)
      expect(existsSync(statePath)).toBe(true)
      const parsed = JSON.parse(await readFile(statePath, 'utf8'))
      expect(parsed.totalSessions).toBe(0)
      expect(parsed.dryRun).toBe(true)
    } finally {
      await fx.cleanup()
    }
  })
})
