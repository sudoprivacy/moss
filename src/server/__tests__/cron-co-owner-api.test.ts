import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createCronApi } from '../api/cron.js'
import { CronStore } from '../services/cron/CronStore.js'
import type { CronService } from '../services/cron/CronService.js'

// This suite drives the real createJob/updateJob path, which consults
// getSystemSettings().clientCronEnabled via the cronDisabledError gate. Pin it
// to true so non-admin owner/co-owner mutations aren't blocked — the tests are
// about co-owner/executor logic, not the org cron-disabled policy (that gate is
// covered by cron-mutation-gate.test.ts). Without this the suite would depend on
// the developer's ~/.moss/settings.json.
mock.module('../systemSettings.js', () => ({
  getSystemSettings: () => ({ clientCronEnabled: true }),
}))

// Drives the real createJob/updateJob API path (in-memory store) to cover the
// co-owner + executor validation and the executor auto-repoint on co-owner
// removal. isOrgUser is stubbed to a fixed org roster.

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

const ORG_USERS = new Set(['creator', 'co-1', 'co-2'])
function stubService() {
  return { updateJob: () => {}, addJob: () => {}, removeJob: () => {} } as unknown as CronService
}

const CREATOR = { orgId: 'org-a', userId: 'creator', scopes: ['*'] }

describe('cron co-owner + executor API', () => {
  let store: CronStore
  let api: ReturnType<typeof createCronApi>

  beforeEach(() => {
    const db = makeDb()
    store = new CronStore(db)
    api = createCronApi(db, {
      cronService: stubService(),
      isOrgUser: (userId: string) => ORG_USERS.has(userId),
    })
  })

  async function createJob(coOwnerIds?: string[], executorUserId?: string | null) {
    const res = await api.createJob(CREATOR, {
      name: 'j',
      schedule: { kind: 'cron', value: '0 9 * * *' },
      payloadMessage: 'go',
      conversationMode: 'new',
      coOwnerIds,
      executorUserId,
    })
    return res
  }

  it('create defaults executor to the creator', async () => {
    const res = await createJob()
    expect(res.success).toBe(true)
    expect((res.data as { executorUserId: string }).executorUserId).toBe('creator')
  })

  it('create rejects a co-owner outside the org', async () => {
    const res = await createJob(['outsider'])
    expect(res.success).toBe(false)
    expect(res.message).toContain('not a member')
  })

  it('create rejects an executor that is not creator or co-owner', async () => {
    const res = await createJob(['co-1'], 'co-2')
    expect(res.success).toBe(false)
    expect(res.message).toContain('creator or one of the co-owners')
  })

  it('update can set co-owners + executor together', async () => {
    const created = await createJob()
    const jobId = (created.data as { id: string }).id
    const res = await api.updateJob(CREATOR, jobId, { coOwnerIds: ['co-1', 'co-2'], executorUserId: 'co-2' })
    expect(res.success).toBe(true)
    const after = store.getById(jobId)!
    expect(after.coOwnerIds.sort()).toEqual(['co-1', 'co-2'])
    expect(after.executorUserId).toBe('co-2')
  })

  it('removing the current executor from co-owners repoints executor to the creator', async () => {
    const created = await createJob(['co-1', 'co-2'], 'co-1')
    const jobId = (created.data as { id: string }).id
    // Drop co-1 (the executor) from the co-owner list without touching executor.
    const res = await api.updateJob(CREATOR, jobId, { coOwnerIds: ['co-2'] })
    expect(res.success).toBe(true)
    const after = store.getById(jobId)!
    expect(after.coOwnerIds).toEqual(['co-2'])
    // Executor was co-1 (now removed) → repointed to the creator, not left dangling.
    expect(after.executorUserId).toBe('creator')
  })

  it('explicitly setting an invalid executor is rejected (not silently repointed)', async () => {
    const created = await createJob(['co-1'], 'co-1')
    const jobId = (created.data as { id: string }).id
    // Explicitly set executor to co-2 while co-2 is not a co-owner → reject.
    const res = await api.updateJob(CREATOR, jobId, { executorUserId: 'co-2' })
    expect(res.success).toBe(false)
    expect(res.message).toContain('creator or one of the co-owners')
    // Unchanged.
    expect(store.getById(jobId)!.executorUserId).toBe('co-1')
  })

  it('a co-owner can update the job (flat parity)', async () => {
    const created = await createJob(['co-1'])
    const jobId = (created.data as { id: string }).id
    const asCoOwner = { orgId: 'org-a', userId: 'co-1', scopes: [] as string[] }
    const res = await api.updateJob(asCoOwner, jobId, { name: 'renamed-by-co-owner' })
    expect(res.success).toBe(true)
    expect(store.getById(jobId)!.name).toBe('renamed-by-co-owner')
  })

  it('response includes co-owner ids and the resolved executor', async () => {
    const created = await createJob(['co-1'], 'co-1')
    const data = created.data as { coOwnerIds: string[]; executorUserId: string }
    expect(data.coOwnerIds).toEqual(['co-1'])
    expect(data.executorUserId).toBe('co-1')
  })
})
