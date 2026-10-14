import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import schema from '../../../contracts/agent-federation/v1alpha1/schema.json' with { type: 'json' }
import { AGENT_FEDERATION_API, AGENT_HTTP_API, type CustomAgentManifest, type ProviderObservation } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import { ProviderAdapterRegistry, type ProviderInvocation } from './adapter.js'
import { CustomHttpAdapter, MAX_HTTP_RESPONSE_BYTES, type ProviderRequest } from './customHttpAdapter.js'
import { DifyGatewayAdapter } from './difyAdapter.js'
import { HTTP_CAPABILITIES, customManifestDigest, parseCustomManifest } from './manifest.js'
import { DifyPilotTransport } from '../externalProviders/difyTransport.js'

function manifest(): CustomAgentManifest {
  return { api_version: AGENT_FEDERATION_API, kind: 'CustomAgentManifest', provider_kind: 'custom_http', external_agent_id: 'helper', name: 'Protocol test agent', source_revision: 'revision-1', protocol: AGENT_HTTP_API, execution_mode: 'external_hosted', input_profile: 'query_only_v1', output_profile: 'text_v1', capabilities: { ...HTTP_CAPABILITIES } }
}
function input(source = manifest()): ProviderInvocation {
  return { task_id: 'sudo-task', attempt_id: 'sudo-attempt', session_id: 'sudo-session', binding_id: 'binding', external_agent_id: source.external_agent_id, source_digest: customManifestDigest(source), endpoint: 'http://127.0.0.1:18123/v1', org_id: 'org', policy: { orgIds: ['org'], endpoints: ['http://127.0.0.1:18123/v1'], timeoutMs: 5000 }, key: 'synthetic-key', query: 'six times seven', end_user: 'opaque-user', provider_session_id: null, signal: AbortSignal.timeout(5000), authorize_dispatch: async () => {} }
}
function result() {
  return { api_version: AGENT_HTTP_API, kind: 'AgentResult', invocation_id: 'sudo-attempt', provider_run_id: 'remote-run', provider_session_id: 'remote-session', status: 'succeeded', output: { text: '42' } }
}
function adapter(request: ProviderRequest) {
  const source = manifest()
  return new CustomHttpAdapter({ manifest: source, digest: customManifestDigest(source) }, request)
}
const ajv = new Ajv2020({ strict: true })
ajv.addSchema(schema)
function conforms(name: string, value: unknown) {
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` })
  assert.equal(validate(value), true, JSON.stringify(validate.errors))
}

void test('manifest is bounded, strict, inert and rejects unimplemented capabilities', () => {
  const source = manifest()
  assert.deepEqual(parseCustomManifest(JSON.stringify(source)), source)
  const reversed = Object.fromEntries(Object.entries(source).reverse()) as unknown as CustomAgentManifest
  assert.equal(customManifestDigest(source), customManifestDigest(reversed))
  for (const patch of [{ api_version: 'agent-federation.sudo.dev/v1' }, { endpoint: 'http://169.254.169.254/v1' }, { api_key: 'synthetic' }, { tools: [] }, { input_profile: 'files' }, { external_agent_id: '../escape' }, { capabilities: {} }, { protocol: 'openai' }]) {
    assert.throws(() => parseCustomManifest(JSON.stringify({ ...source, ...patch })), { code: 'INVALID_CUSTOM_MANIFEST' })
  }
  for (const capability of Object.keys(HTTP_CAPABILITIES)) {
    assert.throws(() => parseCustomManifest(JSON.stringify({ ...source, capabilities: { ...source.capabilities, [capability]: true } })), { code: 'UNSUPPORTED_PROVIDER_CAPABILITY' })
  }
  assert.throws(() => parseCustomManifest(' '.repeat(65537)), { code: 'INVALID_CUSTOM_MANIFEST' })
  assert.throws(() => new CustomHttpAdapter({ manifest: source, digest: `sha256:${'0'.repeat(64)}` }), { code: 'MANIFEST_DIGEST_MISMATCH' })
})

void test('HTTP profile uses actual HTTP, independent remote IDs, one final event and canonical envelopes', async t => {
  const requests: { path: string; body?: unknown }[] = []
  let authorized = false
  const server = createServer((req, res) => {
    void (async () => {
      assert.equal(req.headers.authorization, 'Bearer synthetic-key')
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/v1/agents/helper/manifest') {
        requests.push({ path: req.url }); res.end(JSON.stringify(manifest())); return
      }
      assert.equal(authorized, true)
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      conforms('InvokeHttpAgent', body)
      requests.push({ path: req.url!, body })
      res.end(JSON.stringify(result()))
    })().catch(error => { res.statusCode = 500; res.end(); t.assert.fail(String(error)) })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const request = { ...input(), endpoint, policy: { orgIds: ['org'], endpoints: [endpoint], timeoutMs: 5000 }, authorize_dispatch: async () => { authorized = true } }
  const events: ProviderObservation[] = []
  const output = await adapter(fetch).invoke(request, async event => { events.push(event) })
  assert.equal(output.text, '42'); assert.equal(events.length, 1); assert.equal(events[0].type, 'result')
  conforms('ProviderObservation', events[0]); conforms('ExternalRunBinding', output.binding)
  assert.equal(output.binding.task_id, 'sudo-task'); assert.equal(output.binding.provider_run_id, 'remote-run')
  assert.equal(output.binding.session_id, 'sudo-session'); assert.equal(output.binding.provider_session_id, 'remote-session')
  assert.equal(output.binding.version_evidence, 'source_snapshot_only')
  assert.deepEqual(requests.map(value => value.path), ['/v1/agents/helper/manifest', '/v1/invoke'])
  assert.equal(JSON.stringify(requests).includes('synthetic-key'), false)
  assert.equal(JSON.stringify(requests).includes('org_id'), false)
})

void test('changed source or denied dispatch never invokes the remote agent', async () => {
  for (const change of ['manifest', 'gate']) {
    let requests = 0, gates = 0
    const transport = adapter(async () => { requests++; return Response.json({ ...manifest(), ...(change === 'manifest' ? { source_revision: 'revision-2' } : {}) }) })
    await assert.rejects(transport.invoke({ ...input(), authorize_dispatch: async () => { gates++; throw new Error('revoked') } }, async () => {}), change === 'manifest' ? { code: 'PROVIDER_SOURCE_CHANGED' } : { message: 'revoked' })
    assert.equal(requests, 1); assert.equal(gates, change === 'manifest' ? 0 : 1)
  }
})

void test('endpoint policy, identity shape and cancellation are checked before network access', async () => {
  let calls = 0
  const transport = adapter(async () => { calls++; throw new Error('must not request') })
  for (const patch of [{ endpoint: 'http://127.0.0.2/v1' }, { endpoint: 'http://localhost/v1' }, { endpoint: 'http://u:p@127.0.0.1/v1' }, { org_id: 'foreign' }, { attempt_id: '../attempt' }, { signal: AbortSignal.abort() }]) {
    await assert.rejects(transport.invoke({ ...input(), ...patch }, async () => {}))
  }
  assert.equal(calls, 0)
})

void test('foreign invocation, swapped session, missing run and unsupported result fields fail closed', async () => {
  for (const patch of [{ invocation_id: 'other' }, { provider_run_id: '' }, { provider_run_id: undefined }, { api_version: 'agent-http.sudo.dev/v99' }, { credential: 'synthetic' }, { status: 'cancelled' }]) {
    let calls = 0
    await assert.rejects(adapter(async () => Response.json(++calls === 1 ? manifest() : { ...result(), ...patch })).invoke(input(), async () => {}), { code: 'INVALID_PROVIDER_RESULT' })
    assert.equal(calls, 2)
  }
  let calls = 0
  await assert.rejects(adapter(async () => Response.json(++calls === 1 ? manifest() : result())).invoke({ ...input(), provider_session_id: 'previous-remote-session' }, async () => {}), { code: 'PROVIDER_SESSION_CHANGED' })
})

void test('ambiguous HTTP failures never retry or expose the provider error body', async () => {
  let calls = 0, events = 0
  await assert.rejects(adapter(async () => ++calls === 1 ? Response.json(manifest()) : new Response('sensitive provider body', { status: 500 })).invoke(input(), async () => { events++ }), error => {
    assert.equal((error as { code: string }).code, 'EXECUTION_UNCONFIRMED')
    assert.equal(String(error).includes('sensitive'), false); return true
  })
  assert.equal(calls, 2); assert.equal(events, 0)
})

void test('raw UTF-8 response budget cancels without accumulating an unbounded JSON body', async () => {
  let calls = 0, chunks = 0, cancelled = false
  const chunk = new TextEncoder().encode('汉'.repeat(20000))
  const transport = adapter(async () => ++calls === 1 ? Response.json(manifest()) : new Response(new ReadableStream({
    pull(controller) { chunks++; controller.enqueue(chunk) }, cancel() { cancelled = true },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } }))
  await assert.rejects(transport.invoke(input(), async () => {}), { code: 'PROVIDER_RESPONSE_LIMIT' })
  assert.equal(chunks, Math.floor(MAX_HTTP_RESPONSE_BYTES / chunk.byteLength) + 1); assert.equal(cancelled, true)
})

void test('Dify and custom HTTP share observation/binding schema without inventing capabilities', async () => {
  const parameters = { user_input_form: [], file_upload: { enabled: false } }
  const stream = [
    { event: 'workflow_started', task_id: 'dify-task', workflow_run_id: 'dify-run', conversation_id: 'dify-session' },
    { event: 'message', answer: '42', message_id: 'dify-message' },
    { event: 'workflow_finished', data: { status: 'succeeded' } }, { event: 'message_end' },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
  const transport = new DifyPilotTransport((async url => String(url).endsWith('/parameters') ? Response.json(parameters) : new Response(stream, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch)
  const fingerprint = await transport.parameters(input().endpoint, 'synthetic', input().signal)
  const dify = new DifyGatewayAdapter(fingerprint, transport)
  const registry = new ProviderAdapterRegistry([dify, adapter(fetch)])
  assert.throws(() => registry.get('langgraph'), { code: 'PROVIDER_NOT_IMPLEMENTED' })
  assert.throws(() => new ProviderAdapterRegistry([dify, dify]), /Duplicate/)
  const events: ProviderObservation[] = []
  const output = await registry.get('dify').invoke(input(), async event => { events.push(event) })
  assert.equal(output.text, '42'); assert.equal(output.binding.provider_run_id, 'dify-run')
  conforms('ExternalRunBinding', output.binding)
  for (const [index, event] of events.entries()) { conforms('ProviderObservation', event); assert.equal(event.sequence, index + 1) }
  assert.equal(events.at(-1)?.status, 'succeeded')
  assert.equal(dify.capabilities.supports_streaming, true)
  assert.equal(dify.capabilities.supports_version_pin, false)
  assert.equal(registry.get('custom_http').capabilities.supports_streaming, false)
})
