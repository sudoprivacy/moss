import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CronStore } from '../services/cron/CronStore.js'

// bun:sqlite stands in for node:sqlite's DatabaseSync (bun cannot resolve
// node:sqlite). The subset CronStore uses — prepare().run()/get()/all(),
// exec(), and result.changes — is API-compatible. Same approach as
// transcript-migration.test.ts.
type DatabaseSync = ConstructorParameters<typeof CronStore>[0]

// Regression test for duplicate cron runs: a run holds a lease for far less
// time than it takes to complete (lease ~30s, run up to 30 min). The dedup
// guard is that acquireLease advances next_run_at in the SAME atomic UPDATE,
// so the 60s checkDueJobs poll no longer sees the job as due while it runs.
// Before the fix, next_run_at was only advanced after completion, so every
// poll tick re-acquired the (expired) lease and fired a duplicate run.

function makeDb(): DatabaseSync {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      deleted_at INTEGER,
      schedule_kind TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      schedule_tz TEXT,
      schedule_description TEXT,
      payload_message TEXT NOT NULL,
      conversation_mode TEXT NOT NULL,
      bound_session_id TEXT,
      last_session_id TEXT,
      assistant_id TEXT,
      assistant_name TEXT,
      workspace TEXT,
      runtime_json TEXT,
      next_run_at INTEGER,
      lease_until INTEGER,
      last_run_at INTEGER,
      last_status TEXT,
      last_error TEXT,
      run_count INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return db as unknown as DatabaseSync
}

describe('cron lease + next_run_at dedup', () => {
  let db: DatabaseSync
  let store: CronStore

  beforeEach(() => {
    db = makeDb()
    store = new CronStore(db)
  })

  function insertDueJob(nextRunAt: number): string {
    const job = store.insert({
      orgId: 'org-a',
      userId: 'user-1',
      name: 'weekly report',
      schedule: { kind: 'cron', value: '0 9 * * 1' },
      payloadMessage: 'go',
      conversationMode: 'reuse',
    })
    // Make it due: insert() leaves next_run_at NULL.
    store.updateNextRunAt(job.id, nextRunAt)
    return job.id
  }

  it('only one acquireLease wins for a due job; the rest see the advanced next_run_at', () => {
    const now = 1_700_000_000_000
    const jobId = insertDueJob(now - 1000) // due 1s ago
    const nextWeek = now + 7 * 24 * 3600 * 1000

    // First fire wins and advances next_run_at to next week.
    expect(store.acquireLease(jobId, now, now + 30_000, nextWeek)).toBe(true)

    // Subsequent poll ticks (lease still held OR expired) must NOT re-fire,
    // because next_run_at is now in the future.
    expect(store.acquireLease(jobId, now + 60_000, now + 90_000, nextWeek)).toBe(false)
    expect(store.acquireLease(jobId, now + 120_000, now + 150_000, nextWeek)).toBe(false)

    const job = store.getById(jobId)!
    expect(job.nextRunAt).toBe(nextWeek)
  })

  it('re-fires only once next_run_at comes due again', () => {
    const now = 1_700_000_000_000
    const jobId = insertDueJob(now - 1000)
    const nextWeek = now + 7 * 24 * 3600 * 1000

    expect(store.acquireLease(jobId, now, now + 30_000, nextWeek)).toBe(true)
    // A tick a week later, once next_run_at is due again, fires.
    expect(
      store.acquireLease(jobId, nextWeek + 1000, nextWeek + 31_000, nextWeek + 7 * 24 * 3600 * 1000),
    ).toBe(true)
  })

  it('a one-shot win sets next_run_at NULL so it never re-fires', () => {
    const now = 1_700_000_000_000
    const jobId = insertDueJob(now - 1000)

    // 'at' jobs pass nextRunAt = null.
    expect(store.acquireLease(jobId, now, now + 30_000, null)).toBe(true)
    expect(store.getById(jobId)!.nextRunAt).toBeNull()
    // next_run_at IS NULL -> never due -> never re-fires.
    expect(store.acquireLease(jobId, now + 60_000, now + 90_000, null)).toBe(false)
  })

  it('a not-yet-due job is never acquired', () => {
    const now = 1_700_000_000_000
    const jobId = insertDueJob(now + 60_000) // due in the future
    expect(store.acquireLease(jobId, now, now + 30_000, now + 7 * 24 * 3600 * 1000)).toBe(false)
  })
})
