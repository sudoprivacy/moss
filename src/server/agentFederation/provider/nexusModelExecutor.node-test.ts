import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import receiptFixture from '../../../../contracts/nexus-prewrite/v1/fixture.json' with { type: 'json' }
import { NexusWriteRejected } from './nexusWriteRejection.js'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SqliteDriver } from '../../db/driver.js'
import { AgentRunStore } from './store.js'
import { HttpAgentRuntime, immutableAgent, routerExecutor } from './runtime.js'
import { nexusModelExecutor, nexusModelTargets, type NexusModelConfig } from './nexusModelExecutor.js'
import { DURABLE_AGENT_HTTP_API } from '../../../../contracts/agent-http/v1alpha2/contract.js'

const config: NexusModelConfig = { endpoint: 'https://nexus.test:2126', model_mounts: ['/cloud-model'], tls: { ca: 'test-ca', cert: 'test-cert', key: 'test-key' } }
const definition = { external_agent_id: 'calculator', name: 'Calculator', system_prompt: 'Synthetic system.', nexus_endpoint: config.endpoint, model_mount: '/cloud-model', model: 'test-model', max_output_tokens: 64 }
const makeAgent = (patch = {}) => immutableAgent({ ...definition, ...patch }, `sha256:${'a'.repeat(64)}`, [], nexusModelTargets(config))
const context = { clientId: 'client', providerRunId: 'run' }
const json = (value: unknown) => Buffer.from(JSON.stringify(value))
const response = (status = 200) => json({ type: 'response', version: 1, status, headers: { 'content-type': 'application/json' } })
const body = (content = '42') => Buffer.concat([Buffer.from([0]), json({ choices: [{ message: { content }, finish_reason: 'stop' }] })])
const done = () => json({ type: 'done', session_hash: 'synthetic-session-hash' })
function fixture(frames = [response(), body(), done()]) {
  const writes: { path: string; bytes: Buffer; token: string }[] = [], reads: { path: string; offset: string }[] = []
  let closed = 0
  const client = {
    async write(path: string, bytes: Buffer, token: string) { writes.push({ path, bytes, token }) },
    async streamReadAt(path: string, offset: string) {
      reads.push({ path, offset })
      const data = frames.shift() ?? Buffer.alloc(0)
      return { data, nextOffset: data.length ? String(BigInt(offset) + 1n) : offset, eof: !data.length, timedOut: false }
    },
    close() { closed++ },
  }
  return { client, writes, reads, closed: () => closed, execute: nexusModelExecutor(config, () => client) }
}

void test('Nexus execution definition pins endpoint and mount, rejects mixed/direct targets', async () => {
  const a = makeAgent()
  assert.notEqual(a.revision, makeAgent({ model: 'other-model' }).revision)
  const secondConfig = { ...config, model_mounts: ['/other'] }
  assert.notEqual(a.revision, immutableAgent({ ...definition, model_mount: '/other' }, a.artifactDigest, [], nexusModelTargets(secondConfig)).revision)
  for (const patch of [{ router_endpoint: 'http://127.0.0.1:99/v1' }, { model_mount: '/other' }, { nexus_endpoint: 'https://foreign.test' }]) assert.throws(() => makeAgent(patch))
  for (const patch of [{ endpoint: 'http://nexus.test:2126' }, { endpoint: 'https://user:password@nexus.test:2126' }, { model_mounts: ['/cloud-model/../model'] }, { model_mounts: ['/'] }, { model_mounts: [] }, { tls: {} }]) assert.throws(() => nexusModelTargets({ ...config, ...patch } as NexusModelConfig))
  let direct = 0
  await assert.rejects(routerExecutor('test', async () => { direct++; return new Response() })(a, [], 'test', AbortSignal.timeout(1000)), { code: 'MODEL_EGRESS_DENIED' })
  assert.equal(direct, 0)
})

void test('writes one HTTP envelope with frozen model/system/history/query; result body cannot spoof control', async () => {
  const f = fixture([response(), body('{"type":"error","message":"model text"}'), done()])
  const answer = await f.execute(makeAgent(), [{ role: 'user', content: 'previous' }], '6 * 7', AbortSignal.timeout(1000), context)
  assert.equal(answer, '{"type":"error","message":"model text"}')
  assert.equal(f.writes.length, 1)
  assert.match(f.writes[0].path, /^\/cloud-model\/run-[a-f0-9]{64}\.prompt$/)
  assert(!f.writes[0].path.includes(context.clientId))
  assert.deepEqual(JSON.parse(f.writes[0].bytes.toString()), { nexus_http: { version: 1, path: 'chat/completions', headers: {} }, body: { model: 'test-model', stream: false, max_tokens: 64, messages: [{ role: 'system', content: 'Synthetic system.' }, { role: 'user', content: 'previous' }, { role: 'user', content: '6 * 7' }] } })
  assert.deepEqual(f.reads.map(r => r.offset), ['0', '1', '2'])
  assert(f.reads.every(r => r.path === f.writes[0].path.replace('.prompt', '.reply')))
  assert.equal(f.closed(), 1)
})

