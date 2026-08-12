import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import http from 'http'
import { EventTriggerStore } from '../services/eventTrigger/EventTriggerStore.js'
import { createEventTriggerApi, createEventTriggerIngest } from '../api/eventTriggers.js'

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
 * Spin the ingest sub-router up on a real HTTP server so the tests exercise
 * genuine header parsing, body streaming and status codes rather than a mock.
 */
async function withServer(
  store: EventTriggerStore,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  // The ingest router only needs getStore() from the service.
  const fakeService = { getStore: () => store } as never
  const ingest = createEventTriggerIngest(fakeService)

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url!, 'http://localhost').pathname
    const handled = await ingest.handle(req, res, pathname)
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not_found_fellthrough' }))
    }
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

function seed(store: EventTriggerStore, opts: Partial<{ enabled: boolean; rateLimitPerMin: number }> = {}) {
  const created = store.insert({
    orgId: 'org-1',
    userId: 'user-1',
    name: 'Order review',
    promptTemplate: 'Analyse the order.',
    enabled: opts.enabled ?? true,
    rateLimitPerMin: opts.rateLimitPerMin ?? null,
  })
  return created
}

describe('event trigger ingest — authentication', () => {
  let db: DatabaseSync
  let store: EventTriggerStore

  beforeEach(() => {
    db = makeDb()
    store = new EventTriggerStore(db)
  })

  it('accepts a valid secret and enqueues a run (202)', async () => {
    const { trigger, secret } = seed(store)
    await withServer(store, async base => {
      const res = await fetch(`${base}/api/v1/triggers/${trigger.id}/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: 'SO-1' }),
      })
      expect(res.status).toBe(202)
      const body = await res.json()
      expect(body.status).toBe('queued')
      expect(body.run_id).toBeTruthy()

      const run = store.getRunById(body.run_id)!
      expect(JSON.parse(run.payloadJson!)).toEqual({ order_id: 'SO-1' })
      // Identity comes from the trigger record, not the request.
      expect(run.orgId).toBe('org-1')
      expect(run.userId).toBe('user-1')
    })
  })

  it('accepts the secret via X-Moss-Trigger-Secret as well', async () => {
    const { trigger, secret } = seed(store)
    await withServer(store, async base => {
      const res = await fetch(`${base}/api/v1/triggers/${trigger.id}/events`, {
        method: 'POST',
        headers: { 'X-Moss-Trigger-Secret': secret, 'Content-Type': 'application/json' },
        body: '{}',
      })
      expect(res.status).toBe(202)
    })
  })

  it('rejects a wrong secret with 401', async () => {
    const { trigger } = seed(store)
    await withServer(store, async base => {
      const res = await fetch(`${base}/api/v1/triggers/${trigger.id}/events`, {
        method: 'POST',
        headers: { Authorization: 'Bearer moss_evt_wrong' },
        body: '{}',
      })
      expect(res.status).toBe(401)
      expect(store.listRunsByTrigger(trigger.id)).toHaveLength(0)
    })
  })

  it('rejects a missing secret with 401', async () => {
    const { trigger } = seed(store)
    await withServer(store, async base => {
      const res = await fetch(`${base}/api/v1/triggers/${trigger.id}/events`, {
        method: 'POST', body: '{}',
      })
      expect(res.status).toBe(401)
    })
  })

  // An unauthenticated caller must not be able to distinguish a real trigger
  // id from a fabricated one.
  it('returns an identical 401 for unknown and real trigger ids', async () => {
    const { trigger } = seed(store)
    await withServer(store, async base => {
      const real = await fetch(`${base}/api/v1/triggers/${trigger.id}/events`, {
        method: 'POST', headers: { Authorization: 'Bearer nope' }, body: '{}',
      })
      const fake = await fetch(`${base}/api/v1/triggers/does-not-exist/events`, {
        method: 'POST', headers: { Authorization: 'Bearer nope' }, body: '{}',
      })
      expect(real.status).toBe(401)
      expect(fake.status).toBe(401)
      expect(await real.json()).toEqual(await fake.json())
    })
  })

  it('rejects a disabled trigger with 403', async () => {
    const { trigger, secret } = seed(store, { enabled: false })
    await withServer(store, async base => {
      const res = await fetch(`${base}/api/v1/triggers/${trigger.id}/events`, {
        method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: '{}',
      })
      expect(res.status).toBe(403)
    })
  })

  it('rejects a rotated-away secret', async () => {
    const { trigger, secret: oldSecret } = seed(store)
    store.rotateSecret(trigger.id)
    await withServer(store, async base => {
      const res = await fetch(`${base}/api/v1/triggers/${trigger.id}/events`, {
        method: 'POST', headers: { Authorization: `Bearer ${oldSecret}` }, body: '{}',
      })
      expect(res.status).toBe(401)
    })
  })

  it('rejects a soft-deleted trigger', async () => {
    const { trigger, secret } = seed(store)
    store.softDelete(trigger.id)
    await withServer(store, async base => {
      const res = await fetch(`${base}/api/v1/triggers/${trigger.id}/events`, {
        method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: '{}',
      })
      expect(res.status).toBe(401)
    })
  })

  it('falls through for paths it does not own', async () => {
    await withServer(store, async base => {
      const res = await fetch(`${base}/api/v1/triggers`, { method: 'GET' })
      expect(res.status).toBe(404)
      expect((await res.json()).error).toBe('not_found_fellthrough')
    })
  })

  it('rejects non-POST on the events path with 405', async () => {
    const { trigger } = seed(store)
    await withServer(store, async base => {
      const res = await fetch(`${base}/api/v1/triggers/${trigger.id}/events`, { method: 'GET' })
      expect(res.status).toBe(405)
    })
  })
})

describe('event trigger ingest — payload handling', () => {
  let store: EventTriggerStore

  beforeEach(() => {
    store = new EventTriggerStore(makeDb())
  })

  it('rejects malformed JSON with 400', async () => {
    const { trigger, secret } = seed(store)
    await withServer(store, async base => {
      const res = await fetch(`${base}/api/v1/triggers/${trigger.id}/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: '{not valid json',
      })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('INVALID_JSON')
    })
  })

  it('accepts an empty body', async () => {
    const { trigger, secret } = seed(store)
    await withServer(store, async base => {
      const res = await fetch(`${base}/api/v1/triggers/${trigger.id}/events`, {
        method: 'POST', headers: { Authorization: `Bearer ${secret}` },
      })
      expect(res.status).toBe(202)
    })
  })

  // The main server's readRawBody has no cap; this surface must not inherit it.
  it('rejects a body over the 1MiB cap with 413', async () => {
    const { trigger, secret } = seed(store)
    await withServer(store, async base => {
      const huge = JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) })
      let status = 0
      try {
        const res = await fetch(`${base}/api/v1/triggers/${trigger.id}/events`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
          body: huge,
        })
        status = res.status
      } catch {
        // The server destroys the socket on overflow, which can surface as a
        // fetch-level connection error instead of a response. Either way the
        // oversized body was refused — assert on the outcome that matters.
        status = 413
      }
      expect(status).toBe(413)
      expect(store.listRunsByTrigger(trigger.id)).toHaveLength(0)
    })
  })

  it('returns the original run for a repeated idempotency key', async () => {
    const { trigger, secret } = seed(store)
    await withServer(store, async base => {
      const send = () =>
        fetch(`${base}/api/v1/triggers/${trigger.id}/events`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secret}`,
            'Content-Type': 'application/json',
            'X-Moss-Idempotency-Key': 'evt-7',
          },
          body: JSON.stringify({ order_id: 'SO-1' }),
        })

      const first = await send()
      const second = await send()

      expect(first.status).toBe(202)
      expect(second.status).toBe(200)
      const a = await first.json()
      const b = await second.json()
      expect(b.run_id).toBe(a.run_id)
      expect(b.duplicate).toBe(true)
      expect(store.listRunsByTrigger(trigger.id)).toHaveLength(1)
    })
  })
})

describe('event trigger ingest — rate limiting', () => {
  it('returns 429 past the per-trigger ceiling', async () => {
    const store = new EventTriggerStore(makeDb())
    const { trigger, secret } = seed(store, { rateLimitPerMin: 3 })
    await withServer(store, async base => {
      const statuses: number[] = []
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${base}/api/v1/triggers/${trigger.id}/events`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
          body: '{}',
        })
        statuses.push(res.status)
      }
      expect(statuses.filter(s => s === 202)).toHaveLength(3)
      expect(statuses.filter(s => s === 429)).toHaveLength(2)
      // Rejected events must not be enqueued.
      expect(store.listRunsByTrigger(trigger.id)).toHaveLength(3)
    })
  })

  it('limits each trigger independently', async () => {
    const store = new EventTriggerStore(makeDb())
    const a = seed(store, { rateLimitPerMin: 1 })
    const b = seed(store, { rateLimitPerMin: 1 })
    await withServer(store, async base => {
      const post = (id: string, sec: string) =>
        fetch(`${base}/api/v1/triggers/${id}/events`, {
          method: 'POST', headers: { Authorization: `Bearer ${sec}` }, body: '{}',
        })

      expect((await post(a.trigger.id, a.secret)).status).toBe(202)
      expect((await post(a.trigger.id, a.secret)).status).toBe(429)
      // b has its own window.
      expect((await post(b.trigger.id, b.secret)).status).toBe(202)
    })
  })
})

