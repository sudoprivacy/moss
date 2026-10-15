import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NexusAcpTransport } from './nexusAcpTransport.js'
import { ManagedAgentClient } from '../nexus/managedAgentClient.js'
import { SessionCodec, type NexusVfsClient } from '@nexus-ai-fs/vfs-client'

const endpoint = {protocol: 'acp-mailbox/1', channel_id: 'generation', agent: 'worker', controller: 'operator',
  transcript: '/conversations/0123456789abcdef0123456789abcdef/transcript'} as const

for (const outcome of ['live', 'reaped', 'changed', 'unavailable', 'denied'] as const) {
  void test(`foreground readiness checks the actual execution, without replaying input (${outcome})`, async () => {
    let probes = 0
    let writes = 0
    let cancels = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const agent = new ManagedAgentClient({
      async call(method: string) {
        if (method.includes('cancel')) { cancels++; return '{}' }
        assert.equal(method, 'managed_agent.get_session_v1')
        probes++
        await gate
        if (outcome === 'reaped') throw new Error(JSON.stringify({ code: -32603,
          message: 'managed_agent.get_session_v1: invalid argument: unknown session_id "pid"' }))
        if (outcome === 'denied') throw new Error('credential refused')
        if (outcome === 'unavailable') throw Object.assign(new Error('daemon unavailable'), { code: 14 })
        return JSON.stringify({ session_id: 'pid', agent_id: 'worker', owner_id: 'owner', workspace_path: '/proc/pid/workspace/',
          state: 'ready', session_endpoint: { ...endpoint, channel_id: outcome === 'changed' ? 'replacement' : endpoint.channel_id } })
      },
      async streamReadAt(_path: string, offset: string) {
        await new Promise(resolve => setTimeout(resolve, 5))
        return { data: Buffer.alloc(0), nextOffset: offset, timedOut: true, eof: false }
      },
      async streamWrite() { writes++ }, close() {},
    } as unknown as NexusVfsClient, '')
    const transport = new NexusAcpTransport(agent, { sessionId: 'pid', osPid: null, sessionEndpoint: endpoint })
    assert.equal(await transport.checkReady(), false)
    transport.start({ onMessage() {}, onStderr() {}, onClose() {} })
    const first = transport.checkReady()
    const second = transport.checkReady()
    assert.equal(first, second)
    release()
    if (outcome === 'live') assert.deepEqual(await Promise.all([first, second]), [true, true])
    else await assert.rejects(Promise.all([first, second]), outcome === 'reaped' ? /disappeared/ :
      outcome === 'changed' ? /channel changed/ : outcome === 'denied' ? /credential refused/ : /daemon unavailable/)
    assert.equal(probes, 1)
    assert.equal(writes, 0)
    assert.equal(cancels, 0)
    await transport.close()
    assert.equal(await transport.checkReady(), false)
  })
}

for (const spawnSpec of [undefined, {cmd: 'scode', args: ['acp'], env: {}, cwd: '/workspace'}]) {
  void test(`both hosting modes use one mailbox (${spawnSpec ? 'subprocess' : 'cohost'})`, async () => {
    const calls: any[] = []
    const writes: any[] = []
    let closes = 0
    const client = {
      async call(method: string, body: string, auth: string) {
        assert.equal(auth, 'controller-token')
        calls.push({method, body: JSON.parse(body)})
        return JSON.stringify({result: method.includes('start_session') ? {session_id: 'pid', session_endpoint: endpoint} : {cancelled: true}})
      },
      async streamReadAt(_path: string, offset: string) {
        await new Promise(resolve => setTimeout(resolve, 5))
        return {data: Buffer.alloc(0), nextOffset: offset, timedOut: true, eof: false}
      },
      async streamWrite(path: string, bytes: Buffer, auth: string) {
        assert.equal(auth, 'controller-token')
        writes.push({path, envelope: JSON.parse(bytes.toString())})
      },
      close() { closes++ },
    }
    const agent = new ManagedAgentClient(client as unknown as NexusVfsClient, 'controller-token')
    const session = await agent.startSession({agentId: 'worker', spawnSpec})
    const transport = new NexusAcpTransport(agent, session)
    transport.start({onMessage() {}, onStderr() {}, onClose() {}})
    await transport.send({jsonrpc: '2.0', id: 0, result: {outcome: {outcome: 'selected', optionId: 'allow_once'}}})
    await transport.close()
    await transport.close()
    assert.equal(writes.length, 2)
    assert(writes.every(write => write.path === endpoint.transcript))
    assert.equal(JSON.parse(writes[0].envelope.body).message.id, 0)
    assert.equal(calls.filter(call => call.method.includes('cancel')).length, 1)
    assert.deepEqual(calls.find(call => call.method.includes('cancel')), {
      method: 'managed_agent.cancel_v2', body: { session_id: 'pid', channel_id: endpoint.channel_id },
    })
    assert.equal(closes, 1)
  })
}

