/** Explicit installed-compiler / real-engine acceptance through Moss's ACP bridge.
 * No production login, tenant grant, Nexus mailbox or provider reasoning is claimed.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createAcpBridgeHandle } from '../../src/server/backends/acpBridge.js'
import { DirectConnectStore } from '../../src/server/db.js'
import type { OntologyContextPorts } from '../../src/server/ontology/projectRegistry.js'

const { values } = parseArgs({ options: {
  engine: { type: 'string' }, 'engine-sha256': { type: 'string' },
  python: { type: 'string' }, evidence: { type: 'string' },
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
const store = join(root, 'model.db'), source = join(root, 'source.sqlite')
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
function worker(module: string, request: unknown): any {
  const response = JSON.parse(runPython(['-m', module, '--store', store, '--actor', 'fixture-moss-host'], request))
  assert.equal(response.ok, true, JSON.stringify(response.error))
  return response.result
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
const registered = worker('compiler.registration', { source: 'sqlite:///' + source.replaceAll('\\', '/'),
  namespace: 'support', operation_id: 'source', language: 'en', snapshot_records: false })
assert.equal(registered.registration.scan.structure_complete, true)
const definition = { concept: 'revenue', category: 'meaning', role: 'business',
  purpose: { stakeholder: 'Support manager', decision: 'Choose revenue policy' },
  label: 'Revenue policy', statement: 'CONTEXT_A_USE_ORDER_DATE', origin: 'inferred',
  contributor: 'model', version: 1, targets: [] }
const model = { format: 'sudograph-business-overlay/v5', namespace: 'support',
  baseline: registered.contract.baseline, definitions: { revenue: definition } }
function apply(operation: string): any {
  const contract = worker('compiler.workspace', { operation: 'contract' })
  return worker('compiler.workspace', { operation: 'apply', request: {
    base_revision: contract.revision, operation_id: operation, model: JSON.stringify(model),
  } })
}
apply('revision-a')
let isAllowed = true
const contexts: any[] = [], requests: any[] = [], output: any[] = [], diagnostics: string[] = []
let hostStore = new DirectConnectStore(join(root, 'host.db'))
await hostStore.driver.run(`INSERT INTO sessions
  (session_id, transcript_session_id, org_id, user_id, role, scopes_json, cwd,
   runtime_type, status, desired_state, transcript_path, created_at, last_active_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
['fixture-moss-session', 'fixture-native-history', 'fixture-org', 'fixture-user', 'user', '[]', workspace,
  'cohost', 'active', 'active', join(root, 'transcript.jsonl'), Date.now(), Date.now()])
const project = await hostStore.ontologyProjects.register({ orgId: 'fixture-org', authorityRef: 'canonical-fixture',
  workerRef: 'registered-fixture-worker', modelRef: 'fixture-model', sourceRefs: ['registered-fixture-source'] })
const contextPorts: OntologyContextPorts = {
  authorize: async binding => {
    assert.equal(binding.orgId, 'fixture-org')
    assert.equal(binding.userId, 'fixture-user')
    if (!isAllowed) throw new Error('Fixture grant revoked')
  },
  readContext: async binding => {
    assert.equal(binding.workerRef, 'registered-fixture-worker')
    assert.equal(binding.modelRef, 'fixture-model')
    const context = worker('compiler.workspace', { operation: 'read', product: 'context' })
    contexts.push(context)
    return context
  },
}
const bound = await hostStore.ontologyProjects.bind({ sessionId: 'fixture-moss-session', projectId: project.projectId,
  orgId: 'fixture-org', userId: 'fixture-user' }, contextPorts)
// Recover the resolver from the actual host database, not a serialized callback.
await hostStore.close()
hostStore = new DirectConnectStore(join(root, 'host.db'))
assert.deepEqual(await hostStore.ontologyProjects.resolveSession('fixture-moss-session'), bound)
const resolveHostContext = await hostStore.ontologyProjects.runnerContext({ sessionId: 'fixture-moss-session',
  orgId: 'fixture-org', userId: 'fixture-user' }, contextPorts)
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
  assert(!(await prompt('FIRST_USER_TURN')).is_error)
  assert.equal(requests.length, 1)
  assert.equal(contexts.length, 1)
  assert(systemText(requests[0].body).includes(contexts[0].text))
  assert(systemText(requests[0].body).includes('CONTEXT_A_USE_ORDER_DATE'))
  definition.version = 2; definition.statement = 'CONTEXT_B_USE_SHIPMENT_DATE'
  const updated = apply('revision-b')
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
  const html = worker('compiler.workspace', { operation: 'read', product: 'html' })
  assert(html.includes(updated.revision) && html.includes('CONTEXT_B_USE_SHIPMENT_DATE'))
  isAllowed = false
  assert((await prompt('DENIED_TURN')).is_error)
  assert.equal(requests.length, 2, 'refusal must precede model work')
  assert.equal(contexts.length, 2)
  assert.equal(hash(await readFile(source)), sourceBefore)
  receipt = { format: 'moss-sudograph-context-acceptance/v1', passed: true, engine_sha256: values['engine-sha256'], compiler,
    canonical_revisions: contexts.map(context => context.revision), real_engine: true, installed_compiler: true,
    moss_acp_bridge: true, durable_project_binding_recovered: true,
    exact_context_in_requests: true, history_preserved: true, context_not_in_user_history: true,
    denied_model_requests: 0, source_unchanged: true,
    scope: 'Real engine stdio, Moss ACP bridge and installed compiler; deterministic loopback provider. Not Nexus mailbox, tenant grants, cloud login, WebUI or ShareOne comments.' }
} finally {
  await handle.destroy(true)
  await exited
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