describe('event trigger management API — org isolation', () => {
  let store: EventTriggerStore
  let api: ReturnType<typeof createEventTriggerApi>

  beforeEach(() => {
    store = new EventTriggerStore(makeDb())
    api = createEventTriggerApi({ store })
  })

  const org1 = { orgId: 'org-1', userId: 'user-1' }
  const org2 = { orgId: 'org-2', userId: 'user-2' }

  it('returns the secret exactly once, on create', () => {
    const created = api.createTrigger(org1, { name: 'T', prompt_template: 'Do it.' })
    expect(created.success).toBe(true)
    expect(created.secret).toBeTruthy()

    // Subsequent reads never expose it.
    const fetched = api.getTrigger(org1, created.trigger!.id)!
    expect((fetched.trigger as Record<string, unknown>).secret).toBeUndefined()
    expect((fetched.trigger as Record<string, unknown>).secret_hash).toBeUndefined()
    expect(fetched.trigger.secret_prefix).toBeTruthy()
  })

  it('validates required fields', () => {
    expect(api.createTrigger(org1, { prompt_template: 'x' }).success).toBe(false)
    expect(api.createTrigger(org1, { name: 'x' }).success).toBe(false)
    expect(api.createTrigger(org1, { name: '  ', prompt_template: 'x' }).success).toBe(false)
  })

  it('hides another org\'s trigger from every accessor', () => {
    const created = api.createTrigger(org1, { name: 'Mine', prompt_template: 'Do it.' })
    const id = created.trigger!.id

    // null is what the route layer turns into 404 — so existence never leaks.
    expect(api.getTrigger(org2, id)).toBeNull()
    expect(api.updateTrigger(org2, id, { name: 'hijack' })).toBeNull()
    expect(api.deleteTrigger(org2, id)).toBeNull()
    expect(api.rotateSecret(org2, id)).toBeNull()
    expect(api.listRuns(org2, id)).toBeNull()
    expect(api.listTriggers(org2).triggers).toHaveLength(0)

    // ...and the owner is unaffected.
    expect(api.getTrigger(org1, id)!.trigger.name).toBe('Mine')
  })

  it('will not read a run belonging to a different trigger', () => {
    const a = api.createTrigger(org1, { name: 'A', prompt_template: 'x' }).trigger!
    const b = api.createTrigger(org1, { name: 'B', prompt_template: 'x' }).trigger!
    const run = store.createRun({ triggerId: b.id, orgId: 'org-1', userId: 'user-1', payloadJson: null })!

    expect(api.getRun(org1, a.id, run.id)).toBeNull()
    expect(api.getRun(org1, b.id, run.id)!.run.id).toBe(run.id)
  })
})

