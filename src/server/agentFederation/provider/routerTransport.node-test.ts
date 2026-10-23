import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createServer, type Server, type RequestListener } from 'node:http'
import { createServer as tlsServer } from 'node:https'
import { once } from 'node:events'
import { generateKeyPairSync } from 'node:crypto'
import forge from 'node-forge'
import { routerTransport } from './routerTransport.js'
import { routerExecutor, immutableAgent } from './runtime.js'

const init = (signal?: AbortSignal): RequestInit => ({ method: 'POST', redirect: 'error', body: '{"query":"synthetic"}', headers: { authorization: 'Bearer synthetic-key', 'content-type': 'application/json' }, signal })
const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
const cert = forge.pki.createCertificate()
cert.publicKey = forge.pki.publicKeyFromPem(pair.publicKey)
cert.serialNumber = '01'
cert.validity.notBefore = new Date(Date.now() - 60_000)
cert.validity.notAfter = new Date(Date.now() + 86400_000)
cert.setSubject([{ name: 'commonName', value: 'router.test' }]); cert.setIssuer(cert.subject.attributes)
cert.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: 'router.test' }] }])
cert.sign(forge.pki.privateKeyFromPem(pair.privateKey), forge.md.sha256.create())
const certificate = forge.pki.certificateToPem(cert)

async function listen(t: TestContext, server: Server, tls = false) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return `${tls ? 'https://router.test' : 'http://127.0.0.1'}:${(server.address() as { port: number }).port}/v1`
}
const answer: RequestListener = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '42' }, finish_reason: 'stop' }] }))
}

void test('default model executor reaches only its actual configured literal-IP endpoint', async t => {
  let calls = 0, credential = '', path = '', body = ''
  const endpoint = await listen(t, createServer((req, res) => {
    calls++; credential = req.headers.authorization ?? ''; path = req.url ?? ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => answer(req, res))
  }))
  const agent = immutableAgent({ external_agent_id: 'test', name: 'Test', system_prompt: 'Synthetic tests.', router_endpoint: endpoint, model: 'test', max_output_tokens: 64 }, `sha256:${'a'.repeat(64)}`, [endpoint])
  const result = await routerExecutor('synthetic-key')(agent, [], '6 * 7', AbortSignal.timeout(5000))
  assert.equal(result, '42'); assert.equal(calls, 1); assert.equal(credential, 'Bearer synthetic-key')
  assert.equal(path, '/v1/chat/completions'); assert.equal(JSON.parse(body).messages.at(-1).content, '6 * 7')
})

void test('fixed destination, POST, no redirects, request size and reserved headers are enforced before sending', async t => {
  let calls = 0
  const endpoint = await listen(t, createServer((req, res) => { calls++; answer(req, res) }))
  const send = routerTransport(endpoint)
  for (const [url, options] of [
    [`${endpoint}/other`, init()], [`${endpoint}/chat/completions?target=elsewhere`, init()],
    [`${endpoint}/chat/completions`, { ...init(), method: 'GET' }],
    [`${endpoint}/chat/completions`, { ...init(), redirect: 'follow' }],
    [`${endpoint}/chat/completions`, { ...init(), headers: { host: 'foreign.invalid' } }],
    [`${endpoint}/chat/completions`, { ...init(), body: 'x'.repeat(2 * 1024 * 1024 + 1) }],
  ] as [string, RequestInit][]) await assert.rejects(send(url, options), { code: 'MODEL_EGRESS_DENIED' })
  assert.equal(calls, 0)
  for (const url of ['http://router.test/v1', 'https://user:password@router.test/v1', 'https://router.test/v1?query=x', 'https://router.test/v1#fragment']) {
    assert.throws(() => routerTransport(url), { code: 'INVALID_ROUTER_ENDPOINT' })
  }
})

void test('DNS private, metadata, translated IPs, family mismatch and mixed answers fail before any request', async () => {
  const endpoint = 'https://router.test/v1'
  for (const entries of [
    [{ address: '127.0.0.1', family: 4 }], [{ address: '10.0.1.158', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }], [{ address: '100.64.0.1', family: 4 }],
    [{ address: '::ffff:7f00:1', family: 6 }], [{ address: '64:ff9b::7f00:1', family: 6 }],
    [{ address: '::1', family: 6 }], [{ address: 'fe80::1', family: 6 }], [{ address: 'fc00::1', family: 6 }],
    [{ address: '1.1.1.1', family: 6 }], [{ address: 'not-an-ip', family: 4 }], [],
    [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }],
  ]) {
    const send = routerTransport(endpoint, {}, { resolve: async () => entries })
    await assert.rejects(send(`${endpoint}/chat/completions`, init()), { code: 'MODEL_EGRESS_DENIED' })
  }
  for (const ip of ['169.254.169.254', '0.0.0.0', '224.0.0.1', '::', '::ffff:127.0.0.1', 'fe80::1']) {
    assert.throws(() => routerTransport(endpoint, { allowedAddresses: [ip] }), { code: 'INVALID_ROUTER_NETWORK_POLICY' })
  }
  for (const pins of [[], ['hostname.invalid'], ['*'], ['10.0.0.0/8'], ['fe80::1%en0']]) {
    assert.throws(() => routerTransport(endpoint, { allowedAddresses: pins }), { code: 'INVALID_ROUTER_NETWORK_POLICY' })
  }
})

