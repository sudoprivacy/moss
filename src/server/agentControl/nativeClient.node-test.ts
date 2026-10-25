import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { NativeControlClient, type NativeControlConfig } from './nativeClient.js'
import { AGENT_CONTROL_PROTOCOL } from './contract.js'

const config: NativeControlConfig = { protocol: AGENT_CONTROL_PROTOCOL, origin: 'http://127.0.0.1',
  accessToken: 'synthetic.private.control.credential', delegationId: 'grant1', deploymentId: 'dgx1',
  expiresAt: Date.now() + 120_000, actions: ['agents.spawn'] }

void test('native HTTP response loss retains the host operation ID, performs one effect and recovers by query', async () => {
  let effects = 0, posts = 0
  let receipt: any
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${config.accessToken}`)
    if (req.method === 'POST') {
      posts++
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      effects++
      receipt = { protocol: AGENT_CONTROL_PROTOCOL, operationId: body.operationId, status: 'completed', outcome: 'completed',
        audit: { delegationId: 'grant1', target: { deploymentId: 'dgx1' } }, result: { sessionId: 'exactly-one' } }
      req.socket.destroy() // effect is durable, but no response reaches the client
    } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(receipt)) }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const client = new NativeControlClient({ ...config, origin: `http://127.0.0.1:${address.port}` })
    const lost = await client.invoke('agents.spawn', { agent: 'persistent-agent' }, 'actual-tool-雪')
    assert.equal(lost.outcome, 'unknown'); assert.equal(posts, 1); assert.equal(effects, 1)
    assert.equal(lost.operationId, client.operationId('actual-tool-雪'))
    const recovered = await client.operation(lost.operationId)
    assert.equal(recovered.outcome, 'completed'); assert.equal(recovered.result.sessionId, 'exactly-one')
    assert.equal(posts, 1); assert.equal(effects, 1, 'query never resubmits')
    assert.notEqual(client.operationId('another-tool'), lost.operationId, 'identical bodies can be distinct commands')
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

void test('native adapter rejects untrusted origins, mismatched receipts, redirects and credential echoes', async t => {
  for (const origin of ['http://192.168.1.11', 'https://user:secret@example.com', 'https://example.com/path',
    'https://example.com?secret=1', 'https://example.com#fragment', 'file:///tmp/token'])
    assert.throws(() => new NativeControlClient({ ...config, origin }))
  for (const label of ['forged', 'echo', 'escaped-echo']) await t.test(label, async () => {
    let attempts = 0
    const client = new NativeControlClient(config, async (_url, init) => {
      attempts++; assert.equal(init?.redirect, 'error')
      const request = JSON.parse(String(init.body))
      const data = { protocol: AGENT_CONTROL_PROTOCOL, operationId: label === 'forged' ? 'other' : request.operationId,
        status: 'completed', outcome: 'completed', audit: { delegationId: 'grant1', target: { deploymentId: 'dgx1' } },
        result: { value: label === 'forged' ? 'ordinary-result' : config.accessToken } }
      const text = JSON.stringify(data)
      return new Response(label === 'escaped-echo' ? text.replaceAll('.', '\\u002e') : text,
        { headers: { 'content-type': 'application/json' } })
    })
    const result = await client.invoke('agents.spawn', { agent: 'agent' }, 'host-tool')
    assert.equal(result.outcome, 'unknown'); assert.equal(attempts, 1)
    assert.ok(!JSON.stringify(result).includes(config.accessToken))
  })
})

void test('native adapter refuses missing context, undelegated action and owner overrides before network', async () => {
  let attempts = 0
  const client = new NativeControlClient(config, async () => { attempts++; throw new Error('must not send') })
  await assert.rejects(client.invoke('agents.spawn', { agent: 'agent' }, ''))
  await assert.rejects(client.invoke('agents.list', {}, 'call'))
  await assert.rejects(client.invoke('agents.spawn', { agent: 'agent', ownerId: 'other' }, 'call'))
  assert.equal(attempts, 0)
})