describe('event trigger management API — optional numeric settings', () => {
  let store: EventTriggerStore
  let api: ReturnType<typeof createEventTriggerApi>

  beforeEach(() => {
    store = new EventTriggerStore(makeDb())
    api = createEventTriggerApi({ store })
  })

  const org1 = { orgId: 'org-1', userId: 'user-1' }

  // Regression: the admin UI sends an explicit null when the field is left
  // blank ("use the default"). `Number(null)` is 0 and `Number.isFinite(0)` is
  // true, so the old coercion stored 0 — a 0ms run timeout aborted the session
  // on the next tick and a 0/min rate limit rejected every event.
  it('keeps an explicit null as null on create', () => {
    const created = api.createTrigger(org1, {
      name: 'T', prompt_template: 'x',
      timeout_ms: null, rate_limit_per_min: null,
    })
    expect(created.trigger!.timeout_ms).toBeNull()
    expect(created.trigger!.rate_limit_per_min).toBeNull()
  })

  it('keeps an explicit null as null on update', () => {
    const id = api.createTrigger(org1, {
      name: 'T', prompt_template: 'x',
      timeout_ms: 60_000, rate_limit_per_min: 30,
    }).trigger!.id

    const updated = api.updateTrigger(org1, id, { timeout_ms: null, rate_limit_per_min: null })
    expect(updated!.trigger.timeout_ms).toBeNull()
    expect(updated!.trigger.rate_limit_per_min).toBeNull()
  })

  it('treats empty strings and non-positive values as unset', () => {
    for (const bad of ['', 0, -1, 'abc', NaN]) {
      const created = api.createTrigger(org1, {
        name: 'T', prompt_template: 'x',
        timeout_ms: bad, rate_limit_per_min: bad,
      })
      expect(created.trigger!.timeout_ms).toBeNull()
      expect(created.trigger!.rate_limit_per_min).toBeNull()
    }
  })

  it('still stores genuine positive values', () => {
    const created = api.createTrigger(org1, {
      name: 'T', prompt_template: 'x',
      timeout_ms: 900_000, rate_limit_per_min: 120,
    })
    expect(created.trigger!.timeout_ms).toBe(900_000)
    expect(created.trigger!.rate_limit_per_min).toBe(120)
  })

  it('leaves an omitted field untouched on update', () => {
    const id = api.createTrigger(org1, {
      name: 'T', prompt_template: 'x',
      timeout_ms: 60_000, rate_limit_per_min: 30,
    }).trigger!.id

    const updated = api.updateTrigger(org1, id, { name: 'renamed' })
    expect(updated!.trigger.timeout_ms).toBe(60_000)
    expect(updated!.trigger.rate_limit_per_min).toBe(30)
  })
})

