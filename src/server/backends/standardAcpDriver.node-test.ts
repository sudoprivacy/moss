import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import type { SessionRpcMessage } from '@nexus-ai-fs/vfs-client'
import type { AcpMessageTransport, AcpTransportEvents } from './acpTransport.js'
import { AcpOutcomeUnknown, StandardAcpDriver, type StandardAcpDriverOptions } from './standardAcpDriver.js'
import { AcpRpcError } from './acpRequestTracker.js'

async function fixture(t: TestContext, capabilities: Record<string, unknown> = {}, options: StandardAcpDriverOptions = {}) {
  const messages: SessionRpcMessage[] = [], notifications: SessionRpcMessage[] = []
  const completions: Array<{ method: string; late: boolean }> = []
  let events!: AcpTransportEvents
  let connected = true, sessions = 0, closes = 0
  const transport: AcpMessageTransport = {
    get connected() { return connected },
    start(value) { events = value },
    async send(message) {
      messages.push(structuredClone(message))
      if (message.method === 'initialize') events.onMessage({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: capabilities } })
      if (message.method === 'session/new') events.onMessage({ jsonrpc: '2.0', id: message.id, result: { sessionId: `native-${++sessions}` } })
      if (message.method === 'session/load') events.onMessage({ jsonrpc: '2.0', id: message.id, result: {} })
    },
    async close() { if (connected) { connected = false; closes++; events.onClose(null, null) } },
  }
  const driver = new StandardAcpDriver(transport, { onNotification: message => notifications.push(message),
    onCompletion: value => completions.push(value), ...options })
  t.after(() => driver.close())
  return { driver, messages, notifications, completions, transport,
    receive: (message: SessionRpcMessage) => events.onMessage(message), closes: () => closes,
    requests: (method: string) => messages.filter(message => message.method === method),
    finish: (result: unknown = { stopReason: 'end_turn' }) => {
      const prompt = messages.filter(message => message.method === 'session/prompt').at(-1)!
      events.onMessage({ jsonrpc: '2.0', id: prompt.id, result })
    } }
}

for (const producer of [{}, { loadSession: true, _meta: { anotherProducer: true } }]) {
  void test(`literal text and streamed events use standard ACP (${JSON.stringify(producer)})`, async t => {
    const f = await fixture(t, producer)
    const id = await f.driver.open({ cwd: '/authorized/workspace' })
    const text = 'Read src/main.ts\n保持原文 🙂\n```ts\nconst x = "a\\nb"\n```'
    const result = f.driver.prompt(id, text)
    assert.deepEqual(f.requests('session/prompt')[0]!.params, { sessionId: id, prompt: [{ type: 'text', text }] })
    assert.deepEqual(f.requests('initialize')[0]!.params, {
      protocolVersion: 1, clientInfo: { name: 'moss-standard-acp', version: '1' }, clientCapabilities: {},
    })
    const update = { jsonrpc: '2.0' as const, method: 'session/update', params: {
      sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } },
    } }
    f.receive(update)
    assert.deepEqual(f.notifications, [update])
    f.finish()
    assert.deepEqual(await result, { stopReason: 'end_turn' })
    assert.equal(f.driver.status(id).pending, false)
    assert.equal(f.requests('authenticate').length, 0)
    assert.equal(f.messages.some(message => message.method?.startsWith('_sudocode/')), false)
  })
}

void test('recovery is negotiated and keeps the recorded native session ID', async t => {
  const unsupported = await fixture(t)
  await assert.rejects(unsupported.driver.open({ cwd: '/workspace', resumeSessionId: 'persisted' }), /does not support/)
  assert.equal(unsupported.requests('session/load').length, 0)
  const f = await fixture(t, { loadSession: true })
  const caps = await f.driver.initialize(); caps.loadSession = false
  assert.equal(await f.driver.open({ cwd: '/workspace', resumeSessionId: 'official-recorded-id' }), 'official-recorded-id')
  assert.equal((f.requests('session/load')[0]!.params as { sessionId: string }).sessionId, 'official-recorded-id')
})

void test('cancellation remains pending until the producer returns its prompt result', async t => {
  const f = await fixture(t), id = await f.driver.open({ cwd: '/workspace' })
  const result = f.driver.prompt(id, 'A controlled operation')
  await f.driver.cancel(id)
  assert.equal(f.driver.status(id).pending, true)
  assert.deepEqual(f.requests('session/cancel'), [{ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: id } }])
  f.finish({ stopReason: 'cancelled' })
  assert.deepEqual(await result, { stopReason: 'cancelled' })
  assert.equal(f.driver.status(id).pending, false)
})

void test('timeout preserves one pending input, blocks replay and accepts a late reply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t, {}, { timeoutMs: 50, promptTimeoutMs: 50 }), id = await f.driver.open({ cwd: '/workspace' })
  const result = f.driver.prompt(id, 'Exactly once transport submission')
  const rejection = assert.rejects(result, AcpOutcomeUnknown)
  t.mock.timers.tick(50); await rejection
  assert.deepEqual(f.driver.status(id), { connected: true, pending: true, outcomeUnknown: true })
  assert.throws(() => f.driver.prompt(id, 'Exactly once transport submission'), /still pending/)
  assert.equal(f.requests('session/prompt').length, 1)
  f.finish()
  assert.deepEqual(f.driver.status(id), { connected: true, pending: false, outcomeUnknown: false })
  assert.deepEqual(f.completions.at(-1), { requestId: f.requests('session/prompt')[0]!.id, method: 'session/prompt', result: { stopReason: 'end_turn' }, late: true })
})