void test('an old daemon is rejected and the just-created process is reaped', async () => {
  const calls: string[] = []
  const agent = new ManagedAgentClient({async call(method: string) {
    calls.push(method)
    return JSON.stringify({result: {session_id: 'pid'}})
  }} as unknown as NexusVfsClient, '')
  await assert.rejects(agent.startSession({agentId: 'worker'}), /does not support acp-mailbox/)
  assert.deepEqual(calls, ['managed_agent.start_session_v1', 'managed_agent.cancel_v1'])
})

for (const outcome of ['live', 'reaped', 'changed', 'denied'] as const) {
  void test(`a failed read checks the live execution before reconnecting (${outcome})`, { timeout: 5000 }, async () => {
    let reads = 0
    let snapshots = 0
    let cancellations = 0
    let closedClients = 0
    const frame = new SessionCodec(endpoint, 'agent').encode({ type: 'rpc', message: { jsonrpc: '2.0', id: 'reconnected', result: {} } })
    const transient = Object.assign(new Error('connection interrupted'), { code: 14 })
    const failure = (method: string) => new Error(JSON.stringify({ code: -32603,
      message: `${method}: invalid argument: unknown session_id "pid"` }))
    const agent = new ManagedAgentClient({
      async call(method: string) {
        if (method.includes('cancel')) {
          cancellations++
          if (outcome === 'reaped') throw failure(method)
          return '{}'
        }
        snapshots++
        if (outcome === 'reaped') throw failure(method)
        if (outcome === 'denied') throw new Error('credential refused')
        return JSON.stringify({ session_id: 'pid', agent_id: 'worker', owner_id: 'owner', workspace_path: '/proc/pid/workspace/',
          session_endpoint: { ...endpoint, channel_id: outcome === 'changed' ? 'new-generation' : endpoint.channel_id } })
      },
      async streamReadAt(_path: string, offset: string) {
        if (++reads === 1) throw transient
        if (reads === 2) return { data: frame, nextOffset: '1', timedOut: false, eof: false }
        await new Promise(resolve => setTimeout(resolve, 5))
        return { data: Buffer.alloc(0), nextOffset: offset, timedOut: true, eof: false }
      },
      async streamWrite() {},
      close() { closedClients++ },
    } as unknown as NexusVfsClient, '')
    const transport = new NexusAcpTransport(agent, { sessionId: 'pid', osPid: null, sessionEndpoint: endpoint })
    let onFinished!: (error?: Error) => void
    const finished = new Promise<Error | undefined>(resolve => { onFinished = resolve })
    transport.start({ onMessage: () => onFinished(), onStderr() {}, onClose: (_code, _signal, error) => onFinished(error) })
    const error = await finished
    if (outcome === 'live') assert.equal(error, undefined)
    else assert.match(error!.message, outcome === 'reaped' ? /disappeared/ : outcome === 'changed' ? /channel changed/ : /credential refused/)
    await transport.close()
    // Automatic close can already be running after the mailbox reports loss.
    for (let attempt = 0; closedClients === 0 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(snapshots, 1)
    assert.equal(cancellations, 1)
    assert.equal(closedClients, 1)
    if (outcome !== 'live') assert.equal(reads, 1)
  })
}

for (const isRefused of [false, true]) {
  void test(`requested close waits for native cancellation acknowledgement (${isRefused ? 'refused' : 'accepted'})`, async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let onCancelling!: () => void
    const cancelling = new Promise<void>(resolve => { onCancelling = resolve })
    const failure = new Error('native cancellation permission denied')
    let closedClients = 0
    const agent = new ManagedAgentClient({
      async call(method: string) {
        assert.equal(method, 'managed_agent.cancel_v2')
        onCancelling()
        await gate
        if (isRefused) throw failure
        return JSON.stringify({ cancelled: true })
      },
      async streamReadAt(_path: string, offset: string) {
        await new Promise(resolve => setTimeout(resolve, 5))
        return { data: Buffer.alloc(0), nextOffset: offset, timedOut: true, eof: false }
      },
      async streamWrite() {}, close() { closedClients++ },
    } as unknown as NexusVfsClient, '')
    const exits: (Error | undefined)[] = []
    const transport = new NexusAcpTransport(agent, { sessionId: 'pid', osPid: null, sessionEndpoint: endpoint })
    transport.start({ onMessage() {}, onStderr() {}, onClose: (_code, _signal, error) => { exits.push(error) } })
    const closing = transport.close()
    const outcome = isRefused ? assert.rejects(closing, /native cancellation permission denied/) : closing
    try {
      await cancelling
      assert.equal(exits.length, 0, 'Closing the mailbox alone must not report a successful execution stop')
      assert.equal(transport.close(), closing)
      release()
      await outcome
      assert.equal(exits.length, 1)
      if (isRefused) assert.equal(exits[0], failure)
      else assert.equal(exits[0], undefined)
      assert.equal(closedClients, 1)
    } finally {
      release()
      await closing.catch(() => {})
    }
  })
}

