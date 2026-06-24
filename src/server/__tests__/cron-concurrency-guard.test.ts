import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CronStore } from '../services/cron/CronStore.js'

// Guards against the reuse-mode pile-up: a job whose previous run is stuck
// (e.g. a wedged single-turn session) must not stack another run, and runs
// orphaned by a crash/restart must be reaped so the guard doesn't block
// forever.

type DatabaseSync = ConstructorParameters<typeof CronStore>[0]

function makeDb(): DatabaseSync {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE cron_job_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      error TEXT,
      summary TEXT,
      created_at INTEGER NOT NULL
    );
  `)
  return db as unknown as DatabaseSync
}

describe('cron concurrency guard + stale-run reaper', () => {
  let db: DatabaseSync
  let store: CronStore

  beforeEach(() => {
    db = makeDb()
    store = new CronStore(db)
  })

  it('hasActiveRun reflects queued/running runs only', () => {
    expect(store.hasActiveRun('job-1')).toBe(false)

    const run = store.createRun('job-1', 'org', 'user') // status 'queued'
    expect(store.hasActiveRun('job-1')).toBe(true)

    store.startRun(run.id) // 'running'
    expect(store.hasActiveRun('job-1')).toBe(true)

    store.updateRunStatus(run.id, { status: 'ok' })
    expect(store.hasActiveRun('job-1')).toBe(false)

    // Other terminal statuses also clear it.
    const r2 = store.createRun('job-1', 'org', 'user')
    store.updateRunStatus(r2.id, { status: 'error' })
    expect(store.hasActiveRun('job-1')).toBe(false)
  })

  it('hasActiveRun is scoped per job', () => {
    store.createRun('job-1', 'org', 'user')
    expect(store.hasActiveRun('job-1')).toBe(true)
    expect(store.hasActiveRun('job-2')).toBe(false)
  })

  it('reapStaleRuns errors only runs older than the threshold', () => {
    const now = 1_700_000_000_000
    // Stale running run started well before the cutoff.
    const stale = store.createRun('job-1', 'org', 'user')
    store.startRun(stale.id)
    db.prepare('UPDATE cron_job_runs SET started_at = ? WHERE id = ?').run(now - 60 * 60 * 1000, stale.id)

    // Fresh running run.
    const fresh = store.createRun('job-1', 'org', 'user')
    store.startRun(fresh.id)
    db.prepare('UPDATE cron_job_runs SET started_at = ? WHERE id = ?').run(now - 1000, fresh.id)

    const reaped = store.reapStaleRuns(now - 31 * 60 * 1000, 'stale')
    expect(reaped).toBe(1)

    expect(store.getRunById(stale.id)!.status).toBe('error')
    expect(store.getRunById(stale.id)!.finishedAt).not.toBeNull()
    expect(store.getRunById(fresh.id)!.status).toBe('running')
    // Reaping the stale one frees the guard, but the fresh one still holds it.
    expect(store.hasActiveRun('job-1')).toBe(true)
  })

  it('reapStaleRuns falls back to created_at when started_at is null (queued orphan)', () => {
    const now = 1_700_000_000_000
    const queued = store.createRun('job-1', 'org', 'user') // queued, started_at NULL
    db.prepare('UPDATE cron_job_runs SET created_at = ? WHERE id = ?').run(now - 60 * 60 * 1000, queued.id)

    const reaped = store.reapStaleRuns(now - 31 * 60 * 1000, 'stale')
    expect(reaped).toBe(1)
    expect(store.getRunById(queued.id)!.status).toBe('error')
    expect(store.hasActiveRun('job-1')).toBe(false)
  })
})