void test('unbound sessions never dispatch; explicit remote rejection is preserved', async t => {
  const f = await fixture(t), id = await f.driver.open({ cwd: '/workspace' })
  assert.throws(() => f.driver.prompt('foreign', 'No dispatch'), /not bound/)
  assert.equal(f.requests('session/prompt').length, 0)
  const result = f.driver.prompt(id, 'The host owns authentication')
  f.receive({ jsonrpc: '2.0', id: f.requests('session/prompt')[0]!.id,
    error: { code: -32000, message: 'Authentication required' } })
  await assert.rejects(result, error => error instanceof AcpRpcError && error.rpcError.code === -32000)
  assert.equal(f.driver.status(id).pending, false)
  assert.equal(f.requests('authenticate').length, 0)
})

function permission(id: string, requestId: string): SessionRpcMessage {
  return { jsonrpc: '2.0', id: requestId, method: 'session/request_permission', params: {
    sessionId: id, toolCall: { toolCallId: 'tool' }, options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
  } }
}

void test('permission defaults to cancelled and does not execute reverse filesystem calls', async t => {
  const f = await fixture(t), id = await f.driver.open({ cwd: '/workspace' })
  const turn = f.driver.prompt(id, 'Permission fixture')
  f.receive(permission(id, 'permission'))
  f.receive({ jsonrpc: '2.0', id: 'file', method: 'fs/write_text_file', params: { path: '/not-authorized' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.messages.find(message => message.id === 'permission')?.result, { outcome: { outcome: 'cancelled' } })
  assert.deepEqual(f.messages.find(message => message.id === 'file')?.error, { code: -32601, message: 'Client method is not supported' })
  f.finish(); await turn
})

void test('a permission decision cannot cross a completed turn into the next one', async t => {
  let decide!: (value: string) => void
  const f = await fixture(t, {}, { requestPermission: () => new Promise(resolve => { decide = resolve }) })
  const id = await f.driver.open({ cwd: '/workspace' }), first = f.driver.prompt(id, 'First turn')
  f.receive(permission(id, 'stale'))
  f.finish(); await first
  const second = f.driver.prompt(id, 'Second turn')
  decide('allow'); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.messages.find(message => message.id === 'stale')?.result, { outcome: { outcome: 'cancelled' } })
  f.finish(); await second
})

void test('only a current host decision for an offered permission option is accepted', async t => {
  const f = await fixture(t, {}, { requestPermission: async () => 'allow' })
  const id = await f.driver.open({ cwd: '/workspace' }), turn = f.driver.prompt(id, 'Authorized fixture')
  f.receive(permission(id, 'current')); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.messages.find(message => message.id === 'current')?.result, { outcome: { outcome: 'selected', optionId: 'allow' } })
  f.finish(); await turn
})

void test('stream loss rejects accepted input as unknown and never resubmits it', async t => {
  const f = await fixture(t), id = await f.driver.open({ cwd: '/workspace' })
  const result = f.driver.prompt(id, 'Already submitted')
  const rejection = assert.rejects(result, AcpOutcomeUnknown)
  await f.transport.close(); await rejection
  assert.equal(f.driver.status(id).outcomeUnknown, true)
  assert.equal(f.requests('session/prompt').length, 1)
  assert.throws(() => f.driver.prompt(id, 'Already submitted'), /closed/)
})

void test('a coding turn has no implicit handshake-length deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t), id = await f.driver.open({ cwd: '/workspace' })
  const result = f.driver.prompt(id, 'A legitimately long task')
  t.mock.timers.tick(3600000)
  assert.deepEqual(f.driver.status(id), { connected: true, pending: true, outcomeUnknown: false })
  f.finish(); await result
})

void test('authentication required at session setup is returned without a login or hidden retry', async t => {
  const f = await fixture(t), original = f.transport.send.bind(f.transport)
  f.transport.send = async message => {
    if (message.method !== 'session/new') return original(message)
    f.messages.push(message)
    f.receive({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Authentication required' } })
  }
  await assert.rejects(f.driver.open({ cwd: '/workspace' }), AcpRpcError)
  assert.equal(f.requests('initialize').length, 1)
  assert.equal(f.requests('session/new').length, 1)
  assert.equal(f.requests('authenticate').length, 0)
})

void test('a malformed completion cannot prove an accepted input stopped', async t => {
  const f = await fixture(t), id = await f.driver.open({ cwd: '/workspace' })
  const result = f.driver.prompt(id, 'An accepted operation')
  const rejection = assert.rejects(result, AcpOutcomeUnknown)
  f.finish({})
  await rejection
  assert.deepEqual(f.driver.status(id), { connected: false, pending: true, outcomeUnknown: true })
  assert.equal(f.requests('session/prompt').length, 1)
})
