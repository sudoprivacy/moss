import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SessionRpcMessage } from '@nexus-ai-fs/vfs-client'
import { createAcpBridgeHandle } from './acpBridge.js'
import type { AcpMessageTransport, AcpTransportEvents } from './acpTransport.js'

type Resolver = (binding: { sessionId: string; nativeSessionId: string }) => Promise<string>

async function fixture(resolveHostContext?: Resolver, isResume = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'moss-host-context-'))
  const sent: SessionRpcMessage[] = []
  let events!: AcpTransportEvents
  let isConnected = true
  const waiters = new Set<() => void>()
  const transport: AcpMessageTransport = {
    get connected() { return isConnected },
    start(value) { events = value },
    async send(message) { sent.push(message); for (const wake of waiters) wake() },
    async close() {
      if (!isConnected) return
      isConnected = false
      events.onClose(null, null)
    },
  }
  const transcriptPath = join(cwd, 'transcript.jsonl')
  const handle = createAcpBridgeHandle({ transport, cwd, sessionId: 'host-session',
    model: 'fixture', runtime: { type: 'cohost', engine: 'scode' }, transcriptPath,
    instructions: 'FIXED_HOST_ROLE', resolveHostContext,
    resumeSessionId: isResume ? 'native-session' : undefined,
  })
  async function wait(predicate: (message: SessionRpcMessage) => boolean): Promise<SessionRpcMessage> {
    const existing = sent.find(predicate)
    if (existing) return existing
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { waiters.delete(wake); reject(new Error('Missing ACP message')) }, 5000)
      const wake = () => {
        const message = sent.find(predicate)
        if (!message) return
        clearTimeout(timeout); waiters.delete(wake); resolve(message)
      }
      waiters.add(wake)
    })
  }
  const receive = (message: Omit<SessionRpcMessage, 'jsonrpc'>) => events.onMessage({ jsonrpc: '2.0', ...message })
  async function ready() {
    await wait(message => message.method === 'initialize')
    receive({ id: 'm-init', result: { _meta: { sudocode: { hostContext: { version: 1 } } } } })
    const request = await wait(message => message.method === (isResume ? 'session/load' : 'session/new'))
    receive({ id: request.id, result: { sessionId: 'native-session' } })
    return request
  }
  async function context(id: string, nativeSessionId = 'native-session') {
    receive({ id, method: '_sudocode/session/host_context', params: { sessionId: nativeSessionId } })
    return wait(message => message.id === id)
  }
  async function close() { await handle.destroy(true); await rm(cwd, { recursive: true, force: true }) }
  return { handle, ready, wait, receive, sent, context, close, transport, transcriptPath }
}

for (const isResume of [false, true]) {
  void test(`host context ${isResume ? 'resume' : 'creation'} negotiates v1 and reads each execution without copying it into history`, async t => {
    let current = 'COMPILED_CONTEXT_A'
    let calls = 0
    const run = await fixture(async binding => {
      assert.deepEqual(binding, { sessionId: 'host-session', nativeSessionId: 'native-session' })
      calls++
      return current
    }, isResume)
    t.after(run.close)
    const request = await run.ready()
    assert.deepEqual((request.params as any)._meta, { sudocode: { hostContext: { version: 1 } } })
    assert.equal(calls, 0, 'admission/handshake must not cache a mutable snapshot')
    run.handle.writeStdin(JSON.stringify({ type: 'user', message: { content: 'Ask the business question' } }))
    const prompt = await run.wait(message => message.method === 'session/prompt')
    assert(!JSON.stringify(prompt).includes('COMPILED_CONTEXT_'))
    assert.deepEqual((await run.context('first')).result, { appendSystemPrompt: 'COMPILED_CONTEXT_A\n\nFIXED_HOST_ROLE' })
    current = 'COMPILED_CONTEXT_B'
    assert.deepEqual((await run.context('second')).result, { appendSystemPrompt: 'COMPILED_CONTEXT_B\n\nFIXED_HOST_ROLE' })
    assert.equal(calls, 2)
    await run.handle.destroy(true)
    const history = await readFile(run.transcriptPath, 'utf8')
    assert(history.includes('Ask the business question'))
    assert(!history.includes('COMPILED_CONTEXT_'))
  })
}