void test('cleanup preserves a cancellation authorization failure', async () => {
  let closed = false
  const agent = new ManagedAgentClient({ call: async () => { throw new Error('permission denied') },
    close() { closed = true } } as unknown as NexusVfsClient, '')
  const transport = new NexusAcpTransport(agent, { sessionId: 'pid', osPid: null, sessionEndpoint: endpoint })
  await assert.rejects(transport.close(), /permission denied/)
  assert.equal(closed, true)
})

for (const outcome of ['reaped', 'changed'] as const) {
  void test(`an empty retained mailbox cannot keep a dead native attachment alive (${outcome})`, { timeout: 5000 }, async t => {
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    let reads = 0
    let cancellations = 0
    const agent = new ManagedAgentClient({
      async call(method: string, body: string) {
        if (method.includes('cancel')) {
          assert.equal(method, 'managed_agent.cancel_v2')
          assert.equal(JSON.parse(body).channel_id, endpoint.channel_id)
          cancellations++
          return JSON.stringify({ cancelled: false })
        }
        if (outcome === 'reaped') throw new Error(JSON.stringify({ code: -32603,
          message: 'managed_agent.get_session_v1: invalid argument: unknown session_id "pid"' }))
        return JSON.stringify({ session_id: 'pid', agent_id: 'worker', owner_id: 'owner', workspace_path: '/proc/pid/workspace/',
          session_endpoint: { ...endpoint, channel_id: 'replacement' } })
      },
      async streamReadAt(_path: string, offset: string) {
        reads++
        now += 5001
        return { data: Buffer.alloc(0), nextOffset: offset, timedOut: true, eof: false }
      },
      async streamWrite() {}, close() {},
    } as unknown as NexusVfsClient, '')
    let onFinished!: (error?: Error) => void
    const finished = new Promise<Error | undefined>(resolve => { onFinished = resolve })
    const transport = new NexusAcpTransport(agent, { sessionId: 'pid', osPid: null, sessionEndpoint: endpoint })
    transport.start({ onMessage() {}, onStderr() {}, onClose: (_code, _signal, error) => onFinished(error) })
    assert.match((await finished)!.message, outcome === 'reaped' ? /disappeared/ : /channel changed/)
    await transport.close()
    assert.equal(reads, 1)
    assert.equal(cancellations, 1)
  })
}

void test('a sustained daemon outage closes its attachment instead of retrying forever', { timeout: 5000 }, async t => {
  let now = 1000
  t.mock.method(performance, 'now', () => now)
  let reads = 0
  const unavailable = () => Object.assign(new Error('daemon unavailable'), { code: 14 })
  const agent = new ManagedAgentClient({
    async call(method: string) {
      if (method.includes('cancel')) return '{}'
      throw unavailable()
    },
    async streamReadAt() { reads++; now += 30001; throw unavailable() },
    async streamWrite() {}, close() {},
  } as unknown as NexusVfsClient, '')
  let onFinished!: (error?: Error) => void
  const finished = new Promise<Error | undefined>(resolve => { onFinished = resolve })
  const transport = new NexusAcpTransport(agent, { sessionId: 'pid', osPid: null, sessionEndpoint: endpoint })
  transport.start({ onMessage() {}, onStderr() {}, onClose: (_code, _signal, error) => onFinished(error) })
  assert.match((await finished)!.message, /remained unavailable/)
  await transport.close()
  assert.equal(reads, 2)
})
