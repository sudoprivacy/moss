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
import { DURABLE_AGENT_HTTP_API, DURABLE_HTTP_CAPABILITIES } from '../../../contracts/agent-http/v1alpha2/contract.js'
import { contentDigest } from './provider/protocol.js'
import { maintainRetention } from '../externalProviders/retention.js'
import { dispatchExternalProvider } from '../externalProviders/routes.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
async function setup(durableError?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'federation-ingress-'))
  const f = await crashFixture(directory)
  cleanup.push(async () => { await f.service.close(); await f.driver.close(); await rm(directory, { recursive: true, force: true }) })
  const manifest = { api_version: AGENT_FEDERATION_API, kind: 'CustomAgentManifest', provider_kind: 'custom_http', external_agent_id: 'http-helper', name: 'HTTP helper', source_revision: 'revision-1', execution_mode: 'external_hosted', protocol: AGENT_HTTP_API, input_profile: 'query_only_v1', output_profile: 'text_v1', capabilities: { ...HTTP_CAPABILITIES }, ...(durableError ? { protocol: DURABLE_AGENT_HTTP_API, source_revision: `sha256:${'a'.repeat(64)}`, capabilities: { ...DURABLE_HTTP_CAPABILITIES }, execution_revision: `sha256:${'a'.repeat(64)}` } : {}) }
  const calls: Record<string, unknown>[] = []
  const control = { beforeManifest: async () => {} }
  const options = f.service.administration.options
  options.policy.timeoutMs = 10_000
  options.httpRequest = async (url, init) => {
    if (new URL(String(url)).pathname.endsWith('/manifest')) { await control.beforeManifest(); return Response.json(manifest) }
    const request = JSON.parse(String(init?.body))
    const attempt = await f.driver.get('SELECT task_id FROM task_attempts WHERE id = ?', [request.invocation_id])
    assert(attempt)
    const record = await f.store.taskRecord(f.actor, String(attempt.task_id))
    assert.equal(record?.resolution.status, 'accepted', 'Admission is durable before invoking the provider')
    calls.push(request)
    if (durableError) return Response.json({ api_version: DURABLE_AGENT_HTTP_API, kind: 'AgentRun', invocation_id: request.invocation_id, request_digest: contentDigest(request), external_agent_id: request.external_agent_id, execution_revision: request.execution_revision, provider_run_id: 'remote-run', provider_session_id: 'remote-session', status: 'failed', sequence: 2, output: { text: '' }, error_code: durableError, created_at: Date.now(), updated_at: Date.now() })
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
  const evidence = await f.service.evidence(f.actor, first.id)
  assert.equal(evidence.kind, 'ExternalTaskEvidence')
  assert.equal(evidence.selection?.version, record.resolution.agent.version)
  assert.equal(evidence.execution?.provider_run_id, first.provider_refs.run_id)
  assert.equal(evidence.execution?.version_evidence, 'source_snapshot_only')
  assert.equal(evidence.execution?.execution_revision, undefined)
  await assert.rejects(f.service.evidence({ ...f.actor, userId: 'another' }, first.id), { code: 'TASK_NOT_FOUND' })
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
    assert.equal((await f.driver.get('SELECT COUNT(*) AS count FROM task_attempts WHERE task_id = ?', [task.id]))?.count, 0)
    assert.equal((await f.store.session(f.actor, task.session_id)).active_task_id, null)
    assert.equal((await f.run(input)).id, task.id, 'Rejected requests are also idempotent')
  }
  assert.equal(f.calls.length, 0)
})

void test('user release options enforce authorization and never expose administration snapshots', async () => {
  const f = await setup()
  const path = new URL(`http://test/api/v1/external-agents/${f.agent.id}/versions`)
  const result = await dispatchExternalProvider(f.service, f.actor, 'GET', path, null, () => { throw new Error('Member has no administration permission') })
  assert.equal(result.status, 200)
  const options = await f.service.releaseOptions(f.actor, f.agent.id)
  assert.equal(options.kind, 'AgentReleaseOptions'); assert.equal(options.items.length, 1)
  for (const key of ['endpoint', 'snapshot', 'review_note', 'credential', 'workspace_id']) assert.equal(JSON.stringify(options).includes(`"${key}"`), false)
  await assert.rejects(f.service.releaseOptions({ ...f.actor, userId: 'not-allowed' }, f.agent.id), { code: 'AGENT_NOT_APPROVED_FOR_USER' })
  await assert.rejects(f.service.releaseOptions({ ...f.actor, orgId: 'other-org' }, f.agent.id), { code: 'AGENT_NOT_FOUND' })
  await f.service.releases.revoke(f.actor, f.agent.id, options.items[0].version, 'Withdraw reviewed version')
  const revoked = await f.service.releaseOptions(f.actor, f.agent.id)
  assert.deepEqual(revoked.items, []); assert.deepEqual(revoked.channels, [])
  const rejected = await f.run({ ...f.input(), agent: { catalog_id: f.agent.id, requested_version: options.items[0].version } })
  assert.equal(rejected.status, 'rejected'); assert.equal(f.calls.length, 0)
})