for (const capability of [undefined, { version: 2 }]) {
  void test(`required host context refuses capability ${JSON.stringify(capability)} before starting or loading a session`, async t => {
    const run = await fixture(async () => assert.fail('unsupported engine cannot read context'), true)
    t.after(run.close)
    const errors: string[] = []
    run.handle.onStderrLine(line => errors.push(line))
    run.handle.writeStdin('queued input')
    await run.wait(message => message.method === 'initialize')
    run.receive({ id: 'm-init', result: { _meta: { sudocode: { hostContext: capability } } } })
    assert(!run.transport.connected)
    assert(errors.some(error => error.includes('requires hostContext v1')))
    assert(!run.sent.some(message => ['session/new', 'session/load', 'session/prompt'].includes(message.method ?? '')))
  })
}

for (const value of ['denied', '', null]) {
  void test(`host context ${JSON.stringify(value)} returns an explicit error without a cached snapshot or resolver secrets`, async t => {
    let current: unknown = 'LAST_AUTHORIZED_CONTEXT'
    const run = await fixture(async () => {
      if (current === 'denied') throw new Error('password=fixture-private-secret')
      return current as string
    })
    t.after(run.close)
    await run.ready()
    assert((await run.context('authorized')).result)
    current = value
    const denied = await run.context('denied')
    assert.equal((denied.error as { code?: number })?.code, -32603)
    assert.equal(denied.result, undefined)
    assert(!JSON.stringify(denied).includes('LAST_AUTHORIZED_CONTEXT'))
    assert(!JSON.stringify(denied).includes('fixture-private-secret'))
  })
}

void test('a foreign native session cannot invoke the bound context reader', async t => {
  const run = await fixture(async () => assert.fail('foreign session must not read a model'))
  t.after(run.close)
  await run.ready()
  assert((await run.context('foreign', 'another-native-session')).error)
})

void test('ordinary sessions retain static context and refuse an unsolicited dynamic read', async t => {
  const run = await fixture()
  t.after(run.close)
  assert.deepEqual(((await run.ready()).params as any)._meta, { sudocode: { appendSystemPrompt: 'FIXED_HOST_ROLE' } })
  assert((await run.context('unsolicited')).error)
})

for (const ending of ['interrupt', 'disconnect']) {
  void test(`context finishing after ${ending} cannot disclose its resolved text`, async t => {
    let complete!: (text: string) => void
    const run = await fixture(() => new Promise(resolve => { complete = resolve }))
    t.after(run.close)
    await run.ready()
    run.receive({ id: 'pending', method: '_sudocode/session/host_context', params: { sessionId: 'native-session' } })
    if (ending === 'disconnect') await run.transport.close()
    else run.handle.writeStdin(JSON.stringify({ type: 'control_request', request: { subtype: 'interrupt' } }))
    complete('CONTEXT_AFTER_OWNERSHIP_ENDED')
    // The resolver resumes in a microtask, without delaying the input path.
    await new Promise<void>(resolve => setImmediate(resolve))
    if (ending === 'interrupt') assert((await run.wait(message => message.id === 'pending')).error)
    assert(!run.sent.some(message => JSON.stringify(message).includes('CONTEXT_AFTER_OWNERSHIP_ENDED')))
  })
}

void test('native close acknowledgement cannot leave a window for an in-flight context read', async t => {
  let complete!: (text: string) => void
  const run = await fixture(() => new Promise(resolve => { complete = resolve }))
  t.after(run.close)
  await run.ready()
  run.receive({ id: 'pending-close', method: '_sudocode/session/host_context', params: { sessionId: 'native-session' } })
  let acknowledge!: () => void
  const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve })
  const close = run.transport.close.bind(run.transport)
  run.transport.close = async () => { await acknowledgement; await close() }
  const stopping = run.handle.destroy(true)
  assert(run.transport.connected, 'native cleanup is still awaiting acknowledgement')
  complete('CONTEXT_DURING_NATIVE_CLEANUP')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert(!run.sent.some(message => message.id === 'pending-close'))
  acknowledge()
  await stopping
})
