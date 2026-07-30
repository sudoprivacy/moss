import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  EventTriggerStore,
  generateSecret,
  secretMatches,
  sha256,
} from '../services/eventTrigger/EventTriggerStore.js'
import { buildPrompt } from '../services/eventTrigger/EventTriggerService.js'

// bun:sqlite stands in for node:sqlite's DatabaseSync (bun cannot resolve
// node:sqlite). The subset the store uses — prepare().run()/get()/all(),
// exec(), and result.changes — is API-compatible. Same approach as
// cron-lease-dedup.test.ts.
type DatabaseSync = ConstructorParameters<typeof EventTriggerStore>[0]

function makeDb(): DatabaseSync {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE event_triggers (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      deleted_at INTEGER,
      secret_hash TEXT NOT NULL,
      secret_prefix TEXT NOT NULL,
      prompt_template TEXT NOT NULL,
      assistant_name TEXT,
      conversation_mode TEXT NOT NULL DEFAULT 'new',
      bound_session_id TEXT,
      last_session_id TEXT,
      workspace TEXT,
      timeout_ms INTEGER,
      rate_limit_per_min INTEGER,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE event_trigger_runs (
      id TEXT PRIMARY KEY,
      trigger_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL,
      payload_json TEXT,
      idempotency_key TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      error TEXT,
      summary TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_event_trigger_runs_idem
      ON event_trigger_runs (trigger_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `)
  return db as unknown as DatabaseSync
}

function seedTrigger(store: EventTriggerStore, overrides: Partial<{ orgId: string; userId: string; name: string }> = {}) {
  return store.insert({
    orgId: overrides.orgId ?? 'org-1',
    userId: overrides.userId ?? 'user-1',
    name: overrides.name ?? 'Order review',
    promptTemplate: 'Analyse the submitted order.',
  })
}

describe('EventTriggerStore secrets', () => {
  it('stores only a hash and verifies the plaintext secret', () => {
    const db = makeDb()
    const store = new EventTriggerStore(db)
    const { trigger, secret } = seedTrigger(store)

    // The raw secret must never be recoverable from the row.
    expect(trigger.secretHash).toBe(sha256(secret))
    expect(trigger.secretHash).not.toContain(secret)
    expect(secret.startsWith('moss_evt_')).toBe(true)

    expect(secretMatches(secret, trigger.secretHash)).toBe(true)
    expect(secretMatches(`${secret}x`, trigger.secretHash)).toBe(false)
    expect(secretMatches('moss_evt_wrong', trigger.secretHash)).toBe(false)
  })

  it('rotation invalidates the previous secret', () => {
    const db = makeDb()
    const store = new EventTriggerStore(db)
    const { trigger, secret: oldSecret } = seedTrigger(store)

    const rotated = store.rotateSecret(trigger.id)!
    expect(secretMatches(oldSecret, rotated.trigger.secretHash)).toBe(false)
    expect(secretMatches(rotated.secret, rotated.trigger.secretHash)).toBe(true)
  })

  it('generates a distinct secret every time', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) seen.add(generateSecret().secret)
    expect(seen.size).toBe(50)
  })
})

describe('EventTriggerStore run claiming', () => {
  let db: DatabaseSync
  let store: EventTriggerStore
  let triggerId: string

  beforeEach(() => {
    db = makeDb()
    store = new EventTriggerStore(db)
    triggerId = seedTrigger(store).trigger.id
  })

  function enqueue(n: number) {
    for (let i = 0; i < n; i++) {
      store.createRun({ triggerId, orgId: 'org-1', userId: 'user-1', payloadJson: `{"i":${i}}` })
    }
  }

  // The core concurrency guarantee: two ticks must never claim the same run,
  // or a single external event would be executed twice.
  it('never hands the same run to two concurrent claims', () => {
    enqueue(10)
    const first = store.claimQueuedRuns(4)
    const second = store.claimQueuedRuns(4)

    expect(first).toHaveLength(4)
    expect(second).toHaveLength(4)

    const ids = new Set([...first, ...second].map(r => r.id))
    expect(ids.size).toBe(8) // disjoint — no overlap
    expect(store.countActiveRuns()).toBe(8)
  })

  it('respects the requested slot limit', () => {
    enqueue(10)
    expect(store.claimQueuedRuns(3)).toHaveLength(3)
    expect(store.claimQueuedRuns(0)).toHaveLength(0)
    expect(store.claimQueuedRuns(-1)).toHaveLength(0)
  })

  it('claims in FIFO order and marks runs running', () => {
    enqueue(3)
    const claimed = store.claimQueuedRuns(3)
    expect(claimed.map(r => JSON.parse(r.payloadJson!).i)).toEqual([0, 1, 2])
    for (const run of claimed) {
      expect(run.status).toBe('running')
      expect(run.startedAt).not.toBeNull()
    }
  })

  it('returns nothing when the queue is empty', () => {
    expect(store.claimQueuedRuns(5)).toHaveLength(0)
  })
})

describe('EventTriggerStore idempotency', () => {
  it('rejects a duplicate idempotency key for the same trigger', () => {
    const db = makeDb()
    const store = new EventTriggerStore(db)
    const triggerId = seedTrigger(store).trigger.id

    const first = store.createRun({
      triggerId, orgId: 'org-1', userId: 'user-1', payloadJson: '{"a":1}', idempotencyKey: 'evt-99',
    })
    const second = store.createRun({
      triggerId, orgId: 'org-1', userId: 'user-1', payloadJson: '{"a":1}', idempotencyKey: 'evt-99',
    })

    expect(first).not.toBeNull()
    expect(second).toBeNull() // collision -> caller returns the original
    expect(store.findRunByIdempotencyKey(triggerId, 'evt-99')!.id).toBe(first!.id)
    expect(store.listRunsByTrigger(triggerId)).toHaveLength(1)
  })

  it('allows the same key on a different trigger', () => {
    const db = makeDb()
    const store = new EventTriggerStore(db)
    const a = seedTrigger(store, { name: 'A' }).trigger.id
    const b = seedTrigger(store, { name: 'B' }).trigger.id

    expect(store.createRun({ triggerId: a, orgId: 'org-1', userId: 'user-1', payloadJson: null, idempotencyKey: 'k' })).not.toBeNull()
    expect(store.createRun({ triggerId: b, orgId: 'org-1', userId: 'user-1', payloadJson: null, idempotencyKey: 'k' })).not.toBeNull()
  })

  it('allows unlimited runs with no idempotency key', () => {
    const db = makeDb()
    const store = new EventTriggerStore(db)
    const triggerId = seedTrigger(store).trigger.id
    for (let i = 0; i < 5; i++) {
      expect(store.createRun({ triggerId, orgId: 'org-1', userId: 'user-1', payloadJson: null })).not.toBeNull()
    }
    expect(store.listRunsByTrigger(triggerId)).toHaveLength(5)
  })
})

describe('EventTriggerStore lifecycle', () => {
  it('reaps stale runs so a crash cannot hold a slot forever', () => {
    const db = makeDb()
    const store = new EventTriggerStore(db)
    const triggerId = seedTrigger(store).trigger.id

    store.createRun({ triggerId, orgId: 'org-1', userId: 'user-1', payloadJson: null })
    store.claimQueuedRuns(1)
    expect(store.countActiveRuns()).toBe(1)

    const reaped = store.reapStaleRuns(Date.now() + 1000, 'Server restarted')
    expect(reaped).toBe(1)
    expect(store.countActiveRuns()).toBe(0)

    const run = store.listRunsByTrigger(triggerId)[0]
    expect(run.status).toBe('error')
    expect(run.error).toBe('Server restarted')
    expect(run.finishedAt).not.toBeNull()
  })

  it('stamps finished_at on terminal statuses only', () => {
    const db = makeDb()
    const store = new EventTriggerStore(db)
    const triggerId = seedTrigger(store).trigger.id
    const run = store.createRun({ triggerId, orgId: 'org-1', userId: 'user-1', payloadJson: null })!

    store.updateRunStatus(run.id, { status: 'running', sessionId: 'sess-1' })
    expect(store.getRunById(run.id)!.finishedAt).toBeNull()

    store.updateRunStatus(run.id, { status: 'ok', summary: 'done' })
    const done = store.getRunById(run.id)!
    expect(done.finishedAt).not.toBeNull()
    // sessionId uses COALESCE, so a later null must not clobber it.
    expect(done.sessionId).toBe('sess-1')
  })

  it('hides soft-deleted triggers from reads and listings', () => {
    const db = makeDb()
    const store = new EventTriggerStore(db)
    const triggerId = seedTrigger(store).trigger.id

    store.softDelete(triggerId)
    expect(store.getById(triggerId)).toBeNull()
    expect(store.listByOrg('org-1')).toHaveLength(0)
  })

  it('scopes listings by org', () => {
    const db = makeDb()
    const store = new EventTriggerStore(db)
    seedTrigger(store, { orgId: 'org-1', name: 'mine' })
    seedTrigger(store, { orgId: 'org-2', name: 'theirs' })

    expect(store.listByOrg('org-1').map(t => t.name)).toEqual(['mine'])
    expect(store.listByOrg('org-2').map(t => t.name)).toEqual(['theirs'])
  })
})

describe('buildPrompt', () => {
  it('appends the payload as a fenced JSON block', () => {
    const out = buildPrompt('Analyse the order.', '{"order_id":"SO-1"}')
    expect(out).toContain('Analyse the order.')
    expect(out).toContain('## Event payload')
    expect(out).toContain('```json')
    expect(out).toContain('"order_id": "SO-1"') // pretty-printed
  })

  it('returns the template unchanged when there is no payload', () => {
    expect(buildPrompt('Just run.', null)).toBe('Just run.')
    expect(buildPrompt('Just run.', '   ')).toBe('Just run.')
  })

  it('passes malformed JSON through rather than dropping it', () => {
    const out = buildPrompt('Analyse.', 'not-json')
    expect(out).toContain('not-json')
  })
})
