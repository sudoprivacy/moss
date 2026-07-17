import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CronStore } from '../services/cron/CronStore.js'

// Guards the reuse-mode session rotation cap: an indefinitely-reused cron
// session grows its runtime transcript on every turn (the runtime nests each
// prior compaction summary inside a new "Previously compacted context" wrapper)
// until a single request overflows the model context. CronService rotates to a
// fresh session once countRunsForSession crosses the cap; this exercises the
// store method that drives that decision.

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

function recordRun(
  store: CronStore,
  jobId: string,
  sessionId: string,
  status: 'ok' | 'error' | 'skipped',
): void {
  const run = store.createRun(jobId, 'org', 'user')
  store.updateRunStatus(run.id, { status, sessionId })
}

describe('cron reuse cap: countRunsForSession', () => {
  let db: DatabaseSync
  let store: CronStore

  beforeEach(() => {
    db = makeDb()
    store = new CronStore(db)
  })

  it('counts runs that used a session, scoped by job and session', () => {
    recordRun(store, 'job-1', 'sess-A', 'ok')
    recordRun(store, 'job-1', 'sess-A', 'error')
    recordRun(store, 'job-1', 'sess-B', 'ok') // different session
    recordRun(store, 'job-2', 'sess-A', 'ok') // different job

    expect(store.countRunsForSession('job-1', 'sess-A')).toBe(2)
    expect(store.countRunsForSession('job-1', 'sess-B')).toBe(1)
    expect(store.countRunsForSession('job-2', 'sess-A')).toBe(1)
    expect(store.countRunsForSession('job-1', 'sess-missing')).toBe(0)
  })

  it('counts errored runs (a wedged session is exactly what we rotate)', () => {
    recordRun(store, 'job-1', 'sess-A', 'error')
    recordRun(store, 'job-1', 'sess-A', 'error')
    recordRun(store, 'job-1', 'sess-A', 'error')
    expect(store.countRunsForSession('job-1', 'sess-A')).toBe(3)
  })

  it('excludes skipped runs (they never sent a turn)', () => {
    recordRun(store, 'job-1', 'sess-A', 'ok')
    recordRun(store, 'job-1', 'sess-A', 'skipped')
    recordRun(store, 'job-1', 'sess-A', 'skipped')
    expect(store.countRunsForSession('job-1', 'sess-A')).toBe(1)
  })

  it('does not count the in-flight run before its session is stamped', () => {
    // createRun inserts session_id = NULL; resolveSessionForRun runs before
    // markRunSessionStarted stamps it. So the current run must not be counted.
    recordRun(store, 'job-1', 'sess-A', 'ok')
    store.createRun('job-1', 'org', 'user') // queued, session_id NULL
    expect(store.countRunsForSession('job-1', 'sess-A')).toBe(1)
  })
})
