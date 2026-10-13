import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { crashFixture } from '../testing/externalProviderCrashFixture.js'
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
import { onlineCommandContext } from '../application/commandContext.js'
import { ExternalTaskStore } from './store.js'
import { ExternalProviderService } from './service.js'
import { DifyPilotTransport, ProgressCoalescer } from './difyTransport.js'
import { decodeOutput } from './decoder.js'
import { canonicalEndpoint, parseRegistration, ExternalProviderError } from './policy.js'
import { dispatchExternalProvider } from './routes.js'
import { CredentialOperations } from './operations.js'
import { DifyAdministrationService } from '../dify/difyAdministrationService.js'

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
  if (!options.failBeforeSend) await service.review(actor, registered.id, true, 1)
  const request = (session_id?: string, query = '6 * 7') => ({ agent_id: registered.id, session_id, query, idempotency_key: randomUUID() })
  const run = async (input = request()) => { const task = await service.create(actor, input); await service.waitForTask(task.id); return store.task(actor, task.id) }
  return { db, driver, catalog, identities, store, service, calls, registered, request, run }
}

void test('success persists answer, attempt, ordered events and a provider conversation for the next turn', async () => {
  const f = await setup(), task = await f.run()
  assert.equal(task.status, 'succeeded'); assert.equal(task.answer, '42'); assert.equal(task.output_status, 'valid')
  assert(task.attempt_id); assert.equal((await f.store.session(actor, task.session_id)).active_task_id, null)
  const page = await f.store.events(actor, task.id, 0)
  assert.equal(page.task?.answer, '42'); assert.equal(page.next_cursor, page.snapshot_sequence)
  assert.deepEqual(page.events, [])
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
    assert.equal((await recovered.events(actor, task.id, 0)).task?.status, 'unknown')
    await second.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

async function administrationSetup() {
  const db = new DatabaseSync(':memory:'), driver = new SqliteDriver(db), authDb = new AuthCenterDb(db)
  await authDb.createOrganization(actor.orgId, 'Pilot', Date.now())
  const catalog = createCatalogTestRepository(db, driver), identities = createIdentityTestRepository(db, {}, driver)
  const values = new Map<string, string>(), writes: string[] = []
  const control = { failWrite: false, beforeWrite: async () => {}, beforeParameters: async () => {} }
  const requestKeys: string[] = []
  const secrets = {
    getSecret: async (namespace: string, key: string) => ({ value: values.get(`${namespace}/${key}`) ?? null, status: 'enabled', version: 1 }),
    putSecret: async (namespace: string, key: string, value: string) => { await control.beforeWrite(); if (control.failWrite) throw new Error('private-secret-detail'); writes.push(namespace); values.set(`${namespace}/${key}`, value) },
    deleteSecret: async (namespace: string, key: string) => { values.delete(`${namespace}/${key}`) },
  }
  const transport = new DifyPilotTransport((async (url, init) => {
    if (init?.headers && (init.headers as Record<string, string>).Authorization === 'Bearer wrong-key') return Response.json({}, { status: 401 })
    if (String(url).endsWith('/info')) return Response.json({ name: 'Synthetic Dify', description: '', tags: [] })
    if (String(url).endsWith('/parameters')) { await control.beforeParameters(); return Response.json({ user_input_form: [], file_upload: { enabled: false } }) }
    requestKeys.push((init?.headers as Record<string, string>).Authorization)
    return new Response(frames(successful()), { headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch)
  const store = new ExternalTaskStore(driver)
  const service = new ExternalProviderService(store, { catalog, identities, secrets, transport, policy: { ...policy, orgIds: [], endpoints: [] }, isActive: async member => member.orgId === actor.orgId && ['u', 'v'].includes(member.userId), members: async () => [{ id: 'u', name: 'User' }, { id: 'v', name: 'Other' }] })
  cleanups.push(async () => { await service.close(); await driver.close() })
  const admin = service.administration
  const body = () => ({ request_id: randomUUID(), name: 'Pilot', endpoint: policy.endpoints[0], api_key: 'private-ui-key', app_id: 'app-1', workspace_id: 'workspace-1', source_definition: JSON.stringify({ workflow: { graph: { nodes: ['start', 'llm', 'answer'].map(type => ({ data: { type } })), edges: [] } } }), decoder: 'reply_actions_v1', allowed_user_ids: ['u'], review_days: 7, review_note: 'Synthetic reviewed definition' })
  const enable = () => admin.setPolicy(actor, { enabled: true, endpoints: policy.endpoints, revision: 0 })
  return { db, driver, store, service, admin, body, enable, values, writes, control, catalog, identities, secrets, transport, requestKeys }
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
  await assert.rejects(f.admin.onboard(actor, { ...f.body(), api_key: 'wrong-key' }), { code: 'PROVIDER_PREFLIGHT_FAILED' })
  await f.admin.operations.reconcile()
  assert.equal((await f.driver.all("SELECT id FROM external_pilot_operations WHERE status = 'cleanup_complete'")).length, 1)
  assert.equal((await f.driver.all("SELECT id FROM external_pilot_operations WHERE status = 'cleanup_guard'")).length, 0)
  assert.equal(f.writes.length, 0)
})

void test('failed Secret writes leave no draft or reservation and allow a safe retry', async () => {
  const f = await administrationSetup(); await f.enable(); const body = f.body()
  f.control.failWrite = true
  await assert.rejects(f.admin.onboard(actor, body), { code: 'REGISTRATION_FAILED' })
  assert.deepEqual(await f.admin.list(actor), []); assert.equal((await f.driver.all('SELECT * FROM external_pilot_admin_operations')).length, 0)
  f.control.failWrite = false
  const retried = await f.admin.onboard(actor, body)
  assert.equal((await f.admin.onboard(actor, body)).id, retried.id)
  assert.notEqual(retried.id, body.request_id)
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
  const binding = await f.store.binding(actor, agent.id)
  assert.equal(f.values.get(binding.credential_ref.slice(8)), 'replacement-key')
  assert.equal([...f.values.values()][0], 'private-ui-key')
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

void test('review requires the exact positive integer revision at both HTTP and service boundaries', async () => {
  const f = await administrationSetup(); await f.enable()
  const agent = await f.admin.onboard(actor, f.body())
  await f.admin.update(actor, agent.id, { revision: 1, name: 'Changed', allowed_user_ids: ['u'], decoder: 'text', review_days: 1, review_note: 'Changed' })
  const url = new URL(`http://moss.test/api/v1/external-agents/${agent.id}/review`)
  for (const revision of [undefined, 0, -1, 1.5, '2']) {
    assert.equal((await dispatchExternalProvider(f.service, actor, 'POST', url, { approved: true, revision }, () => {})).status, 400)
    await assert.rejects(f.service.review(actor, agent.id, true, revision as number), { code: 'INVALID_REVIEW' })
  }
  assert.equal((await dispatchExternalProvider(f.service, actor, 'POST', url, { approved: true, revision: 1 }, () => {})).status, 409)
  assert.equal((await dispatchExternalProvider(f.service, actor, 'POST', url, { approved: true, revision: 2 }, () => {})).status, 200)
})

void test('query-only capability profile rejects modern and legacy attachment switches', async () => {
  for (const file_upload of [{ enabled: true }, { image: { enabled: true } }]) {
    const transport = new DifyPilotTransport((async (_url: string | URL | Request) => Response.json({ user_input_form: [], file_upload })) as typeof fetch)
    await assert.rejects(transport.parameters(policy.endpoints[0], 'synthetic-key', AbortSignal.timeout(1000)), { code: 'UNSUPPORTED_PROVIDER_ATTACHMENTS' })
  }
})

void test('rotation and reapproval during preflight reject the old execution snapshot before any POST', async () => {
  const f = await administrationSetup(); await f.enable()
  const agent = await f.admin.onboard(actor, f.body())
  await f.service.review(actor, agent.id, true, 1)
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), barrier = new Promise<void>(resolve => { release = resolve })
  f.control.beforeParameters = async () => { f.control.beforeParameters = async () => {}; enter(); await barrier }
  const task = await f.service.create(actor, { agent_id: agent.id, query: 'synthetic', idempotency_key: randomUUID() })
  await entered
  try {
    const rotated = await f.admin.rotate(actor, agent.id, { revision: 2, api_key: 'replacement-key' })
    await f.service.review(actor, agent.id, true, rotated.revision)
  } finally { release() }
  await f.service.waitForTask(task.id)
  assert.equal((await f.store.task(actor, task.id)).error_code, 'CONFIGURATION_CHANGED')
  assert.deepEqual(f.requestKeys, [])
  const next = await f.service.create(actor, { agent_id: agent.id, query: 'synthetic', idempotency_key: randomUUID() })
  await f.service.waitForTask(next.id)
  assert.deepEqual(f.requestKeys, ['Bearer replacement-key'])
})

void test('legacy management cannot view, change ACL, attach datasets, or delete external agents', async () => {
  const f = await administrationSetup(); await f.enable()
  const agent = await f.admin.onboard(actor, f.body())
  const legacy = new DifyAdministrationService({ catalog: f.catalog } as never)
  assert.deepEqual(await legacy.listAgents(actor.orgId), [])
  assert.equal(await legacy.getAgent(actor.orgId, agent.id), null)
  for (const action of [() => legacy.deleteAgent(actor.orgId, agent.id, onlineCommandContext('external-delete')), () => legacy.listAcl(actor.orgId, agent.id), () => legacy.replaceAcl(actor.orgId, agent.id, []), () => legacy.replaceDatasets(actor.orgId, agent.id, []), () => legacy.getEnhancement(actor.orgId, agent.id)]) {
    await assert.rejects(action(), /not found/)
  }
  assert.deepEqual((await f.catalog.getAgent(agent.id, actor.orgId))?.visibleTo, { user_ids: ['u'] })
})

void test('the same onboarding UUID can complete independently in two organizations', async () => {
  const f = await administrationSetup(); await f.enable()
  const other = { orgId: 'org-b', userId: 'u' }
  await new AuthCenterDb(f.db).createOrganization(other.orgId, 'Second', Date.now())
  const second = new ExternalProviderService(f.store, { catalog: f.catalog, identities: f.identities, secrets: f.secrets, transport: f.transport, policy: { ...policy, orgIds: ['org-b'] }, isActive: async () => true })
  cleanups.unshift(() => second.close())
  const input = f.body()
  const a = await f.admin.onboard(actor, input), b = await second.administration.onboard(other, input)
  assert.notEqual(a.id, b.id)
  assert.equal((await second.administration.onboard(other, input)).id, b.id)
  await assert.rejects(f.store.binding(actor, b.id), { code: 'AGENT_NOT_FOUND' })
})

void test('expired rotation recovers an immutable written Secret as an unapproved draft', async () => {
  const f = await administrationSetup(); await f.enable()
  const agent = await f.admin.onboard(actor, f.body())
  await f.service.review(actor, agent.id, true, 1)
  let release!: () => void, enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), barrier = new Promise<void>(resolve => { release = resolve })
  f.control.beforeWrite = async () => { enter(); await barrier }
  const rotation = f.admin.rotate(actor, agent.id, { revision: 2, api_key: 'replacement-key' })
  await entered
  const row = await f.driver.get("SELECT document FROM external_pilot_operations WHERE kind = 'rotate' AND status = 'pending'")
  const operation = JSON.parse(String(row!.document))
  f.values.set(operation.targetRef.slice(8), 'replacement-key')
  await f.driver.run('UPDATE external_pilot_operations SET lease_until = 0 WHERE id = ?', [operation.id])
  const restarted = new CredentialOperations(new ExternalTaskStore(f.driver), { catalog: f.catalog, identities: f.identities, secrets: f.secrets, policy, isActive: async () => true })
  await restarted.reconcile()
  const recovered = await f.store.binding(actor, agent.id)
  assert.equal(recovered.approved, false); assert.equal(recovered.credentialUpdating, false)
  assert.equal(recovered.credential_ref, operation.targetRef)
  release(); await rotation
  assert.equal((await f.store.binding(actor, agent.id)).revision, recovered.revision)
})

void test('an expired unwritten rotation cannot be published by a late writer and its Secret is cleaned', async () => {
  const f = await administrationSetup(); await f.enable()
  const agent = await f.admin.onboard(actor, f.body())
  let release!: () => void, enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), barrier = new Promise<void>(resolve => { release = resolve })
  f.control.beforeWrite = async () => { enter(); await barrier }
  const rotation = f.admin.rotate(actor, agent.id, { revision: 1, api_key: 'replacement-key' })
  const failed = assert.rejects(rotation, { code: 'CREDENTIAL_OPERATION_EXPIRED' })
  await entered
  await f.driver.run("UPDATE external_pilot_operations SET lease_until = 0 WHERE status = 'pending'")
  await f.admin.operations.reconcile()
  release(); await failed
  const recovered = await f.store.binding(actor, agent.id)
  assert.equal(recovered.credentialRecoveryRequired, true); assert.equal(recovered.credentialUpdating, false)
  await assert.rejects(f.service.review(actor, agent.id, true, recovered.revision!), { code: 'CREDENTIAL_ROTATION_REQUIRED' })
  await f.admin.operations.reconcile(Date.now() + 120_000)
  assert(![...f.values.values()].includes('replacement-key'))
})

void test('SIGKILL before and after vault writes leaves recoverable onboarding and rotation operations', async () => {
  for (const kind of ['onboard', 'rotate']) for (const stage of ['before-write', 'after-write']) {
    const directory = await mkdtemp(join(tmpdir(), 'moss-external-kill-'))
    try {
      assert.throws(() => execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../testing/externalProviderCrashFixture.ts', import.meta.url)), directory, kind, stage], { stdio: 'pipe', timeout: 10000 }), error => (error as { signal: string }).signal === 'SIGKILL')
      const f = await crashFixture(directory)
      try {
        await f.store.ready
        await f.driver.run("UPDATE external_pilot_operations SET lease_until = 0 WHERE status = 'pending'")
        await f.service.administration.operations.reconcile()
        const bindings = await f.store.bindings(f.actor)
        if (kind === 'onboard' && stage === 'before-write') assert.equal(bindings.length, 0)
        else {
          assert.equal(bindings.length, 1)
          assert.equal(bindings[0].approved, false)
          assert.equal(Boolean(bindings[0].credentialUpdating), false)
          assert.equal(Boolean(bindings[0].credentialRecoveryRequired), kind === 'rotate' && stage === 'before-write')
        }
        assert.equal((await f.driver.all("SELECT id FROM external_pilot_operations WHERE status = 'pending'")).length, 0)
      } finally { await f.service.close(); await f.driver.close() }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
})

void test('incremental events bound storage, support replacements, page cursors and checkpoint resync without read writes', async t => {
  const f = await setup(), binding = await f.store.binding(actor, f.registered.id)
  const task = await f.store.create(actor, f.request(), binding, 120000)
  const initial = await f.store.events(actor, task.id, 0)
  const writes: string[] = [], run = f.driver.run.bind(f.driver)
  f.driver.run = async (sql, params) => { writes.push(sql); return run(sql, params) }
  await f.store.events(actor, task.id, initial.next_cursor)
  assert.deepEqual(writes, [])
  let answer = ''
  for (let i = 1; i <= 128; i++) {
    answer += 'x'.repeat(1000)
    await f.store.mutate(task.id, current => { current.status = 'running'; current.answer = answer; current.raw_answer = answer; return 'answer' })
  }
  const size = await f.driver.get('SELECT SUM(LENGTH(document)) AS size FROM external_pilot_events WHERE task_id = ?', [task.id])
  t.diagnostic(`128000 answer characters: ${size?.size} event document characters`)
  assert(Number(size?.size) < 250000, `Event size ${size?.size} must grow approximately linearly`)
  const first = await f.store.events(actor, task.id, initial.next_cursor)
  assert.equal(first.task, undefined); assert.equal(first.events.length, 100); assert.equal(first.has_more, true)
  const second = await f.store.events(actor, task.id, first.next_cursor)
  let projected = initial.task!.answer
  for (const event of [...first.events, ...second.events]) if (event.delta) projected = projected.slice(0, event.delta.offset) + event.delta.text
  assert.equal(projected, answer); assert.equal((await f.store.task(actor, task.id)).answer, answer)
  await f.store.mutate(task.id, current => { current.answer = 'replacement'; current.raw_answer = 'replacement'; return 'answer' })
  const replacement = await f.store.events(actor, task.id, second.next_cursor)
  assert.deepEqual(replacement.events[0].delta, { offset: 0, text: 'replacement' })
  await f.store.mutate(task.id, current => { current.status = 'succeeded'; current.output_status = 'valid'; return 'status' })
  const final = await f.store.events(actor, task.id, replacement.next_cursor)
  assert.equal(final.task?.answer, 'replacement'); assert.equal(final.task?.raw_answer, 'replacement')
  assert.equal((await f.store.events(actor, task.id, 100000)).task?.answer, 'replacement')
})

void test('administrator reconciliation preserves unknown status, audit and the session fence', async () => {
  const f = await setup({ events: successful().slice(0, 2) }), task = await f.run()
  const note = 'Checked provider run; local conversation closed without replay.'
  const result = await f.store.reconcileUnknown(actor, task.id, note)
  assert.equal(result.status, 'unknown'); assert.equal(result.reconciliation?.note, note)
  assert.equal((await f.store.unresolved(actor.orgId)).length, 0)
  await assert.rejects(f.store.reconcileUnknown({ ...actor, orgId: 'other' }, task.id, note), { code: 'TASK_NOT_FOUND' })
  await assert.rejects(f.service.create(actor, f.request(task.session_id)), { code: 'SESSION_BUSY_OR_AGENT_MISMATCH' })
  assert.equal(f.calls.length, 1)
  const audit = await f.driver.all("SELECT * FROM external_pilot_admin_audit WHERE action = 'task.unknown_closed'")
  assert.equal(audit.length, 1)
})

void test('upgrading a legacy interrupted rotation requires a fresh key and never republishes it', async () => {
  const f = await administrationSetup(); await f.enable()
  const agent = await f.admin.onboard(actor, f.body())
  const binding = await f.store.binding(actor, agent.id)
  binding.credentialUpdating = true; binding.approved = true; delete binding.credentialVersion
  await f.store.saveBinding(binding)
  const restarted = new ExternalTaskStore(f.driver)
  await restarted.ready
  const operations = new CredentialOperations(restarted, f.admin.options)
  await operations.reconcile()
  const recovered = await restarted.binding(actor, agent.id)
  assert.equal(recovered.approved, false)
  assert.equal(recovered.credentialUpdating, false)
  assert.equal(recovered.credentialRecoveryRequired, true)
  await assert.rejects(f.service.review(actor, agent.id, true, recovered.revision!), { code: 'CREDENTIAL_ROTATION_REQUIRED' })
  await f.admin.archive(actor, agent.id, { revision: recovered.revision })
  assert.equal((await f.identities.getIntegrationConnection(binding.connectionId))?.enabled, false)
})

void test('configuration and policy mutations during preflight invalidate pending dispatch', async () => {
  for (const field of ['endpoint', 'decoder', 'allowed_user_ids', 'approved', 'policy']) {
    const f = await administrationSetup(); await f.enable()
    const agent = await f.admin.onboard(actor, f.body())
    await f.service.review(actor, agent.id, true, 1)
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), barrier = new Promise<void>(resolve => { release = resolve })
    f.control.beforeParameters = async () => { f.control.beforeParameters = async () => {}; enter(); await barrier }
    const task = await f.service.create(actor, { agent_id: agent.id, query: 'synthetic', idempotency_key: randomUUID() })
    await entered
    try {
      if (field === 'policy') {
        const current = await f.admin.policy(actor)
        await f.admin.setPolicy(actor, { ...current, enabled: false })
      } else {
        const binding = await f.store.binding(actor, agent.id)
        if (field === 'endpoint') binding.endpoint = 'http://127.0.0.1:9999/v1'
        if (field === 'decoder') binding.decoder = binding.decoder === 'text' ? 'reply_actions_v1' : 'text'
        if (field === 'allowed_user_ids') binding.allowed_user_ids = []
        if (field === 'approved') binding.approved = false
        await f.store.saveBinding(binding)
      }
    } finally { release() }
    await f.service.waitForTask(task.id)
    assert.equal((await f.store.task(actor, task.id)).status, 'rejected', field)
    assert.deepEqual(f.requestKeys, [], field)
  }
})

void test('onboarding rejects changed credentials, including completed retries and old unfingerprinted hashes', async () => {
  const f = await administrationSetup(); await f.enable()
  const body = f.body(), agent = await f.admin.onboard(actor, body)
  await assert.rejects(f.admin.onboard(actor, { ...body, api_key: 'replacement-key' }), { code: 'IDEMPOTENCY_CONFLICT' })
  await assert.rejects(f.admin.onboard(actor, { ...body, api_key: '' }), { code: 'INVALID_ADMIN_INPUT' })
  assert.equal(f.writes.length, 1)
  assert.equal((await f.admin.onboard(actor, body)).id, agent.id)
  assert(!JSON.stringify(await f.driver.all('SELECT * FROM external_pilot_operations')).includes(body.api_key))
  await f.driver.run("UPDATE external_pilot_operations SET request_hash = 'legacy-unfingerprinted'")
  await assert.rejects(f.admin.onboard(actor, body), { code: 'IDEMPOTENCY_CONFLICT' })
})

void test('raw deltas survive checkpoint gaps, restart, replacement and unknown finalization', async () => {
  const f = await setup(), binding = await f.store.binding(actor, f.registered.id)
  const task = await f.store.create(actor, f.request(), binding, 120000)
  for (const raw of ['{"reply":"a', '{"reply":"ab', '{"reply":"replacement']) {
    await f.store.mutate(task.id, current => { current.status = 'running'; current.raw_answer = raw; current.answer = decodeOutput(raw, 'reply_actions_v1').answer; return 'answer' })
    const restarted = new ExternalTaskStore(f.driver)
    assert.equal((await restarted.task(actor, task.id)).raw_answer, raw)
  }
  await f.store.mutate(task.id, current => { current.status = 'unknown'; return 'status' })
  assert.equal((await f.store.task(actor, task.id)).raw_answer, '{"reply":"replacement')
  assert.equal((await f.store.events(actor, task.id, 0)).api_version, 'external-provider.sudo.dev/v1alpha3')
})

void test('legacy alpha2 streams resync to a labelled snapshot and unknown versions are not replayed', async () => {
  const f = await setup(), task = await f.run()
  const row = await f.driver.get('SELECT document FROM external_pilot_tasks WHERE id = ?', [task.id])
  const legacy = JSON.parse(String(row!.document)); legacy.api_version = 'external-provider.sudo.dev/v1alpha2'; delete legacy.raw_answer_freshness
  await f.driver.run('UPDATE external_pilot_tasks SET document = ? WHERE id = ?', [JSON.stringify(legacy), task.id])
  const page = await f.store.events(actor, task.id, 0)
  assert.equal(page.task?.raw_answer_freshness, 'legacy_checkpoint')
  const eventRow = await f.driver.get('SELECT sequence, document FROM external_pilot_events WHERE task_id = ? AND sequence = 2', [task.id])
  const event = JSON.parse(String(eventRow!.document)); delete event.api_version; delete event.kind
  await f.driver.run('UPDATE external_pilot_events SET document = ? WHERE task_id = ? AND sequence = 2', [JSON.stringify(event), task.id])
  assert((await f.store.events(actor, task.id, 1)).task)
})

void test('history batches pending projections and skips event queries for completed checkpoints', async () => {
  const f = await setup(), first = await f.run()
  for (let i = 0; i < 5; i++) await f.run(f.request(first.session_id, `synthetic ${i}`))
  const all = f.driver.all.bind(f.driver); let eventQueries = 0
  f.driver.all = async (sql, params) => { if (sql.includes('FROM external_pilot_events')) eventQueries++; return all(sql, params) }
  assert.equal((await f.store.history(actor, first.session_id)).length, 6)
  assert.equal(eventQueries, 0)
  const binding = await f.store.binding(actor, first.agent_id)
  const pending = await f.store.create(actor, f.request(first.session_id), binding, 120000)
  await f.store.mutate(pending.id, current => { current.answer = 'partial'; current.raw_answer = 'partial'; return 'answer' })
  eventQueries = 0
  const history = await f.store.history(actor, first.session_id)
  assert.equal(history.at(-1)?.answer, 'partial'); assert.equal(eventQueries, 1)
})

void test('reconciliation records attempt closure while preserving unknown outcome and is idempotent', async () => {
  const f = await setup({ events: successful().slice(0, 2) }), task = await f.run()
  await f.store.reconcileUnknown(actor, task.id, 'checked')
  await f.store.reconcileUnknown(actor, task.id, 'duplicate')
  const row = await f.driver.get('SELECT a.status, r.document FROM external_pilot_attempts a JOIN external_pilot_reconciliations r ON r.task_id = a.task_id WHERE a.task_id = ?', [task.id])
  assert.equal(row?.status, 'unknown'); assert.equal(JSON.parse(String(row?.document)).note, 'checked')
  assert.equal((await f.store.unresolved(actor.orgId)).length, 0)
})

void test('acknowledged cleanup becomes terminal, stops vault calls and expires after retention', async () => {
  const f = await administrationSetup(); await f.enable()
  const agent = await f.admin.onboard(actor, f.body())
  await f.admin.archive(actor, agent.id, { revision: agent.revision })
  const now = Date.now()
  await f.admin.operations.reconcile(now)
  assert.equal(f.values.size, 0)
  const rows = await f.driver.all("SELECT * FROM external_pilot_operations WHERE status = 'cleanup_complete'")
  assert.equal(rows.length, 1)
  let reads = 0; const read = f.secrets.getSecret
  f.secrets.getSecret = async (...args) => { reads++; return read(...args) }
  await f.admin.operations.reconcile(now + 86400_000)
  assert.equal(reads, 0)
  await f.admin.operations.reconcile(now + 31 * 86400_000)
  assert.equal((await f.driver.all("SELECT * FROM external_pilot_operations WHERE status = 'cleanup_complete'")).length, 0)
})

void test('uncertain cleanup retains a compact guard without repeated deletes and catches late writes', async () => {
  const f = await administrationSetup(); await f.enable()
  const ref = 'nexus://org:org-a:external:uncertain/app-key'
  await f.admin.operations.queueCleanup(actor, ref)
  let deletes = 0; const remove = f.secrets.deleteSecret
  f.secrets.deleteSecret = async (...args) => { deletes++; await remove(...args) }
  const now = Date.now()
  await f.admin.operations.reconcile(now)
  await f.admin.operations.reconcile(now + 86400_000)
  assert.equal(deletes, 0)
  f.values.set(ref.slice(8), 'late-synthetic-key')
  await f.admin.operations.reconcile(now + 2 * 86400_000)
  assert.equal(deletes, 1); assert.equal(f.values.size, 0)
  const row = await f.driver.get("SELECT document FROM external_pilot_operations WHERE status = 'cleanup_guard'")
  assert(row); assert(!String(row.document).includes('binding'))
})

void test('progress coalesces a blocked writer to one latest snapshot and flushes before terminal', async () => {
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const writes: string[] = []
  const progress = new ProgressCoalescer(async value => { writes.push(value.raw); if (writes.length === 1) await barrier })
  progress.push({ raw: 'first', refs: {} })
  await Promise.resolve()
  for (let i = 0; i < 100; i++) progress.push({ raw: `latest-${i}`, refs: {} })
  assert.deepEqual(writes, ['first'])
  const flushed = progress.flush()
  release(); await flushed
  assert.deepEqual(writes, ['first', 'latest-99'])
  const failed = new ProgressCoalescer(async () => { throw new Error('database unavailable') })
  failed.push({ raw: 'pending', refs: {} })
  await assert.rejects(failed.flush(), /database unavailable/)
})

void test('a write acknowledged during an absence check is cleaned again before terminal retirement', async () => {
  const f = await administrationSetup(); await f.enable()
  const ref = 'nexus://org:org-a:external:race/app-key'
  await f.admin.operations.queueCleanup(actor, ref)
  const row = await f.driver.get("SELECT id, document FROM external_pilot_operations WHERE status = 'cleanup'")
  const read = f.secrets.getSecret
  let raced = false
  f.secrets.getSecret = async (...args) => {
    if (raced) return read(...args)
    raced = true
    f.values.set(ref.slice(8), 'late-acknowledged')
    const document = { ...JSON.parse(String(row!.document)), writeConfirmed: true }
    await f.driver.run('UPDATE external_pilot_operations SET document = ? WHERE id = ?', [JSON.stringify(document), String(row!.id)])
    return {value: null, status: 'enabled', version: 1}
  }
  await f.admin.operations.reconcile()
  assert.equal((await f.driver.get('SELECT status FROM external_pilot_operations WHERE id = ?', [String(row!.id)]))?.status, 'cleanup')
  await f.admin.operations.reconcile()
  assert.equal(f.values.size, 0)
  assert.equal((await f.driver.get('SELECT status FROM external_pilot_operations WHERE id = ?', [String(row!.id)]))?.status, 'cleanup_complete')
})