void test('TLS connects to the checked address, preserves hostname, rechecks DNS per dispatch and copies policy pins', async t => {
  let calls = 0, resolutions = 0, host = '', sni = ''
  const server = tlsServer({ cert: certificate, key: pair.privateKey }, (req, res) => { calls++; host = req.headers.host ?? ''; answer(req, res) })
  server.on('secureConnection', socket => { sni = socket.servername || '' })
  const endpoint = await listen(t, server, true)
  const pins = ['127.0.0.1']
  const send = routerTransport(endpoint, { allowedAddresses: pins }, { ca: certificate, resolve: async name => {
    assert.equal(name, 'router.test'); resolutions++
    return [{ address: resolutions === 1 ? '127.0.0.1' : '10.0.1.158', family: 4 }]
  } })
  pins.push('10.0.1.158')
  assert.equal((await send(`${endpoint}/chat/completions`, init())).status, 200)
  await assert.rejects(send(`${endpoint}/chat/completions`, init()), { code: 'MODEL_EGRESS_DENIED' })
  assert.equal(calls, 1); assert.equal(resolutions, 2); assert.equal(host, new URL(endpoint).host); assert.equal(sni, 'router.test')
})

void test('invalid TLS trust or hostname cannot deliver credentials or request content', async t => {
  let requests = 0
  const endpoint = await listen(t, tlsServer({ cert: certificate, key: pair.privateKey }, (req, res) => { requests++; answer(req, res) }), true)
  const resolve = async () => [{ address: '127.0.0.1', family: 4 }]
  await assert.rejects(routerTransport(endpoint, { allowedAddresses: ['127.0.0.1'] }, { resolve })(`${endpoint}/chat/completions`, init()), { code: 'MODEL_EXECUTION_UNCONFIRMED' })
  const foreign = endpoint.replace('router.test', 'wrong.test')
  await assert.rejects(routerTransport(foreign, { allowedAddresses: ['127.0.0.1'] }, { resolve, ca: certificate })(`${foreign}/chat/completions`, init()), { code: 'MODEL_EXECUTION_UNCONFIRMED' })
  assert.equal(requests, 0)
})

void test('redirects never forward credentials or resubmit; original delivery stays uncertain', async t => {
  let source = 0, redirected = 0
  const other = await listen(t, createServer((req, res) => { redirected++; answer(req, res) }))
  const endpoint = await listen(t, createServer((_req, res) => { source++; res.writeHead(307, { location: `${other}/chat/completions` }); res.end() }))
  await assert.rejects(routerTransport(endpoint)(`${endpoint}/chat/completions`, init()), { code: 'MODEL_EXECUTION_UNCONFIRMED' })
  assert.equal(source, 1); assert.equal(redirected, 0)
})

void test('DNS errors and cancelled resolution cannot leak diagnostics or issue HTTP', async () => {
  const endpoint = 'https://router.test/v1'
  const failed = routerTransport(endpoint, {}, { resolve: async () => { throw new Error('private DNS details / synthetic-key') } })
  await assert.rejects(failed(`${endpoint}/chat/completions`, init()), { code: 'MODEL_EGRESS_UNAVAILABLE', message: 'MODEL_EGRESS_UNAVAILABLE' })
  const controller = new AbortController()
  const waiting = routerTransport(endpoint, {}, { resolve: () => new Promise(() => {}) })(`${endpoint}/chat/completions`, init(controller.signal))
  controller.abort()
  await assert.rejects(waiting, { code: 'MODEL_EGRESS_UNAVAILABLE' })
})

void test('bounded responses and upstream errors do not expose upstream diagnostic bodies', async t => {
  for (const [status, payload, expected] of [[401, 'private diagnostic', null], [200, 'x'.repeat(2 * 1024 * 1024 + 1), 'MODEL_OUTPUT_INVALID']] as const) {
    const endpoint = await listen(t, createServer((_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(payload) }))
    const result = routerTransport(endpoint)(`${endpoint}/chat/completions`, init())
    if (expected) await assert.rejects(result, { code: expected })
    else { const response = await result; assert.equal(response.status, 401); assert.equal(await response.text(), '') }
  }
})
