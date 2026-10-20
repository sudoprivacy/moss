// Real isolated kernel + built Provider acceptance. No production service is modified.
// NEXUS_MODEL_TEST_BIN and HTTP_AGENT_TEST_ARTIFACT must name existing binaries.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { mkdtemp, readFile, writeFile, mkdir, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'

const binary = resolve(process.env.NEXUS_MODEL_TEST_BIN || 'missing-binary')
const artifact = resolve(process.env.HTTP_AGENT_TEST_ARTIFACT || 'missing-artifact')
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const evidence = { kernel_sha256: await digest(binary), provider_sha256: await digest(artifact), scope: 'synthetic loopback; lab node identity; no end-user delegation or network sandbox claim', cases: [] }
const root = await mkdtemp(join(tmpdir(), 'http-agent-nexus-live-'))
const proto = resolve('node_modules/@nexus-ai-fs/vfs-client/proto')
const definition = protoLoader.loadSync(join(proto, 'nexus/grpc/vfs/vfs.proto'), { keepCase: true, longs: String, defaults: true, includeDirs: [proto] })
const api = grpc.loadPackageDefinition(definition)
const sensitive = '11010519491231002X' // Published synthetic GB 11643 specimen, not a person.
const token = randomBytes(32).toString('hex')

async function port() {
  const server = tcpServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const n = server.address().port; await new Promise(resolve => server.close(resolve)); return n
}
async function until(action, child, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error('owned process exited before readiness')
    try { const value = await action(); if (value) return value } catch {}
    await delay(100)
  }
  throw new Error('acceptance deadline exceeded')
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode) return
  const exited = once(child, 'exit'); child.kill('SIGTERM')
  let timer
  try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000) })]); await exited }
  finally { clearTimeout(timer) }
}

