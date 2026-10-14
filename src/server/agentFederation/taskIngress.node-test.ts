import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { crashFixture } from '../testing/externalProviderCrashFixture.js'
import { AGENT_FEDERATION_API, AGENT_HTTP_API } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import { TASK_API, type SubmitTask } from '../../../contracts/task/v1alpha1/contract.js'
import { HTTP_CAPABILITIES } from './manifest.js'
import { dispatchExternalProvider } from '../externalProviders/routes.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'federation-ingress-'))
  const f = await crashFixture(directory)
  cleanup.push(async () => { await f.service.close(); await f.driver.close(); await rm(directory, { recursive: true, force: true }) })
  const manifest = { api_version: AGENT_FEDERATION_API, kind: 'CustomAgentManifest', provider_kind: 'custom_http', external_agent_id: 'http-helper', name: 'HTTP helper', source_revision: 'revision-1', execution_mode: 'external_hosted', protocol: AGENT_HTTP_API, input_profile: 'query_only_v1', output_profile: 'text_v1', capabilities: { ...HTTP_CAPABILITIES } }
  const calls: Record<string, unknown>[] = []
  const control = { beforeManifest: async () => {} }
  const options = f.service.administration.options
  options.policy.timeoutMs = 10_000
  options.httpRequest = async (url, init) => {
    if (String(url).endsWith('/manifest')) { await control.beforeManifest(); return Response.json(manifest) }
    const request = JSON.parse(String(init?.body))
    const attempt = await f.driver.get('SELECT task_id FROM external_pilot_attempts WHERE id = ?', [request.invocation_id])
    assert(attempt)
    const record = await f.store.taskRecord(f.actor, String(attempt.task_id))
    assert.equal(record?.resolution.status, 'accepted', 'Admission is durable before invoking the provider')
    calls.push(request)
    return Response.json({ api_version: AGENT_HTTP_API, kind: 'AgentResult', invocation_id: request.invocation_id, provider_run_id: `remote-run-${calls.length}`, provider_session_id: 'remote-session', status: 'succeeded', output: { text: calls.length === 1 ? '42' : '50' } })
  }
  const body = { ...f.body, provider_kind: 'custom_http', app_id: manifest.external_agent_id, workspace_id: 'custom-http', source_definition: JSON.stringify(manifest) }
  const agent = await f.service.administration.onboard(f.actor, body)
  await f.service.review(f.actor, agent.id, true, agent.revision)
  const input = (): SubmitTask => ({ api_version: TASK_API, kind: 'SubmitTask', agent: { catalog_id: agent.id }, request_source: 'interactive', input: { instruction: '6 * 7', resource_refs: [] }, workspace_refs: [], requested_mode: 'auto', data_classification: 'synthetic', required_capabilities: [], constraints: { idempotency_key: randomUUID() } })
  const run = async (value = input()) => { const task = await f.service.create(f.actor, value); await f.service.waitForTask(task.id); return f.store.task(f.actor, task.id) }
  return { ...f, calls, control, manifest, body, agent, input, run }
}

void test('Custom Manifest onboarding, catalog, formal TaskSpec and two-turn execution use one workflow', async () => {
  const f = await setup()
  const row = await f.service.administration.options.catalog.getAgent(f.agent.id, f.actor.orgId)
  assert.equal(row?.providerType, 'custom_http')
  assert.equal((await f.service.list(f.actor))[0].capabilities.streaming, 'unsupported')
  const first = await f.run(), record = await f.store.taskRecord(f.actor, first.id)
  assert.equal(first.status, 'succeeded'); assert.equal(first.answer, '42')
  assert.equal(record?.spec.requested_by.subject_id, f.actor.userId)
  assert.equal(record?.spec.input.instruction, '6 * 7')
  assert.equal(record?.resolution.status, 'accepted')
  if (record?.resolution.status !== 'accepted') assert.fail('expected accepted resolution')
  assert.equal(record.resolution.attempt_id, first.attempt_id)
  assert.equal(record.resolution.resolved_runtime, 'external_provider')
  const second = await f.run({ ...f.input(), session_id: first.session_id, input: { instruction: 'plus eight', resource_refs: [] } })
  assert.equal(second.answer, '50'); assert.equal(f.calls[1].provider_session_id, 'remote-session')
  assert.equal((await f.store.history(f.actor, first.session_id)).length, 2)
  record.spec.input.instruction = 'mutated client copy'
  assert.equal((await f.store.taskRecord(f.actor, first.id))?.spec.input.instruction, '6 * 7')
  const route = await dispatchExternalProvider(f.service, f.actor, 'GET', new URL(`http://test/api/v1/tasks/${first.id}/specification`), null, () => {})
  assert.equal(route.status, 200)
  await assert.rejects(f.store.taskRecord({ ...f.actor, userId: 'another' }, first.id), { code: 'TASK_NOT_FOUND' })
})

