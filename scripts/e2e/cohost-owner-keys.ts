/** Real owner runtimes and HTTP model credentials; only model responses are scripted. */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as portServer } from 'node:net'
import { join, resolve } from 'node:path'
import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import { createUserRuntimeCredentialBundle, NexusVfsClient, NexusZoneApiClient, userRuntimeServerName } from '@nexus-ai-fs/vfs-client'
import { buildCohostProxyConfig } from '../../src/server/backends/scodeProxyConfig.js'
import { connectSessionRuntime } from '../../src/server/nexus/sessionConnection.js'
import { ManagedAgentClient } from '../../src/server/nexus/managedAgentClient.js'
import { connectController } from './cohost-controller-live.js'
import { readAgentNamespace } from '../../src/server/nexus/agentNamespace.js'

assert.equal(process.env.MOSS_OWNER_KEY_E2E, '1', 'Explicit owner model acceptance selection is required')
const binary = resolve(process.env.NEXUSD_COHOST_BIN!)
const work = mkdtempSync(join(process.env.MOSS_COHOST_ARTIFACTS!, 'owner-keys-'))
const model = 'moss-owner-key-fixture'
const processes: ChildProcess[] = []
const logs: string[] = []
const clients: NexusVfsClient[] = []
const controllers: ReturnType<typeof connectController>[] = []
const agents: ManagedAgentClient[] = []
const requests: Array<{ key: string; prompt: string }> = []
let node: any
let issuer: NexusZoneApiClient | undefined
async function freePort() {
  const server = portServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
async function waitFor(check: () => Promise<boolean>, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Native owner acceptance readiness timed out')
}
function boot(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(binary, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const index = processes.push(child) - 1
  logs[index] = ''
  child.stdout!.on('data', data => { logs[index] += data.toString() })
  child.stderr!.on('data', data => { logs[index] += data.toString() })
  return child
}
const provider = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const input = JSON.parse(body)
  const prompt = JSON.stringify(input.messages)
  requests.push({ key: String(request.headers['x-api-key'] ?? ''), prompt })
  const marker = prompt.match(/OWNER_REPLY_[A-Za-z0-9_]+/)?.[0] ?? 'MISSING_OWNER_REPLY'
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const event = (name: string, value: unknown) => response.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`)
  event('message_start', { type: 'message_start', message: { id: randomUUID(), type: 'message', role: 'assistant',
    model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: marker } })
  event('content_block_stop', { type: 'content_block_stop', index: 0 })
  event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
  event('message_stop', { type: 'message_stop' })
  response.end()
})
try {
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`
  const port = await freePort()
  const control = join(work, 'issuer')
  mkdirSync(control)
  boot(['--data-dir', join(control, 'data'), '--bind-addr', `127.0.0.1:${port}`], {
    NEXUS_IDENTITY_DIR: join(control, 'identity'), NEXUS_API_KEY_SECRET: randomUUID(),
    NEXUS_ADVERTISE_ADDR: `127.0.0.1:${port}`, NEXUS_CLUSTER_INIT: 'zone',
    NEXUS_CLUSTER_INIT_MOUNTS: '/agents=zone,/sessions=zone,/conversations=zone',
    SUDO_CODE_CONFIG_HOME: join(control, 'config'), SCODE_GLOBAL_CONFIG_DIR: join(control, 'config'),
  })
  const endpoint = `127.0.0.1:${port}`
  const tlsRoot = join(control, 'data', 'tls')
  await waitFor(async () => logs[0]!.includes('Static topology applied'))
  const tls = { ca: join(tlsRoot, 'ca.pem'), cert: join(tlsRoot, 'node.pem'), key: join(tlsRoot, 'node-key.pem') }
  const operator = NexusVfsClient.withMtls(endpoint, tls)
  clients.push(operator)
  await waitFor(async () => { try { await operator.serverInfo(''); return true } catch { return false } })
  const proto = join(process.cwd(), 'node_modules', '@nexus-ai-fs', 'vfs-client', 'proto')
  const definitions = grpc.loadPackageDefinition(protoLoader.loadSync(join(proto, 'nexus', 'raft', 'transport.proto'),
    { keepCase: true, longs: String, defaults: true, includeDirs: [proto] })) as any
  node = new definitions.nexus.raft.ZoneApiService(endpoint,
    grpc.credentials.createSsl(readFileSync(tls.ca), readFileSync(tls.key), readFileSync(tls.cert)),
    { 'grpc.ssl_target_name_override': 'nexus-node', 'grpc.default_authority': 'nexus-node' })
  const rpc = (method: string, input: unknown) => new Promise<any>((resolve, reject) =>
    node[method](input, (error: Error | null, value: unknown) => error ? reject(error) : resolve(value)))
  const principal = `moss-key-e2e-${randomUUID()}`
  const credential = await rpc('mintAgent', { subject_id: principal, display_name: principal })
  assert.equal(credential.success, true, credential.error)
  assert.equal((await rpc('allowSessionMinter', { agent_id: principal })).success, true)
  const frontDoor = join(work, 'front-door')
  mkdirSync(frontDoor)
  for (const [name, value] of [['ca.pem', credential.ca_pem], ['agent.pem', credential.agent_cert_pem], ['agent-key.pem', credential.agent_key_pem]]) {
    writeFileSync(join(frontDoor, name), value, { mode: 0o600 })
  }
  const mossTls = { ca: join(frontDoor, 'ca.pem'), cert: join(frontDoor, 'agent.pem'), key: join(frontDoor, 'agent-key.pem') }
  issuer = NexusZoneApiClient.withMtls(endpoint, mossTls)
  const proofs: unknown[] = []
  for (const lane of ['alice', 'bob']) {
    const ownerId = `owner-${lane}-${randomUUID()}`
    const apiKey = `fixture-${randomUUID()}`
    const directory = join(work, lane)
    const configRoot = join(directory, 'config')
    mkdirSync(configRoot, { recursive: true })
    const runtimeCredential = await issuer.mintUserRuntime(ownerId, { validitySecs: 300 })
    const bundle = createUserRuntimeCredentialBundle(ownerId, runtimeCredential)
    for (const [name, value] of Object.entries({ ...bundle.files, [bundle.manifestName]: bundle.manifest })) {
      writeFileSync(join(directory, name), value, { mode: 0o600 })
    }
    const configuration = buildCohostProxyConfig(providerUrl, apiKey, model)
    writeFileSync(join(configRoot, 'sudocode.json'), configuration['sudocode.json']!, { mode: 0o600 })
    const backend = JSON.parse(configuration['backend-config.json']!)
    backend.mounts[0].backend_params.blob_root = join(directory, 'model-cache')
    writeFileSync(join(directory, 'backend-config.json'), JSON.stringify(backend), { mode: 0o600 })
    const runtimePort = await freePort()
    boot(['--data-dir', join(directory, 'data'), '--root-path', directory,
      '--bind-addr', `127.0.0.1:${runtimePort}`, 'serve-user', '--owner', ownerId,
      '--credential', directory, '--backend-config', join(directory, 'backend-config.json')],
    { SCODE_GLOBAL_CONFIG_DIR: configRoot, SUDO_CODE_CONFIG_HOME: configRoot, SCODE_CHECK_UPDATES: '0' })
    const connection = await connectSessionRuntime({ endpoint, tls: mossTls, authToken: '',
      runtimeEndpoint: `https://127.0.0.1:${runtimePort}` }, ownerId)
    clients.push(connection.client)
    await waitFor(async () => { try { await connection.client.stat('/agents', ''); return true } catch { return false } })
    const agent = new ManagedAgentClient(connection.client, connection.authToken)
    agents.push(agent)
    const session = await agent.startSession({ agentId: 'same-agent-name', model })
    const controller = connectController({ agent, ...session }, new Set())
    controllers.push(controller)
    await controller.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const opened = await controller.rpc('session/new', { cwd: '/', mcpServers: [] })
    const marker = `OWNER_REPLY_${lane}_${randomUUID().replaceAll('-', '')}`
    const before = requests.length
    const reply = await controller.rpc('session/prompt', { sessionId: opened.sessionId,
      prompt: [{ type: 'text', text: `Reply with exactly ${marker}; use no tools.` }] }, 60_000)
    assert.equal(reply.stopReason, 'end_turn')
    const calls = requests.slice(before)
    assert(calls.length > 0, 'the real native engine must call the HTTP model')
    assert(calls.every(request => request.key === apiKey && request.prompt.includes(marker)), 'every model request uses its owner key')
    assert(controller.updates.some(update => update.content?.text?.includes(marker)))
    await agent.verifySessionEndpoint(session.sessionId, session.sessionEndpoint)
    await assert.rejects(agent.verifySessionEndpoint(session.sessionId,
      { ...session.sessionEndpoint, channel_id: randomUUID() }), /channel changed/)
    const namespace = await readAgentNamespace(connection.client, connection.authToken, ownerId, true)
    assert(namespace.names.includes('same-agent-name'), 'Agent discovery reads the real persistent namespace')
    assert(namespace.executions.some(execution => execution.name === 'same-agent-name' && execution.ownerId === ownerId && execution.kind === 'managed'), 'native registry proves owner and conversation capability')
    const foreign = await connectSessionRuntime({ endpoint, tls: mossTls, authToken: '',
      runtimeEndpoint: `https://127.0.0.1:${runtimePort}` }, `foreign-${randomUUID()}`)
    clients.push(foreign.client)
    const untrusted = NexusVfsClient.withMtls(`https://127.0.0.1:${runtimePort}`, {
      ...foreign.identity!.tls, serverName: userRuntimeServerName(ownerId),
    })
    clients.push(untrusted)
    await assert.rejects(untrusted.readdir('/agents', ''), /permission|Permission|PERMISSION|denied|-32003/)
    await agent.cancel(session.sessionId, { channel_id: randomUUID() })
    const retained = await agent.getSession(session.sessionId)
    assert.equal(retained.durable_session_id, session.durableSessionId, 'a retired channel cannot terminate the live native session')
    assert.equal(retained.session_endpoint?.channel_id, session.sessionEndpoint.channel_id)
    await agent.cancel(session.sessionId, session.sessionEndpoint)
    await assert.rejects(agent.getSession(session.sessionId), /unknown session_id/)
    await assert.rejects(agent.verifySessionEndpoint(session.sessionId, session.sessionEndpoint), /execution disappeared/)
    proofs.push({ lane, ownerId, durableSessionId: session.durableSessionId, modelRequests: calls.length,
      isOwnerKeyVerified: true, isForeignOwnerRefused: true, isChannelCancellationVerified: true, isExecutionReadinessVerified: true })
  }
  assert.notEqual(requests[0]!.key, requests.at(-1)!.key)
  writeFileSync(join(work, 'acceptance.json'), JSON.stringify({ binary, proofs, isScriptedModelResponse: true }, null, 2))
  console.log(`PASS: distinct owner credentials reached the real native HTTP transport; evidence=${work}`)
} finally {
  await Promise.allSettled(controllers.map(controller => controller.close()))
  for (const agent of agents) agent.close()
  for (const client of clients) client.close()
  issuer?.close()
  node?.close()
  await Promise.all(processes.map(async (child, index) => {
    writeFileSync(join(work, `daemon-${index}.log`), logs[index]!)
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM') })
  }))
  await new Promise<void>(resolve => provider.close(() => resolve()))
}
