import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { browserAction, browserController, HttpBrowserWorker } from './browserGateway.js'
import { bridgeBrowserWindowStream } from './browserWindowStream.js'

void test('first RFB frame survives coalescing with the worker HTTP upgrade', { timeout: 5000 }, async t => {
  const banner = Buffer.from('RFB 003.008\n')
  const workerServer = http.createServer()
  const gateway = http.createServer()
  const gatewayWss = new WebSocketServer({ noServer: true })
  const rawSockets = new Set<import('node:stream').Duplex>()
  let upstream: WebSocket | undefined
  let client: WebSocket | undefined
  t.after(async () => {
    client?.terminate()
    upstream?.terminate()
    for (const socket of gatewayWss.clients) socket.terminate()
    for (const socket of rawSockets) socket.destroy()
    gatewayWss.close()
    await Promise.all([workerServer, gateway].map(server =>
      new Promise<void>(resolve => server.close(() => resolve()))))
  })
  workerServer.on('upgrade', (request, socket) => {
    rawSockets.add(socket)
    const accept = createHash('sha1')
      .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    // Exercise a single TCP write containing both the upgrade and first RFB frame.
    socket.write(Buffer.concat([
      Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Protocol: binary\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n'),
      Buffer.from([0x82, banner.length]), banner,
    ]))
  })
  workerServer.listen(0, '127.0.0.1')
  await once(workerServer, 'listening')
  const worker = new HttpBrowserWorker(`http://127.0.0.1:${(workerServer.address() as { port: number }).port}/`, 'fixture-only')
  gateway.on('upgrade', (request, socket, head) => {
    void worker.openWindowStream({ orgId: 'org', userId: 'owner', sessionId: 'task' }, 'user-owner',
      { viewerId: 'viewer', controlEpoch: 1, targetEpoch: 1 }).then(channel => {
      upstream = channel
      gatewayWss.handleUpgrade(request, socket, head, downstream => {
        bridgeBrowserWindowStream(downstream, channel, async () => true)
      })
    }).catch(() => socket.destroy())
  })
  gateway.listen(0, '127.0.0.1')
  await once(gateway, 'listening')
  client = new WebSocket(`ws://127.0.0.1:${(gateway.address() as { port: number }).port}/`, ['binary'])
  const [message, isBinary] = await once(client, 'message')
  assert.equal(isBinary, true)
  assert.deepEqual(message, banner)
})

for (const trigger of ['frame', 'idle']) {
void test(`real binary browser stream stops both directions after ${trigger} revocation`, { timeout: 8000 }, async t => {
  const binding = { orgId: 'tenant', userId: 'owner', sessionId: 'original-task' }
  const controller = browserController(binding)
  const action = browserAction({ kind: 'window-stream', viewerId: '00000000-0000-4000-8000-000000000000',
    controlEpoch: 3, targetEpoch: 5, binding: { userId: 'attacker' }, controller: 'ai' })
  const workerServer = http.createServer()
  const workerWss = new WebSocketServer({ server: workerServer })
  const received: Buffer[] = []
  let workerSocket: WebSocket | null = null
  workerWss.on('connection', (socket, request) => {
    assert.equal(request.url, '/window-stream')
    assert.equal(request.headers.authorization, 'Bearer host-fixture-credential')
    assert.deepEqual(JSON.parse(decodeURIComponent(String(request.headers['x-adb-browser-context']))), {
      binding, controller, viewerId: action.viewerId, controlEpoch: 3, targetEpoch: 5,
    })
    workerSocket = socket
    socket.on('message', (data, isBinary) => {
      assert.ok(isBinary)
      received.push(Buffer.from(data as Buffer))
      socket.send(data, { binary: true })
    })
  })
  workerServer.listen(0, '127.0.0.1')
  await once(workerServer, 'listening')
  const port = (workerServer.address() as { port: number }).port
  const worker = new HttpBrowserWorker(`http://127.0.0.1:${port}/`, 'host-fixture-credential')
  const gateway = http.createServer()
  const gatewayWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  let isAllowed = true
  gateway.on('upgrade', (request, socket, head) => {
    void worker.openWindowStream(binding, controller, action).then(upstream => {
      gatewayWss.handleUpgrade(request, socket, head, downstream => {
        bridgeBrowserWindowStream(downstream, upstream, async () => isAllowed)
      })
    }).catch(() => socket.destroy())
  })
  gateway.listen(0, '127.0.0.1')
  await once(gateway, 'listening')
  const gatewayPort = (gateway.address() as { port: number }).port
  const client = new WebSocket(`ws://127.0.0.1:${gatewayPort}/`, ['binary'])
  t.after(async () => {
    client.terminate()
    for (const socket of [...workerWss.clients, ...gatewayWss.clients]) socket.terminate()
    workerWss.close()
    gatewayWss.close()
    await Promise.all([new Promise<void>(resolve => workerServer.close(() => resolve())),
      new Promise<void>(resolve => gateway.close(() => resolve()))])
  })
  await once(client, 'open')
  const reply = once(client, 'message')
  client.send(Buffer.from([0, 1, 2, 255]))
  const [message, isBinary] = await reply
  assert.equal(isBinary, true)
  assert.deepEqual(message, Buffer.from([0, 1, 2, 255]))
  assert.deepEqual(received, [Buffer.from([0, 1, 2, 255])])

  const visible: unknown[] = []
  client.on('message', value => visible.push(value))
  const clientClosed = once(client, 'close')
  const workerClosed = once(workerSocket!, 'close')
  isAllowed = false
  if (trigger === 'frame') workerSocket!.send(Buffer.from('private frame after revocation'))
  const [code] = await clientClosed
  assert.equal(code, 1008)
  await workerClosed
  assert.deepEqual(visible, [])
  assert.equal(received.length, 1)
})
}

void test('worker handshake refusal is surfaced once without reconnecting or disclosing its endpoint', async t => {
  let attempts = 0
  const server = http.createServer()
  server.on('upgrade', (_request, socket) => {
    attempts++
    socket.end('HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const port = (server.address() as { port: number }).port
  const worker = new HttpBrowserWorker(`http://127.0.0.1:${port}/`, 'host-fixture-credential')
  await assert.rejects(worker.openWindowStream({ orgId: 'org', userId: 'owner', sessionId: 'task' }, 'user-owner',
    { viewerId: 'viewer', controlEpoch: 1, targetEpoch: 1 }), error => {
      assert.equal((error as { statusCode: number }).statusCode, 409)
      assert.equal((error as Error).message, 'browser_window_stream_unavailable')
      return true
    })
  assert.equal(attempts, 1)
})
