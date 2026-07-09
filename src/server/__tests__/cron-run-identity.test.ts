import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CronService, type CronServiceConfig } from '../services/cron/CronService.js'
import { CronStore } from '../services/cron/CronStore.js'

// Control the clientCronEnabled gate without touching on-disk settings: stub the
// systemSettings module so getSystemSettings() reads our in-memory flag.
let clientCronEnabled = true
mock.module('../systemSettings.js', () => ({
  getSystemSettings: () => ({ clientCronEnabled }),
}))

// Verifies which identity a run executes under:
//  - scheduled (executeJob): the job's EXECUTOR, while the clientCronEnabled gate
//    keys off the CREATOR's capability.
//  - manual (triggerJob): the user who triggered (the actor).
// We stub runtimeService.createSession to capture the session userId and then
// throw, short-circuiting the socket path — identity is resolved before that.

type DatabaseSync = ConstructorParameters<typeof CronService>[0]

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

// Auth roster: creator is an admin; the executor + actor are plain users.
const AUTH: Record<string, { role: string; scopes: string[] }> = {
  creator: { role: 'admin', scopes: ['*'] },
  'exec-user': { role: 'user', scopes: ['cron:self'] },
  'actor-user': { role: 'user', scopes: ['cron:self'] },
}

function buildService(db: DatabaseSync) {
  const sessionUserIds: string[] = []
  const authLookups: string[] = []
  const config: CronServiceConfig = {
    runtimeService: {
      // Capture the identity the session would run under, then abort the run
      // before the socket path (we only care about identity resolution here).
      createSession: async (opts: { userId: string }) => {
        sessionUserIds.push(opts.userId)
        throw new Error('stop-after-identity')
      },
    } as unknown as CronServiceConfig['runtimeService'],
    runtimeDir: '/tmp/runtime',
    defaultRuntime: 'host',
    dockerContainerMode: 'session',
    getUserAuth: async (userId: string) => {
      authLookups.push(userId)
      return AUTH[userId] ?? null
    },
  }
  return { service: new CronService(db, config), sessionUserIds, authLookups }
}

describe('CronService run identity', () => {
  let db: DatabaseSync
  let store: CronStore

  beforeEach(() => {
    db = makeDb()
    store = new CronStore(db)
    clientCronEnabled = true
  })
  afterEach(() => {
    clientCronEnabled = true
  })

  function insertJob(executorUserId: string | null) {
    return store.insert({
      orgId: 'org-a',
      userId: 'creator',
      coOwnerIds: executorUserId && executorUserId !== 'creator' ? [executorUserId] : [],
      executorUserId,
      name: 'j',
      schedule: { kind: 'cron', value: '0 9 * * *' },
      payloadMessage: 'go',
      conversationMode: 'new',
    })
  }

  it('manual trigger runs under the actor (clicking user), not the executor', async () => {
    const job = insertJob('exec-user')
    const { service, sessionUserIds } = buildService(db)
    await expect(
      service.triggerJob(job.id, { userId: 'actor-user', orgId: 'org-a' }),
    ).rejects.toThrow('stop-after-identity')
    expect(sessionUserIds).toEqual(['actor-user'])
    // The run row is attributed to the actor.
    const run = db.prepare('SELECT user_id FROM cron_job_runs WHERE job_id = ?').get(job.id) as { user_id: string }
    expect(run.user_id).toBe('actor-user')
  })

  it('manual trigger without an actor falls back to the executor', async () => {
    const job = insertJob('exec-user')
    const { service, sessionUserIds } = buildService(db)
    await expect(service.triggerJob(job.id)).rejects.toThrow('stop-after-identity')
    expect(sessionUserIds).toEqual(['exec-user'])
  })

  it('scheduled run executes under the executor identity', async () => {
    const job = insertJob('exec-user')
    const { service, sessionUserIds } = buildService(db)
    // executeJob is private; drive it via the public checkDueJobs-equivalent by
    // calling the exposed run path. We access it through triggerJob's sibling by
    // invoking the private method reflectively (kept internal on purpose).
    await (service as unknown as { executeJob: (id: string) => Promise<void> }).executeJob(job.id)
    // The run is created + session attempted under the executor.
    expect(sessionUserIds).toEqual(['exec-user'])
    const run = db.prepare('SELECT user_id, status FROM cron_job_runs WHERE job_id = ?').get(job.id) as { user_id: string; status: string }
    expect(run.user_id).toBe('exec-user')
    // createSession threw, so the run ends in error — identity is what we assert.
    expect(run.status).toBe('error')
  })

  it('clientCronEnabled=false: admin-created job with a normal-user executor still runs (gate keys off creator)', async () => {
    clientCronEnabled = false
    const job = insertJob('exec-user') // creator is admin, executor is a plain user
    const { service, sessionUserIds } = buildService(db)
    await (service as unknown as { executeJob: (id: string) => Promise<void> }).executeJob(job.id)
    // Not skipped: the run proceeded to session creation under the executor.
    expect(sessionUserIds).toEqual(['exec-user'])
    const run = db.prepare('SELECT status FROM cron_job_runs WHERE job_id = ?').get(job.id) as { status: string }
    expect(run.status).not.toBe('skipped')
  })

  it('clientCronEnabled=false: a non-admin-created job is skipped', async () => {
    clientCronEnabled = false
    // Creator is a plain user here (executor === creator, a normal user).
    const job = store.insert({
      orgId: 'org-a', userId: 'exec-user', executorUserId: 'exec-user',
      name: 'j', schedule: { kind: 'cron', value: '0 9 * * *' },
      payloadMessage: 'go', conversationMode: 'new',
    })
    const { service, sessionUserIds } = buildService(db)
    await (service as unknown as { executeJob: (id: string) => Promise<void> }).executeJob(job.id)
    // Skipped before session creation.
    expect(sessionUserIds).toEqual([])
    const run = db.prepare('SELECT status FROM cron_job_runs WHERE job_id = ?').get(job.id) as { status: string }
    expect(run.status).toBe('skipped')
  })
})