void test('channel changes between admission and dispatch preserve exact accepted release', async () => {
  const f = await setup()
  const binding = await f.store.binding(f.actor, f.agent.id)
  await f.service.releases.publish(f.actor, binding, '1.0.0', 'Initial alias')
  await f.service.releases.publish(f.actor, binding, '1.1.0', 'Canary alias')
  await f.service.releases.moveChannel(f.actor, binding.id, 'canary', '1.0.0', 0)
  f.control.beforeManifest = async () => {
    await f.service.releases.moveChannel(f.actor, binding.id, 'canary', '1.1.0', 1)
  }
  const task = await f.run({ ...f.input(), agent: { catalog_id: binding.id, requested_channel: 'canary' } })
  assert.equal(task.status, 'succeeded')
  const record = await f.store.taskRecord(f.actor, task.id)
  assert.equal(record?.resolution.status, 'accepted')
  if (record?.resolution.status !== 'accepted') assert.fail('Expected accepted task')
  assert.equal(record.resolution.agent.version, '1.0.0')
  assert.equal(record.resolution.agent.channel_revision, 1)
  assert.equal((await f.service.releases.resolve(f.actor, binding.id, undefined, 'canary')).manifest.version, '1.1.0')
  f.control.beforeManifest = async () => {}
  const followup = await f.run({ ...f.input(), session_id: task.session_id })
  assert.equal(followup.status, 'succeeded')
  const followupRecord = await f.store.taskRecord(f.actor, followup.id)
  assert.equal(followupRecord?.resolution.status === 'accepted' && followupRecord.resolution.agent.version, '1.0.0')
  const conflict = await f.run({ ...f.input(), session_id: task.session_id, agent: { catalog_id: binding.id, requested_channel: 'canary' } })
  assert.equal(conflict.status, 'rejected'); assert.equal(conflict.policy_decision?.reason_code, 'VERSION_CHANGE_REQUIRES_NEW_SESSION')
  assert.equal(conflict.policy_decision?.reason, '当前会话已固定智能体版本，切换版本或频道请新建会话。')
  assert.equal(f.calls.length, 2)
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
  for (const table of ['product_task_records', 'tasks', 'external_sessions', 'task_attempts']) assert.equal((await f.driver.get(`SELECT COUNT(*) AS count FROM ${table}`))?.count, 0)
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

void test('legacy HTTP submissions cannot bypass classification or create any task state', async () => {
  const f = await setup(), url = new URL('http://test/api/v1/tasks')
  const legacy = { agent_id: f.agent.id, query: 'synthetic fixture', idempotency_key: randomUUID() }
  for (const body of [legacy, { ...legacy, data_classification: 'confidential' }, { ...legacy, required_capabilities: ['verified_source_identity'] }]) {
    const response = await dispatchExternalProvider(f.service, f.actor, 'POST', url, body, () => {})
    assert.equal(response.status, 409)
    assert.match(JSON.stringify(response.body), /TASK_CLIENT_UPGRADE_REQUIRED/)
  }
  for (const table of ['product_task_records', 'tasks', 'external_sessions', 'task_attempts', 'task_events']) {
    assert.equal((await f.driver.get(`SELECT COUNT(*) AS count FROM ${table}`))?.count, 0)
  }
  assert.equal(f.calls.length, 0)
  const task = await f.run({ ...f.input(), constraints: { idempotency_key: legacy.idempotency_key } })
  assert.equal(task.status, 'succeeded', 'A rejected legacy request never reserves the upgraded request key')
})

void test('source identity remains explicitly unverified and strong-audit tasks reject before provider I/O', async () => {
  const f = await setup()
  let preflights = 0
  f.control.beforeManifest = async () => { preflights++ }
  assert.equal(f.agent.source_identity_evidence, 'unverified')
  assert.equal((await f.service.list(f.actor))[0].source_identity_evidence, 'unverified')
  const request = { ...f.input(), required_capabilities: ['verified_source_identity'] }
  const rejected = await f.run(request)
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.error_code, 'SOURCE_IDENTITY_UNVERIFIED')
  assert.equal(rejected.attempt_id, null); assert.equal(preflights, 0); assert.equal(f.calls.length, 0)
  assert.equal((await f.run(request)).id, rejected.id)
  const task = await f.run(), record = await f.store.taskRecord(f.actor, task.id)
  assert.equal(task.source_identity_evidence, 'unverified')
  assert.equal((await f.store.runBinding(f.actor, task.id))?.source_identity_evidence, 'unverified')
  if (record?.resolution.status !== 'accepted' || record.resolution.execution_mode !== 'external_hosted') assert.fail('expected accepted synthetic external task')
  assert.equal(record.resolution.agent.source_identity_evidence, 'unverified')
  assert.equal(record.resolution.agent.claimed_app_id, f.manifest.external_agent_id)
  assert.equal(record.resolution.agent.claimed_workspace_id, 'custom-http')
  const snapshot = JSON.parse(String((await f.driver.get('SELECT policy_snapshot FROM product_task_records WHERE task_id = ?', [task.id]))?.policy_snapshot))
  assert.equal(snapshot.source_identity_evidence, 'unverified')
  assert.equal(snapshot.claimed_app_id, f.manifest.external_agent_id)
})

void test('history follows durable session creation order despite deadlines and clock changes', async () => {
  const f = await setup(), first = await f.run()
  const second = await f.run({ ...f.input(), session_id: first.session_id })
  const third = await f.run({ ...f.input(), session_id: first.session_id })
  // Arrange history facts after execution so dispatch budgets remain independent
  // of this ordering test. Keep the durable ordinal through every mutation.
  for (const task of [second, third]) {
    const row = await f.driver.get('SELECT document FROM tasks WHERE id = ?', [task.id])
    const document = JSON.parse(String(row?.document))
    document.created_at = task.id === second.id ? first.created_at : first.created_at - 60_000
    if (task.id === second.id) document.deadline_at = first.deadline_at - 1000
    await f.driver.run('UPDATE tasks SET document = ? WHERE id = ?', [JSON.stringify(document), task.id])
  }
  const { ExternalTaskStore } = await import('../externalProviders/store.js')
  const reopened = new ExternalTaskStore(f.driver)
  const history = await reopened.history(f.actor, first.session_id)
  assert(history[1].deadline_at < history[0].deadline_at)
  assert.deepEqual(history.map(task => task.id), [first.id, second.id, third.id])
  assert.deepEqual(history.map(task => task.session_sequence), [1, 2, 3])
  assert.equal(f.calls.length, 3)
})

void test('short budgets reject durably without credentials, Attempt or provider calls', async () => {
  const f = await setup()
  let reads = 0
  f.service.administration.options.secrets.getSecret = async () => { reads++; throw new Error('No vault I/O allowed') }
  for (const constraints of [{ timeout_ms: 1 }, { deadline: new Date(Date.now() + 50).toISOString() }]) {
    const input = { ...f.input(), constraints: { idempotency_key: randomUUID(), ...constraints } }
    const task = await f.run(input)
    assert.equal(task.status, 'rejected')
    assert(['DISPATCH_BUDGET_TOO_SHORT', 'DEADLINE_EXPIRED'].includes(task.error_code!))
    assert.equal(task.attempt_id, null)
    assert.equal((await f.store.taskRecord(f.actor, task.id))?.resolution.status, 'rejected')
    assert.equal((await f.run(input)).id, task.id)
  }
  assert.equal(reads, 0); assert.equal(f.calls.length, 0)
})

void test('expiry during admission storage terminalizes before dispatch without waiting for maintenance', async () => {
  const f = await setup()
  await f.service.maintain()
  // Disable only expiry scanning; a closed service must not accept new work.
  f.store.expire = async () => {}
  let reads = 0
  f.service.administration.options.secrets.getSecret = async () => { reads++; throw new Error('No vault I/O allowed') }
  const run = f.driver.run.bind(f.driver)
  f.driver.run = async (sql, params) => {
    if (sql.startsWith('INSERT INTO tasks')) await new Promise(resolve => setTimeout(resolve, 150))
    return run(sql, params)
  }
  const task = await f.run({ ...f.input(), constraints: { idempotency_key: randomUUID(), timeout_ms: 100 } })
  assert.equal(task.status, 'failed'); assert.equal(task.error_code, 'DISPATCH_DEADLINE')
  assert.equal((await f.store.session(f.actor, task.session_id)).active_task_id, null)
  assert.equal((await f.driver.get('SELECT status FROM task_attempts WHERE task_id = ?', [task.id]))?.status, 'failed')
  assert.equal(reads, 0); assert.equal(f.calls.length, 0)
})

void test('an unregistered stored provider is rejected before vault or adapter dispatch', async () => {
  const f = await setup(), binding = await f.store.binding(f.actor, f.agent.id)
  await f.store.saveBinding({ ...binding, provider_kind: 'future-provider' as typeof binding.provider_kind })
  let reads = 0
  f.service.administration.options.secrets.getSecret = async () => { reads++; throw new Error('No vault I/O allowed') }
  const task = await f.run()
  assert.equal(task.status, 'rejected'); assert.equal(task.error_code, 'PROVIDER_NOT_IMPLEMENTED')
  assert.equal(task.attempt_id, null); assert.equal(reads, 0); assert.equal(f.calls.length, 0)
})

void test('retention compacts terminal events, retires payloads and preserves idempotency and unknown work', async () => {
  const f = await setup(), input = f.input(), task = await f.run(input)
  await f.service.maintain()
  const uncertain = await f.store.create(f.actor, { agent_id: f.agent.id, query: 'retain uncertain', idempotency_key: randomUUID() }, await f.store.binding(f.actor, f.agent.id), 1000)
  await f.store.mutate(uncertain.id, value => { value.status = 'unknown'; return 'status' })
  const day = 86400_000, base = Date.now()
  await maintainRetention(f.store, base + 2 * day)
  assert.equal((await f.store.events(f.actor, task.id, 1)).task?.answer, '42')
  await maintainRetention(f.store, base + 31 * day)
  assert.equal((await f.store.history(f.actor, task.session_id)).length, 0)
  assert.equal((await f.store.sessions(f.actor)).some(value => value.id === task.session_id), false)
  await assert.rejects(f.store.task(f.actor, task.id), { code: 'TASK_HISTORY_EXPIRED' })
  for (const cursor of [0, 1, 9999]) await assert.rejects(f.store.events(f.actor, task.id, cursor), { code: 'TASK_HISTORY_EXPIRED' })
  await assert.rejects(f.service.create(f.actor, input), { code: 'TASK_HISTORY_EXPIRED' })
  assert.equal(f.calls.length, 1)
  assert.equal((await f.store.task(f.actor, uncertain.id)).status, 'unknown')
  assert.equal((await f.store.session(f.actor, uncertain.session_id)).active_task_id, uncertain.id)
  assert.equal((await f.driver.get('SELECT COUNT(*) AS count FROM product_task_records WHERE task_id = ?', [task.id]))?.count, 0)
  assert((await f.driver.get('SELECT audit_document FROM external_pilot_retention WHERE task_id = ?', [task.id]))?.audit_document)
  await maintainRetention(f.store, base + 122 * day)
  assert.equal((await f.driver.get('SELECT audit_document FROM external_pilot_retention WHERE task_id = ?', [task.id]))?.audit_document, null)
  await assert.rejects(f.service.create(f.actor, input), { code: 'TASK_HISTORY_EXPIRED' })
})

void test('scheduled maintenance claims coalesce instances and a failed batch can retry', async () => {
  const f = await setup()
  let calls = 0
  const now = Date.now() + 10000
  const claims = await Promise.all(Array.from({ length: 8 }, () => f.store.scheduled('test', 1000, async () => { calls++ }, now)))
  assert.equal(claims.filter(Boolean).length, 1); assert.equal(calls, 1)
  await assert.rejects(f.store.scheduled('failed-test', 1000, async () => { throw new Error('rollback') }, now))
  assert.equal(await f.store.scheduled('failed-test', 1000, async () => {}, now), true)
})

void test('Pilot capacity counts tombstones, preserves retries and rejects new work without partial state', async () => {
  const f = await setup(), input = f.input(), task = await f.run(input)
  await f.driver.run(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < 9999)
    INSERT INTO tasks(id, org_id, user_id, session_id, idempotency_key, request_hash, status, deadline_at, sequence, document)
    SELECT 'retired-' || n, ?, ?, ?, 'old-key-' || n, 'old-hash', 'succeeded', 1, 1, '{"_retired":true}' FROM ids`,
  [f.actor.orgId, f.actor.userId, task.session_id])
  assert.equal((await f.run(input)).id, task.id)
  await assert.rejects(f.service.create(f.actor, f.input()), { code: 'PILOT_TASK_CAPACITY_REACHED' })
  assert.equal(f.calls.length, 1)
  for (const table of ['external_sessions', 'task_attempts', 'product_task_records']) {
    assert.equal((await f.driver.get(`SELECT COUNT(*) AS count FROM ${table}`))?.count, 1)
  }
  assert.equal((await f.driver.get('SELECT COUNT(*) AS count FROM tasks'))?.count, 10000)
})

void test('directory pages advance past archived bindings and member search is paged', async () => {
  const f = await setup(), binding = await f.store.binding(f.actor, f.agent.id)
  for (let i = 0; i < 102; i++) await f.store.saveBinding({ ...binding, id: `000-${String(i).padStart(3, '0')}`, archived: true })
  const first = await f.service.administration.listPage(f.actor)
  assert.equal(first.items.length, 0); assert(first.next_cursor)
  const second = await f.service.administration.listPage(f.actor, first.next_cursor!)
  assert.equal(second.items[0].id, f.agent.id); assert.equal(second.next_cursor, null)
  assert.equal((await f.service.list(f.actor))[0].id, f.agent.id)
  f.service.administration.options.members = async () => Array.from({ length: 120 }, (_, i) => ({ id: `member-${String(i).padStart(3, '0')}`, name: `Member ${i}` }))
  const people = await f.service.administration.memberPage(f.actor, '', 'Member')
  assert.equal(people.items.length, 50); assert.equal(people.next_cursor, 'member-049')
  assert.equal((await f.service.administration.memberPage(f.actor, people.next_cursor!, 'Member')).items[0].id, 'member-050')
  await assert.rejects(f.service.administration.memberPage(f.actor, '../invalid', ''), { code: 'INVALID_CURSOR' })
})

void test('legacy approved bindings remain unpublished on member/admin GET and member task submission', async () => {
  const f = await setup()
  // Simulate an approved Pilot binding that predates the release ledger.
  for (const table of ['agent_channel_events', 'agent_channels', 'agent_version_decisions', 'agent_versions']) {
    await f.driver.run(`DELETE FROM ${table} WHERE catalog_id = ?`, [f.agent.id])
  }
  const tables = ['agent_principals', 'agent_versions', 'agent_version_decisions', 'agent_channels', 'agent_channel_events', 'external_pilot_admin_audit']
  const snapshot = () => Promise.all(tables.map(table => f.driver.all(`SELECT * FROM ${table} ORDER BY 1`)))
  const before = await snapshot()
  const notAdmin = () => { throw new Error('Member has no administration permission') }
  for (let repeat = 0; repeat < 2; repeat++) {
    const member = await dispatchExternalProvider(f.service, f.actor, 'GET', new URL(`http://test/api/v1/external-agents/${f.agent.id}/versions`), null, notAdmin)
    assert.equal(member.status, 200)
    assert.deepEqual((member.body.data as { items: unknown[] }).items, [])
    const admin = await dispatchExternalProvider(f.service, f.actor, 'GET', new URL(`http://test/api/v1/external-agents/admin/${f.agent.id}/versions`), null, () => {})
    assert.equal(admin.status, 200)
    assert.deepEqual((admin.body.data as { items: unknown[] }).items, [])
  }
  const rejected = await f.run()
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.attempt_id, null)
  assert.equal(f.calls.length, 0)
  assert.deepEqual(await snapshot(), before, 'Reading or executing cannot publish, approve or promote a channel')
  const binding = await f.store.binding(f.actor, f.agent.id)
  const forbidden = await dispatchExternalProvider(f.service, f.actor, 'POST', new URL(`http://test/api/v1/external-agents/${f.agent.id}/review`), { approved: true, revision: binding.revision }, notAdmin)
  assert.notEqual(forbidden.status, 200)
  assert.deepEqual(await snapshot(), before)
  const reviewed = await dispatchExternalProvider(f.service, f.actor, 'POST', new URL(`http://test/api/v1/external-agents/${f.agent.id}/review`), { approved: true, revision: binding.revision }, () => {})
  assert.equal(reviewed.status, 200)
  const options = await f.service.releaseOptions(f.actor, f.agent.id)
  assert.equal(options.items.length, 1); assert.equal(options.channels[0].name, 'stable')
  const published = await snapshot()
  await f.service.releaseOptions(f.actor, f.agent.id)
  assert.deepEqual(await snapshot(), published)
  assert.equal((await f.run()).status, 'succeeded')
})


