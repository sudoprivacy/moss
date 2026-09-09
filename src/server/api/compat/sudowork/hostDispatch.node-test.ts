import assert from 'node:assert/strict'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { after, before, describe, test } from 'node:test'
import { Hono } from 'hono'
import { createHostDispatch } from './hostDispatch.js'

describe('production Sudowork host dispatch', () => {
  let port = 0
  let close: () => Promise<void>

  before(async () => {
    const sudowork = new Hono()
    sudowork.post('/api/v1/auth/login', (context) => context.json({ service: 'sudowork' }))
    sudowork.post('/api/v1/usage/report', async (context) => context.json({
      service: 'sudowork',
      body: await context.req.json(),
    }))
    sudowork.get('/api/v1/admin/logs', (context) => context.json({ service: 'sudowork' }))
    sudowork.get('/api/v1/admin/users', (context) => context.json({ service: 'sudowork' }))
    sudowork.get('/api/v1/admin/enterprises', (context) => context.json({ service: 'sudowork' }))
    sudowork.get('/api/v1/qms/system/health', (context) => context.json({ service: 'qms' }))
    const moss = (_request: IncomingMessage, response: ServerResponse) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ service: 'moss' }))
    }
    const server = createServer(createHostDispatch({
      sudoworkHosts: ['api.sudowork.test'],
      sudoworkFetch: sudowork.fetch,
      sudoworkRoutes: sudowork.routes,
      mossOperationsFetch: sudowork.fetch,
      mossHandler: moss,
    }))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert(address && typeof address === 'object')
    port = address.port
    close = () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  })

  after(async () => close())

  function send(
    host: string,
    path = '/api/v1/auth/login',
    method = 'POST',
    body?: string,
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port, path, method,
        headers: {
          host,
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
        },
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }))
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  test('routes exact trusted hosts before the native Moss handler', async () => {
    assert.deepEqual(await send('api.sudowork.test:443'), {
      status: 200, body: { service: 'sudowork' },
    })
    assert.deepEqual(await send('moss.test'), {
      status: 200, body: { service: 'moss' },
    })
    assert.deepEqual(await send('api.sudowork.test.attacker.example'), {
      status: 200, body: { service: 'moss' },
    })
  })

  test('only sends registered compatibility paths to Hono on the legacy host', async () => {
    assert.deepEqual(await send('api.sudowork.test', '/', 'GET'), {
      status: 200, body: { service: 'moss' },
    })
    assert.deepEqual(await send('api.sudowork.test', '/api/v1/users', 'GET'), {
      status: 200, body: { service: 'moss' },
    })
    assert.deepEqual(await send('api.sudowork.test', '/api/v1/auth/login?device_id=desktop', 'POST'), {
      status: 200, body: { service: 'sudowork' },
    })
  })

  test('uses a dedicated Moss operations namespace without exposing legacy paths on the Moss host', async () => {
    assert.deepEqual(await send('moss.test', '/api/moss/v1/operations/logs', 'GET'), {
      status: 200, body: { service: 'sudowork' },
    })
    assert.deepEqual(await send('moss.test', '/api/moss/v1/operations/qms/system/health', 'GET'), {
      status: 200, body: { service: 'qms' },
    })
    assert.deepEqual(await send('moss.test', '/api/v1/admin/logs', 'GET'), {
      status: 200, body: { service: 'moss' },
    })
    assert.deepEqual(await send('api.sudowork.test', '/api/moss/v1/operations/logs', 'GET'), {
      status: 200, body: { service: 'sudowork' },
    })
    assert.deepEqual(await send('api.sudowork.test', '/api/moss/v1/auth/token', 'POST'), {
      status: 200, body: { service: 'moss' },
    })
    assert.deepEqual(await send('moss.test', '/api/moss/v1/operations/enterprises', 'GET'), {
      status: 200, body: { service: 'moss' },
    })
  })

  test('forwards a streamed request body to Hono exactly once', async () => {
    assert.deepEqual(await send(
      'api.sudowork.test',
      '/api/v1/usage/report',
      'POST',
      JSON.stringify({ inputTokens: 7, outputTokens: 5 }),
    ), {
      status: 200,
      body: { service: 'sudowork', body: { inputTokens: 7, outputTokens: 5 } },
    })
  })

  test('serves Moss operations when the legacy compatibility surface is disabled', async () => {
    const operations = new Hono()
    operations.get('/api/v1/admin/stats', (context) => context.json({ service: 'operations' }))
    const isolated = createServer(createHostDispatch({
      mossOperationsFetch: operations.fetch,
      mossHandler: (_request, response) => response.end(JSON.stringify({ service: 'moss' })),
    }))
    await new Promise<void>((resolve, reject) => {
      isolated.once('error', reject)
      isolated.listen(0, '127.0.0.1', resolve)
    })
    const address = isolated.address()
    assert(address && typeof address === 'object')
    const body = await new Promise<string>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port: address.port,
        path: '/api/moss/v1/operations/stats', method: 'GET',
      }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      })
      req.on('error', reject)
      req.end()
    })
    await new Promise<void>(resolve => isolated.close(() => resolve()))
    assert.deepEqual(JSON.parse(body), { service: 'operations' })
  })
})
