import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventTriggerStore } from '../services/eventTrigger/EventTriggerStore.js'
import { EventTriggerService, resolveTriggerWorkspace } from '../services/eventTrigger/EventTriggerService.js'

type DatabaseSync = ConstructorParameters<typeof EventTriggerStore>[0]

function makeDb(): DatabaseSync {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE event_triggers (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
      name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, deleted_at INTEGER,
      secret_hash TEXT NOT NULL, secret_prefix TEXT NOT NULL, prompt_template TEXT NOT NULL,
      assistant_name TEXT, conversation_mode TEXT NOT NULL DEFAULT 'new',
      bound_session_id TEXT, last_session_id TEXT, workspace TEXT,
      timeout_ms INTEGER, rate_limit_per_min INTEGER,
      last_used_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE event_trigger_runs (
      id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
      session_id TEXT, status TEXT NOT NULL, payload_json TEXT, idempotency_key TEXT,
      started_at INTEGER, finished_at INTEGER, error TEXT, summary TEXT, created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_event_trigger_runs_idem
      ON event_trigger_runs (trigger_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
  `)
  return db as unknown as DatabaseSync
}

/**
 * A RuntimeService stand-in that blocks each run until we release it, so the
 * concurrency cap can be observed rather than raced.
 */
function makeRuntimeStub() {
  const gates: Array<() => void> = []
  const terminated: string[] = []
  let created = 0
  return {
    gates,
    terminated,
    get createdCount() { return created },
    releaseAll() { for (const g of gates.splice(0)) g() },
    runtime: {
      createSession: async () => {
        created += 1
        return { sessionId: `sess-${created}` }
      },
      getSession: () => null,
      ensureSessionReady: async () => ({ attempt: {} }),
      connectToAttempt: async () => {
        // Never settles until released; driveSession awaits socket events.
        await new Promise<void>(resolve => gates.push(resolve))
        throw new Error('stub socket closed')
      },
      terminateSession: async (sessionId: string) => {
        terminated.push(sessionId)
      },
    } as never,
  }
}

function makeService(db: DatabaseSync, runtimeService: never) {
  return new EventTriggerService(db, {
    runtimeService,
    runtimeDir: '/tmp/moss-test-runtime',
    defaultRuntime: 'host',
    dockerContainerMode: 'session',
    getUserAuth: async () => ({ role: 'user', scopes: ['sessions:create'] }),
  })
}

describe('EventTriggerService concurrency', () => {
  let db: DatabaseSync
  let store: EventTriggerStore
  let triggerId: string

  beforeEach(() => {
    db = makeDb()
    store = new EventTriggerStore(db)
    triggerId = store.insert({
      orgId: 'org-1', userId: 'user-1', name: 'T', promptTemplate: 'Analyse.',
    }).trigger.id
  })

  it('never exceeds the concurrency cap, and drains the rest afterwards', async () => {
    const stub = makeRuntimeStub()
    const service = makeService(db, stub.runtime)

    // 8 events, default cap of 3.
    for (let i = 0; i < 8; i++) {
      store.createRun({ triggerId, orgId: 'org-1', userId: 'user-1', payloadJson: `{"i":${i}}` })
    }

    await service.tickOnce()
    await new Promise(r => setTimeout(r, 50))

    // Exactly the cap is in flight; the remainder stays queued.
    expect(stub.createdCount).toBe(3)
    expect(store.countActiveRuns()).toBe(3)

    // A second tick while the slots are full must claim nothing.
    await service.tickOnce()
    await new Promise(r => setTimeout(r, 20))
    expect(stub.createdCount).toBe(3)

    // Release the in-flight runs; they fail (stub socket), freeing slots.
    stub.releaseAll()
    await new Promise(r => setTimeout(r, 50))
    expect(store.countActiveRuns()).toBe(0)

    await service.tickOnce()
    await new Promise(r => setTimeout(r, 50))
    expect(stub.createdCount).toBe(6)
  })

  it('skips runs whose trigger was deleted or disabled after enqueue', async () => {
    const stub = makeRuntimeStub()
    const service = makeService(db, stub.runtime)

    store.createRun({ triggerId, orgId: 'org-1', userId: 'user-1', payloadJson: '{}' })
    store.softDelete(triggerId)

    await service.tickOnce()
    await new Promise(r => setTimeout(r, 50))

    const run = store.listRunsByTrigger(triggerId)[0]
    expect(run.status).toBe('skipped')
    expect(stub.createdCount).toBe(0)
  })

  // Regression: found in end-to-end testing. A 'new'-mode session lingers as
  // active/detached after the run, so without explicit teardown every event
  // permanently consumes one of the runtime's maxSessionsPerUser slots and the
  // trigger bricks itself after a handful of events.
  it('retires the session it created so slots are not leaked', async () => {
    const stub = makeRuntimeStub()
    const service = makeService(db, stub.runtime)

    for (let i = 0; i < 3; i++) {
      store.createRun({ triggerId, orgId: 'org-1', userId: 'user-1', payloadJson: '{}' })
    }
    await service.tickOnce()
    await new Promise(r => setTimeout(r, 20))
    stub.releaseAll()
    await new Promise(r => setTimeout(r, 60))

    // Every session created must have been torn down, even though each run
    // failed — the teardown lives in a finally, not the success path.
    expect(stub.terminated.length).toBe(stub.createdCount)
    expect(new Set(stub.terminated).size).toBe(stub.createdCount)
  })

  it('records a failure when the runner dies without agent output', async () => {
    const stub = makeRuntimeStub()
    const service = makeService(db, stub.runtime)

    store.createRun({ triggerId, orgId: 'org-1', userId: 'user-1', payloadJson: '{}' })
    await service.tickOnce()
    await new Promise(r => setTimeout(r, 20))
    stub.releaseAll()
    await new Promise(r => setTimeout(r, 50))

    // The key behaviour: a dead runner is an error, never a silent success.
    const run = store.listRunsByTrigger(triggerId)[0]
    expect(run.status).toBe('error')
    expect(run.error).toBeTruthy()
  })
})

describe('resolveTriggerWorkspace', () => {
  it('defaults to a per-trigger workspace under runtimeDir', () => {
    const ws = resolveTriggerWorkspace({
      triggerId: 'trg-1',
      runtimeDir: '/data/runtime',
      defaultRuntime: 'host',
      dockerContainerMode: 'session',
    })
    expect(ws).toBe('/data/runtime/event-triggers/trg-1/workspace')
  })

  it('honours an explicit workspace', () => {
    const ws = resolveTriggerWorkspace({
      triggerId: 'trg-1',
      triggerWorkspace: '/srv/work',
      runtimeDir: '/data/runtime',
      defaultRuntime: 'host',
      dockerContainerMode: 'session',
    })
    expect(ws).toBe('/srv/work')
  })

  it('rejects an unmounted path in docker user-container mode', () => {
    expect(() =>
      resolveTriggerWorkspace({
        triggerId: 'trg-1',
        triggerWorkspace: '/somewhere/else',
        runtimeDir: '/data/runtime',
        defaultRuntime: 'docker',
        dockerContainerMode: 'user',
        mossHome: '/data/moss',
      }),
    ).toThrow(/not mounted/)
  })

  it('allows a path inside runtimeDir in docker user-container mode', () => {
    const ws = resolveTriggerWorkspace({
      triggerId: 'trg-1',
      triggerWorkspace: '/data/runtime/custom',
      runtimeDir: '/data/runtime',
      defaultRuntime: 'docker',
      dockerContainerMode: 'user',
      mossHome: '/data/moss',
    })
    expect(ws).toBe('/data/runtime/custom')
  })
})

describe('EventTriggerService construction', () => {
  it('fails loud when runtimeDir is missing', () => {
    // The project has no type-check step, so this must fail at construction
    // rather than deep inside path.join at run time.
    expect(() =>
      new EventTriggerService(makeDb(), {
        runtimeService: {} as never,
        runtimeDir: '',
        defaultRuntime: 'host',
        dockerContainerMode: 'session',
        getUserAuth: async () => null,
      }),
    ).toThrow(/runtimeDir is required/)
  })
})
