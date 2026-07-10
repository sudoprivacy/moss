import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CronStore, resolveExecutorId, type CronJob } from '../services/cron/CronStore.js'
import { canReadJob, canManageJob, validateCoOwnersAndExecutor } from '../api/cron.js'

// Co-owners + transferable executor: co-owners get flat parity (view/manage/
// trigger) with the creator; a designated executor is the identity a SCHEDULED
// run uses. bun:sqlite stands in for node:sqlite, as in the other store tests.
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

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'cron_1',
    orgId: 'org-a',
    userId: 'user-owner',
    coOwnerIds: [],
    executorUserId: null,
    name: 'job',
    enabled: true,
    schedule: { kind: 'cron', value: '0 9 * * *' },
    payloadMessage: 'hi',
    conversationMode: 'new',
    boundSessionId: null,
    lastSessionId: null,
    assistantId: null,
    assistantName: null,
    workspace: null,
    runtimeJson: null,
    nextRunAt: null,
    leaseUntil: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    runCount: 0,
    retryCount: 0,
    maxRetries: 3,
    deletedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('co-owner access predicates', () => {
  const coOwner = { orgId: 'org-a', userId: 'user-co', scopes: [] as string[] }
  const stranger = { orgId: 'org-a', userId: 'user-x', scopes: ['sessions:create'] }
  const crossOrgCoOwner = { orgId: 'org-b', userId: 'user-co', scopes: [] as string[] }

  it('a co-owner can both read and manage the job (flat parity)', () => {
    const j = job({ coOwnerIds: ['user-co'] })
    expect(canReadJob(coOwner, j)).toBe(true)
    expect(canManageJob(coOwner, j)).toBe(true)
  })

  it('a same-org user who is NOT a co-owner is denied', () => {
    const j = job({ coOwnerIds: ['user-co'] })
    expect(canReadJob(stranger, j)).toBe(false)
    expect(canManageJob(stranger, j)).toBe(false)
  })

  it('co-ownership does not cross org boundaries', () => {
    // Same user id, but the job is in org-a and the actor is in org-b.
    const j = job({ orgId: 'org-a', coOwnerIds: ['user-co'] })
    expect(canReadJob(crossOrgCoOwner, j)).toBe(false)
    expect(canManageJob(crossOrgCoOwner, j)).toBe(false)
  })

  it('an empty/absent co-owner list grants nobody extra', () => {
    expect(canManageJob(coOwner, job({ coOwnerIds: [] }))).toBe(false)
    // Legacy row shape (coOwnerIds missing): the ?. guard must not throw.
    expect(canManageJob(coOwner, job({ coOwnerIds: undefined as unknown as string[] }))).toBe(false)
  })
})

describe('validateCoOwnersAndExecutor', () => {
  const isOrgUser = (userId: string, _orgId: string) =>
    ['creator', 'co-1', 'co-2'].includes(userId)

  it('accepts co-owners that are org members', () => {
    expect(
      validateCoOwnersAndExecutor({
        orgId: 'org-a', creatorUserId: 'creator', coOwnerIds: ['co-1', 'co-2'], isOrgUser,
      }),
    ).toBeNull()
  })

  it('rejects a co-owner that is not an org member', () => {
    expect(
      validateCoOwnersAndExecutor({
        orgId: 'org-a', creatorUserId: 'creator', coOwnerIds: ['outsider'], isOrgUser,
      }),
    ).toContain('not a member')
  })

  it('accepts the creator as executor with no co-owners', () => {
    expect(
      validateCoOwnersAndExecutor({
        orgId: 'org-a', creatorUserId: 'creator', executorUserId: 'creator', isOrgUser,
      }),
    ).toBeNull()
  })

  it('accepts a co-owner as executor', () => {
    expect(
      validateCoOwnersAndExecutor({
        orgId: 'org-a', creatorUserId: 'creator', coOwnerIds: ['co-1'], executorUserId: 'co-1', isOrgUser,
      }),
    ).toBeNull()
  })

  it('rejects an executor who is neither creator nor co-owner', () => {
    expect(
      validateCoOwnersAndExecutor({
        orgId: 'org-a', creatorUserId: 'creator', coOwnerIds: ['co-1'], executorUserId: 'co-2', isOrgUser,
      }),
    ).toContain('creator or one of the co-owners')
  })

  it('skips membership checks when isOrgUser is undefined (constraint logic only)', () => {
    expect(
      validateCoOwnersAndExecutor({
        orgId: 'org-a', creatorUserId: 'creator', coOwnerIds: ['anyone'], executorUserId: 'anyone',
      }),
    ).toBeNull()
  })
})

