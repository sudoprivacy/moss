import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { test } from 'node:test'
import { reservePorts, waitReady } from './packaged-pg-ha-smoke.mjs'

test('HA HTTP and Nexus ports remain distinct and reserved until each launch', async t => {
  const reservations = await reservePorts(4)
  t.after(() => Promise.all(reservations.map(reservation => reservation.release())))
  assert.equal(new Set(reservations.map(reservation => reservation.port)).size, 4)
  async function bind(port) {
    const server = net.createServer()
    try {
      server.listen(port, '127.0.0.1')
      await once(server, 'listening')
    } finally {
      if (server.listening) await new Promise(resolve => server.close(resolve))
    }
  }
  for (const reservation of reservations) {
    await assert.rejects(bind(reservation.port), { code: 'EADDRINUSE' })
  }
  await reservations[0].release()
  await bind(reservations[0].port)
  for (const reservation of reservations.slice(1)) {
    await assert.rejects(bind(reservation.port), { code: 'EADDRINUSE' })
  }
})

test('packaged HA readiness rejects a different live instance on the requested port', async t => {
  let instanceId = 'packaged-pg-a'
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ ready: true, instance_id: instanceId }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const child = { exitCode: null }
  await assert.rejects(waitReady(baseUrl, child, 'packaged-pg-b'), /Expected instance packaged-pg-b.*received packaged-pg-a/)
  instanceId = 'packaged-pg-b'
  await waitReady(baseUrl, child, 'packaged-pg-b')
})