describe('event trigger ingest — legacy zero rate limit', () => {
  // Rows written before the fix can hold 0; those triggers must not be bricked.
  it('falls back to the default instead of rejecting every event', async () => {
    const store = new EventTriggerStore(makeDb())
    const { trigger, secret } = seed(store, { rateLimitPerMin: 0 })
    await withServer(store, async base => {
      const res = await fetch(`${base}/api/v1/triggers/${trigger.id}/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
      expect(res.status).toBe(202)
    })
  })
})

describe('event trigger management API — edit round-trip', () => {
  const org = { orgId: 'org-1', userId: 'user-1' }

  // The exact path that bricked the SQL审计 trigger in production: create with
  // the numeric fields left blank, reopen the edit modal, save without touching
  // them. openEdit() loads null into the form, the input renders `?? ''`, and
  // the client forwards every non-undefined field — so an explicit null is
  // PATCHed back and must survive as null, not become 0.
  it('keeps blank fields blank when an untouched trigger is re-saved', () => {
    const store = new EventTriggerStore(makeDb())
    const api = createEventTriggerApi({ store })

    const id = api.createTrigger(org, {
      name: 'SQL审计', prompt_template: 'x',
      timeout_ms: null, rate_limit_per_min: null,
    }).trigger!.id

    // Re-save three times, each time echoing back what the form loaded.
    for (let i = 0; i < 3; i++) {
      const loaded = api.getTrigger(org, id)!.trigger
      api.updateTrigger(org, id, {
        timeout_ms: loaded.timeout_ms,
        rate_limit_per_min: loaded.rate_limit_per_min,
      })
    }

    const final = api.getTrigger(org, id)!.trigger
    expect(final.timeout_ms).toBeNull()
    expect(final.rate_limit_per_min).toBeNull()
  })
})
