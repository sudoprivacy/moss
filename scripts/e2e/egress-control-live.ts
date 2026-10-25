/** Real HTTP policy control, atomic host delivery and native managed model turns.
 * Run the bundled Node entry with: <candidate nexusd-cohost> <new private directory>.
 * The upstream is synthetic. This does not activate a product deployment.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { createEgressPolicy, type EgressPolicy } from '@sudo/egress-policy'
import { buildCohostModelConfiguration, readEgressPolicyFile, writeEgressPolicyFile } from '@sudo/user-runtime'
import { createAuthService } from '../../src/server/auth/service.js'
import { getDefaultServerConfig, readServerConfig, ensureServerDirectories } from '../../src/server/config.js'
import { repairConfigAvailability } from '../../src/server/configuration/configAvailabilitySchema.js'
import { DirectConnectStore } from '../../src/server/db.js'
import { ensureCompatibilityCoreSchema, ensureSqliteCompatibilityDomainSchemas } from '../../src/server/db/compatibilitySchema.js'
import { encodeCohostConnection } from '../../src/server/nexus/cohostConnection.js'
import { ManagedAgentClient } from '../../src/server/nexus/managedAgentClient.js'
import { connectSessionRuntime } from '../../src/server/nexus/sessionConnection.js'
import { ownerField } from '../../src/server/nexus/sessionIdentity.js'
import { RuntimeService } from '../../src/server/runtimeService.js'
import { startServer } from '../../src/server/server.js'
import { connectController } from './cohost-controller-live.js'

const [binaryArgument, directoryArgument, recoveryFlag] = process.argv.slice(2)
assert(binaryArgument && directoryArgument, 'candidate binary and new private directory are required')
const binary = resolve(binaryArgument)
const root = resolve(directoryArgument)
assert(!recoveryFlag || recoveryFlag === '--recover-controller', 'unknown acceptance option')
if (recoveryFlag) {
  await recoverController(root)
} else {
  assert(existsSync(binary), 'candidate binary is missing')
  mkdirSync(root, { mode: 0o700 })
  const policyFile = join(root, 'policy', 'egress-policy.json')
  const configDir = join(root, 'native-config')
  mkdirSync(configDir, { mode: 0o700 })
  const secret = 'sk' + '-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345'
  const prompt = `Synthetic credential ${secret}. Reply MOSS_GATE_OK.`
  const hits: Array<{ scenario: string; credential: string; body: unknown }> = []
  const failures: string[] = []
  const rows: unknown[] = []
  let scenario = 'bootstrap'
  let daemon: ChildProcess | undefined
  let log: number | undefined
  let store: DirectConnectStore | undefined
  let isStoreClosed = false
  let runtime: RuntimeService | undefined
  let server: ReturnType<typeof startServer> | undefined
  let nodeClient: grpc.Client | undefined
  let admin: NexusVfsClient | undefined
  let isPassed = false

  const upstream = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    if (request.url === '/analyze') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('[{"entity_type":"PERSON","start":-1,"end":99999999,"score":1}]')
      return
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString())
    hits.push({ scenario, credential: String(request.headers['x-api-key'] ?? request.headers.authorization), body })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const message = { id: 'moss-gate-fixture', type: 'message', role: 'assistant', model: 'managed-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } }
    for (const [name, value] of [
      ['message_start', { type: 'message_start', message }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'MOSS_GATE_OK' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
      ['message_stop', { type: 'message_stop' }],
    ]) response.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`)
    response.end()
  })
  await new Promise<void>((ready, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', ready) })
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress !== 'string')
  const upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}`
  const modelConfiguration = buildCohostModelConfiguration(['local', 'cloud'].map(id => ({
    id, mountPath: id === 'local' ? '/model' : '/cloud-model', baseUrl: upstreamUrl,
    apiKey: `${id}-synthetic-only`, blobRoot: join(root, 'model-cache'),
    models: [{ alias: `${id}:managed-fixture`, model: 'managed-fixture', api: 'anthropic-messages' }],
  })))
  for (const [name, value] of Object.entries(modelConfiguration)) writeFileSync(join(configDir, name), value, { mode: 0o600 })
  await writeEgressPolicyFile(policyFile, createEgressPolicy({ modelMounts: ['/cloud-model'] }))

  try {
    const reserve = createTcpServer()
    await new Promise<void>((ready, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', ready) })
    const address = reserve.address()
    assert(address && typeof address !== 'string')
    const endpoint = `127.0.0.1:${address.port}`
    await new Promise<void>((done, reject) => reserve.close(error => error ? reject(error) : done()))
    const data = join(root, 'native-data')
    const identity = join(root, 'native-identity')
    const tls = join(data, 'tls')
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NEXUS_EGRESS_GATE_')))
    log = openSync(join(root, 'native.log'), 'wx', 0o600)
    daemon = spawn(binary, ['--cluster-init', 'moss-egress-live', '--hostname', 'moss-egress-live',
      '--bind-addr', endpoint, '--advertise-addr', endpoint, '--data-dir', data, '--identity-dir', identity], {
      env: { ...environment, NEXUS_EGRESS_GATE_CONFIG: policyFile, SCODE_GLOBAL_CONFIG_DIR: configDir },
      stdio: ['ignore', log, log],
    })
    const pid = daemon.pid
    assert(pid, 'native process did not start')
    const deadline = Date.now() + 60_000
    while (!existsSync(join(tls, 'node.pem'))) {
      assert(daemon.exitCode === null && daemon.signalCode === null, 'native process exited during bootstrap')
      assert(Date.now() < deadline, 'native TLS bootstrap timed out')
      await delay(100)
    }
    const nativeTls = { ca: join(tls, 'ca.pem'), cert: join(tls, 'node.pem'), key: join(tls, 'node-key.pem'), serverName: 'nexus-node' }
    admin = NexusVfsClient.withMtls(endpoint, nativeTls, { connectTimeoutMs: 1000 })
    for (;;) {
      try { await admin.serverInfo(''); break } catch (error) {
        if (Date.now() >= deadline) throw error
        await delay(100)
      }
    }
    const proto = resolve('node_modules/@nexus-ai-fs/vfs-client/proto')
    const definitions = grpc.loadPackageDefinition(protoLoader.loadSync([
      join(proto, 'nexus/raft/transport.proto'), join(proto, 'nexus/grpc/vfs/vfs.proto'),
    ], { keepCase: true, longs: String, defaults: true, includeDirs: [proto] })) as any
    const credentials = grpc.credentials.createSsl(readFileSync(nativeTls.ca), readFileSync(nativeTls.key), readFileSync(nativeTls.cert))
    const options = { 'grpc.ssl_target_name_override': 'nexus-node', 'grpc.default_authority': 'nexus-node' }
    nodeClient = new definitions.nexus.raft.ZoneApiService(endpoint, credentials, options)
    const vfs = new definitions.nexus.grpc.vfs.NexusVFSService(endpoint, credentials, options)
    const rpc = (client: any, method: string, input: unknown): Promise<any> => new Promise((done, reject) => {
      client[method](input, new grpc.Metadata(), { deadline: Date.now() + 30_000 }, (error: Error | null, value: any) => error ? reject(error) : done(value))
    })
    try {
      for (const mount of JSON.parse(modelConfiguration['backend-config.json']!).mounts) {
        assert.equal((await rpc(vfs, 'setattr', { ...mount, entry_type: 2, zone_id: 'root' })).is_error, false)
      }
    } finally { vfs.close() }
    const controllerId = `moss-egress-${randomUUID()}`
    const minted = await rpc(nodeClient, 'mintAgent', { subject_id: controllerId, display_name: 'Synthetic Moss egress acceptance' })
    assert.equal(minted.success, true)
    assert.equal((await rpc(nodeClient, 'allowSessionMinter', { agent_id: controllerId })).success, true)
    const frontDoor = join(root, 'controller-identity')
    mkdirSync(frontDoor, { mode: 0o700 })
    for (const [name, value] of Object.entries({ 'ca.pem': minted.ca_pem, 'agent.pem': minted.agent_cert_pem, 'agent-key.pem': minted.agent_key_pem })) {
      writeFileSync(join(frontDoor, name), String(value), { mode: 0o600 })
    }
    const connection = { endpoint: `http://${endpoint}`, authToken: '', tls: {
      ca: join(frontDoor, 'ca.pem'), cert: join(frontDoor, 'agent.pem'), key: join(frontDoor, 'agent-key.pem'), serverName: 'nexus-node',
    } }
    process.env.MOSS_COHOST_CONNECTION = encodeCohostConnection(connection)
    const rawConfig = getDefaultServerConfig()
    rawConfig.server = { ...rawConfig.server, host: '127.0.0.1', port: 0 }
    rawConfig.bootstrapAdmin = { username: 'egress-live-admin', password: randomUUID() }
    rawConfig.storage = { rootDir: root, dbPath: join(root, 'moss.db'), transcriptDir: join(root, 'transcripts'), runtimeDir: join(root, 'runtime') }
    rawConfig.wikiIndex.enabled = false
    const configPath = join(root, 'server.json')
    writeFileSync(configPath, JSON.stringify(rawConfig), { mode: 0o600 })
    const { config } = await readServerConfig(configPath)
    await ensureServerDirectories(config)
    store = new DirectConnectStore(config.dbPath)
    ensureSqliteCompatibilityDomainSchemas(store.requireSqliteDb())
    ensureCompatibilityCoreSchema(store.requireSqliteDb())
    await store.ensureDefaultConfigItems()
    await repairConfigAvailability(store.driver)
    const { service: authService } = await createAuthService({ db: store, dbPath: config.dbPath, tokenTtlSec: config.tokenTtlSec, bootstrapAdmin: config.bootstrapAdmin })
    const issued = await authService.issueTokenFromPassword({ username: rawConfig.bootstrapAdmin.username!, password: rawConfig.bootstrapAdmin.password! })
    config.egressGate = { localPolicyFile: policyFile, localOrganizationId: issued.user.orgId }
    rawConfig.egressGate = config.egressGate
    writeFileSync(configPath, JSON.stringify(rawConfig), { mode: 0o600 })
    runtime = new RuntimeService({ config, store, authService, serverInstanceId: `egress-live-${randomUUID()}` })
    await runtime.reconcileOnStartup()
    server = startServer(config, runtime, authService, { info: () => {}, warn: () => {}, error: message => failures.push(message), debug: () => {} })
    const port = await server.ready
    assert(port !== null)
    const origin = `http://127.0.0.1:${port}`
    const login = await fetch(`${origin}/api/v1/auth/token`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: rawConfig.bootstrapAdmin.username, password: rawConfig.bootstrapAdmin.password }) })
    assert.equal(login.status, 200)
    const token = (await login.json() as { access_token: string }).access_token
    assert(token)
    const policyPath = `${origin}/api/v1/settings/egress?scope=organization`
    assert.equal((await fetch(policyPath)).status, 401)
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    let view = await (await fetch(policyPath, { headers })).json() as { policy: EgressPolicy; runtimes: Array<{ state: string; status?: { revision: number } }> }
    for (const name of ['disabled-before', 'redact', 'local-control', 'deny', 'outage', 'malformed', 'disabled-after']) {
      scenario = name
      const isDenied = ['deny', 'outage', 'malformed'].includes(name)
      const policy = { ...view.policy, enabled: !name.startsWith('disabled-'), mode: name === 'deny' ? 'deny' as const : 'redact' as const,
        modelMounts: ['/cloud-model'], analyzer: name === 'outage' || name === 'malformed'
          ? { url: name === 'outage' ? 'http://127.0.0.1:1' : upstreamUrl, language: 'zh', scoreThreshold: 0.5, entities: ['PERSON'], timeoutMs: 1000 } : null }
      const saved = await fetch(policyPath, { method: 'PUT', headers, body: JSON.stringify({ policy, expectedRevision: view.policy.revision }) })
      assert.equal(saved.status, 200, await saved.clone().text())
      view = await saved.json() as typeof view
      assert(view.runtimes.length > 0, 'save returned no actual runtime observation')
      assert(view.runtimes.every(receipt => receipt.state === 'applied'), 'save was not applied by the native runtime')
      assert.deepEqual(readEgressPolicyFile(policyFile), view.policy)
      const agentId = `moss-gate-${name}`
      const resolved = await runtime.resolveCohostConnection(issued.user.id, agentId, modelConfiguration)
      const session = await connectSessionRuntime(resolved, issued.user.id)
      const agent = new ManagedAgentClient(session.client, session.authToken)
      let started: Awaited<ReturnType<typeof agent.startSession>> | undefined
      try {
        started = await agent.startSession({ agentId, model: `${name === 'local-control' ? 'local' : 'cloud'}:managed-fixture`, ...ownerField(session.identity, issued.user.id) })
        const controller = connectController({ agent, ...started }, new Set())
        try {
          await controller.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
          const opened = await controller.rpc('session/new', { cwd: '/', mcpServers: [] })
          assert.equal(opened.sessionId, started.durableSessionId)
          const turn = controller.rpc('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text: prompt }] })
          if (isDenied) await assert.rejects(turn, /egress|classif|redact|denied|hook/i)
          else {
            assert.equal((await turn).stopReason, 'end_turn')
            assert(JSON.stringify(controller.updates).includes('MOSS_GATE_OK'))
          }
          controller.assertHealthy()
          const historyClient = new definitions.nexus.grpc.vfs.NexusVFSService(endpoint, credentials, options)
          try {
            const history = await rpc(historyClient, 'streamCollectAll', { path: `/sessions/${started.durableSessionId}/transcript.jsonl` })
            assert.equal(history.is_error, false)
            assert(Buffer.from(history.data).includes(Buffer.from(prompt)), 'local original was not retained')
          } finally { historyClient.close() }
        } finally { await controller.close() }
      } finally {
        try { if (started) await agent.cancel(started.sessionId) } finally { session.client.close() }
      }
      const requests = hits.filter(hit => hit.scenario === name)
      assert.equal(requests.length, isDenied ? 0 : 1)
      if (requests.length) {
        const expectedCredential = `${name === 'local-control' ? 'local' : 'cloud'}-synthetic-only`
        assert([expectedCredential, `Bearer ${expectedCredential}`].includes(requests[0]!.credential))
        assert.equal(JSON.stringify(requests[0]!.body).includes(secret), name.startsWith('disabled-') || name === 'local-control')
      }
      assert.equal(daemon.pid, pid)
      assert(daemon.exitCode === null && daemon.signalCode === null, 'policy update stopped the native runtime')
      rows.push({ scenario: name, savedRevision: view.policy.revision, nativeApplied: true, upstreamRequests: requests.length,
        callerReceivedGateError: isDenied, localOriginalRetained: true })
    }
    const savedPolicy = view.policy
    await server.stop()
    server = undefined
    await runtime.closeRuntimeServices()
    store.close()
    isStoreClosed = true
    await writeEgressPolicyFile(policyFile, createEgressPolicy())
    writeFileSync(join(root, 'expected-policy.json'), JSON.stringify(savedPolicy), { mode: 0o600 })
    // A new Node process avoids retaining application singletons bound to the old database.
    execFileSync(process.execPath, [process.argv[1]!, binary, root, '--recover-controller'], {
      env: process.env, stdio: 'inherit', timeout: 60_000,
    })
    assert.deepEqual(readEgressPolicyFile(policyFile), savedPolicy)
    const recovery = JSON.parse(readFileSync(join(root, 'controller-recovery.json'), 'utf8'))
    assert.equal(recovery.passed, true)
    assert.notEqual(recovery.processId, process.pid)
    assert(daemon.exitCode === null && daemon.signalCode === null)
    assert.equal(daemon.pid, pid)
    assert.equal(failures.length, 0, 'Moss reported an HTTP handler error')
    isPassed = true
  } finally {
    const cleanupErrors: string[] = []
    try { await server?.stop() } catch { cleanupErrors.push('moss-server-stop') }
    try { await runtime?.closeRuntimeServices() } catch { cleanupErrors.push('runtime-close') }
    admin?.close()
    nodeClient?.close()
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, 'exit')
      daemon.kill('SIGTERM')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('native stop timed out')), 10_000) })])
      } catch {
        cleanupErrors.push('native-required-forced-stop')
        daemon.kill('SIGKILL')
        await exited
      } finally { clearTimeout(timer) }
    }
    if (log !== undefined) closeSync(log)
    await new Promise<void>(done => upstream.close(() => done()))
    if (store && !isStoreClosed) store.close()
    writeFileSync(join(root, 'acceptance.json'), JSON.stringify({ passed: isPassed && cleanupErrors.length === 0,
      scope: 'Moss HTTP policy API -> shared host file -> native receipt -> managed ACP -> synthetic model',
      binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
      productionServicesChanged: false, sameNativeProcess: isPassed, controllerProcessReplacement: isPassed,
      crashRecoveryTested: false, policyFileOsIsolationTested: false, rows, cleanupErrors }, null, 2))
    assert.equal(cleanupErrors.length, 0, 'owned acceptance cleanup failed')
  }
  console.log(`PASS real Moss HTTP and native live policy acceptance: ${root}`)
}

/** Recover the saved controller state in a fresh process, retaining the same native daemon. */
async function recoverController(root: string) {
  const { config } = await readServerConfig(join(root, 'server.json'))
  const expected = JSON.parse(readFileSync(join(root, 'expected-policy.json'), 'utf8')) as EgressPolicy
  const store = new DirectConnectStore(config.dbPath)
  const { service: authService } = await createAuthService({ db: store, dbPath: config.dbPath, tokenTtlSec: config.tokenTtlSec, bootstrapAdmin: config.bootstrapAdmin })
  const runtime = new RuntimeService({ config, store, authService, serverInstanceId: `egress-restart-${randomUUID()}` })
  let server: ReturnType<typeof startServer> | undefined
  const errors: string[] = []
  try {
    await runtime.reconcileOnStartup()
    server = startServer(config, runtime, authService, { info: () => {}, warn: () => {}, error: message => errors.push(message), debug: () => {} })
    const port = await server.ready
    assert(port !== null)
    const origin = `http://127.0.0.1:${port}`
    const login = await fetch(`${origin}/api/v1/auth/token`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: config.bootstrapAdmin.username, password: config.bootstrapAdmin.password }) })
    assert.equal(login.status, 200)
    const token = (await login.json() as { access_token: string }).access_token
    assert(token)
    const response = await fetch(`${origin}/api/v1/settings/egress?scope=organization`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(response.status, 200)
    const view = await response.json() as { policy: EgressPolicy; runtimes: Array<{ state: string }> }
    assert.deepEqual(view.policy, expected)
    assert(view.runtimes.length > 0 && view.runtimes.every(receipt => receipt.state === 'applied'))
    assert.equal(errors.length, 0)
    writeFileSync(join(root, 'controller-recovery.json'), JSON.stringify({ passed: true, processId: process.pid, revision: expected.revision }), { mode: 0o600 })
  } finally {
    try { await server?.stop() } finally {
      await runtime.closeRuntimeServices()
      store.close()
    }
  }
}
