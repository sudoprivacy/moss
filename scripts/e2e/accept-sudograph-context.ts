/** Explicit installed-compiler / real-engine acceptance through Moss's ACP bridge.
 * No production login, tenant grant, Nexus mailbox or provider reasoning is claimed.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { SudographModelClient } from '@sudowork/sudograph-runtime'
import { McpStore } from '../../src/server/mcp/db.js'
import { ReviewedMcpAccess, mcpServerDigest } from '../../src/server/mcp/reviewedAccess.js'
import { ToolGatewayStore } from '../../src/server/agentFederation/toolGatewayStore.js'
import { createCompilerContextWorker } from '../../src/server/ontology/compilerContextWorker.js'
import { McpOntologyContextPorts } from '../../src/server/ontology/mcpContextPorts.js'
import { createSessionRunnerHost } from '../../src/server/ontology/runnerHost.js'
import { AuthCenterDb } from '../../src/server/authCenter/db.js'
import { currentMcpMember } from '../../src/server/mcp/currentMember.js'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createAcpBridgeHandle } from '../../src/server/backends/acpBridge.js'
import { DirectConnectStore } from '../../src/server/db.js'

const { values } = parseArgs({ options: {
  engine: { type: 'string' }, 'engine-sha256': { type: 'string' },
  python: { type: 'string' }, evidence: { type: 'string' }, worker: { type: 'string' },
} })
assert(values.engine && values['engine-sha256'] && values.python && values.evidence,
  'Supply --engine, --engine-sha256, --python (installed compiler) and --evidence')
const engine = resolve(values.engine)
const python = resolve(values.python)
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
assert.equal(hash(await readFile(engine)), values['engine-sha256'].toLowerCase(), 'Pinned engine checksum differs')
await mkdir(resolve(values.evidence), { recursive: true })
const root = await mkdtemp(join(resolve(values.evidence), 'moss-context-'))
const workspace = join(root, 'workspace'), profile = join(root, 'profile'), config = join(root, 'config')
await Promise.all([workspace, profile, config].map(path => mkdir(path)))
const source = join(root, 'source.sqlite'), modelRef = 'fixture-model', actor = 'fixture-moss-host'
const runtime = { python, compilerRoot: root, modelDirectory: root }
const modelClient = new SudographModelClient(runtime)
console.log(`Acceptance evidence: ${root}`)

function runPython(args: string[], input?: unknown): string {
  const process = spawnSync(python, ['-I', '-X', 'utf8', ...args], { cwd: root,
    input: input === undefined ? undefined : JSON.stringify(input) + '\n',
    encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
  })
  assert(!process.error, String(process.error))
  assert.equal(process.status, 0, process.stderr)
  return process.stdout
}
const compiler = JSON.parse(runPython(['-c', `
import compiler, json
from importlib.metadata import distribution
from pathlib import Path
from compiler.managed import code_digest
package = distribution('sudograph-compiler')
assert Path(compiler.__file__).resolve() == package.locate_file('compiler/__init__.py').resolve()
print(json.dumps({'version':package.version, 'digest':code_digest()}))
`]))
runPython(['-c', `
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    db.executescript('CREATE TABLE Tickets(id INTEGER PRIMARY KEY, amount REAL); INSERT INTO Tickets VALUES (1,7),(2,NULL);')
`, source])
const sourceBefore = hash(await readFile(source))
const registered = await modelClient.registerSource(modelRef, actor, { source: 'sqlite:///' + source.replaceAll('\\', '/'),
  namespace: 'support', operationId: 'source', language: 'en' })
assert.equal(registered.registration.scan.structure_complete, true)
const definition = { concept: 'revenue', category: 'meaning', role: 'business',
  purpose: { stakeholder: 'Support manager', decision: 'Choose revenue policy' },
  label: 'Revenue policy', statement: 'CONTEXT_A_USE_ORDER_DATE', origin: 'inferred',
  contributor: 'model', version: 1, targets: [] }
const model = { format: 'sudograph-business-overlay/v5', namespace: 'support',
  baseline: registered.contract.baseline, definitions: { revenue: definition } }
async function apply(operation: string): Promise<any> {
  const contract = await modelClient.invoke<any>(modelRef, actor, { operation: 'contract' })
  return modelClient.invoke<any>(modelRef, actor, { operation: 'apply', request: {
    base_revision: contract.revision, operation_id: operation, model: JSON.stringify(model),
  } })
}
await apply('revision-a')
const contexts: any[] = [], requests: any[] = [], output: any[] = [], diagnostics: string[] = []
let hostStore = new DirectConnectStore(join(root, 'host.db'))
const auth = new AuthCenterDb(hostStore)
await auth.createOrganization('fixture-org', 'Fixture organization', Date.now())
await auth.createUser({ id: 'fixture-user', orgId: 'fixture-org', name: 'fixture-user', email: 'fixture@example.invalid',
  displayName: null, departmentId: null, role: 'user', status: 'active', localAuth: false, tokenLimit: null,
  createdAt: Date.now(), passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null })
await hostStore.driver.run(`INSERT INTO sessions
  (session_id, transcript_session_id, org_id, user_id, role, scopes_json, cwd,
   runtime_type, status, desired_state, transcript_path, created_at, last_active_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
['fixture-moss-session', 'fixture-native-history', 'fixture-org', 'fixture-user', 'user', '[]', workspace,
  'cohost', 'active', 'active', join(root, 'transcript.jsonl'), Date.now(), Date.now()])
// The registered worker is a separate authenticated MCP endpoint, not a host path.
const modelIdentity = { authorityRef: 'canonical-fixture', modelRef, sourceRefs: ['registered-fixture-source'] }
const workerToken = 'fixture-worker-token-for-acceptance-only'
let workerServer: ReturnType<typeof createCompilerContextWorker> | undefined
let stopWorker: () => Promise<void>
let workerPort: number
if (values.worker) {
  const path = join(root, 'worker-deployment.json')
  await writeFile(path, JSON.stringify({ binding: modelIdentity, runtime, actor, host: '127.0.0.1', port: 0 }))
  const child = spawn(process.execPath, [resolve(values.worker), path], {
    env: { ...process.env, SUDOGRAPH_WORKER_TOKEN: workerToken }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.stderr.on('data', chunk => diagnostics.push(String(chunk)))
  workerPort = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged compiler worker did not become ready')) }, 10000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Packaged compiler worker exited before readiness')) })
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      if (!buffer.includes('\n')) return
      clearTimeout(timer)
      try {
        const ready = JSON.parse(buffer.split('\n')[0])
        assert.equal(ready.format, 'sudograph-worker-ready/v1')
        assert(Number.isSafeInteger(ready.port) && ready.port > 0 && ready.port <= 65535)
        resolve(ready.port)
      } catch (error) { child.kill(); reject(error) }
    })
  })
  stopWorker = async () => { child.kill(); await exited }
} else {
  workerServer = createCompilerContextWorker({ binding: modelIdentity, runtime, actor, token: workerToken })
  await new Promise<void>(resolve => workerServer!.listen(0, '127.0.0.1', resolve))
  const address = workerServer.address()
  assert(address && typeof address !== 'string')
  workerPort = address.port
  stopWorker = async () => { workerServer!.closeAllConnections(); await new Promise<void>(resolve => workerServer!.close(() => resolve())) }
}
const mcpStore = new McpStore(hostStore.driver)
const registeredWorker = await mcpStore.createMcpServer('fixture-org', { name: 'Compiler worker', scope: 'org', owner_type: 'system', owner_id: 'fixture-org',
  mcp_type: 'http', url: `http://127.0.0.1:${workerPort}/mcp`, auth_type: 'bearer',
  auth_config_json: JSON.stringify({ header_name: 'Authorization', prefix: 'Bearer', token: workerToken }),
  allow_read: true, allow_read_sensitive_fields: true, allow_write: false }, 'fixture-manager')
await mcpStore.setMcpServerStatus('fixture-org', registeredWorker.id, 'enabled', 'fixture-manager')
await mcpStore.upsertMcpPolicy('fixture-org', { allow_http_sse_mcp: true, allow_external_network: true, domain_whitelist_json: ['127.0.0.1'] }, 'fixture-manager')
const reviews = new ToolGatewayStore(hostStore.driver)
function accessFor(currentStore: DirectConnectStore) {
  return new ReviewedMcpAccess(new ToolGatewayStore(currentStore.driver), { mcp: new McpStore(currentStore.driver),
    member: currentMcpMember(new AuthCenterDb(currentStore)),
  })
}
const access = accessFor(hostStore)
const protocol = access.protocol((await access.connection('fixture-org', registeredWorker.id)).config, AbortSignal.timeout(10000))
let descriptor
try { await protocol.connect(); descriptor = (await protocol.descriptors())[0] } finally { await protocol.close() }
assert(descriptor)
await reviews.saveReview({ ...descriptor, orgId: 'fixture-org', serverId: registeredWorker.id,
  resource: `mcp:${registeredWorker.id}/sudograph_context`, serverDigest: mcpServerDigest(registeredWorker), action: 'read', sensitive: true,
  outbound: false, enabled: true, revision: 'reviewed-context-v1', reviewedBy: 'fixture-manager', reviewedAt: Date.now() }, null)
const project = await hostStore.ontologyProjects.register({ orgId: 'fixture-org', ...modelIdentity, workerRef: registeredWorker.id })
const contextPorts = new McpOntologyContextPorts(access, mcpStore)
const bound = await hostStore.ontologyProjects.bind({ sessionId: 'fixture-moss-session', projectId: project.projectId,
  orgId: 'fixture-org', userId: 'fixture-user' }, contextPorts)
// Recover the resolver from the actual host database, not a serialized callback.
await hostStore.close()
hostStore = new DirectConnectStore(join(root, 'host.db'))
const host = await createSessionRunnerHost(hostStore, 'fixture-moss-session')
assert.deepEqual(await hostStore.ontologyProjects.resolveSession('fixture-moss-session'), bound)
const resolveHostContext = await hostStore.ontologyProjects.runnerContext({ sessionId: 'fixture-moss-session',
  orgId: 'fixture-org', userId: 'fixture-user' }, host.ontologyContext)
assert(resolveHostContext)
const server = createServer((req, res) => {
  void (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    const events = [
      ['message_start', { type: 'message_start', message: { id: `fixture-${requests.length}`, type: 'message',
        role: 'assistant', model: 'context-probe', content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fixture response.' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
      ['message_stop', { type: 'message_stop' }],
    ]
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
    res.end(events.map(([event, value]) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`).join(''))
  })().catch(error => { diagnostics.push(String(error)); res.destroy(error instanceof Error ? error : undefined) })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert(address && typeof address !== 'string')
await writeFile(join(config, 'sudocode.json'), JSON.stringify({ auth_modes: { 'api-key': { anthropic: {
  baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-only-key',
} } }, models: { 'context-probe': { name: 'Context probe', providers: {
  'api-key': { provider: 'anthropic', model: 'context-probe' },
} } } }))
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PATHEXT'].includes(key.toUpperCase())))
Object.assign(env, { SUDO_CODE_CONFIG_HOME: config, HOME: profile, USERPROFILE: profile, NO_COLOR: '1' })
const child = spawn(engine, ['--auth', 'api-key', '--model', 'context-probe', '--permission-mode', 'read-only', 'acp'],
  { cwd: workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
const handle = createAcpBridgeHandle({ child, cwd: workspace, sessionId: 'fixture-moss-session', model: 'context-probe',
  runtime: { type: 'cohost', engine: 'scode' }, transcriptPath: join(root, 'transcript.jsonl'),
  resolveHostContext,
})
let wake: (() => void) | undefined
handle.onStdoutLine(line => { output.push(JSON.parse(line)); wake?.() })
handle.onStderrLine(line => diagnostics.push(line))
let failure: Error | undefined
handle.onExit((_code, _signal, error) => { failure = error ?? new Error('Engine connection ended'); wake?.() })
function prompt(text: string): Promise<any> {
  const start = output.length
  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { wake = undefined; reject(new Error('Turn did not complete; inspect diagnostics.log')) }, 30_000)
    wake = () => {
      const result = output.slice(start).find(event => event.type === 'result')
      if (!result && !failure) return
      clearTimeout(timer); wake = undefined
      if (result) resolve(result)
      else reject(failure)
    }
  })
  handle.writeStdin(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }))
  return completion
}
const systemText = (body: any): string => typeof body.system === 'string' ? body.system : body.system.map((block: any) => block.text).join('\n')
let receipt: unknown
try {
  contexts.push(await modelClient.invoke(modelRef, actor, { operation: 'read', product: 'context' }))
  assert(!(await prompt('FIRST_USER_TURN')).is_error)
  assert.equal(requests.length, 1)
  assert.equal(contexts.length, 1)
  assert(systemText(requests[0].body).includes(contexts[0].text))
  assert(systemText(requests[0].body).includes('CONTEXT_A_USE_ORDER_DATE'))
  definition.version = 2; definition.statement = 'CONTEXT_B_USE_SHIPMENT_DATE'
  const updated = await apply('revision-b')
  contexts.push(await modelClient.invoke(modelRef, actor, { operation: 'read', product: 'context' }))
  assert(!(await prompt('SECOND_USER_TURN')).is_error)
  assert.equal(requests.length, 2)
  assert.equal(contexts.length, 2)
  assert.equal(contexts[1].revision, updated.revision)
  assert.notEqual(contexts[0].revision, contexts[1].revision)
  assert(systemText(requests[1].body).includes(contexts[1].text))
  assert(!systemText(requests[1].body).includes('CONTEXT_A_USE_ORDER_DATE'))
  const history = JSON.stringify(requests[1].body.messages)
  assert(history.includes('FIRST_USER_TURN'))
  assert(!history.includes('CONTEXT_A_USE_ORDER_DATE') && !history.includes('CONTEXT_B_USE_SHIPMENT_DATE'))
  const html = await modelClient.invoke<string>(modelRef, actor, { operation: 'read', product: 'html' })
  assert(html.includes(updated.revision) && html.includes('CONTEXT_B_USE_SHIPMENT_DATE'))
  await hostStore.driver.run("UPDATE users SET status = 'disabled' WHERE id = 'fixture-user'")
  assert((await prompt('DENIED_TURN')).is_error)
  assert.equal(requests.length, 2, 'refusal must precede model work')
  assert.equal(contexts.length, 2)
  assert.equal(hash(await readFile(source)), sourceBefore)
  receipt = { format: 'moss-sudograph-context-acceptance/v1', passed: true, engine_sha256: values['engine-sha256'], compiler,
    canonical_revisions: contexts.map(context => context.revision), real_engine: true, installed_compiler: true,
    moss_acp_bridge: true, durable_project_binding_recovered: true, registered_mcp_worker: true, production_host_factory: true,
    published_host_sdk: true, compiler_worker_endpoint: true, packaged_worker: Boolean(values.worker),
    exact_context_in_requests: true, history_preserved: true, context_not_in_user_history: true,
    denied_model_requests: 0, source_unchanged: true,
    scope: 'Real engine stdio, Moss ACP bridge, registered MCP worker and installed compiler; deterministic loopback provider. Not Nexus mailbox, tenant grants, cloud login, WebUI or ShareOne comments.' }
} finally {
  await handle.destroy(true)
  await exited
  await host.close?.()
  await stopWorker()
  await hostStore.close()
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await Promise.all([
    writeFile(join(root, 'requests.json'), JSON.stringify(requests, null, 2)),
    writeFile(join(root, 'output.json'), JSON.stringify(output, null, 2)),
    writeFile(join(root, 'diagnostics.log'), diagnostics.join('')),
  ])
}
await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify(receipt))