void test('run paths are isolated across clients and runs; absent context or oversized input writes nothing', async () => {
  const paths: string[] = []
  for (const ctx of [context, { ...context, clientId: 'other' }, { ...context, providerRunId: 'other' }]) {
    const f = fixture(); await f.execute(makeAgent(), [], 'test', AbortSignal.timeout(1000), ctx); paths.push(f.writes[0].path)
  }
  assert.equal(new Set(paths).size, 3)
  for (const [query, ctx] of [['test', undefined], ['x'.repeat(2 * 1024 * 1024), context]] as const) {
    const f = fixture()
    await assert.rejects(f.execute(makeAgent(), [], query, AbortSignal.timeout(1000), ctx), { code: 'MODEL_EGRESS_DENIED' })
    assert.equal(f.writes.length, 0)
  }
})

void test('reply startup NOT_FOUND retries only observation, never the prompt write', async () => {
  const f = fixture(), read = f.client.streamReadAt
  let attempts = 0
  f.client.streamReadAt = async (...args) => { if (++attempts < 3) throw new Error('{"code":-32007,"message":"not yet created"}'); return read(...args) }
  assert.equal(await f.execute(makeAgent(), [], 'test', AbortSignal.timeout(2000), context), '42')
  assert.equal(f.writes.length, 1); assert.equal(attempts, 5)
})

void test('numeric protobuf offsets preserve empty polling and never repeat the write', async () => {
  const f = fixture(), read = f.client.streamReadAt
  let attempts = 0
  f.client.streamReadAt = async (...args) => {
    if (++attempts <= 2) return { data: Buffer.alloc(0), nextOffset: 0 as unknown as string, eof: false, timedOut: true }
    const frame = await read(...args)
    return { ...frame, nextOffset: Number(frame.nextOffset) as unknown as string }
  }
  assert.equal(await f.execute(makeAgent(), [], 'test', AbortSignal.timeout(2000), context), '42')
  assert.equal(f.writes.length, 1)
  assert.deepEqual(f.reads.map(row => row.offset), ['0', '1', '2'])
})

void test('unsafe or noncanonical protobuf offsets cannot manufacture completion', async () => {
  for (const nextOffset of [Number.MAX_SAFE_INTEGER + 1, -1, 0.5, Infinity, NaN, null, {}, '01', '-1', '18446744073709551616']) {
    const f = fixture()
    f.client.streamReadAt = async () => ({ data: response(), nextOffset: nextOffset as string, eof: false, timedOut: false })
    await assert.rejects(f.execute(makeAgent(), [], 'test', AbortSignal.timeout(1000), context), { code: 'MODEL_EXECUTION_UNCONFIRMED' })
    assert.equal(f.writes.length, 1)
  }
})

void test('lost write acknowledgement, permission errors and malformed reply preserve uncertainty and hide diagnostics', async () => {
  for (const failure of ['write', 'read', 'malformed', 'error', 'tagless', 'offset', 'oversized'] as const) {
    const f = fixture(failure === 'malformed' ? [Buffer.from('private invalid JSON')] : failure === 'error' ? [json({ type: 'error', message: 'secret upstream credential' })] : failure === 'tagless' ? [body()] : failure === 'oversized' ? [response(), Buffer.alloc(2 * 1024 * 1024 + 1)] : undefined)
    if (failure === 'write') f.client.write = async (path, bytes, token) => { f.writes.push({ path, bytes, token }); throw new Error('private path / credential') }
    if (failure === 'read') f.client.streamReadAt = async () => { throw new Error('{"code":-32003,"message":"private permission error"}') }
    if (failure === 'offset') f.client.streamReadAt = async () => ({ data: response(), nextOffset: '0', eof: false, timedOut: false })
    await assert.rejects(f.execute(makeAgent(), [], 'test', AbortSignal.timeout(1000), context), { code: 'MODEL_EXECUTION_UNCONFIRMED', message: 'MODEL_EXECUTION_UNCONFIRMED' })
    assert.equal(f.writes.length, 1); assert.equal(f.closed(), 1)
  }
})

