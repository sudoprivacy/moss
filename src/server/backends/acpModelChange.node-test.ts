import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { SessionRpcMessage } from '@nexus-ai-fs/vfs-client'
import { createAcpBridgeHandle } from './acpBridge.js'
import type { AcpMessageTransport, AcpTransportEvents } from './acpTransport.js'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'moss-model-activity-'))
  const requests: SessionRpcMessage[] = []
  const output: Array<Record<string, unknown>> = []
  const notifications = new EventEmitter()
  let events!: AcpTransportEvents
  let onModel: ((message: SessionRpcMessage) => void) | undefined
  let isConnected = true
  let closes = 0
  const transport: AcpMessageTransport = {
    get connected() { return isConnected },
    start(value) { events = value },
    async send(message) {
      requests.push(message)
      notifications.emit('request')
      if (message.method === 'session/set_model') onModel?.(message)
    },
    async close() {
      if (!isConnected) return
      isConnected = false
      closes++
      events.onClose(null, null)
    },
  }
  const handle = createAcpBridgeHandle({ transport, cwd: root, sessionId: 'model-activity', model: 'original',
    modelProviderId: 'provider', enabledSkillNames: [], runtime: { type: 'cohost', engine: 'scode' } })
  handle.onStdoutLine(line => { output.push(JSON.parse(line) as Record<string, unknown>) })
  t.after(async () => {
    await handle.destroy(true)
    assert(root.startsWith(join(tmpdir(), 'moss-model-activity-')))
    await rm(root, { recursive: true, force: true })
  })
  const request = async (method: string) => {
    for (;;) {
      const message = requests.find(value => value.method === method)
      if (message) return message
      await once(notifications, 'request')
    }
  }
  const respond = (message: SessionRpcMessage) => events.onMessage(message)
  const initialize = await request('initialize')
  respond({ jsonrpc: '2.0', id: initialize.id, result: {} })
  const session = await request('session/new')
  respond({ jsonrpc: '2.0', id: session.id, result: { sessionId: 'engine' } })
  assert.equal(handle.isBusy?.(), false)
  return { handle, requests, output, request, respond,
    switchModel: (modelId: unknown) => handle.writeStdin(JSON.stringify({ type: 'control_request',
      request: { subtype: 'set_model', model_id: modelId } })),
    onModel: (callback: (message: SessionRpcMessage) => void) => { onModel = callback },
    settle: () => new Promise<void>(resolve => setImmediate(resolve)),
    modelRequests: () => requests.filter(message => message.method === 'session/set_model'),
    closes: () => closes, isConnected: () => isConnected }
}

void test('rejected model controls leave an idle execution idle and send no model RPC', async t => {
  const f = await fixture(t)
  for (const value of [undefined, '', 'another-provider:foreign', 'provider:']) {
    f.switchModel(value)
    assert.equal(f.handle.isBusy?.(), false)
    assert.equal(f.modelRequests().length, 0)
  }
})

for (const isFailure of [false, true]) {
  void test(`a ${isFailure ? 'failed' : 'completed'} model change releases its own busy state`, async t => {
    const f = await fixture(t)
    f.switchModel('provider:next')
    assert.equal(f.handle.isBusy?.(), true)
    const message = f.modelRequests()[0]!
    f.respond({ jsonrpc: '2.0', id: message.id,
      ...(isFailure ? { error: { code: -32602, message: 'Model unavailable' } } : { result: {} }) })
    await f.settle()
    assert.equal(f.handle.isBusy?.(), false)
    assert.equal(f.output.filter(event => event.subtype === (isFailure ? 'model_switch_rejected' : 'model_changed')).length, 1)
  })
}

void test('an immediate model response is correlated before transport dispatch', async t => {
  const f = await fixture(t)
  f.onModel(message => f.respond({ jsonrpc: '2.0', id: message.id, result: {} }))
  f.switchModel('provider:immediate')
  await f.settle()
  assert.equal(f.output.filter(event => event.subtype === 'model_changed').length, 1)
  assert.equal(f.handle.isBusy?.(), false)
})

void test('concurrent model changes keep distinct requests and remain busy until both settle', async t => {
  const f = await fixture(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  f.switchModel('provider:first')
  f.switchModel('provider:second')
  const [first, second] = f.modelRequests()
  assert(first && second)
  assert.notEqual(first.id, second.id)
  f.respond({ jsonrpc: '2.0', id: second.id, result: {} })
  await f.settle()
  assert.equal(f.handle.isBusy?.(), true)
  f.respond({ jsonrpc: '2.0', id: first.id, error: { code: -32602, message: 'Refused' } })
  await f.settle()
  assert.equal(f.handle.isBusy?.(), false)
  assert.equal(f.output.filter(event => event.subtype === 'model_changed').length, 1)
  assert.equal(f.output.filter(event => event.subtype === 'model_switch_rejected').length, 1)
})

void test('ending a prompt does not release a model change still in flight', async t => {
  const f = await fixture(t)
  f.handle.writeStdin(JSON.stringify({ type: 'user', message: { role: 'user', content: 'A controlled turn' } }))
  const prompt = await f.request('session/prompt')
  f.switchModel('provider:next')
  f.respond({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } })
  assert.equal(f.handle.isBusy?.(), true)
  f.respond({ jsonrpc: '2.0', id: f.modelRequests()[0]!.id, result: {} })
  await f.settle()
  assert.equal(f.handle.isBusy?.(), false)
})

void test('a model-change timeout preserves running work and accepts a late definitive reply', async t => {
  const f = await fixture(t)
  f.handle.writeStdin(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Keep this task running' } }))
  const prompt = await f.request('session/prompt')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  f.switchModel('provider:unconfirmed')
  const message = f.modelRequests()[0]!
  t.mock.timers.tick(30_000)
  await f.settle()
  assert.equal(f.closes(), 0, 'a model-control deadline must not cancel an accepted foreground task')
  assert.equal(f.isConnected(), true)
  assert.equal(f.handle.isBusy?.(), true)
  assert.equal(f.modelRequests().length, 1)
  assert.equal(f.output.filter(event => event.reason === 'model_change_outcome_unknown').length, 1)
  f.respond({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } })
  await f.settle()
  assert.equal(f.handle.isBusy?.(), true, 'an unconfirmed model change still prevents an idle claim')
  f.respond({ jsonrpc: '2.0', id: message.id, result: {} })
  await f.settle()
  assert.equal(f.output.filter(event => event.subtype === 'model_changed').length, 1)
  assert.equal(f.handle.isBusy?.(), false)
  assert.equal(f.modelRequests().length, 1, 'late confirmation must never resend the request')
  assert.equal(f.requests.filter(event => event.method === 'session/prompt').length, 1)
})
