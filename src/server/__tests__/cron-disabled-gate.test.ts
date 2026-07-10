import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createCronApi } from '../api/cron.js'
import { CronStore } from '../services/cron/CronStore.js'
import type { CronService } from '../services/cron/CronService.js'

// When client cron is disabled org-wide (clientCronEnabled=false), the #83 gate
// blocks non-admins from CREATING jobs — but managing an EXISTING job (trigger/
// update/delete) is allowed for anyone who can manage it (owner, co-owner,
// admin). This file drives the real API path with the flag flipped off.
let clientCronEnabled = false
mock.module('../systemSettings.js', () => ({
  getSystemSettings: () => ({ clientCronEnabled }),
}))

type DatabaseSync = ConstructorParameters<typeof CronStore>[0]

function makeDb(): DatabaseSync {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
      co_owner_ids TEXT, executor_user_id TEXT,
      name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, deleted_at INTEGER,
      schedule_kind TEXT NOT NULL, schedule_value TEXT NOT NULL, schedule_tz TEXT, schedule_description TEXT,
      payload_message TEXT, conversation_mode TEXT, bound_session_id TEXT, last_session_id TEXT,
      assistant_id TEXT, assistant_name TEXT, workspace TEXT, runtime_json TEXT,
      next_run_at INTEGER, lease_until INTEGER, last_run_at INTEGER, last_status TEXT, last_error TEXT,
      run_count INTEGER DEFAULT 0, retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE cron_job_runs (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
      session_id TEXT, status TEXT NOT NULL, started_at INTEGER, finished_at INTEGER,
      error TEXT, summary TEXT, created_at INTEGER NOT NULL
    );
  `)
  return db as unknown as DatabaseSync
}

const ORG_USERS = new Set(['creator', 'co-1'])
function stubService() {
  return {
    updateJob: () => {},
    addJob: () => {},
    removeJob: () => {},
    // triggerJob is exercised by the co-owner manual-run case; return a run row.
    triggerJob: async () => ({
      id: 'run-1', jobId: 'j', orgId: 'org-a', userId: 'co-1', sessionId: null,
      status: 'queued', startedAt: null, finishedAt: null, error: null, summary: null, createdAt: 0,
    }),
  } as unknown as CronService
}

// An admin creates the job (so it exists even with cron disabled), then a
// non-admin co-owner / the owner manage it.
const ADMIN = { orgId: 'org-a', userId: 'creator', scopes: ['*'] }
const CO_OWNER = { orgId: 'org-a', userId: 'co-1', scopes: [] as string[] }
const OUTSIDER = { orgId: 'org-a', userId: 'stranger', scopes: ['sessions:create'] }

describe('cron_disabled_by_org gate — existing-job management bypass', () => {
  let store: CronStore
  let api: ReturnType<typeof createCronApi>
  let jobId: string

  beforeEach(async () => {
    clientCronEnabled = false
    const db = makeDb()
    store = new CronStore(db)
    api = createCronApi(db, {
      cronService: stubService(),
      isOrgUser: (userId: string) => ORG_USERS.has(userId),
    })
    // Seed directly via the store so we don't depend on create being allowed.
    const job = store.insert({
      orgId: 'org-a', userId: 'creator', coOwnerIds: ['co-1'], executorUserId: 'creator',
      name: 'j', schedule: { kind: 'cron', value: '0 9 * * *' },
      payloadMessage: 'go', conversationMode: 'new',
    })
    jobId = job.id
  })

  it('a non-admin co-owner can TRIGGER an existing job while cron is disabled', async () => {
    const res = await api.triggerJob(CO_OWNER, jobId)
    expect(res.success).toBe(true)
  })

  it('a non-admin co-owner can UPDATE an existing job while cron is disabled', async () => {
    const res = await api.updateJob(CO_OWNER, jobId, { name: 'renamed' })
    expect(res.success).toBe(true)
    expect(store.getById(jobId)!.name).toBe('renamed')
  })

  it('a non-admin co-owner can DELETE an existing job while cron is disabled', async () => {
    const res = await api.deleteJob(CO_OWNER, jobId)
    expect(res.success).toBe(true)
    expect(store.getById(jobId)).toBeNull()
  })

  it('the owner can manage their own existing job while cron is disabled', async () => {
    const res = await api.updateJob(ADMIN, jobId, { name: 'owner-renamed' })
    expect(res.success).toBe(true)
  })

  it('a non-manager (not owner/co-owner/admin) is still denied — access, not the disabled gate', async () => {
    const res = await api.updateJob(OUTSIDER, jobId, { name: 'nope' })
    expect(res.success).toBe(false)
    expect(res.message).toBe('Access denied')
  })

  it('creating a NEW job as a non-admin is still blocked while cron is disabled (#83 unchanged)', async () => {
    const res = await api.createJob(OUTSIDER, {
      name: 'new', schedule: { kind: 'cron', value: '0 9 * * *' },
      payloadMessage: 'go', conversationMode: 'new',
    })
    expect(res.success).toBe(false)
    expect(res.message).toBe('cron_disabled_by_org')
  })

  it('an admin can still create while cron is disabled', async () => {
    const res = await api.createJob(ADMIN, {
      name: 'admin-new', schedule: { kind: 'cron', value: '0 9 * * *' },
      payloadMessage: 'go', conversationMode: 'new',
    })
    expect(res.success).toBe(true)
  })
})