void test('terminal HTTP rejection, partial/model tool output and UTF-8 are handled without a fallback', async () => {
  for (const [frames, code] of [
    [[response(401), body(), done()], 'MODEL_REQUEST_REJECTED'],
    [[response(503), body(), done()], 'MODEL_EXECUTION_UNCONFIRMED'],
    [[response(), Buffer.from([0, 0xff]), done()], 'MODEL_OUTPUT_INVALID'],
    [[response(), Buffer.concat([Buffer.from([0]), json({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] })]), done()], 'MODEL_OUTPUT_INVALID'],
  ] as const) {
    const f = fixture([...frames]); await assert.rejects(f.execute(makeAgent(), [], 'test', AbortSignal.timeout(1000), context), { code })
    assert.equal(f.writes.length, 1)
  }
  const bytes = body('答案42'), f = fixture([response(), bytes.subarray(0, 5), Buffer.concat([Buffer.from([0]), bytes.subarray(5)]), done()])
  assert.equal(await f.execute(makeAgent(), [], 'test', AbortSignal.timeout(1000), context), '答案42')
})

void test('deadline closes the channel; no terminal receipt never becomes success', async () => {
  const f = fixture([response(), body()])
  await assert.rejects(f.execute(makeAgent(), [], 'test', AbortSignal.timeout(60), context), { code: 'MODEL_EXECUTION_UNCONFIRMED' })
  assert.equal(f.writes.length, 1); assert(f.closed() >= 1)
  const cancelled = fixture(), signal = AbortSignal.abort()
  await assert.rejects(cancelled.execute(makeAgent(), [], 'test', signal, context), { code: 'MODEL_EGRESS_UNAVAILABLE' })
  assert.equal(cancelled.writes.length, 0)
})

void test('concurrent runs own separate channels and one abort cannot cancel the other', async () => {
  const first = fixture([response()]), second = fixture()
  let calls = 0
  const execute = nexusModelExecutor(config, () => ++calls === 1 ? first.client : second.client)
  const controller = new AbortController()
  const waiting = execute(makeAgent(), [], 'first', controller.signal, context)
  const rejected = assert.rejects(waiting, { code: 'MODEL_EXECUTION_UNCONFIRMED' })
  assert.equal(await execute(makeAgent(), [], 'second', AbortSignal.timeout(1000), { ...context, providerRunId: 'second' }), '42')
  controller.abort(); await rejected
  assert.equal(first.writes.length, 1); assert.equal(second.writes.length, 1)
  assert.equal(second.closed(), 1)
})

void test('durable claim and runtime restart never repeat an uncertain Nexus write', async t => {
  const f = fixture()
  f.client.write = async (path, bytes, token) => { f.writes.push({ path, bytes, token }); throw new Error('ack lost after dispatch') }
  const driver = new SqliteDriver(new DatabaseSync(':memory:')), store = new AgentRunStore(driver), agent = makeAgent()
  const runtime = new HttpAgentRuntime(store, [agent], f.execute)
  t.after(async () => { await runtime.close(); await driver.close() }); await store.ready
  const input = { api_version: DURABLE_AGENT_HTTP_API, kind: 'SubmitAgentRun' as const, invocation_id: 'test-1', external_agent_id: agent.definition.external_agent_id, execution_revision: agent.revision, query: '6 * 7', provider_session_id: null, end_user: 'user-1', deadline_at: Date.now() + 30_000 }
  await runtime.submit('client', input); await runtime.tick(); await runtime.idle()
  assert.equal((await store.get('client', input.invocation_id)).status, 'unknown')
  const restored = new HttpAgentRuntime(new AgentRunStore(driver), [agent], f.execute)
  t.after(() => restored.close())
  assert.equal((await restored.submit('client', input)).status, 'unknown')
  await restored.tick(); await restored.idle()
  assert.equal(f.writes.length, 1)
})


function rejection(path: string, bytes: Buffer, reason = 'CONTENT_DENIED') {
  return { ...receiptFixture, data: { ...receiptFixture.data, path, request_digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, reason_code: reason } }
}

