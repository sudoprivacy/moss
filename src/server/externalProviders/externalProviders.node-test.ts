import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { SqliteDriver } from '../db/driver.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { createCatalogTestRepository, createIdentityTestRepository } from '../testing/compatibilityRepositories.js'
import { ExternalTaskStore } from './store.js'
import { ExternalProviderService } from './service.js'
import { DifyPilotTransport } from './difyTransport.js'
import { decodeOutput } from './decoder.js'
import { canonicalEndpoint, parseRegistration, ExternalProviderError } from './policy.js'
import { dispatchExternalProvider } from './routes.js'

const actor = { orgId: 'org-a', userId: 'u' }
const policy = { orgIds: ['org-a'], endpoints: ['http://127.0.0.1:8089/v1'], timeoutMs: 2000 }
const definition = () => ({ name: 'Pilot', endpoint: policy.endpoints[0], app_id: 'app-1', workspace_id: 'workspace-1', credential_ref: 'nexus://org:org-a:system:dify/app-key', source_digest: `sha256:${'1'.repeat(64)}`, decoder: 'reply_actions_v1' as const, allowed_user_ids: ['u', 'v'], review_expires_at: Date.now() + 86400_000, review_note: 'Synthetic inputs, reviewed read-only Chatflow' })
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function frames(events: unknown[]) { return events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') }
function successful(answer = '{"reply":"42","actions":[]}') {
  return [
    { event: 'workflow_started', task_id: 'remote-task', workflow_run_id: 'run-1' },
    { event: 'message', answer, conversation_id: 'conv-1', message_id: 'msg-1' },
    { event: 'message_end', conversation_id: 'conv-1' },
    { event: 'workflow_finished', data: { status: 'succeeded' } },
  ]
}
async function setup(options: { events?: unknown[]; status?: number; parameters?: () => unknown; failBeforeSend?: boolean } = {}) {
  const db = new DatabaseSync(':memory:'), driver = new SqliteDriver(db)
  const authDb = new AuthCenterDb(db)
  await authDb.createOrganization('org-a', 'Pilot', Date.now())
  const catalog = createCatalogTestRepository(db, driver), identities = createIdentityTestRepository(db, {}, driver)
  const calls: Array<Record<string, unknown>> = []
  const transport = new DifyPilotTransport((async (url, init) => {
    assert.equal(init?.redirect, 'error')
    if (String(url).endsWith('/parameters')) {
      if (options.failBeforeSend) throw new Error('private-provider-detail')
      return Response.json(options.parameters?.() ?? { user_input_form: [], file_upload: { enabled: false } })
    }
    calls.push(JSON.parse(String(init?.body)))
    return new Response(frames(options.events ?? successful()), { status: options.status ?? 200, headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch)
  const store = new ExternalTaskStore(driver)
  const service = new ExternalProviderService(store, { catalog, identities, policy, transport, isActive: async () => true, secrets: { getSecret: async (namespace, key, subject) => {
    assert.equal(namespace, 'org:org-a:system:dify'); assert.equal(key, 'app-key'); assert.equal(subject, 'org:org-a')
    return { value: 'private-app-key', status: 'enabled', version: 1 }
  } } })
  cleanups.push(async () => { await service.close(); await driver.close() })
  const registered = await service.register(actor, definition())
  if (!options.failBeforeSend) await service.review(actor, registered.id, true)
  const request = (session_id?: string, query = '6 * 7') => ({ agent_id: registered.id, session_id, query, idempotency_key: randomUUID() })
  const run = async (input = request()) => { const task = await service.create(actor, input); await service.waitForTask(task.id); return store.task(actor, task.id) }
  return { db, driver, catalog, identities, store, service, calls, registered, request, run }
}

void test('success persists answer, attempt, ordered events and a provider conversation for the next turn', async () => {
  const f = await setup(), task = await f.run()
  assert.equal(task.status, 'succeeded'); assert.equal(task.answer, '42'); assert.equal(task.output_status, 'valid')
  assert(task.attempt_id); assert.equal((await f.store.session(actor, task.session_id)).active_task_id, null)
  const page = await f.store.events(actor, task.id, 0)
  assert.deepEqual(page.events.map(e => e.sequence), page.events.map((_, i) => i + 1))
  await f.run(f.request(task.session_id, 'plus 8'))
  assert.equal(f.calls[1].conversation_id, 'conv-1'); assert.equal(f.calls[0].user, f.calls[1].user)
  assert.equal((await f.store.history(actor, task.session_id)).length, 2)
  assert.equal((await f.driver.get('SELECT status FROM external_pilot_attempts WHERE id = ?', [task.attempt_id]))?.status, 'succeeded')
})

void test('concurrent idempotent retries dispatch once and mismatching body conflicts', async () => {
  const f = await setup(), request = f.request()
  const tasks = await Promise.all(Array.from({ length: 6 }, () => f.service.create(actor, request)))
  assert.equal(new Set(tasks.map(t => t.id)).size, 1)
  await f.service.waitForTask(tasks[0].id); assert.equal(f.calls.length, 1)
  await assert.rejects(f.service.create(actor, { ...request, query: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' })
})

void test('session CAS serializes different prompts; wrong owner and wrong organization are hidden', async () => {
  const f = await setup(), task = await f.run()
  const binding = await f.store.binding(actor, task.agent_id)
  const result = await Promise.allSettled([f.store.create(actor, f.request(task.session_id), binding, 2000), f.store.create(actor, f.request(task.session_id), binding, 2000)])
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
  for (const other of [{ ...actor, userId: 'v' }, { ...actor, orgId: 'org-b' }]) {
    await assert.rejects(f.store.task(other, task.id), { code: 'TASK_NOT_FOUND' })
    await assert.rejects(f.store.events(other, task.id, 0), { code: 'TASK_NOT_FOUND' })
    await assert.rejects(f.store.history(other, task.session_id), { code: 'SESSION_NOT_FOUND' })
    assert.deepEqual(await f.store.sessions(other), [])
    await assert.rejects(f.service.create(other, f.request(task.session_id)), ExternalProviderError)
  }
})

void test('stream EOF without confirmed terminals is unknown and retains session lock; retry never resubmits', async () => {
  const f = await setup({ events: successful().slice(0, 2) }), request = f.request(), task = await f.run(request)
  assert.equal(task.status, 'unknown'); assert.equal((await f.store.session(actor, task.session_id)).active_task_id, task.id)
  await f.run(request); assert.equal(f.calls.length, 1)
  await assert.rejects(f.service.create(actor, f.request(task.session_id)), { code: 'SESSION_BUSY_OR_AGENT_MISMATCH' })
})

void test('workflow success alone or message_end alone cannot prove Chatflow answer completed', async () => {
  for (const events of [[successful()[3]], [successful()[2]]]) {
    const f = await setup({ events }); assert.equal((await f.run()).status, 'unknown')
  }
})

void test('provider 4xx is rejected; 5xx acceptance stays unknown', async () => {
  const denied = await setup({ status: 401 }); assert.equal((await denied.run()).status, 'rejected')
  const uncertain = await setup({ status: 503 }); assert.equal((await uncertain.run()).status, 'unknown')
})

void test('confirmed workflow failure releases lock without reporting success', async () => {
  const f = await setup({ events: [{ event: 'workflow_finished', data: { status: 'failed' } }] }), task = await f.run()
  assert.equal(task.status, 'failed'); assert.equal((await f.store.session(actor, task.session_id)).active_task_id, null)
})

void test('restart expires claimed work to unknown, never reassigns it, and expires unsent intent to rejected', async () => {
  const f = await setup(), binding = await f.store.binding(actor, f.registered.id)
  const task = await f.store.create(actor, f.request(), binding, 20)
  await f.store.mutate(task.id, t => { t.status = 'dispatching'; t.attempt_id = randomUUID(); return 'status' })
  const restarted = new ExternalTaskStore(f.driver)
  await restarted.expire(Date.now() + 100)
  assert.equal((await restarted.task(actor, task.id)).status, 'unknown')
  assert.equal(await restarted.mutate(task.id, () => 'status'), null)
  const unsent = await restarted.create(actor, f.request(), binding, 20)
  await restarted.expire(Date.now() + 100)
  assert.equal((await restarted.task(actor, unsent.id)).status, 'rejected'); assert.equal(f.calls.length, 0)
})

void test('parameters drift rejects before provider POST', async () => {
  let changed = false
  const f = await setup({ parameters: () => ({ user_input_form: [], marker: changed }) })
  changed = true
  const task = await f.run(); assert.equal(task.status, 'rejected'); assert.equal(task.error_code, 'PROVIDER_PARAMETERS_CHANGED'); assert.equal(f.calls.length, 0)
})

void test('approval, user allowlist, review expiry, catalog revoke and connection revoke gate dispatch', async () => {
  const f = await setup(), binding = await f.store.binding(actor, f.registered.id)
  for (const patch of [{ approved: false }, { allowed_user_ids: ['v'] }, { review_expires_at: 1 }]) {
    await f.store.saveBinding({ ...binding, ...patch })
    await assert.rejects(f.service.create(actor, f.request()), ExternalProviderError)
  }
  await f.store.saveBinding(binding)
  const original = (await f.catalog.getAgent(binding.id, actor.orgId))!
  await f.catalog.updateAgentConfiguration(binding.id, actor.orgId, { providerBinding: { ...original.providerBinding, appId: 'changed-app' } })
  await assert.rejects(f.service.create(actor, f.request()), { code: 'AGENT_DISABLED_OR_CHANGED' })
  await f.catalog.updateAgentConfiguration(binding.id, actor.orgId, { providerBinding: original.providerBinding, visibleTo: { user_ids: ['v'] } })
  await assert.rejects(f.service.create(actor, f.request()), { code: 'AGENT_DISABLED_OR_CHANGED' })
  await f.catalog.updateAgentConfiguration(binding.id, actor.orgId, { visibleTo: original.visibleTo, enabled: false })
  await assert.rejects(f.service.create(actor, f.request()), { code: 'AGENT_DISABLED_OR_CHANGED' })
  await f.catalog.updateAgentConfiguration(binding.id, actor.orgId, { enabled: true })
  const connection = (await f.identities.getIntegrationConnection(binding.connectionId))!
  await f.identities.putIntegrationConnection({ ...connection, enabled: false })
  await assert.rejects(f.service.create(actor, f.request()), { code: 'CONNECTION_DISABLED_OR_CHANGED' })
  assert.equal(f.calls.length, 0)
})

void test('registration forbids plaintext keys, cross-tenant secret references, DNS and unapproved endpoints', () => {
  for (const endpoint of ['https://example.org/v1', 'http://127.0.0.1/v1?token=secret', 'http://a:b@127.0.0.1/v1', 'file:///v1']) assert.throws(() => canonicalEndpoint(endpoint))
  for (const value of [{ ...definition(), api_key: 'secret' }, { ...definition(), credential_ref: 'nexus://org:org-b:system:dify/app-key' }, { ...definition(), credential_ref: 'nexus://org:org-a:system:dify/a/b' }, { ...definition(), endpoint: 'http://127.0.0.2/v1' }]) assert.throws(() => parseRegistration(value, actor.orgId, policy))
})

void test('decoder streams only root reply; escaped unicode and incomplete JSON are handled; actions never execute', () => {
  assert.equal(decodeOutput('{"nested":{"reply":"wrong"},"reply":"right', 'reply_actions_v1').answer, 'right')
  assert.equal(decodeOutput('{"other":"\\\"reply\\\":\\\"wrong","reply":"ok', 'reply_actions_v1').answer, 'ok')
  assert.equal(decodeOutput('{"reply":"a\\n\\uD83D', 'reply_actions_v1').answer, 'a\n')
  assert.equal(decodeOutput('{"reply":"a\\uD83D\\uDE00', 'reply_actions_v1').answer, 'a😀')
  assert.deepEqual(decodeOutput('invalid', 'reply_actions_v1', true), { answer: 'invalid', valid: false })
  assert.equal(decodeOutput('{"reply":"ok","actions":["rm -rf"]}', 'reply_actions_v1', true).answer, 'ok')
})

void test('API enforces admin review, cursor validation, ownership and honest cancellation', async () => {
  const f = await setup(), task = await f.run()
  const call = (path: string, method = 'GET', body: unknown = {}) => dispatchExternalProvider(f.service, actor, method, new URL(path, 'http://moss.test'), body, () => { throw new ExternalProviderError(403, 'ADMIN_REQUIRED') })
  assert.equal((await call('/api/v1/external-agents', 'POST', definition())).status, 403)
  assert.equal((await call(`/api/v1/tasks/${task.id}/events?cursor=-1`)).status, 400)
  assert.equal((await call(`/api/v1/tasks/${task.id}/cancel`, 'POST')).status, 409)
  assert.equal((await call(`/api/v1/tasks/${task.id}`)).status, 200)
  assert(!JSON.stringify(await call('/api/v1/external-agents')).includes('private-app-key'))
})

void test('malformed or oversized provider output is bounded and remains unconfirmed', async () => {
  const f = await setup({ events: [{ event: 'message', answer: 'a'.repeat(128001) }] })
  assert.equal((await f.run()).status, 'unknown')
  const ids = await setup({ events: [{ event: 'message', conversation_id: 'a' }, { event: 'message', conversation_id: 'b' }] })
  assert.equal((await ids.run()).error_code, 'PROVIDER_ID_CHANGED')
})

void test('transport abort deadline marks unknown without pretending remote cancellation', async () => {
  const f = await setup(), binding = await f.store.binding(actor, f.registered.id)
  const transport = new DifyPilotTransport((async (url, init) => {
    if (String(url).endsWith('/parameters')) return Response.json({ user_input_form: [], file_upload: { enabled: false } })
    return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted'))) } }), { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch)
  const service = new ExternalProviderService(f.store, { catalog: f.catalog, identities: f.identities, policy: { ...policy, timeoutMs: 30 }, transport, isActive: async () => true, secrets: { getSecret: async () => ({ value: 'private-app-key', status: 'enabled', version: 1 }) } })
  cleanups.unshift(async () => service.close())
  const task = await service.create(actor, { ...f.request(), agent_id: binding.id }); await service.waitForTask(task.id)
  const final = await f.store.task(actor, task.id)
  assert.equal(final.status, 'unknown'); assert.equal(final.cancellation.status, 'unsupported')
})


void test('task intent survives a database close/reopen and unconfirmed work is not replayed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moss-external-recovery-'))
  const file = join(directory, 'tasks.sqlite')
  try {
    const first = new SqliteDriver(new DatabaseSync(file)), store = new ExternalTaskStore(first)
    const binding = { ...definition(), id: 'agent', orgId: actor.orgId, connectionId: 'connection', approved: true, parametersDigest: 'test', reviewedBy: 'admin' }
    const task = await store.create(actor, { agent_id: 'agent', query: 'synthetic', idempotency_key: randomUUID() }, binding, 1000)
    await store.mutate(task.id, value => { value.status = 'dispatching'; value.attempt_id = randomUUID(); return 'status' })
    await first.close()
    const second = new SqliteDriver(new DatabaseSync(file)), recovered = new ExternalTaskStore(second)
    await recovered.expire(Date.now() + 2000)
    assert.equal((await recovered.task(actor, task.id)).status, 'unknown')
    assert.equal((await recovered.session(actor, task.session_id)).active_task_id, task.id)
    assert.equal(await recovered.mutate(task.id, value => { value.status = 'succeeded'; return 'status' }), null)
    assert.equal((await recovered.events(actor, task.id, 0)).events.length, 3)
    await second.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

async function administrationSetup() {
  const db = new DatabaseSync(':memory:'), driver = new SqliteDriver(db), authDb = new AuthCenterDb(db)
  await authDb.createOrganization(actor.orgId, 'Pilot', Date.now())
  const catalog = createCatalogTestRepository(db, driver), identities = createIdentityTestRepository(db, {}, driver)
  const values = new Map<string, string>(), writes: string[] = []
  const control = { failWrite: false, beforeWrite: async () => {} }
  const secrets = {
    getSecret: async (namespace: string, key: string) => ({ value: values.get(`${namespace}/${key}`) ?? null, status: 'enabled', version: 1 }),
    putSecret: async (namespace: string, key: string, value: string) => { await control.beforeWrite(); if (control.failWrite) throw new Error('private-secret-detail'); writes.push(namespace); values.set(`${namespace}/${key}`, value) },
    deleteSecret: async (namespace: string, key: string) => { values.delete(`${namespace}/${key}`) },
  }
  const transport = new DifyPilotTransport((async (url, init) => {
    if (init?.headers && (init.headers as Record<string, string>).Authorization === 'Bearer wrong-key') return Response.json({}, { status: 401 })
    if (String(url).endsWith('/info')) return Response.json({ name: 'Synthetic Dify', description: '', tags: [] })
    if (String(url).endsWith('/parameters')) return Response.json({ user_input_form: [], file_upload: { enabled: false } })
    return new Response(frames(successful()), { headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch)
  const store = new ExternalTaskStore(driver)
  const service = new ExternalProviderService(store, { catalog, identities, secrets, transport, policy: { ...policy, orgIds: [], endpoints: [] }, isActive: async member => member.orgId === actor.orgId && ['u', 'v'].includes(member.userId), members: async () => [{ id: 'u', name: 'User' }, { id: 'v', name: 'Other' }] })
  cleanups.push(async () => { await service.close(); await driver.close() })
  const admin = service.administration
  const body = () => ({ request_id: randomUUID(), name: 'Pilot', endpoint: policy.endpoints[0], api_key: 'private-ui-key', app_id: 'app-1', workspace_id: 'workspace-1', source_definition: JSON.stringify({ workflow: { graph: { nodes: ['start', 'llm', 'answer'].map(type => ({ data: { type } })), edges: [] } } }), decoder: 'reply_actions_v1', allowed_user_ids: ['u'], review_days: 7, review_note: 'Synthetic reviewed definition' })
  const enable = () => admin.setPolicy(actor, { enabled: true, endpoints: policy.endpoints, revision: 0 })
  return { db, driver, store, service, admin, body, enable, values, writes, control }
}

void test('administration policy persists per organization, CAS prevents stale updates, and only platform admins can write it', async () => {
  const f = await administrationSetup()
  assert.equal((await f.admin.policy(actor)).enabled, false)
  const input = { enabled: true, endpoints: policy.endpoints, revision: 0 }
  const url = new URL('http://moss.test/api/v1/external-agents/admin/policy')
  assert.equal((await dispatchExternalProvider(f.service, actor, 'POST', url, input, () => {})).status, 403)
  assert.equal((await dispatchExternalProvider(f.service, actor, 'POST', url, input, () => {}, () => {})).status, 200)
  assert.deepEqual(await f.admin.policy(actor), { ...input, revision: 1 })
  assert.equal((await f.admin.policy({ ...actor, orgId: 'other' })).enabled, false)
  await assert.rejects(f.admin.setPolicy(actor, input), { code: 'CONFIGURATION_CHANGED' })
  const reopened = new ExternalTaskStore(f.driver)
  assert((await reopened.db.get('SELECT document FROM external_pilot_policy WHERE org_id = ?', [actor.orgId]))?.document)
})

void test('onboarding stores keys only in Secret, is idempotent, and remains hidden until approval', async () => {
  const f = await administrationSetup(); await f.enable()
  const body = f.body(), agent = await f.admin.onboard(actor, body)
  assert.equal(agent.approved, false); assert.equal(agent.revision, 1)
  assert.deepEqual(await f.service.list(actor), [])
  assert.equal((await f.admin.onboard(actor, body)).id, agent.id); assert.equal(f.writes.length, 1)
  assert.equal([...f.values.values()][0], 'private-ui-key')
  const persisted = JSON.stringify(await f.driver.all('SELECT document FROM external_pilot_bindings')) + JSON.stringify(await f.driver.all('SELECT * FROM external_pilot_admin_audit'))
  for (const text of [persisted, JSON.stringify(agent), JSON.stringify(await f.admin.list(actor))]) { assert(!text.includes('private-ui-key')); assert(!text.includes('source_definition')) }
  await assert.rejects(f.admin.onboard(actor, { ...body, name: 'changed' }), { code: 'IDEMPOTENCY_CONFLICT' })
  await f.service.review(actor, agent.id, true, 1, 1)
  assert.equal((await f.service.list(actor)).length, 1)
  assert.deepEqual(await f.service.list({ ...actor, userId: 'v' }), [])
})

void test('onboarding rejects inactive members, tool DSL and unapproved endpoints without writing credentials', async () => {
  const f = await administrationSetup(); await f.enable()
  await assert.rejects(f.admin.onboard(actor, { ...f.body(), allowed_user_ids: ['outsider'] }), { code: 'INVALID_MEMBER' })
  await assert.rejects(f.admin.onboard(actor, { ...f.body(), source_definition: f.body().source_definition.replace('llm', 'http-request') }), { code: 'UNSUPPORTED_DIFY_DEFINITION' })
  await assert.rejects(f.admin.onboard(actor, { ...f.body(), endpoint: 'http://127.0.0.2/v1' }), ExternalProviderError)
  assert.equal(f.writes.length, 0)
})

void test('failed Secret writes leave no draft or reservation and allow a safe retry', async () => {
  const f = await administrationSetup(); await f.enable(); const body = f.body()
  f.control.failWrite = true
  await assert.rejects(f.admin.onboard(actor, body), { code: 'REGISTRATION_FAILED' })
  assert.deepEqual(await f.admin.list(actor), []); assert.equal((await f.driver.all('SELECT * FROM external_pilot_admin_operations')).length, 0)
  f.control.failWrite = false
  assert.equal((await f.admin.onboard(actor, body)).id, body.request_id)
})

void test('editing revokes approval; stale reviews conflict; archive preserves history and prevents new tasks', async () => {
  const f = await administrationSetup(); await f.enable()
  let agent = await f.admin.onboard(actor, f.body())
  await f.service.review(actor, agent.id, true, agent.revision, 7)
  const task = await f.service.create(actor, { agent_id: agent.id, query: '6 * 7', idempotency_key: randomUUID() }); await f.service.waitForTask(task.id)
  agent = await f.admin.update(actor, agent.id, { name: 'Renamed', revision: 2, allowed_user_ids: ['u', 'v'], review_note: 'Reviewed changed membership', decoder: 'text', review_days: 7 })
  assert.equal(agent.approved, false); assert.deepEqual(await f.service.list(actor), [])
  await assert.rejects(f.service.review(actor, agent.id, true, 2, 7), { code: 'CONFIGURATION_CHANGED' })
  await f.admin.archive(actor, agent.id, { revision: agent.revision })
  assert.deepEqual(await f.admin.list(actor), []); assert.equal((await f.store.history(actor, task.session_id))[0].answer, '42')
  await assert.rejects(f.service.create(actor, { agent_id: agent.id, query: 'again', idempotency_key: randomUUID() }), ExternalProviderError)
})

void test('credential rotation revokes before write and prevents concurrent edit, archive and publication', async () => {
  const f = await administrationSetup(); await f.enable(); const agent = await f.admin.onboard(actor, f.body())
  await f.service.review(actor, agent.id, true, 1, 7)
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), barrier = new Promise<void>(resolve => { release = resolve })
  f.control.beforeWrite = async () => { entered(); await barrier }
  const rotation = f.admin.rotate(actor, agent.id, { revision: 2, api_key: 'replacement-key' })
  await started
  try {
    assert.deepEqual(await f.service.list(actor), [])
    await assert.rejects(f.service.review(actor, agent.id, true, 3, 7), { code: 'CREDENTIAL_UPDATE_IN_PROGRESS' })
    await assert.rejects(f.admin.archive(actor, agent.id, { revision: 3 }), { code: 'CREDENTIAL_UPDATE_IN_PROGRESS' })
  } finally { release() }
  const result = await rotation
  assert.equal(result.approved, false); assert.equal(result.revision, 4)
  assert.equal([...f.values.values()][0], 'replacement-key')
  await f.service.review(actor, agent.id, true, 4, 7)
  assert.equal((await f.service.list(actor)).length, 1)
})

void test('admin HTTP routes reject ordinary users and cross-organization binding access', async () => {
  const f = await administrationSetup(); await f.enable(); const agent = await f.admin.onboard(actor, f.body())
  for (const path of ['policy', 'agents', 'members', 'inspect', 'onboard', `${agent.id}/rotate`]) {
    const result = await dispatchExternalProvider(f.service, actor, 'POST', new URL(`http://moss.test/api/v1/external-agents/admin/${path}`), {}, () => { throw new ExternalProviderError(403, 'ADMIN_REQUIRED') })
    assert.equal(result.status, 403)
  }
  await assert.rejects(f.admin.testSaved({ ...actor, orgId: 'other' }, agent.id), { code: 'AGENT_NOT_FOUND' })
})