void test('valid policy rejections persist original request and reason without Attempt or remote request', async () => {
  const f = await setup()
  const cases = [
    { ...f.input(), data_classification: 'confidential' },
    { ...f.input(), requested_mode: 'private' as const },
    { ...f.input(), required_capabilities: ['cancel'] },
    { ...f.input(), agent: { catalog_id: 'unknown-agent' } },
    { ...f.input(), constraints: { idempotency_key: randomUUID(), deadline: '2000-01-01T00:00:00Z' } },
  ]
  for (const input of cases) {
    const task = await f.run(input), record = await f.store.taskRecord(f.actor, task.id)
    assert.equal(task.status, 'rejected'); assert.equal(task.attempt_id, null); assert.equal(task.answer, '')
    assert.equal(record?.resolution.status, 'rejected'); assert.equal('attempt_id' in record!.resolution, false)
    assert.equal((await f.driver.get('SELECT COUNT(*) AS count FROM external_pilot_attempts WHERE task_id = ?', [task.id]))?.count, 0)
    assert.equal((await f.store.session(f.actor, task.session_id)).active_task_id, null)
    assert.equal((await f.run(input)).id, task.id, 'Rejected requests are also idempotent')
  }
  assert.equal(f.calls.length, 0)
})

void test('forged identity, invalid envelopes and changed idempotency bodies cannot create or replace TaskSpec', async () => {
  const f = await setup(), request = f.input()
  for (const patch of [{ requested_by: { subject_id: 'admin' } }, { actor: 'admin' }, { api_version: 'task.sudo.dev/v999' }, { task_id: 'chosen-task' }]) {
    await assert.rejects(f.service.create(f.actor, { ...request, ...patch }), { code: 'INVALID_TASK_SPEC' })
  }
  const tasks = await Promise.all(Array.from({ length: 12 }, () => f.service.create(f.actor, request)))
  await f.service.waitForTask(tasks[0].id)
  assert.equal(new Set(tasks.map(task => task.id)).size, 1); assert.equal(f.calls.length, 1)
  await assert.rejects(f.service.create(f.actor, { ...request, data_classification: 'confidential' }), { code: 'IDEMPOTENCY_CONFLICT' })
  assert.equal((await f.store.taskRecord(f.actor, tasks[0].id))?.spec.data_classification, 'synthetic')
})

void test('ledger insertion failure rolls back task, session, attempt and key reservation', async () => {
  const f = await setup(), request = f.input(), original = f.driver.run.bind(f.driver)
  f.driver.run = async (sql, params) => { if (sql.startsWith('INSERT INTO product_task_records')) throw new Error('Synthetic ledger failure'); return original(sql, params) }
  try { await assert.rejects(f.service.create(f.actor, request), /Synthetic ledger failure/) }
  finally { f.driver.run = original }
  for (const table of ['product_task_records', 'external_pilot_tasks', 'external_pilot_sessions', 'external_pilot_attempts']) assert.equal((await f.driver.get(`SELECT COUNT(*) AS count FROM ${table}`))?.count, 0)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.run(request)).status, 'succeeded')
})

void test('revocation after admission fails the Attempt while retaining the immutable accepted decision', async () => {
  const f = await setup()
  let release!: () => void, enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), barrier = new Promise<void>(resolve => { release = resolve })
  f.control.beforeManifest = async () => { enter(); await barrier }
  const task = await f.service.create(f.actor, f.input())
  await entered
  try { await f.service.review(f.actor, f.agent.id, false, 2) } finally { release() }
  await f.service.waitForTask(task.id)
  const failed = await f.store.task(f.actor, task.id)
  assert.equal(failed.status, 'failed'); assert(failed.attempt_id)
  assert.equal((await f.store.taskRecord(f.actor, task.id))?.resolution.status, 'accepted')
  assert.equal(f.calls.length, 0)
})

void test('changed custom source invalidates approval and cannot switch the bound remote identity', async () => {
  const f = await setup()
  const current = (await f.service.administration.list(f.actor))[0]
  await assert.rejects(f.service.administration.update(f.actor, f.agent.id, { ...f.body, request_id: undefined }), { code: 'INVALID_ADMIN_INPUT' })
  const update = { revision: current.revision, name: current.name, decoder: 'text', allowed_user_ids: [f.actor.userId], review_days: 1, review_note: 'Changed source snapshot', source_definition: JSON.stringify({ ...f.manifest, external_agent_id: 'different-agent' }) }
  await assert.rejects(f.service.administration.update(f.actor, f.agent.id, update), { code: 'MANIFEST_BINDING_MISMATCH' })
  const next = await f.service.administration.update(f.actor, f.agent.id, { ...update, source_definition: JSON.stringify({ ...f.manifest, source_revision: 'revision-2' }) })
  assert.equal(next.approved, false); assert.notEqual(next.source_digest, current.source_digest)
  await assert.rejects(f.service.review(f.actor, next.id, true, next.revision), { code: 'PROVIDER_SOURCE_CHANGED' })
})

void test('corrupted persisted ResourceRefs and resolution correlations fail closed on reads', async () => {
  const f = await setup(), task = await f.run(), record = await f.store.taskRecord(f.actor, task.id)
  assert(record)
  record.spec.input.resource_refs = [{}] as typeof record.spec.input.resource_refs
  await f.driver.run('UPDATE product_task_records SET document = ? WHERE task_id = ?', [JSON.stringify(record), task.id])
  await assert.rejects(f.store.taskRecord(f.actor, task.id), { code: 'INVALID_TASK_RECORD' })
  record.spec.input.resource_refs = []
  if (record.resolution.status !== 'accepted') assert.fail('expected accepted')
  record.resolution.agent.principal.agent_name = 'another'
  await f.driver.run('UPDATE product_task_records SET document = ? WHERE task_id = ?', [JSON.stringify(record), task.id])
  await assert.rejects(f.store.taskRecord(f.actor, task.id), { code: 'TASK_RECORD_MISMATCH' })
})
