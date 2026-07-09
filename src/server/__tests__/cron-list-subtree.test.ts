import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CronStore } from '../services/cron/CronStore.js'

// CronStore.listBySubtree powers a dept_admin's view of every job owned by a
// member of their department subtree. bun:sqlite stands in for node:sqlite (as
// in the other cron store tests).
type DatabaseSync = ConstructorParameters<typeof CronStore>[0]

function makeDb(): DatabaseSync {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      co_owner_ids TEXT,
      executor_user_id TEXT,
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

describe('CronStore.listBySubtree', () => {
  let db: DatabaseSync
  let store: CronStore

  beforeEach(() => {
    db = makeDb()
    store = new CronStore(db)
    for (const [org, user] of [
      ['org-a', 'da'],
      ['org-a', 'member-1'],
      ['org-a', 'member-2'],
      ['org-a', 'outsider'],
      ['org-b', 'member-1'], // same user id, different org — must not leak
    ] as const) {
      store.insert({
        orgId: org,
        userId: user,
        name: `${org}:${user}`,
        schedule: { kind: 'cron', value: '0 9 * * *' },
        payloadMessage: 'go',
        conversationMode: 'new',
      })
    }
  })

  it('returns jobs for every subtree member, scoped to the org', () => {
    const jobs = store.listBySubtree('org-a', ['da', 'member-1', 'member-2'])
    expect(jobs.map(j => j.userId).sort()).toEqual(['da', 'member-1', 'member-2'])
    expect(jobs.every(j => j.orgId === 'org-a')).toBe(true)
  })

  it('excludes owners outside the subtree', () => {
    const jobs = store.listBySubtree('org-a', ['da', 'member-1', 'member-2'])
    expect(jobs.some(j => j.userId === 'outsider')).toBe(false)
  })

  it('does not cross org boundaries for a shared user id', () => {
    const jobs = store.listBySubtree('org-a', ['member-1'])
    expect(jobs).toHaveLength(1)
    expect(jobs[0].orgId).toBe('org-a')
  })

  it('an empty id set returns nothing (fail-closed)', () => {
    expect(store.listBySubtree('org-a', [])).toHaveLength(0)
  })

  it('excludes soft-deleted jobs', () => {
    const jobs = store.listBySubtree('org-a', ['member-1'])
    store.softDelete(jobs[0].id)
    expect(store.listBySubtree('org-a', ['member-1'])).toHaveLength(0)
  })
})
