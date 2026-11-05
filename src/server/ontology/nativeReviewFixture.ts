import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { createAcpBridgeHandle } from '../backends/acpBridge.js'
import type { AcpMessageTransport, AcpTransportEvents } from '../backends/acpTransport.js'
import type { InternalSessionChannel } from '../internalSessionChannel.js'

export async function createNativeReviewFixture(t: TestContext, mode: 'complete' | 'drop' | 'legacy' = 'complete', sessionId = 'conversation', onInput?: (input: any) => void) {
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
        onInput?.(message.params)
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
  const bridge = createAcpBridgeHandle({ transport, cwd: root, sessionId, model: 'fixture', transcriptPath,
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
  const runtime = { connectInternalChannel: async (requestedSession: string) => {
    assert.equal(requestedSession, sessionId)
    const channel = createConnection({ host: '127.0.0.1', port: address.port })
    await new Promise<void>((resolve, reject) => { channel.once('connect', resolve); channel.once('error', reject) })
    const write = channel.write.bind(channel)
    channel.write = ((line: string, onError?: (error: unknown) => void) => write(line + '\n', onError)) as typeof channel.write
    return channel as unknown as InternalSessionChannel
  } }
  return { runtime, submissions, controls, transcriptPath }
}