describe('resolveExecutorId', () => {
  it('returns the explicit executor when set', () => {
    expect(resolveExecutorId(job({ userId: 'creator', executorUserId: 'co-1' }))).toBe('co-1')
  })
  it('falls back to the creator (userId) when executor is null (legacy rows)', () => {
    expect(resolveExecutorId(job({ userId: 'creator', executorUserId: null }))).toBe('creator')
  })
})

describe('CronStore co-owner persistence + listing', () => {
  let db: DatabaseSync
  let store: CronStore

  beforeEach(() => {
    db = makeDb()
    store = new CronStore(db)
  })

  function insert(overrides: Partial<Parameters<CronStore['insert']>[0]> = {}) {
    return store.insert({
      orgId: 'org-a',
      userId: 'creator',
      name: 'j',
      schedule: { kind: 'cron', value: '0 9 * * *' },
      payloadMessage: 'go',
      conversationMode: 'new',
      ...overrides,
    })
  }

  it('defaults executor to the creator on insert', () => {
    const j = insert()
    expect(j.executorUserId).toBe('creator')
    expect(j.coOwnerIds).toEqual([])
  })

  it('persists explicit co-owners and executor round-trip', () => {
    const j = insert({ coOwnerIds: ['co-1', 'co-2'], executorUserId: 'co-1' })
    const reloaded = store.getById(j.id)!
    expect(reloaded.coOwnerIds).toEqual(['co-1', 'co-2'])
    expect(reloaded.executorUserId).toBe('co-1')
  })

  it('listByUser returns jobs the user owns OR co-owns', () => {
    const owned = insert({ userId: 'creator' })
    const coOwned = insert({ userId: 'someone-else', coOwnerIds: ['creator'] })
    insert({ userId: 'unrelated', coOwnerIds: ['nobody'] }) // must not appear

    const ids = store.listByUser('org-a', 'creator').map(j => j.id).sort()
    expect(ids).toEqual([owned.id, coOwned.id].sort())
  })

  it('listByUser co-owner match is org-scoped', () => {
    insert({ orgId: 'org-a', userId: 'x', coOwnerIds: ['creator'] })
    insert({ orgId: 'org-b', userId: 'y', coOwnerIds: ['creator'] })
    const jobs = store.listByUser('org-a', 'creator')
    expect(jobs.every(j => j.orgId === 'org-a')).toBe(true)
  })

  it('listBySubtree includes jobs co-owned by a subtree member', () => {
    const coOwned = insert({ userId: 'outsider', coOwnerIds: ['member-1'] })
    const owned = insert({ userId: 'member-1' })
    insert({ userId: 'outsider' }) // neither owned nor co-owned by subtree

    const ids = store.listBySubtree('org-a', ['member-1', 'member-2']).map(j => j.id).sort()
    expect(ids).toEqual([coOwned.id, owned.id].sort())
  })

  it('update can change co-owners and executor', () => {
    const j = insert({ coOwnerIds: ['co-1'], executorUserId: 'co-1' })
    const updated = store.update(j.id, { coOwnerIds: ['co-1', 'co-2'], executorUserId: 'co-2' })!
    expect(updated.coOwnerIds).toEqual(['co-1', 'co-2'])
    expect(updated.executorUserId).toBe('co-2')
  })

  it('a legacy NULL co_owner_ids row lists and maps as empty (no json_each error)', () => {
    // Simulate a pre-migration row: NULL co_owner_ids, NULL executor.
    db.prepare(`
      INSERT INTO cron_jobs (id, org_id, user_id, co_owner_ids, executor_user_id, name, enabled,
        schedule_kind, schedule_value, payload_message, conversation_mode, created_at, updated_at)
      VALUES ('legacy', 'org-a', 'creator', NULL, NULL, 'legacy', 1, 'cron', '0 9 * * *', 'go', 'new', 0, 0)
    `).run()
    const jobs = store.listByUser('org-a', 'creator')
    expect(jobs.map(j => j.id)).toContain('legacy')
    expect(store.getById('legacy')!.coOwnerIds).toEqual([])
    expect(resolveExecutorId(store.getById('legacy')!)).toBe('creator')
  })
})
