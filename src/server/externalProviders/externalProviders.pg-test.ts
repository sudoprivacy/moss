import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { PgDriver, type PgPoolLike } from '../db/driver.js'
import { applyPgSchema } from '../db/pg_schema.js'
import { CatalogRepository } from '../catalog/catalogRepository.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { ExternalTaskStore } from './store.js'
import { ExternalProviderService } from './service.js'
import { DifyPilotTransport } from './difyTransport.js'

void test('PostgreSQL: cross-instance idempotency, dispatch fencing, nonblocking event reads and deadline reconciliation', { skip: !process.env.MOSS_PG_TEST_URL }, async () => {
  const url = process.env.MOSS_PG_TEST_URL!, schema = `external_review_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: url })
  pg.types.setTypeParser(20, Number)
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pools = [0, 1].map(() => new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 8 }))
  const drivers = pools.map(pool => new PgDriver(pool as unknown as PgPoolLike))
  const services: ExternalProviderService[] = []
  try {
    await applyPgSchema(drivers[0])
    const actor = { orgId: 'review-org', userId: 'reviewer' }
    await drivers[0].run('INSERT INTO organizations(id, name, created_at) VALUES (?, ?, ?)', [actor.orgId, 'Synthetic review', Date.now()])
    const keys = new Map<string, string>(), calls: string[] = []
    const control = { preflight: async () => {} }
    const secrets = {
      getSecret: async (namespace: string, key: string) => ({ value: keys.get(`${namespace}/${key}`) ?? null, status: 'enabled', version: 1 }),
      putSecret: async (namespace: string, key: string, value: string) => { keys.set(`${namespace}/${key}`, value) },
      deleteSecret: async (namespace: string, key: string) => { keys.delete(`${namespace}/${key}`) },
    }
    const transport = new DifyPilotTransport((async (url, init) => {
      if (String(url).endsWith('/info')) return Response.json({ name: 'Synthetic' })
      if (String(url).endsWith('/parameters')) { await control.preflight(); return Response.json({ user_input_form: [], file_upload: { enabled: false } }) }
      calls.push((init?.headers as Record<string, string>).Authorization)
      const events = [{ event: 'message', answer: '42' }, { event: 'message_end' }, { event: 'workflow_finished', data: { status: 'succeeded' } }]
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch)
    for (const driver of drivers) {
      const store = new ExternalTaskStore(driver); await store.ready
      services.push(new ExternalProviderService(store, { catalog: new CatalogRepository(driver), identities: new IdentityRepository(driver), secrets, transport, isActive: async () => true, policy: { orgIds: [actor.orgId], endpoints: ['http://127.0.0.1:8089/v1'], timeoutMs: 30000 } }))
    }
    const [first, second] = services
    const input = { request_id: randomUUID(), name: 'Concurrent pilot', endpoint: 'http://127.0.0.1:8089/v1', api_key: 'synthetic-original', app_id: 'app', workspace_id: 'workspace', source_definition: JSON.stringify({ graph: { nodes: ['start', 'llm', 'answer'].map(type => ({ data: { type } })), edges: [] } }), decoder: 'text', allowed_user_ids: [actor.userId], review_days: 1, review_note: 'Synthetic concurrency fixture' }
    const agent = await first.administration.onboard(actor, input)
    assert.equal((await second.administration.onboard(actor, input)).id, agent.id)
    await assert.rejects(second.administration.onboard(actor, { ...input, api_key: 'different-synthetic-key' }), { code: 'IDEMPOTENCY_CONFLICT' })
    await first.review(actor, agent.id, true, 1)
    const request = { agent_id: agent.id, query: 'synthetic', idempotency_key: randomUUID() }
    const accepted = await Promise.all(Array.from({ length: 12 }, (_, i) => services[i % 2].create(actor, request)))
    assert.equal(new Set(accepted.map(task => task.id)).size, 1)
    await Promise.all(services.map(service => service.waitForTask(accepted[0].id)))
    assert.equal(calls.length, 1)
    assert.equal((await second.store.task(actor, accepted[0].id)).answer, '42')

    let enter!: () => void, release!: () => void
    let entered = new Promise<void>(resolve => { enter = resolve }), barrier = new Promise<void>(resolve => { release = resolve })
    const locked = drivers[0].transaction(async () => { await drivers[0].run('UPDATE external_pilot_tasks SET sequence = sequence WHERE id = ?', [accepted[0].id]); enter(); await barrier })
    await entered
    try {
      const timeout = AbortSignal.timeout(3000)
      const read = second.store.events(actor, accepted[0].id, 0)
      const page = await Promise.race([read, new Promise<never>((_, reject) => timeout.addEventListener('abort', () => reject(new Error('Event read blocked on a writer'))))])
      assert.equal(page.task?.answer, '42')
    } finally { release(); await locked }

    entered = new Promise<void>(resolve => { enter = resolve }); barrier = new Promise<void>(resolve => { release = resolve })
    control.preflight = async () => { control.preflight = async () => {}; enter(); await barrier }
    const stale = await first.create(actor, { ...request, idempotency_key: randomUUID() })
    await entered
    try {
      const rotated = await second.administration.rotate(actor, agent.id, { revision: 2, api_key: 'synthetic-replacement' })
      await second.review(actor, agent.id, true, rotated.revision)
    } finally { release() }
    await first.waitForTask(stale.id)
    assert.equal((await second.store.task(actor, stale.id)).error_code, 'CONFIGURATION_CHANGED')
    assert.equal(calls.length, 1)

    const binding = await first.store.binding(actor, agent.id)
    const pending = await first.store.create(actor, { ...request, idempotency_key: randomUUID() }, binding, 1)
    await first.store.mutate(pending.id, task => { task.status = 'running'; task.attempt_id = randomUUID(); task.answer = 'partial'; task.raw_answer = '{\"reply\":\"partial'; return 'answer' })
    assert.equal((await second.store.task(actor, pending.id)).raw_answer, '{\"reply\":\"partial')
    await Promise.all(services.map(service => service.store.expire(Date.now() + 100)))
    assert.equal((await second.store.task(actor, pending.id)).status, 'unknown')
    await first.store.reconcileUnknown(actor, pending.id, 'Checked synthetic provider run; close without replay.')
    assert((await second.store.task(actor, pending.id)).reconciliation)
    const attempt = await drivers[1].get('SELECT a.status, r.document FROM external_pilot_attempts a JOIN external_pilot_reconciliations r ON r.task_id = a.task_id WHERE a.task_id = ?', [pending.id])
    assert.equal(attempt?.status, 'unknown'); assert(attempt?.document)
    assert.equal((await second.store.session(actor, pending.session_id)).active_task_id, pending.id)
    assert.equal(calls.length, 1)
  } finally {
    await Promise.allSettled(services.map(service => service.close()))
    await Promise.all(pools.map(pool => pool.end()))
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})
