import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { attachSessionSocketAuthorization, type SessionSocketAuthorization } from './sessionSocketAuthorization.js'

async function connect(t: TestContext, access: SessionSocketAuthorization) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  server.on('connection', ws => attachSessionSocketAuthorization(ws, access))
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`)
  t.after(async () => {
    client.terminate()
    for (const ws of server.clients) ws.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  await once(client, 'open')
  return client
}

void test('established session controls keep their order and stop immediately on a revoked grant', { timeout: 10_000 }, async t => {
  let isAllowed = true
  const received: string[] = []
  let resolveFirst!: () => void
  const first = new Promise<void>(resolve => { resolveFirst = resolve })
  const client = await connect(t, {
    isManagement: false,
    verify: async () => { await delay(10); return isAllowed },
    onMessage: data => { received.push(data.toString()); if (received.length === 2) resolveFirst() },
  })
  client.send('first')
  client.send('second')
  await first
  assert.deepEqual(received, ['first', 'second'])
  isAllowed = false
  const closed = once(client, 'close')
  client.send('forbidden')
  assert.equal((await closed)[0], 1008)
  assert.deepEqual(received, ['first', 'second'])
})

void test('an idle cross-owner subscriber is disconnected when current permission is revoked', { timeout: 12_000 }, async t => {
  let isAllowed = true
  const client = await connect(t, { isManagement: true, verify: async () => isAllowed,
    onMessage: () => { throw new Error('The idle subscriber must send no messages') } })
  const closed = once(client, 'close')
  isAllowed = false
  assert.equal((await closed)[0], 1008)
})

void test('a failed authorization lookup refuses the frame and closes the connection', { timeout: 10_000 }, async t => {
  const client = await connect(t, { isManagement: false,
    verify: async () => { throw new Error('Authorization unavailable') },
    onMessage: () => { throw new Error('An unchecked frame must never reach the runner') } })
  const closed = once(client, 'close')
  client.send('unchecked')
  assert.equal((await closed)[0], 1008)
})

void test('a quiet authenticated turn stays subscribed and can continue after human input', { timeout: 55_000 }, async t => {
  let isAllowed = true
  const received: string[] = []
  let resolveContinuation!: () => void
  const continuation = new Promise<void>(resolve => { resolveContinuation = resolve })
  const client = await connect(t, { isManagement: false,
    verify: async () => isAllowed,
    onMessage: data => { received.push(data.toString()); if (received.length === 2) resolveContinuation() } })
  // A real transport deadline reproduces an idle intermediary. With no
  // protocol traffic this connection closes before the second heartbeat.
  let deadline: ReturnType<typeof setTimeout>
  const refreshDeadline = () => {
    clearTimeout(deadline)
    deadline = setTimeout(() => client.terminate(), 25_000)
  }
  t.after(() => clearTimeout(deadline))
  refreshDeadline()
  const pings: number[] = []
  client.on('ping', () => { pings.push(Date.now()); refreshDeadline() })
  client.send('begin quiet turn')
  await delay(42_000)
  assert.equal(client.readyState, WebSocket.OPEN)
  assert(pings.length >= 2)
  const closed = once(client, 'close')
  client.send('continue after human input')
  await continuation
  assert.deepEqual(received, ['begin quiet turn', 'continue after human input'])
  isAllowed = false
  client.send('revoked continuation')
  assert.equal((await closed)[0], 1008)
  assert.deepEqual(received, ['begin quiet turn', 'continue after human input'])
})
