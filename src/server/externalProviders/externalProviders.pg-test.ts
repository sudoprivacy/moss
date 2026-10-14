import { TASK_API } from '../../../contracts/task/v1alpha1/contract.js'
import { AGENT_FEDERATION_API, AGENT_HTTP_API } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import { HTTP_CAPABILITIES } from '../agentFederation/manifest.js'
import { definitionDigest } from './definition.js'
import { queryOnlyDefinition } from '../testing/externalProviderDefinitionFixture.js'
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
      const events = [{ event: 'workflow_started', workflow_run_id: `remote-run-${calls.length}` }, { event: 'message', answer: '42' }, { event: 'message_end' }, { event: 'workflow_finished', data: { status: 'succeeded' } }]
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch)
    for (const driver of drivers) {
      const store = new ExternalTaskStore(driver); await store.ready
      services.push(new ExternalProviderService(store, { catalog: new CatalogRepository(driver), identities: new IdentityRepository(driver), secrets, transport, isActive: async () => true, policy: { orgIds: [actor.orgId], endpoints: ['http://127.0.0.1:8089/v1'], timeoutMs: 30000 } }))
    }
    const [first, second] = services
    const input = { request_id: randomUUID(), name: 'Concurrent pilot', endpoint: 'http://127.0.0.1:8089/v1', api_key: 'synthetic-original', app_id: 'app', workspace_id: 'workspace', source_definition: JSON.stringify(queryOnlyDefinition()), decoder: 'text', allowed_user_ids: [actor.userId], review_days: 1, review_note: 'Synthetic concurrency fixture' }
    const agent = await first.administration.onboard(actor, input)
    assert.equal((await second.administration.onboard(actor, input)).id, agent.id)
    await assert.rejects(second.administration.onboard(actor, { ...input, api_key: 'different-synthetic-key' }), { code: 'IDEMPOTENCY_CONFLICT' })
    const source = JSON.stringify(queryOnlyDefinition())
    const reference = { request_id: randomUUID(), name: 'Referenced pilot', endpoint: input.endpoint, app_id: input.app_id, workspace_id: input.workspace_id, credential_ref: 'nexus://org:review-org:system:dify/app-key', source_definition: source, source_digest: definitionDigest(source), decoder: 'text', allowed_user_ids: [actor.userId], review_expires_at: Date.now() + 86400_000, review_note: 'Synthetic reference concurrency fixture' }
    const registrations = await Promise.all(Array.from({ length: 12 }, (_, i) => services[i % 2].register(actor, reference)))
    assert.equal(new Set(registrations.map(value => value.id)).size, 1)
    assert.equal((await second.register(actor, reference)).id, registrations[0].id)
    await assert.rejects(second.register(actor, { ...reference, name: 'Changed reference' }), { code: 'IDEMPOTENCY_CONFLICT' })
    const counts = async () => Promise.all(['external_pilot_bindings', 'integration_connections', 'tenant_assistants', 'external_pilot_operations', 'external_pilot_admin_audit'].map(async table => Number((await drivers[1].get(`SELECT COUNT(*) AS count FROM ${table}`))!.count)))
    const before = await counts(), audit = first.administration.audit.bind(first.administration)
    const retry = { ...reference, request_id: randomUUID() }
    first.administration.audit = async () => { throw new Error('Synthetic failure after all registration writes') }
    try { await assert.rejects(first.register(actor, retry), /Synthetic failure/) }
    finally { first.administration.audit = audit }
    assert.deepEqual(await counts(), before, 'Reservation, binding, catalog, connection and audit roll back together')
    assert((await second.register(actor, retry)).id, 'Same request can succeed after rollback')
    await first.review(actor, agent.id, true, 1)
    const request = { agent_id: agent.id, query: 'synthetic', idempotency_key: randomUUID() }
    const accepted = await Promise.all(Array.from({ length: 12 }, (_, i) => services[i % 2].create(actor, request)))
    assert.equal(new Set(accepted.map(task => task.id)).size, 1)
    await Promise.all(services.map(service => service.waitForTask(accepted[0].id)))
    assert.equal(calls.length, 1)
    assert.equal((await second.store.task(actor, accepted[0].id)).answer, '42')
    assert.equal((await second.store.task(actor, accepted[0].id)).status, 'succeeded')
    assert.equal((await second.store.runBinding(actor, accepted[0].id))?.provider_run_id, 'remote-run-1')

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
    const saveRun = first.store.saveRunBinding.bind(first.store)
    first.store.saveRunBinding = async (currentActor, run) => { await saveRun(currentActor, run); throw new Error('Synthetic failure after run binding write') }
    const incomplete = await first.create(actor, { ...request, idempotency_key: randomUUID() })
    await first.waitForTask(incomplete.id)
    first.store.saveRunBinding = saveRun
    assert.equal((await second.store.task(actor, incomplete.id)).status, 'unknown')
    assert.equal(await second.store.runBinding(actor, incomplete.id), null, 'Run binding and terminal task roll back together')
    assert.equal(calls.length, 2, 'Uncertain results are never automatically replayed')
    // Exercise the new admission ledger through independent PG pools.
    const manifest = { api_version: AGENT_FEDERATION_API, kind: 'CustomAgentManifest', provider_kind: 'custom_http', external_agent_id: 'http-helper', name: 'HTTP helper', source_revision: 'revision-1', execution_mode: 'external_hosted', protocol: AGENT_HTTP_API, input_profile: 'query_only_v1', output_profile: 'text_v1', capabilities: { ...HTTP_CAPABILITIES } }
    let httpCalls = 0
    for (const service of services) service.administration.options.httpRequest = async (url, init) => {
      if (String(url).endsWith('/manifest')) return Response.json(manifest)
      httpCalls++
      const body = JSON.parse(String(init?.body))
      return Response.json({ api_version: AGENT_HTTP_API, kind: 'AgentResult', invocation_id: body.invocation_id, provider_run_id: 'pg-http-run', status: 'succeeded', output: { text: '42' } })
    }
    const custom = await first.administration.onboard(actor, { ...input, request_id: randomUUID(), provider_kind: 'custom_http', app_id: manifest.external_agent_id, workspace_id: 'custom-http', source_definition: JSON.stringify(manifest) })
    await second.review(actor, custom.id, true, custom.revision)
    const submission = { api_version: TASK_API, kind: 'SubmitTask', agent: { catalog_id: custom.id }, request_source: 'api', input: { instruction: '6 * 7', resource_refs: [] }, workspace_refs: [], requested_mode: 'auto', data_classification: 'synthetic', required_capabilities: [], constraints: { idempotency_key: randomUUID() } }
    const admitted = await Promise.all(Array.from({ length: 12 }, (_, i) => services[i % 2].create(actor, submission)))
    assert.equal(new Set(admitted.map(task => task.id)).size, 1)
    await Promise.all(services.map(service => service.waitForTask(admitted[0].id)))
    assert.equal(httpCalls, 1)
    assert.equal((await second.store.taskRecord(actor, admitted[0].id))?.resolution.status, 'accepted')
    assert.equal((await second.store.task(actor, admitted[0].id)).answer, '42')
    const rejected = await second.create(actor, { ...submission, data_classification: 'confidential', constraints: { idempotency_key: randomUUID() } })
    assert.equal(rejected.status, 'rejected'); assert.equal(rejected.attempt_id, null)
    assert.equal((await first.store.taskRecord(actor, rejected.id))?.resolution.status, 'rejected')
    assert.equal(httpCalls, 1)
    const ledgerCounts = async () => Promise.all(['product_task_records', 'external_pilot_tasks', 'external_pilot_sessions', 'external_pilot_attempts'].map(async table => Number((await drivers[1].get(`SELECT COUNT(*) AS count FROM ${table}`))!.count)))
    const ledgerBefore = await ledgerCounts(), originalRun = drivers[0].run.bind(drivers[0])
    drivers[0].run = async (sql, params) => { if (sql.startsWith('INSERT INTO product_task_records')) throw new Error('Synthetic admission write failure'); return originalRun(sql, params) }
    try { await assert.rejects(first.create(actor, { ...submission, constraints: { idempotency_key: randomUUID() } }), /Synthetic admission write failure/) }
    finally { drivers[0].run = originalRun }
    assert.deepEqual(await ledgerCounts(), ledgerBefore)

  } finally {
    await Promise.allSettled(services.map(service => service.close()))
    await Promise.all(pools.map(pool => pool.end()))
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})
