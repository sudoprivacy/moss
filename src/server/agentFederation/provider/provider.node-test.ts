import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { once } from 'node:events'
import { SqliteDriver } from '../../db/driver.js'
import { DURABLE_AGENT_HTTP_API, type SubmitAgentRun } from '../../../../contracts/agent-http/v1alpha2/contract.js'
import { AgentRunStore } from './store.js'
import { AgentProtocolError, parseAgentRun, parseSubmitAgentRun } from './protocol.js'
import { HttpAgentRuntime, immutableAgent, routerExecutor, agentManifest, type ModelExecutor } from './runtime.js'
import { providerServer } from './server.js'
import { DurableHttpAdapter } from '../durableHttpAdapter.js'
import { parseCustomManifest, customManifestDigest } from '../manifest.js'
import type { ProviderInvocation } from '../adapter.js'

const definition = { external_agent_id: 'calculator', name: 'Calculator', system_prompt: 'Calculate accurately.', router_endpoint: 'http://127.0.0.1:30123/v1', model: 'test-model', max_output_tokens: 128 }
const agent = () => immutableAgent(definition, `sha256:${'a'.repeat(64)}`, [definition.router_endpoint])
const request = (id = 'request-1'): SubmitAgentRun => ({ api_version: DURABLE_AGENT_HTTP_API, kind: 'SubmitAgentRun', invocation_id: id, external_agent_id: 'calculator', execution_revision: agent().revision, query: '6 * 7', provider_session_id: null, end_user: 'user-1', deadline_at: Date.now() + 60_000 })
async function fixture(t: { after: (fn: () => Promise<void>) => void }, executor: ModelExecutor = async () => '42') {
  const driver = new SqliteDriver(new DatabaseSync(':memory:')), store = new AgentRunStore(driver)
  const runtime = new HttpAgentRuntime(store, [agent()], executor)
  await store.ready
  t.after(async () => { await runtime.close(); await driver.close() })
  return { driver, store, runtime }
}

void test('execution revision covers runtime artifact and actual model/prompt configuration', () => {
  const first = agent()
  for (const patch of [{ model: 'another-model' }, { system_prompt: 'New instruction.' }, { max_output_tokens: 256 }]) {
    assert.notEqual(immutableAgent({ ...definition, ...patch }, first.artifactDigest, [definition.router_endpoint]).revision, first.revision)
  }
  assert.notEqual(immutableAgent(definition, `sha256:${'b'.repeat(64)}`, [definition.router_endpoint]).revision, first.revision)
  assert.throws(() => immutableAgent({ ...definition, router_endpoint: 'http://foreign.invalid' }, first.artifactDigest, [definition.router_endpoint]), { code: 'INVALID_AGENT_DEFINITION' })
  assert.throws(() => immutableAgent({ ...definition, api_key: 'must-not-store' }, first.artifactDigest, [definition.router_endpoint]), { code: 'INVALID_AGENT_DEFINITION' })
  assert.throws(() => { Object.assign(first.definition, { model: 'mutated' }) }, TypeError)
})