void test('durable rejection reason survives accepted Task admission and persisted history, with only known provider codes explained', async () => {
  for (const errorCode of ['MODEL_CONTENT_DENIED', 'MODEL_CLASSIFIER_UNAVAILABLE', 'MODEL_REDACTION_UNSAFE', 'OTHER_PROVIDER_FAILURE']) {
    const f = await setup(errorCode)
    const task = await f.run()
    assert.equal(task.policy_decision?.status, 'accepted')
    assert.equal(task.status, 'failed', task.error_code ?? 'missing error')
    assert.equal(task.error_code, errorCode.startsWith('MODEL_') ? errorCode : 'PROVIDER_EXECUTION_FAILED')
    assert.equal((await f.store.history(f.actor, task.session_id))[0].error_code, task.error_code)
    assert.equal(f.calls.length, 1)
  }
})

void test('hosted Task resolution pins an artifact without accepting external Provider fields or fabricated evidence', async () => {
  const { parseTaskRecord } = await import('./taskContract.js')
  const principal = { trust_domain: 'agents.example', agent_name: 'hosted-helper' }
  const hash = `sha256:${'a'.repeat(64)}`, now = new Date().toISOString()
  const record = {
    api_version: TASK_API, kind: 'TaskRecord',
    spec: { api_version: TASK_API, kind: 'TaskSpec', task_id: 'task-a', session_id: 'session-a', created_at: now,
      requested_by: { subject_type: 'user', subject_id: 'user-a' }, agent: { principal, requested_version: 'v1' },
      request_source: 'interactive', input: { instruction: '6 * 7', resource_refs: [] }, workspace_refs: [], requested_mode: 'private',
      data_classification: 'synthetic', required_capabilities: [], constraints: { idempotency_key: 'hosted-request-a' } },
    resolution: { api_version: TASK_API, kind: 'TaskExecutionResolution', resolution_id: 'resolution-a', task_id: 'task-a',
      reason_code: 'ALLOWED', reason: 'Accepted hosted task', policy_version: 'hosted-text-v1', policy_snapshot_digest: hash, decided_at: now,
      status: 'accepted', attempt_id: 'attempt-a', execution_mode: 'internal_hosted', resolved_runtime: 'hosted_artifact', runtime_authority_id: hash, resolution_mode: 'default',
      governance_org_id: 'org-a', catalog_id: 'catalog-a', asset_id: 'asset-a', artifact_id: 'artifact-a', metadata_digest: hash,
      agent: { principal, version: 'v1', source_digest: hash, version_evidence: 'immutable_hosted_artifact', release_digest: hash,
        registry: { authority: 'nexus_registry', principal, registration_digest: hash, signing_key_id: hash, evidence: 'signed_registration_only' } },
      artifact: { spec_digest: hash, image_id: hash, dependency_lock_digest: hash, profile: 'langgraph-stdio-v1' },
      limits: { timeout_ms: 120000, max_model_calls: 2 } },
  }
  assert.equal(parseTaskRecord(record).resolution.status, 'accepted')
  for (const change of [
    { provider_kind: 'dify' }, { binding_id: 'fake-provider' }, { resolved_runtime: 'external_provider' },
    { agent: { ...record.resolution.agent, version_evidence: 'source_snapshot_only' } },
    { agent: { ...record.resolution.agent, registry: undefined } },
    { agent: { ...record.resolution.agent, release_digest: `sha256:${'b'.repeat(64)}` } },
    { artifact: { ...record.resolution.artifact, image_id: 'image:latest' } },
    { limits: { timeout_ms: 300001, max_model_calls: 2 } },
  ]) assert.throws(() => parseTaskRecord({ ...record, resolution: { ...record.resolution, ...change } }), /INVALID_TASK_RECORD|TASK_RECORD_MISMATCH/)
  assert.throws(() => parseTaskRecord({ ...record, resolution: { ...record.resolution, agent: { ...record.resolution.agent,
    registry: { ...record.resolution.agent.registry, principal: { ...principal, agent_name: 'different' } } } } }), /TASK_RECORD_MISMATCH/)
  assert.throws(() => parseTaskRecord({ ...record, spec: { ...record.spec, required_capabilities: ['verified_source_identity'] } }), /TASK_RECORD_MISMATCH/)
})