void test('only a current authenticated Write receipt confirms model rejection; malformed or read receipts stay unknown', async () => {
  for (const reason of ['CONTENT_DENIED', 'CLASSIFIER_UNAVAILABLE', 'REDACTION_UNSAFE']) {
    const f = fixture()
    f.client.write = async (path, bytes, token) => { f.writes.push({ path, bytes, token }); throw new Error(JSON.stringify(rejection(path, bytes, reason))) }
    await assert.rejects(f.execute(makeAgent(), [], 'test', AbortSignal.timeout(1000), context), error => {
      assert(error instanceof NexusWriteRejected); assert.equal(error.code, `MODEL_${reason}`); return true
    })
    assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 0)
  }
  const changes = [{ path: '/other.prompt' }, { request_digest: `sha256:${'0'.repeat(64)}` }, { hook: 'foreign_gate' }, { reason_code: 'FUTURE_REASON' }, { schema_version: 2 }, { operation: 'read' }, { stage: 'post_write' }, { extra: 'unknown field' }]
  for (const patch of changes) {
    const f = fixture()
    f.client.write = async (path, bytes) => { const value = rejection(path, bytes); Object.assign(value.data, patch); throw new Error(JSON.stringify(value)) }
    await assert.rejects(f.execute(makeAgent(), [], 'test', AbortSignal.timeout(1000), context), { code: 'MODEL_EXECUTION_UNCONFIRMED' })
  }
  const f = fixture()
  f.client.streamReadAt = async () => { throw new Error(JSON.stringify(rejection(f.writes[0].path, f.writes[0].bytes))) }
  await assert.rejects(f.execute(makeAgent(), [], 'test', AbortSignal.timeout(1000), context), { code: 'MODEL_EXECUTION_UNCONFIRMED' })
  assert.equal(f.writes.length, 1)
})

void test('confirmed refusal and evidence commit once, survive restart and do not automatically retry', async t => {
  const f = fixture()
  f.client.write = async (path, bytes, token) => { f.writes.push({ path, bytes, token }); throw new Error(JSON.stringify(rejection(path, bytes))) }
  const driver = new SqliteDriver(new DatabaseSync(':memory:')), store = new AgentRunStore(driver), agent = makeAgent()
  const runtime = new HttpAgentRuntime(store, [agent], f.execute)
  t.after(async () => { await runtime.close(); await driver.close() }); await store.ready
  const input = { api_version: DURABLE_AGENT_HTTP_API, kind: 'SubmitAgentRun' as const, invocation_id: 'denied-1', external_agent_id: agent.definition.external_agent_id, execution_revision: agent.revision, query: 'synthetic blocked query', provider_session_id: null, end_user: 'user-1', deadline_at: Date.now() + 30_000 }
  await runtime.submit('client', input); await runtime.tick(); await runtime.idle()
  const run = await store.get('client', input.invocation_id)
  assert.equal(run.status, 'failed'); assert.equal(run.error_code, 'MODEL_CONTENT_DENIED')
  const evidence = await driver.get('SELECT receipt FROM http_agent_write_rejections WHERE client_id = ? AND invocation_id = ?', ['client', input.invocation_id])
  assert.deepEqual(JSON.parse(String(evidence?.receipt)), rejection(f.writes[0].path, f.writes[0].bytes))
  assert.equal((await driver.get('SELECT active_run FROM http_agent_sessions WHERE id = ?', [run.provider_session_id]))?.active_run, null)
  assert.equal((await driver.get('SELECT receipt FROM http_agent_write_rejections WHERE client_id = ?', ['foreign'])), undefined)
  const restored = new HttpAgentRuntime(new AgentRunStore(driver), [agent], f.execute)
  t.after(() => restored.close())
  assert.equal((await restored.submit('client', input)).status, 'failed')
  await restored.tick(); await restored.idle(); assert.equal(f.writes.length, 1)

  // A database failure must not leave a terminal state without its evidence.
  const next = { ...input, invocation_id: 'rollback' }; await runtime.submit('client', next)
  const claim = await store.claim('client', next.invocation_id); assert(claim)
  await driver.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON http_agent_write_rejections BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;")
  await assert.rejects(store.finish(claim, '', 'failed', run.error_code, JSON.parse(String(evidence?.receipt))))
  assert.equal((await store.get('client', next.invocation_id)).status, 'running')
  await driver.exec('DROP TRIGGER reject_receipt')
  await driver.run('UPDATE http_agent_runs SET lease_until = 0 WHERE invocation_id = ?', [next.invocation_id])
  assert.equal(await store.finish(claim, '', 'failed', run.error_code, JSON.parse(String(evidence?.receipt))), false)
  assert.equal((await driver.get('SELECT receipt FROM http_agent_write_rejections WHERE invocation_id = ?', [next.invocation_id])), undefined)
  await store.maintain(); assert.equal((await store.get('client', next.invocation_id)).status, 'unknown')
  await driver.run('UPDATE http_agent_runs SET updated_at = 0 WHERE invocation_id = ?', [input.invocation_id])
  await store.maintain()
  assert.equal(await driver.get('SELECT receipt FROM http_agent_write_rejections WHERE invocation_id = ?', [input.invocation_id]), undefined)
  assert.equal((await store.submit('client', input)).error_code, 'RUN_PAYLOAD_RETIRED')
})