void test('concurrent identical submissions and two workers execute exactly one model call', async t => {
  let calls = 0
  const f = await fixture(t, async () => { calls++; return '42' })
  const other = new HttpAgentRuntime(new AgentRunStore(f.driver), [agent()], async () => { calls++; return 'wrong duplicate' })
  t.after(() => other.close())
  const input = request()
  const submissions = await Promise.all(Array.from({ length: 20 }, () => f.runtime.submit('client-1', input)))
  assert.equal(new Set(submissions.map(run => run.provider_run_id)).size, 1)
  await Promise.all([f.runtime.tick(), other.tick()]); await Promise.all([f.runtime.idle(), other.idle()])
  assert.equal(calls, 1)
  const result = await f.store.get('client-1', input.invocation_id)
  assert.equal(result.status, 'succeeded'); assert.equal(result.output.text, '42')
  assert.equal((await f.runtime.submit('client-1', input)).provider_run_id, result.provider_run_id)
  await assert.rejects(f.runtime.submit('client-1', { ...input, query: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' })
  await assert.rejects(f.store.get('other-client', input.invocation_id), { code: 'RUN_NOT_FOUND' })
  const otherInput = { ...input, execution_revision: `sha256:${'0'.repeat(64)}`, invocation_id: 'wrong-version' }
  await assert.rejects(f.runtime.submit('client-1', otherInput), { code: 'EXECUTION_REVISION_UNAVAILABLE' })
  assert.equal(calls, 1)
})

void test('durable multi-turn context is bound to client, user, agent and immutable revision', async t => {
  const history: unknown[] = []
  const f = await fixture(t, async (_agent, messages, query) => { history.push(structuredClone(messages)); return query === '6 * 7' ? '42' : '50' })
  const first = await f.runtime.submit('client-1', request())
  await assert.rejects(f.runtime.submit('client-1', { ...request('busy'), provider_session_id: first.provider_session_id }), { code: 'SESSION_UNAVAILABLE' })
  await f.runtime.tick(); await f.runtime.idle()
  for (const [client, patch] of [['other-client', {}], ['client-1', { end_user: 'other-user' }]] as const) {
    await assert.rejects(f.runtime.submit(client, { ...request('foreign'), provider_session_id: first.provider_session_id, ...patch }), { code: 'SESSION_UNAVAILABLE' })
  }
  const second = await f.runtime.submit('client-1', { ...request('second'), provider_session_id: first.provider_session_id, query: 'plus eight' })
  await f.runtime.tick(); await f.runtime.idle()
  assert.deepEqual(history, [[], [{ role: 'user', content: '6 * 7' }, { role: 'assistant', content: '42' }]])
  assert.equal((await f.store.get('client-1', second.invocation_id)).output.text, '50')
})

void test('queued work survives runtime replacement; expired dispatch intent becomes unknown and fences late results', async t => {
  let calls = 0
  const f = await fixture(t, async () => { calls++; return '42' })
  const queued = await f.runtime.submit('client-1', request())
  const recovered = new HttpAgentRuntime(new AgentRunStore(f.driver), [agent()], async () => { calls++; return '42' })
  t.after(() => recovered.close())
  await recovered.tick(); await recovered.idle(); assert.equal(calls, 1)
  assert.equal((await f.store.get('client-1', queued.invocation_id)).status, 'succeeded')
  const input = request('crashed-after-intent')
  await f.runtime.submit('client-1', input)
  const claim = await f.store.claim('client-1', input.invocation_id); assert(claim)
  await f.driver.run('UPDATE http_agent_runs SET lease_until = 0 WHERE invocation_id = ?', [input.invocation_id])
  await f.driver.run('UPDATE http_agent_maintenance SET next_run_at = 0')
  assert.equal(await f.store.renew(claim), false)
  assert.equal(await f.store.finish(claim, 'late-answer', 'succeeded'), false)
  await recovered.tick(); await recovered.idle()
  const unknown = await f.store.get('client-1', input.invocation_id)
  assert.equal(unknown.status, 'unknown'); assert.equal(calls, 1)
  assert.equal((await f.runtime.submit('client-1', input)).status, 'unknown')
  await assert.rejects(f.runtime.submit('client-1', { ...request('after-unknown'), provider_session_id: unknown.provider_session_id }), { code: 'SESSION_UNAVAILABLE' })
  assert.equal(await f.store.claim('client-1', input.invocation_id), null)
})

void test('cancellation is confirmed only before dispatch and never advertises upstream termination', async t => {
  const f = await fixture(t)
  const input = request()
  await f.runtime.submit('client-1', input)
  assert.equal((await f.store.cancelQueued('client-1', input.invocation_id)).status, 'cancelled')
  assert.equal(await f.store.claim('client-1', input.invocation_id), null)
  await f.runtime.submit('client-1', request('running'))
  assert(await f.store.claim('client-1', 'running'))
  await assert.rejects(f.store.cancelQueued('client-1', 'running'), { code: 'REMOTE_CANCELLATION_UNSUPPORTED' })
})

void test('retention removes payload, retains idempotency and preserves unknown evidence', async t => {
  const f = await fixture(t)
  const input = request(); await f.runtime.submit('client-1', input); await f.runtime.tick(); await f.runtime.idle()
  await f.driver.run('UPDATE http_agent_runs SET updated_at = 0')
  await f.store.maintain()
  const result = await f.runtime.submit('client-1', input)
  assert.equal(result.output.text, ''); assert.equal(result.error_code, 'RUN_PAYLOAD_RETIRED')
  assert.equal(result.status, 'succeeded'); assert.equal(await f.store.claim('client-1', input.invocation_id), null)
  assert.equal((await f.driver.get('SELECT request FROM http_agent_runs'))?.request, '{}')
})

void test('model failures distinguish explicit rejection from uncertain execution without persisting secrets', async t => {
  for (const [status, expected] of [[401, 'failed'], [500, 'unknown']] as const) {
    const f = await fixture(t, routerExecutor('test-model-key', async () => new Response('secret-key-and-sensitive-provider-body', { status })))
    await f.runtime.submit('client-1', request()); await f.runtime.tick(); await f.runtime.idle()
    const result = await f.store.get('client-1', 'request-1')
    assert.equal(result.status, expected)
    assert.equal(JSON.stringify(await f.driver.all('SELECT * FROM http_agent_runs')).includes('secret'), false)
  }
})

void test('pre-dispatch egress refusal is a stable failed run; it does not create an unknown or retry', async t => {
  for (const code of ['MODEL_EGRESS_DENIED', 'MODEL_EGRESS_UNAVAILABLE']) {
    let attempts = 0
    const f = await fixture(t, async () => { attempts++; throw new AgentProtocolError(403, code) })
    const input = request()
    const accepted = await f.runtime.submit('client-1', input)
    await f.runtime.tick(); await f.runtime.idle()
    const result = await f.runtime.submit('client-1', input)
    assert.equal(result.status, 'failed'); assert.equal(result.error_code, code)
    assert.equal(result.provider_run_id, accepted.provider_run_id)
    await f.runtime.tick(); await f.runtime.idle(); assert.equal(attempts, 1)
  }
})

void test('provider replicas coalesce maintenance and a failed batch can retry', async t => {
  const f = await fixture(t), other = new AgentRunStore(f.driver)
  await other.ready
  let calls = 0
  f.store.maintain = async () => { calls++; return 0 }
  other.maintain = async () => { calls++; return 0 }
  await Promise.all([f.store.scheduledMaintenance(), other.scheduledMaintenance()])
  assert.equal(calls, 1)
  await f.store.scheduledMaintenance(); assert.equal(calls, 1)
  await f.driver.run('UPDATE http_agent_maintenance SET next_run_at = 0')
  f.store.maintain = async () => { throw new Error('Batch failure') }
  await assert.rejects(f.store.scheduledMaintenance(), /Batch failure/)
  await other.scheduledMaintenance(); assert.equal(calls, 2)
})

void test('HTTP authentication, client isolation, immutable manifest and strict request/result schemas', async t => {
  const f = await fixture(t)
  const token = 'a'.repeat(40), otherToken = 'b'.repeat(40)
  const server = providerServer(f.runtime, [{ id: 'client-1', token, agentIds: ['calculator'] }, { id: 'client-2', token: otherToken, agentIds: ['calculator'] }])
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  assert.equal((await fetch(`${url}/v1/agents/calculator/manifest`)).status, 401)
  const manifest = await (await fetch(`${url}/v1/agents/calculator/manifest`, { headers })).json() as { execution_revision: string }
  assert.equal(manifest.execution_revision, agent().revision)
  const response = await fetch(`${url}/v1/runs`, { method: 'POST', headers, body: JSON.stringify(request()) })
  assert.equal(response.status, 202); parseAgentRun(await response.json())
  assert.equal((await fetch(`${url}/v1/runs/request-1`, { headers: { Authorization: `Bearer ${otherToken}` } })).status, 404)
  assert.equal((await fetch(`${url}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ ...request('invalid'), unexpected: 'reject' }) })).status, 400)
  assert.equal((await fetch(`${url}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ ...request('large'), query: 'x'.repeat(70_000) }) })).status, 413)
  assert.throws(() => parseSubmitAgentRun({ ...request(), query: '  ' }), AgentProtocolError)
})

