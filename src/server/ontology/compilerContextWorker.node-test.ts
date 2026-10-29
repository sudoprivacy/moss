import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ToolProtocol } from '../agentFederation/toolProtocol.js'
import { createCompilerContextWorker } from './compilerContextWorker.js'

void test('the production worker enforces endpoint authentication and fixed tool inputs before reading a model', async t => {
  const token = 'fixture-worker-token-for-acceptance-only'
  const config = { token, binding: { authorityRef: 'authority', modelRef: 'model', sourceRefs: ['source'] }, actor: 'worker',
    runtime: { python: '/deliberately-unavailable/private-python', compilerRoot: '/private-model-root', modelDirectory: '/private-model-data' } }
  const server = createCompilerContextWorker(config)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) })
  const address = server.address()
  assert(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}/mcp`
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401)
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' })).status, 401)
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'https://foreign.invalid' }, body: '{}' })).status, 403)
  assert.equal((await fetch(endpoint + '/foreign-model', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })).status, 403)
  const protocol = new ToolProtocol({ endpoint, headers: { Authorization: `Bearer ${token}` }, timeoutMs: 5000 }, AbortSignal.timeout(10000))
  try {
    await protocol.connect()
    const descriptors = await protocol.descriptors()
    assert.deepEqual(descriptors.map(item => item.tool.name), ['sudograph_context'])
    assert.equal((await protocol.call('sudograph_context', { model_ref: 'foreign', path: '/foreign-model' })).isError, true)
    const failure = await protocol.call('sudograph_context', {})
    assert.equal(failure.isError, true)
    assert.ok(!JSON.stringify(failure).includes('/private-') && !JSON.stringify(failure).includes(token))
  } finally { await protocol.close() }
})

void test('a worker cannot start with a missing or weak deployment credential', () => {
  const config = { binding: { authorityRef: 'authority', modelRef: 'model', sourceRefs: ['source'] }, actor: 'worker',
    runtime: { python: 'python', compilerRoot: '.', modelDirectory: '.' } }
  for (const token of ['', 'short', 'x'.repeat(513), 'x'.repeat(32) + '\n']) {
    assert.throws(() => createCompilerContextWorker({ ...config, token }), /deployment-owned worker token/)
  }
})
