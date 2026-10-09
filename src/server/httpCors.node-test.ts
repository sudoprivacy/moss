import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { handleCorsPreflight, setCorsHeaders } from './httpCors.js'

void test('desktop billing preflight permits stable idempotency headers before authenticated POST', async () => {
  let writes = 0
  const server = createServer((req, res) => {
    if (handleCorsPreflight(req, res)) return
    setCorsHeaders(req, res)
    writes++
    res.end(JSON.stringify({ reference: req.headers['idempotency-key'] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/api/v1/model-billing/orders`
  const origin = 'http://localhost:5173'
  try {
    const requestedHeaders = ['authorization', 'content-type', 'idempotency-key']
    const preflight = await fetch(url, { method: 'OPTIONS', headers: {
      origin, 'access-control-request-method': 'POST', 'access-control-request-headers': requestedHeaders.join(', '),
    } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true')
    const allowed = preflight.headers.get('access-control-allow-headers')!.toLowerCase().split(/,\s*/)
    for (const header of requestedHeaders) assert(allowed.includes(header), `Preflight must allow ${header}`)
    assert(preflight.headers.get('access-control-allow-methods')!.split(/,\s*/).includes('POST'))
    assert.equal(writes, 0)
    const posted = await fetch(url, { method: 'POST', headers: { origin, 'idempotency-key': 'stable-order' } })
    assert.equal(posted.headers.get('access-control-allow-origin'), origin)
    assert.deepEqual(await posted.json(), { reference: 'stable-order' })
    assert.equal(writes, 1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
