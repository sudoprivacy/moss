import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createAcpBridgeHandle } from '../backends/acpBridge.js'
import type { AcpMessageTransport, AcpTransportEvents } from '../backends/acpTransport.js'
import type { InternalSessionChannel } from '../internalSessionChannel.js'
import { createNativeConversationReview } from './nativeConversationReview.js'

async function fixture(t: TestContext, mode: 'complete' | 'drop' | 'legacy' = 'complete') {
  const root = await mkdtemp(join(tmpdir(), 'moss-review-conversation-'))
  const transcriptPath = join(root, 'transcript.jsonl')
  const controls: unknown[] = [], submissions: any[] = []
  const sockets = new Set<Socket>()
  let events!: AcpTransportEvents
  const transport: AcpMessageTransport = {
    connected: true, start(value) { events = value }, async close() {},
    async send(message: any) {
      const receive = (value: any) => events.onMessage({ jsonrpc: '2.0', ...value })
      const update = (value: any) => receive({ method: '_sudocode/session/input_update', params: { sessionId: 'native-execution', update: value } })
      if (message.method === 'initialize') queueMicrotask(() => receive({ id: message.id, result: { _meta: { sudocode: { inputDelivery: { version: 1 } } } } }))
      else if (message.method === 'session/new') queueMicrotask(() => receive({ id: message.id, result: { sessionId: 'native-execution' } }))
      else if (message.method === '_sudocode/session/input' && message.params.action === 'submit') {
        submissions.push(message.params)
        const state = { revision: 1, activeTurnId: 1, running: true, paused: false,
          pending: [{ id: 1, clientId: message.params.clientId, source: 'human', delivery: 'queue' }] }
        queueMicrotask(() => {
          update({ kind: 'state', state })
          receive({ id: message.id, result: { id: 1, state } })
          if (mode === 'drop') { for (const socket of sockets) socket.destroy(); return }
          update({ kind: 'committed', clientId: message.params.clientId, source: 'human' })
          update({ kind: 'state', state: { ...state, revision: 2, pending: [] } })
          receive({ method: 'session/update', params: { sessionId: 'native-execution', update: {
            sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The original conversation reviewed the field.' } } } })
          update({ kind: 'turn_complete', turnId: 1, stopReason: 'end_turn' })
          update({ kind: 'state', state: { ...state, revision: 3, activeTurnId: null, pending: [], running: false } })
        })
      }
    },
  }
  const bridge = createAcpBridgeHandle({ transport, cwd: root, sessionId: 'conversation', model: 'fixture', transcriptPath,
    enabledSkillNames: [], runtime: { type: 'cohost', engine: 'scode' } })
  let hello = ''
  let ready!: () => void
  const readyPromise = new Promise<void>(resolve => { ready = resolve })
  bridge.onStdoutLine(line => {
    const event = JSON.parse(line)
    if (event.type === 'hello') {
      if (mode === 'legacy') delete event.nativeInputReceipts
      hello = JSON.stringify(event)
      ready()
    }
  })
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    socket.write(JSON.stringify({ type: 'stdout', line: hello }) + '\n')
    const unsubscribe = bridge.onStdoutLine(line => socket.write(JSON.stringify({ type: 'stdout', line }) + '\n'))
    socket.once('close', unsubscribe)
    let buffer = ''
    socket.on('data', bytes => {
      buffer += String(bytes)
      for (;;) {
        const end = buffer.indexOf('\n')
        if (end < 0) break
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        const packet = JSON.parse(line)
        controls.push(packet)
        if (packet.type === 'stdin') bridge.writeStdin(packet.data)
      }
    })
  })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await bridge.destroy(true)
    await rm(root, { recursive: true, force: true })
  })
  await readyPromise
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const runtime = { connectInternalChannel: async (sessionId: string) => {
    assert.equal(sessionId, 'conversation')
    const channel = createConnection({ host: '127.0.0.1', port: address.port })
    await new Promise<void>((resolve, reject) => { channel.once('connect', resolve); channel.once('error', reject) })
    const write = channel.write.bind(channel)
    channel.write = ((line: string, onError?: (error: unknown) => void) => write(line + '\n', onError)) as typeof channel.write
    return channel as unknown as InternalSessionChannel
  } }
  return { runtime, submissions, controls, transcriptPath }
}

const input = { conversationId: 'conversation', messageId: 'review-stable', content: 'Human comment', agentContent: 'Expanded anchored input' }

void test('review delivery uses the normal native input channel and recovers without another submission', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  let authorizations = 0, started = 0
  const answers: string[] = []
  const delivery = createNativeConversationReview(f.runtime, async () => { authorizations++ })
  t.after(() => delivery.close())
  assert.deepEqual(await delivery.deliver(input, { onStarted: async () => { started++ }, onCompleted: async text => { answers.push(text) } }), { success: true })
  assert.equal(started, 1)
  assert.deepEqual(answers, ['The original conversation reviewed the field.'])
  assert.equal(f.submissions.length, 1)
  assert.equal(f.submissions[0].clientId, input.messageId)
  assert.equal(f.submissions[0].display, input.content)
  assert.ok(JSON.stringify(f.submissions[0].content).includes(input.agentContent))
  assert.ok((await readFile(f.transcriptPath, 'utf8')).includes('native_input_complete'))
  const replacement = createNativeConversationReview(f.runtime, async () => { authorizations++ })
  t.after(() => replacement.close())
  assert.deepEqual(await replacement.recover(input), { state: 'complete', text: answers[0] })
  assert.equal(await replacement.messageExists(input.conversationId, input.messageId), true)
  assert.equal(await replacement.messageExists(input.conversationId, 'missing'), false)
  assert.equal(f.submissions.length, 1)
  assert.ok(authorizations >= 8)
})

void test('an older runner refuses review controls before any stdin is sent', { timeout: 10000 }, async t => {
  const f = await fixture(t, 'legacy')
  const delivery = createNativeConversationReview(f.runtime, async () => {})
  t.after(() => delivery.close())
  await assert.rejects(delivery.recover(input), /Upgrade the native runner/)
  assert.equal(f.controls.length, 0)
  assert.equal(f.submissions.length, 0)
})

void test('permission revoked after connection prevents native submission', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  let authorizations = 0
  const delivery = createNativeConversationReview(f.runtime, async () => { if (++authorizations > 1) throw new Error('Current access revoked') })
  t.after(() => delivery.close())
  await assert.rejects(delivery.deliver(input, { onStarted: async () => assert.fail(), onCompleted: async () => assert.fail() }), /revoked/)
  assert.equal(f.submissions.length, 0)
})

void test('connection loss after admission is unknown and never creates a completed answer', { timeout: 10000 }, async t => {
  const f = await fixture(t, 'drop')
  const delivery = createNativeConversationReview(f.runtime, async () => {})
  t.after(() => delivery.close())
  await assert.rejects(delivery.deliver(input, { onStarted: async () => {}, onCompleted: async () => assert.fail('Unknown completion cannot be acknowledged') }), /unknown/i)
  assert.deepEqual(await delivery.recover(input), { state: 'pending' })
  assert.equal(f.submissions.length, 1)
})