void test('Moss durable adapter recovers a lost submit response by querying the same run and validates version evidence', async t => {
  let calls = 0, dropped = false, gates = 0
  const f = await fixture(t, async () => { calls++; return '42' })
  const token = 'a'.repeat(40)
  const server = providerServer(f.runtime, [{ id: 'client-1', token, agentIds: ['calculator'] }])
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); f.runtime.start()
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const manifest = parseCustomManifest(JSON.stringify(agentManifest(agent())))
  const digest = customManifestDigest(manifest)
  const adapter = new DurableHttpAdapter({ manifest, digest }, async (url, init) => {
    const response = await fetch(url, init)
    if (init?.method === 'POST' && !dropped) { dropped = true; await response.body?.cancel(); throw new TypeError('simulated lost response') }
    return response
  })
  const input: ProviderInvocation = {
    task_id: 'task-1', attempt_id: 'attempt-1', session_id: 'session-1', binding_id: 'binding-1',
    external_agent_id: 'calculator', source_digest: digest, endpoint, org_id: 'org-1',
    policy: { orgIds: ['org-1'], endpoints: [endpoint], timeoutMs: 10_000 }, key: token,
    query: '6 * 7', end_user: 'end-user-1', provider_session_id: null, deadline_at: Date.now() + 10_000,
    signal: new AbortController().signal, authorize_dispatch: async () => { gates++ },
  }
  const result = await adapter.invoke(input, async () => {})
  assert.equal(result.text, '42'); assert.equal(calls, 1); assert.equal(gates, 1)
  assert.equal(result.binding.version_evidence, 'provider_revision_fenced'); assert.equal(result.binding.execution_revision, agent().revision)
  const resumed = await adapter.invoke({ ...input, recovery: true }, async () => {})
  assert.equal(resumed.binding.provider_run_id, result.binding.provider_run_id)
  assert.equal(calls, 1); assert.equal(gates, 1, 'query-only recovery does not reauthorize a dispatch')
})

void test('a worker during rolling upgrade never claims a queued revision it cannot execute', async t => {
  const f = await fixture(t)
  const updated = immutableAgent({ ...definition, system_prompt: 'Updated prompt.' }, agent().artifactDigest, [definition.router_endpoint])
  let calls = 0
  const other = new HttpAgentRuntime(f.store, [updated], async () => { calls++; return 'updated' })
  t.after(() => other.close())
  await f.runtime.submit('client-1', request())
  await other.tick(); await other.idle()
  assert.equal((await f.store.get('client-1', 'request-1')).status, 'accepted'); assert.equal(calls, 0)
  await f.runtime.tick(); await f.runtime.idle()
  assert.equal((await f.store.get('client-1', 'request-1')).status, 'succeeded')
})
