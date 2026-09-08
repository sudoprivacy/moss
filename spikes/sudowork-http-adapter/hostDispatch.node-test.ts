import assert from 'node:assert/strict'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { createHostDispatch } from './hostDispatch.js'

interface TestResponse {
  status: number
  headers: IncomingMessage['headers']
  body: string
}

describe('Sudowork Host dispatch spike', () => {
  let port = 0
  let closeServer: () => Promise<void>
  let legacyRequests = 0
  let mossRequests = 0
  let upgrades = 0
  let resolveSseAbort: () => void
  let sseAborted: Promise<void>

  before(async () => {
    sseAborted = new Promise((resolve) => {
      resolveSseAbort = resolve
    })
    const legacy = new Hono()
    legacy.use('*', cors({ origin: 'https://desktop.test', credentials: true }))
    legacy.use('*', async (_context, next) => {
      legacyRequests += 1
      await next()
    })
    legacy.post('/api/v1/auth/login', async (context) => {
      return context.json({ service: 'sudowork', body: await context.req.json() })
    })
    legacy.post('/api/v1/form', async (context) => {
      return context.json({ body: await context.req.parseBody() })
    })
    legacy.post('/api/v1/upload', async (context) => {
      const body = await context.req.parseBody()
      const file = body.file
      return context.json({
        name: file instanceof File ? file.name : null,
        content: file instanceof File ? await file.text() : null,
      })
    })
    legacy.get('/api/v1/redirect', (context) => context.redirect('/api/v1/target', 302))
    legacy.get('/api/v1/error', (context) => context.json({ code: 'LEGACY_ERROR' }, 422))
    legacy.get('/api/v1/events', (context) => streamSSE(context, async (stream) => {
      stream.onAbort(resolveSseAbort)
      await stream.writeSSE({ event: 'ready', data: 'connected', id: '1' })
      while (!stream.aborted) await stream.sleep(5)
    }))

    const mossHandler = (req: IncomingMessage, res: ServerResponse): void => {
      mossRequests += 1
      res.setHeader('content-type', 'application/json')
      if (req.url === '/healthz') {
        res.end(JSON.stringify({ ok: true }))
        return
      }
      res.end(JSON.stringify({ service: 'moss' }))
    }
    const server = createServer(createHostDispatch({
      sudoworkHosts: ['api.sudowork.test'],
      sudoworkFetch: legacy.fetch,
      mossHandler,
    }))
    server.on('upgrade', (_req, socket) => {
      upgrades += 1
      socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    assert(address && typeof address === 'object')
    port = address.port
    closeServer = () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  })

  after(async () => {
    await closeServer()
  })

  function send(options: {
    path: string
    host?: string
    method?: string
    headers?: Record<string, string>
    body?: string
  }): Promise<TestResponse> {
    return new Promise((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1',
        port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: {
          Host: options.host ?? 'moss.test',
          ...options.headers,
        },
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      req.on('error', reject)
      if (options.body) req.write(options.body)
      req.end()
    })
  }

  test('dispatches the same path by exact trusted Host before reading the body', async () => {
    const body = JSON.stringify({ username: 'alice' })
    const legacyBefore = legacyRequests
    const mossBefore = mossRequests
    const legacy = await send({
      path: '/api/v1/auth/login',
      host: 'api.sudowork.test:443',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const moss = await send({ path: '/api/v1/auth/login', host: 'moss.test' })

    assert.equal(legacy.status, 200)
    assert.deepEqual(JSON.parse(legacy.body), { service: 'sudowork', body: { username: 'alice' } })
    assert.deepEqual(JSON.parse(moss.body), { service: 'moss' })
    assert.equal(legacyRequests - legacyBefore, 1)
    assert.equal(mossRequests - mossBefore, 1)
  })

  test('keeps native health checks and untrusted lookalike Hosts on Moss', async () => {
    const health = await send({ path: '/healthz', host: 'moss.test' })
    const lookalike = await send({ path: '/api/v1/auth/login', host: 'api.sudowork.test.attacker.example' })
    assert.deepEqual(JSON.parse(health.body), { ok: true })
    assert.deepEqual(JSON.parse(lookalike.body), { service: 'moss' })
  })

  test('preserves urlencoded and multipart request bodies', async () => {
    const form = await send({
      path: '/api/v1/form',
      host: 'api.sudowork.test',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=alice&role=admin',
    })
    assert.deepEqual(JSON.parse(form.body), { body: { name: 'alice', role: 'admin' } })

    const boundary = 'moss-spike-boundary'
    const multipartBody = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="note.txt"',
      'Content-Type: text/plain',
      '',
      'hello from sudowork',
      `--${boundary}--`,
      '',
    ].join('\r\n')
    const upload = await send({
      path: '/api/v1/upload',
      host: 'api.sudowork.test',
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: multipartBody,
    })
    assert.deepEqual(JSON.parse(upload.body), { name: 'note.txt', content: 'hello from sudowork' })
  })

  test('preserves CORS, redirects, and legacy error JSON', async () => {
    const preflight = await send({
      path: '/api/v1/auth/login',
      host: 'api.sudowork.test',
      method: 'OPTIONS',
      headers: {
        Origin: 'https://desktop.test',
        'Access-Control-Request-Method': 'POST',
      },
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers['access-control-allow-origin'], 'https://desktop.test')

    const redirect = await send({ path: '/api/v1/redirect', host: 'api.sudowork.test' })
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.location, '/api/v1/target')

    const error = await send({ path: '/api/v1/error', host: 'api.sudowork.test' })
    assert.equal(error.status, 422)
    assert.deepEqual(JSON.parse(error.body), { code: 'LEGACY_ERROR' })
  })

  test('streams SSE and observes client abort', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1',
        port,
        path: '/api/v1/events',
        headers: { Host: 'api.sudowork.test' },
      }, (res) => {
        assert.equal(res.headers['content-type'], 'text/event-stream')
        res.once('data', (chunk) => {
          assert.match(chunk.toString(), /event: ready/)
          res.destroy()
          resolve()
        })
      })
      req.on('error', reject)
      req.end()
    })
    await Promise.race([
      sseAborted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SSE abort was not observed')), 1_000)),
    ])
  })

  test('leaves WebSocket upgrades outside the Hono request listener', async () => {
    const legacyBefore = legacyRequests
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1')
      const chunks: Buffer[] = []
      socket.on('connect', () => socket.write([
        'GET /api/v1/events HTTP/1.1',
        'Host: api.sudowork.test',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '',
        '',
      ].join('\r\n')))
      socket.on('data', (chunk) => chunks.push(chunk))
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      socket.on('error', reject)
    })
    assert.match(response, /426 Upgrade Required/)
    assert.equal(upgrades, 1)
    assert.equal(legacyRequests, legacyBefore)
  })
})
