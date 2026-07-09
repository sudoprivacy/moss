import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createCronApi } from '../api/cron.js'
import { CronStore } from '../services/cron/CronStore.js'
import type { CronService } from '../services/cron/CronService.js'

// The "owner updates their own job" case drives the cronDisabledError gate,
// which reads getSystemSettings().clientCronEnabled. Pin it to true so this
// suite doesn't depend on the developer's ~/.moss/settings.json (which may set
// it false); the admin cases bypass the gate regardless.
mock.module('../systemSettings.js', () => ({
  getSystemSettings: () => ({ clientCronEnabled: true }),
}))

// #85 follow-up: an admin console must be able to FULLY update any cron job in
// its org — edit schedule/payload/name and re-enable — not merely disable it.
// Previously updateJob capped a non-owner admin to a single `enabled:false`
// toggle, contradicting the "admin has full CRUD in-org" model. These tests
// drive the real updateJob API path with an in-memory store.

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
      enabled INTEGER NOT NULL,
      deleted_at INTEGER,
      schedule_kind TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      schedule_tz TEXT,
      schedule_description TEXT,
      payload_message TEXT,
      conversation_mode TEXT,
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
      run_count INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return db as unknown as DatabaseSync
}

// updateJob calls config.cronService.updateJob(job); a no-op stub is enough to
// observe the API's authorization + persistence behavior.
function stubService() {
  const calls: unknown[] = []
  return {
    service: { updateJob: (job: unknown) => { calls.push(job) }, addJob: () => {} } as unknown as CronService,
    calls,
  }
}

const OWNER = { orgId: 'org-a', userId: 'user-owner', scopes: [] as string[] }
const OTHER = { orgId: 'org-a', userId: 'user-other', scopes: ['sessions:create'] }
// Admins/super_admins carry wildcard scope in production.
const ADMIN = { orgId: 'org-a', userId: 'admin-1', scopes: ['*'] }
const CROSS_ORG_ADMIN = { orgId: 'org-b', userId: 'admin-2', scopes: ['*'] }

describe('cron updateJob — admin full-update capability (#85)', () => {
  let store: CronStore
  let api: ReturnType<typeof createCronApi>
  let jobId: string

  beforeEach(() => {
    const db = makeDb()
    store = new CronStore(db)
    api = createCronApi(db, { cronService: stubService().service })
    const job = store.insert({
      orgId: 'org-a',
      userId: 'user-owner',
      name: 'orig',
      enabled: false, // start disabled so we can assert admins can re-enable
      schedule: { kind: 'cron', value: '0 9 * * *' },
      payloadMessage: 'hi',
      conversationMode: 'new',
    })
    jobId = job.id
  })

  it('lets an admin edit schedule, payload and name on another user’s job', async () => {
    const res = await api.updateJob(ADMIN, jobId, {
      name: 'edited-by-admin',
      schedule: { kind: 'cron', value: '30 8 * * 1' },
      payloadMessage: 'changed',
    })
    expect(res.success).toBe(true)
    const after = store.getById(jobId)!
    expect(after.name).toBe('edited-by-admin')
    expect(after.schedule.value).toBe('30 8 * * 1')
    expect(after.payloadMessage).toBe('changed')
  })

  it('lets an admin re-enable another user’s job', async () => {
    const res = await api.updateJob(ADMIN, jobId, { enabled: true })
    expect(res.success).toBe(true)
    expect(store.getById(jobId)!.enabled).toBe(true)
  })

  it('still lets the owner update their own job', async () => {
    const res = await api.updateJob(OWNER, jobId, { name: 'owner-edit' })
    expect(res.success).toBe(true)
    expect(store.getById(jobId)!.name).toBe('owner-edit')
  })

  it('denies a non-admin non-owner', async () => {
    const res = await api.updateJob(OTHER, jobId, { name: 'nope' })
    expect(res.success).toBe(false)
    expect(store.getById(jobId)!.name).toBe('orig')
  })

  it('denies an admin from another org (capability does not cross org)', async () => {
    const res = await api.updateJob(CROSS_ORG_ADMIN, jobId, { name: 'cross-org' })
    expect(res.success).toBe(false)
    expect(store.getById(jobId)!.name).toBe('orig')
  })
})