for (const mode of ['deny', 'redact', 'outage']) {
  const work = join(root, mode); await mkdir(work)
  const calls = []
  const model = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      calls.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '42' }, finish_reason: 'stop' }] }))
    })
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelUrl = `http://127.0.0.1:${model.address().port}/v1`
  const kernelPort = await port(), providerPort = await port()
  const kernelLog = await open(join(work, 'kernel.log'), 'w', 0o600), providerLog = await open(join(work, 'provider.log'), 'w', 0o600)
  let kernel, provider, vfs
  try {
    const env = { ...process.env, NEXUS_DATA_DIR: join(work, 'data'), NEXUS_IDENTITY_DIR: join(work, 'identity'), NEXUS_EGRESS_GATE_MODEL_MOUNTS: '/cloud-model', NEXUS_EGRESS_GATE_POLICY: mode === 'deny' ? 'deny' : 'redact' }
    // Refuse to inherit a weakened diagnostic mode or an unrelated analyzer.
    for (const key of Object.keys(env)) if (key.startsWith('NEXUS_EGRESS_GATE_') && !['NEXUS_EGRESS_GATE_MODEL_MOUNTS', 'NEXUS_EGRESS_GATE_POLICY'].includes(key)) delete env[key]
    delete env.NEXUS_NO_TLS; delete env.NEXUS_INSECURE_NO_AUTH
    if (mode === 'outage') { env.NEXUS_EGRESS_GATE_PRESIDIO_URL = `http://127.0.0.1:${await port()}`; env.NEXUS_EGRESS_GATE_PRESIDIO_TIMEOUT_MS = '250' }
    kernel = spawn(binary, ['--cluster-init', `agent-test-${mode}`, '--hostname', 'localhost', '--bind-addr', `127.0.0.1:${kernelPort}`, '--advertise-addr', `127.0.0.1:${kernelPort}`], { env, stdio: ['ignore', kernelLog.fd, kernelLog.fd] })
    const tlsDir = join(work, 'data/tls')
    await until(async () => (await readFile(join(tlsDir, 'node.pem'))).length, kernel)
    const tls = { ca: join(tlsDir, 'ca.pem'), cert: join(tlsDir, 'node.pem'), key: join(tlsDir, 'node-key.pem'), serverName: 'nexus-node' }
    vfs = new api.nexus.grpc.vfs.NexusVFSService(`127.0.0.1:${kernelPort}`, grpc.credentials.createSsl(await readFile(tls.ca), await readFile(tls.key), await readFile(tls.cert)), { 'grpc.ssl_target_name_override': 'nexus-node', 'grpc.default_authority': 'nexus-node' })
    const rpc = (method, input) => new Promise((resolve, reject) => vfs[method](input, { deadline: Date.now() + (method === 'Ping' ? 1000 : 15000) }, (error, result) => error || result.is_error ? reject(new Error(`${method}: ${error?.code ?? result?.error_payload?.toString() ?? 'RPC refused'}`)) : resolve(result)))
    const info = await until(() => rpc('Ping', {}), kernel)
    assert(info.zone_id, 'kernel must report its existing zone')
    // Administrative Setattr is only in the fixture, never in Provider execution.
    await rpc('Setattr', { path: '/cloud-model', entry_type: 2, backend_type: 'openai', backend_name: 'test-model', zone_id: info.zone_id, backend_params: { base_url: modelUrl, api_key: 'synthetic-model-key', blob_root: join(work, 'blobs') } })
    const endpoint = `https://127.0.0.1:${kernelPort}`
    const config = { host: '127.0.0.1', port: providerPort, database_file: join(work, 'provider.sqlite'), nexus_model: { endpoint, model_mounts: ['/cloud-model'], tls }, clients: [{ id: 'client', token_file: join(work, 'client.token'), agent_ids: ['test-agent'] }], definitions: [{ external_agent_id: 'test-agent', name: 'Test agent', system_prompt: 'Answer synthetic tests.', nexus_endpoint: endpoint, model_mount: '/cloud-model', model: 'synthetic-model', max_output_tokens: 64 }] }
    await writeFile(join(work, 'client.token'), token, { mode: 0o600 })
    await writeFile(join(work, 'provider.json'), JSON.stringify(config), { mode: 0o600 })
    const start = () => spawn(process.execPath, [artifact, join(work, 'provider.json')], { stdio: ['ignore', providerLog.fd, providerLog.fd] })
    provider = start()
    const base = `http://127.0.0.1:${providerPort}`
    const http = async (path, body) => {
      const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(2000) })
      assert(r.ok, `provider HTTP status ${r.status}`); return r.json()
    }
    await until(() => http('/healthz'), provider)
    const manifest = await http('/v1/agents/test-agent/manifest')
    const inputs = []
    for (const [name, query] of [['clean', '6 * 7'], ['sensitive', `Synthetic ID ${sensitive}. Reply 42.`]]) {
      const input = { api_version: 'agent-http.sudo.dev/v1alpha2', kind: 'SubmitAgentRun', invocation_id: name, external_agent_id: 'test-agent', execution_revision: manifest.execution_revision, query, provider_session_id: null, end_user: 'synthetic-user', deadline_at: Date.now() + 30000 }
      // Read the protocol from the manifest rather than duplicating a spelling.
      input.api_version = manifest.protocol
      inputs.push(input); await http('/v1/runs', input)
      const run = await until(async () => { const value = await http(`/v1/runs/${name}`); return ['succeeded', 'failed', 'unknown'].includes(value.status) ? value : null }, provider)
      const allowed = mode === 'redact' || (mode === 'deny' && name === 'clean')
      assert.equal(run.status, allowed ? 'succeeded' : 'unknown')
      if (allowed) assert.equal(run.output.text, '42')
      else assert.equal(run.error_code, 'MODEL_EXECUTION_UNCONFIRMED')
      evidence.cases.push({ mode, input: name, status: run.status, upstream_requests: calls.length })
    }
    assert.equal(calls.length, mode === 'deny' ? 1 : mode === 'redact' ? 2 : 0)
    assert(calls.every(c => c.path === '/v1/chat/completions' && c.authorization === 'Bearer synthetic-model-key' && !JSON.stringify(c.body).includes(sensitive)))
    await stop(provider)
    const db = new DatabaseSync(config.database_file, { readOnly: true })
    try {
      const saved = db.prepare('SELECT request FROM http_agent_runs WHERE invocation_id = ?').get('sensitive')
      assert.equal(JSON.parse(saved.request).query, inputs[1].query)
      evidence.cases.push({ mode, original_local_query_preserved: true })
    } finally { db.close() }
    provider = start(); await until(() => http('/healthz'), provider)
    for (const input of inputs) await http('/v1/runs', input)
    await delay(400)
    assert.equal(calls.length, mode === 'deny' ? 1 : mode === 'redact' ? 2 : 0)
    evidence.cases.push({ mode, restart_replay: 'no additional model writes' })
    console.log(JSON.stringify({ mode, result: 'passed', upstream_requests: calls.length }))
  } finally {
    vfs?.close(); await stop(provider); await stop(kernel)
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve))
    await kernelLog.close(); await providerLog.close()
    // Retain diagnostics and synthetic database; discard even lab private keys/tokens.
    await rm(join(work, 'data/tls'), { recursive: true, force: true }); await rm(join(work, 'client.token'), { force: true })
  }
}
await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2))
console.log(JSON.stringify({ evidence: join(root, 'evidence.json') }))
