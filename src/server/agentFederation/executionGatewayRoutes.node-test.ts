import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { dispatchModelInvocation, modelInvocationResult, modelInvocationRoute, readExecutionJson } from './executionGatewayRoutes.js'
import type { ExecutionModelCall } from './executionModelGateway.js'
import { ExternalProviderError } from '../externalProviders/policy.js'

function call(): ExecutionModelCall {
  return { id: 'call-record', callId: 'client-call', taskId: 'task', status: 'completed', answer: '42', error: undefined,
    grantExpiresAt: Date.now() + 60000, routerAuthorityId: 'sha256:' + 'a'.repeat(64), ledgerStatus: 'router_verified', consumption: [{ id: 1 }],
    routerToken: { key: 'forbidden-router-key' }, orgId: 'private-org', ownerUserId: 'private-owner', specDigest: 'private-spec' } as unknown as ExecutionModelCall
}
void test('execution HTTP: result projection excludes internal credentials, attribution and ledger; stale requests stay unknown', () => {
  const current = call(), result = modelInvocationResult(current)
  assert.deepEqual(result, { kind: 'ModelInvocationResult', call_id: 'client-call', task_id: 'task', model_call_id: 'call-record',
    status: 'completed', output: { text: '42' }, usage_status: 'router_verified' })
  assert.doesNotMatch(JSON.stringify(result), /forbidden|private-|routerToken|consumption/)
  current.status = 'dispatching'; current.grantExpiresAt = 1
  assert.equal(modelInvocationResult(current).status, 'unknown')
  assert.equal('output' in modelInvocationResult(current), false)
  assert.equal(current.status, 'dispatching', 'GET/replay projection never mutates execution facts')
  delete current.routerAuthorityId
  assert.equal(modelInvocationResult(current).usage_status, 'pending')
})
void test('execution HTTP: exact task bearer and selected organization pass to IAM-backed gateway; no automatic retry', async () => {
  let calls = 0
  const gateway = { invoke: async (org: string, body: unknown, token: string, signal?: AbortSignal) => {
    calls++; assert.equal(org, 'org-a'); assert.deepEqual(body, { task_id: 'task' }); assert.equal(token, 'short-lived-iam'); assert.ok(signal)
    return call()
  } }
  const result = await dispatchModelInvocation(gateway, 'org-a', { task_id: 'task' }, 'short-lived-iam', new AbortController().signal)
  assert.equal(result.status, 'completed'); assert.equal(calls, 1)
  await assert.rejects(dispatchModelInvocation(gateway, 'org-a', {}, ''), { code: 'EXECUTION_TOKEN_INVALID' }); assert.equal(calls, 1)
  await assert.rejects(dispatchModelInvocation(undefined, 'org-a', {}, 'x'), { code: 'MODEL_GATEWAY_NOT_CONFIGURED' })
  const rejected = { invoke: async () => { throw new ExternalProviderError(401, 'EXECUTION_INACTIVE') } }
  await assert.rejects(dispatchModelInvocation(rejected, 'org-a', {}, 'browser-jwt'), { code: 'EXECUTION_INACTIVE' })
  assert.equal(modelInvocationRoute.exec('/api/v1/agent-models/org-a/invoke')?.[1], 'org-a')
  assert.equal(modelInvocationRoute.test('/api/v1/agent-models/org-a/invoke/extra'), false)
})
function request(contentType = 'application/json', length?: string) {
  const stream = new PassThrough() as PassThrough & { headers: IncomingMessage['headers'] }
  stream.headers = { 'content-type': contentType, ...(length ? { 'content-length': length } : {}) }
  return stream as unknown as IncomingMessage & PassThrough
}
void test('execution HTTP: streamed body is bounded before parsing, including absent/false Content-Length and UTF-8', async () => {
  const good = request('application/json; charset=utf-8'), parsed = readExecutionJson(good, 30)
  good.end(Buffer.from('{"query":"算术"}')); assert.deepEqual(await parsed, { query: '算术' })
  for (const length of [undefined, '1']) {
    const stream = request('application/json', length), result = readExecutionJson(stream, 5)
    stream.write(Buffer.from('1234')); stream.end(Buffer.from('56'))
    await assert.rejects(result, { code: 'EXECUTION_BODY_TOO_LARGE' })
  }
  await assert.rejects(readExecutionJson(request('application/json', '999'), 5), { code: 'EXECUTION_BODY_TOO_LARGE' })
  await assert.rejects(readExecutionJson(request('text/plain'), 30), { code: 'EXECUTION_JSON_REQUIRED' })
  const encoded = request(); encoded.headers['content-encoding'] = 'gzip'
  await assert.rejects(readExecutionJson(encoded, 30), { code: 'EXECUTION_JSON_REQUIRED' })
  for (const bytes of [Buffer.from('[]'), Buffer.from('null'), Buffer.from([0xff]), Buffer.from('{')]) {
    const stream = request(), result = readExecutionJson(stream, 30); stream.end(bytes)
    await assert.rejects(result, { code: 'INVALID_EXECUTION_JSON' })
  }
})
void test('execution HTTP: actual server responds to a rejected chunked upload without dispatching a model', async t => {
  let accepted = 0
  const server = createServer(async (req, res) => {
    try { await readExecutionJson(req, 40); accepted++; res.writeHead(200).end('{}') }
    catch (e) { res.writeHead(e instanceof ExternalProviderError ? e.status : 500).end('{}') }
  }).listen(0, '127.0.0.1')
  await once(server, 'listening'); t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const payload = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"query":"' + 'x'.repeat(200) + '"}')); controller.close() } })
  const response = await fetch(`http://127.0.0.1:${address.port}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, duplex: 'half' } as RequestInit)
  assert.equal(response.status, 413); await response.text(); assert.equal(accepted, 0)
})
