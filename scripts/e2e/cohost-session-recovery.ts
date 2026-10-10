/** Real released daemon, Moss credentials/controller, native storage and durable recovery. */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as reservePort } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import { NexusVfsClient } from '@nexus-ai-fs/vfs-client'

import { ManagedAgentClient, type StartSessionResult } from '../../src/server/nexus/managedAgentClient.js'
import { mintSessionIdentity, ownerField } from '../../src/server/nexus/sessionIdentity.js'
import { connectController } from './cohost-controller-live.js'
import { startCohostExecution } from '../../src/server/backends/cohostRecovery.js'
import { SqliteDriver } from '../../src/server/db/driver.js'
import { CohostSessionRepository } from '../../src/server/runtime/cohostSessionRepository.js'
import { COHOST_SESSION_SCHEMA } from '../../src/server/storage/cohostSessionSchema.js'
import { cohostRepositoryPath } from '../../src/server/backends/cohostSessionState.js'

const binary = resolve(process.env.NEXUSD_COHOST_BIN ?? 'bin/cohost/nexusd-cohost')
const artifacts = process.env.MOSS_COHOST_ARTIFACTS ?? join(tmpdir(), 'moss-cohost-evidence')
mkdirSync(artifacts, { recursive: true })
const work = mkdtempSync(join(artifacts, 'recovery-'))
const model = 'moss-recovery-fixture'
const modelMount = '/model'
const zone = 'moss-recovery'
const requests: any[] = []
const clients: NexusVfsClient[] = []
let daemon: ChildProcess | undefined
let daemonLog = ''
let operator: NexusVfsClient | undefined
let node: any
let vfs: any
let bindingStore: CohostSessionRepository | undefined
let bindingDriver: SqliteDriver | undefined
const bindingPath = join(work, 'moss-bindings.db')

function openBindings(): CohostSessionRepository {
  const db = new DatabaseSync(bindingPath)
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, user_id TEXT, runtime_type TEXT,
      current_attempt_id TEXT, deleted_at INTEGER);
    CREATE TABLE IF NOT EXISTS session_attempts (attempt_id TEXT PRIMARY KEY, server_instance_id TEXT,
      runtime_state TEXT);
  `)
  db.exec(COHOST_SESSION_SCHEMA)
  bindingDriver = new SqliteDriver(db)
  return new CohostSessionRepository(bindingDriver)
}

/** Script only the model; all credential, transport, approval and file operations are real. */
const provider = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const messages = body.messages as any[]
    const text = messages.flatMap(message => (Array.isArray(message.content) ? message.content : [])
      .filter((block: any) => block.type === 'text').map((block: any) => block.text)).join('\n')
    const order = JSON.parse(text.match(/MOSS_RECOVERY_ORDER (\{[^\n]+\})/)?.[1] ?? 'null')
    assert(order, 'model request lost the original order')
    const fee = JSON.parse(text.match(/MOSS_RECOVERY_FEE (\{[^\n]+\})/)?.[1] ?? 'null')
    const isToolResult = messages.at(-1)?.content?.some((block: any) => block.type === 'tool_result')
    const value = fee ? { code: order.code, total: order.subtotal + 13 } : { code: order.code, subtotal: order.subtotal }
    const output = fee?.output ?? order.output
    const write = body.tools?.find((tool: any) => ['write', 'write_file'].includes(tool.name.toLowerCase()))
    assert(write, 'real runtime did not advertise its file writer')
    const input = { path: output, content: JSON.stringify(value) }
    const block = isToolResult
      ? { type: 'text', text: `Stored ${order.code}: ${JSON.stringify(value)}` }
      : { type: 'tool_use', id: `write-${randomUUID()}`, name: write.name, input }
    const stop = isToolResult ? 'end_turn' : 'tool_use'
    const message = { id: `msg-${randomUUID()}`, type: 'message', role: 'assistant', model,
      content: [block], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 64, output_tokens: 32 } }
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(message))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = (type: string, data: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } })
    event('content_block_start', { type: 'content_block_start', index: 0,
      content_block: isToolResult ? { type: 'text', text: '' } : { ...block, input: {} } })
    event('content_block_delta', { type: 'content_block_delta', index: 0,
      delta: isToolResult ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
    event('content_block_stop', { type: 'content_block_stop', index: 0 })
    event('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 32 } })
    event('message_stop', { type: 'message_stop' })
    response.end()
  } catch (error) {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: String(error) } }))
  }
})

async function waitFor<T>(label: string, probe: () => Promise<T | undefined>, budget = 30_000): Promise<T> {
  const deadline = Date.now() + budget
  do {
    const value = await probe()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${label}`)
}

function rpc(client: any, method: string, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => client[method](params, new grpc.Metadata(),
    { deadline: Date.now() + 10_000 }, (error: Error | null, result: unknown) => error ? reject(error) : resolve(result)))
}

async function readSession(id: string): Promise<any[]> {
  const path = `/sessions/${id}/transcript.jsonl`
  assert.equal((await operator!.stat(path, ''))?.entryType, 4, 'transcript must be a native stream')
  const chunks: Buffer[] = []
  let offset = '0'
  for (;;) {
    const frame = await operator!.streamReadAt(path, offset, '')
    if (!frame.data.length) break
    assert.notEqual(frame.nextOffset, offset, 'stream cursor must advance')
    chunks.push(frame.data)
    offset = frame.nextOffset
  }
  let messages: any[] = []
  for (const line of Buffer.concat(chunks).toString().trim().split('\n')) {
    const record = JSON.parse(line)
    if (record.type === 'session_meta') messages = []
    else if (record.type === 'message') messages.push(record.message)
  }
  return messages
}

try {
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address()
  assert(address && typeof address !== 'string')
  const providerUrl = `http://127.0.0.1:${address.port}`
  const reservation = reservePort()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const reserved = reservation.address()
  assert(reserved && typeof reserved !== 'string')
  const port = reserved.port
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  const config = join(work, 'config')
  mkdirSync(config)
  writeFileSync(join(config, 'sudocode.json'), JSON.stringify({
    auth_modes: { 'api-key': { anthropic: { baseUrl: `nexus://${modelMount}` } } },
    models: { [model]: { alias: model, name: model, input: ['text'],
      providers: { 'api-key': { provider: 'anthropic', model } } } },
  }))
  const daemonEnv = {
    ...process.env, SUDO_CODE_CONFIG_HOME: config, NEXUS_DATA_DIR: join(work, 'data'),
    NEXUS_IDENTITY_DIR: join(work, 'identity'), NEXUS_API_KEY_SECRET: `fixture-${randomUUID()}`,
    NEXUS_ADVERTISE_ADDR: `127.0.0.1:${port}`, NEXUS_CLUSTER_INIT: `${zone},model`,
    NEXUS_CLUSTER_INIT_MOUNTS: `/agents=${zone},/sessions=${zone},/conversations=${zone}`, RUST_LOG: 'info',
    ANTHROPIC_API_KEY: 'fixture-unused',
  }
  async function bootDaemon() {
    const offset = daemonLog.length
    daemon = spawn(binary, ['--bind-addr', `127.0.0.1:${port}`], { env: daemonEnv, windowsHide: true })
    daemon.stdout!.on('data', data => { daemonLog += data.toString() })
    daemon.stderr!.on('data', data => { daemonLog += data.toString() })
    daemon.once('error', error => { daemonLog += String(error) })
    await waitFor('founder topology', async () => daemonLog.slice(offset).includes('Static topology applied') ? true : undefined, 60_000)
  }
  async function stopDaemon(signal: NodeJS.Signals) {
    const running = daemon!
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { running.kill('SIGKILL'); reject(new Error('Daemon shutdown timed out')) }, 20_000)
      running.once('exit', () => { clearTimeout(timer); resolve() })
      running.kill(signal)
    })
  }
  async function mountModel() {
    const bootstrap = process.env.MOSS_COHOST_MODEL_BOOTSTRAP
    assert(bootstrap, 'The real startup bootstrap bundle is required')
    await new Promise<void>((resolve, reject) => {
      const hook = spawn(process.execPath, [bootstrap, endpoint, tls, providerUrl, join(work, 'model')], { windowsHide: true })
      let output = ''
      hook.stdout!.on('data', data => { output += data.toString() })
      hook.stderr!.on('data', data => { output += data.toString() })
      hook.once('error', reject)
      hook.once('exit', code => code === 0 ? resolve() : reject(new Error(`Model startup bootstrap failed: ${output}`)))
    })
  }
  await bootDaemon()
  const endpoint = `127.0.0.1:${port}`
  const tls = join(work, 'data', 'tls')
  const operatorTls = { ca: join(tls, 'ca.pem'), cert: join(tls, 'node.pem'), key: join(tls, 'node-key.pem') }
  operator = NexusVfsClient.withMtls(endpoint, operatorTls)
  await waitFor('writable node', async () => {
    try { await operator!.serverInfo(''); return true }
    catch (error) { if ((error as { code?: number }).code === grpc.status.UNAVAILABLE) return undefined; throw error }
  })
  const proto = join(process.cwd(), 'node_modules', '@nexus-ai-fs', 'vfs-client', 'proto')
  const definitions = grpc.loadPackageDefinition(protoLoader.loadSync([
    join(proto, 'nexus', 'raft', 'transport.proto'), join(proto, 'nexus', 'grpc', 'vfs', 'vfs.proto'),
  ], { keepCase: true, longs: String, defaults: true, includeDirs: [proto] })) as any
  const credential = grpc.credentials.createSsl(readFileSync(operatorTls.ca), readFileSync(operatorTls.key), readFileSync(operatorTls.cert))
  const options = { 'grpc.ssl_target_name_override': 'nexus-node', 'grpc.default_authority': 'nexus-node' }
  node = new definitions.nexus.raft.ZoneApiService(endpoint, credential, options)
  vfs = new definitions.nexus.grpc.vfs.NexusVFSService(endpoint, credential, options)
  await mountModel()
  const principal = `moss-recovery-${randomUUID()}`
  const minted = await rpc(node, 'mintAgent', { subject_id: principal, display_name: principal })
  assert.equal(minted.success, true, minted.error)
  assert.equal((await rpc(node, 'allowSessionMinter', { agent_id: principal })).success, true)
  const frontDoor = join(work, 'front-door')
  mkdirSync(frontDoor)
  for (const [name, content] of [['ca.pem', minted.ca_pem], ['agent.pem', minted.agent_cert_pem], ['agent-key.pem', minted.agent_key_pem]]) {
    writeFileSync(join(frontDoor, name), content, { mode: 0o600 })
  }
  const mossTls = { ca: join(frontDoor, 'ca.pem'), cert: join(frontDoor, 'agent.pem'), key: join(frontDoor, 'agent-key.pem') }
  async function consumer(owner: string) {
    const identity = await mintSessionIdentity(endpoint, mossTls, owner)
    assert(identity, 'Moss must prove the session owner with a minted credential')
    const client = NexusVfsClient.withMtls(endpoint, identity.tls)
    clients.push(client)
    return { agent: new ManagedAgentClient(client, ''), client, identity }
  }
  const ownerA = `owner-a-${randomUUID()}`
  const ownerB = `owner-b-${randomUUID()}`
  const a = await consumer(ownerA)
  const b = await consumer(ownerB)
  assert.notEqual(a.identity.subjectId, b.identity.subjectId)
  const orphanAgent = `orphan-${ownerA}`
  const orphanRepository = `/agents/${orphanAgent}/workspaces/${randomUUID()}`
  await operator.mkdir(orphanRepository, '', { parents: true, existOk: true })
  const orphanInput = { agentId: orphanAgent, model, repos: [{ alias: 'workspace', hostPath: orphanRepository }] }
  const orphan = await startCohostExecution(a.agent, orphanInput,
    { ownerId: ownerA, repositoryPath: orphanRepository, controllerId: a.identity.subjectId })
  const originalReply = await startCohostExecution(a.agent, orphanInput,
    { ownerId: ownerA, repositoryPath: orphanRepository, controllerId: a.identity.subjectId })
  assert.equal(originalReply.session.sessionId, orphan.session.sessionId, 'a lost creation reply must not start a second process')
  const replacement = await consumer(ownerA)
  const recoveredOrphan = await startCohostExecution(replacement.agent, orphanInput,
    { ownerId: ownerA, repositoryPath: orphanRepository, controllerId: replacement.identity.subjectId })
  assert.equal(recoveredOrphan.isResume, true, 'a replacement controller must recover the owned orphan')
  assert.equal(recoveredOrphan.session.durableSessionId, orphan.session.durableSessionId)
  assert.notEqual(recoveredOrphan.session.sessionId, orphan.session.sessionId)
  const orphanController = connectController({ agent: replacement.agent, ...recoveredOrphan.session }, new Set())
  try {
    await orphanController.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
    await orphanController.rpc('session/load', { sessionId: recoveredOrphan.session.durableSessionId, cwd: '/', mcpServers: [] })
  } finally {
    await replacement.agent.cancel(recoveredOrphan.session.sessionId)
    await orphanController.close()
  }
  const proofs: any[] = []
  bindingStore = openBindings()
  const memoryMarkers = new Map<string, string>()
  for (const [owner, current] of [[ownerA, a], [ownerB, b]] as const) {
    const other = current === a ? b : a
    const agentId = `agent-${owner}`
    const mossSessionId = randomUUID()
    const repositoryPath = cohostRepositoryPath(agentId, mossSessionId)
    await operator.mkdir(repositoryPath, '', { parents: true, existOk: true })
    const attemptId = randomUUID()
    await bindingDriver!.run('INSERT INTO sessions (session_id, user_id, runtime_type, current_attempt_id) VALUES (?, ?, ?, ?)',
      [mossSessionId, owner, 'cohost', attemptId])
    await bindingDriver!.run('INSERT INTO session_attempts (attempt_id, server_instance_id, runtime_state) VALUES (?, ?, ?)',
      [attemptId, 'moss-owner', 'running'])
    const start = (resumeSessionId?: string) => current.agent.startSession({ agentId, model, resumeSessionId,
      repos: [{ hostPath: repositoryPath, alias: 'workspace' }],
      ...ownerField(current.identity, owner) })
    const first = await start()
    assert(first.durableSessionId)
    assert.notEqual(first.sessionId, first.durableSessionId)
    const sid = first.durableSessionId
    assert.equal(await bindingStore.bind(mossSessionId, attemptId,
      { ownerId: owner, agentId, durableSessionId: sid, repositoryPath }, 'moss-owner'), true)
    const root = `/agents/${agentId}/recovery-${randomUUID()}`
    const output = `${root}/subtotal.json`
    const final = `${root}/total.json`
    const order = { code: `ORDER_${randomUUID()}`, subtotal: 200 + Math.floor(Math.random() * 100), output }
    const memoryPath = `/agents/${agentId}/memory/MEMORY.md`
    const memoryMarker = `NATIVE_AGENT_MEMORY_${randomUUID()}`
    memoryMarkers.set(owner, memoryMarker)
    const memory = `# Customer preferences\n- Shipping preference: ${memoryMarker}\n`
    await operator.mkdir(`/agents/${agentId}/memory`, '', { parents: true, existOk: true })
    await operator.write(memoryPath, Buffer.from(memory), '')
    const shutdownSignal = current === b ? 'SIGKILL' : 'SIGTERM'
    const allowed = new Set([output, final])
    let controller = connectController({ agent: current.agent, sessionEndpoint: first.sessionEndpoint, sessionId: first.sessionId }, allowed)
    let active: StartSessionResult = first
    try {
      await controller.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
      assert.equal((await controller.rpc('session/new', { cwd: '/', mcpServers: [] })).sessionId, sid)
      await controller.rpc('session/setPermissionMode', { sessionId: sid, permissionMode: 'prompt' })
      const initialRequestStart = requests.length
      assert.equal((await controller.rpc('session/prompt', { sessionId: sid,
        prompt: [{ type: 'text', text: `MOSS_RECOVERY_ORDER ${JSON.stringify(order)}\nWrite the subtotal to the named file.` }] })).stopReason, 'end_turn')
      assert.deepEqual(JSON.parse((await operator.read(output, '')).toString()), { code: order.code, subtotal: order.subtotal })
      assert(requests.slice(initialRequestStart).every(request => JSON.stringify(request.system).includes(memoryMarker)),
        'the real model system prompt must load this agent memory')
      for (const [otherOwner, marker] of memoryMarkers) {
        if (otherOwner !== owner) assert(requests.slice(initialRequestStart).every(request => !JSON.stringify(request.system).includes(marker)),
          'another owner agent memory must not reach this model')
      }
      controller.assertHealthy()
      assert(controller.approvals > 0, 'real write must reach the Moss permission controller')
      const before = await readSession(sid)
      assert.equal(before.filter(m => m.role === 'user').length, 1)
      if (owner === ownerA) {
        for (const isSameAgent of [true, false]) {
          const peer = await consumer(owner)
          const peerAgent = isSameAgent ? agentId : `sibling-${agentId}`
          const peerSession = await peer.agent.startSession({ agentId: peerAgent, model, ...ownerField(peer.identity, owner) })
          assert.notEqual(peerSession.durableSessionId, sid)
          const peerOutput = `/agents/${peerAgent}/peer-${randomUUID()}.json`
          const peerOrder = { code: `PEER_${randomUUID()}`, subtotal: 421, output: peerOutput }
          const peerController = connectController({ agent: peer.agent, ...peerSession }, new Set([peerOutput]))
          try {
            await peerController.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
            assert.equal((await peerController.rpc('session/new', { cwd: '/', mcpServers: [] })).sessionId, peerSession.durableSessionId)
            await peerController.rpc('session/setPermissionMode', { sessionId: peerSession.durableSessionId, permissionMode: 'prompt' })
            const peerStart = requests.length
            assert.equal((await peerController.rpc('session/prompt', { sessionId: peerSession.durableSessionId,
              prompt: [{ type: 'text', text: `MOSS_RECOVERY_ORDER ${JSON.stringify(peerOrder)}\nWrite the subtotal to the named file.` }] })).stopReason, 'end_turn')
            assert.deepEqual(JSON.parse((await operator.read(peerOutput, '')).toString()), { code: peerOrder.code, subtotal: peerOrder.subtotal })
            peerController.assertHealthy()
            assert(peerController.approvals > 0)
            assert(requests.slice(peerStart).every(request => JSON.stringify(request.system).includes(memoryMarker) === isSameAgent),
              'same-owner sessions share memory only when they belong to the same agent')
            assert(requests.slice(peerStart).every(request => !JSON.stringify(request.messages).includes(order.code)),
              'a new session must not inherit another session transcript')
            assert.deepEqual(await readSession(sid), before, 'peer execution must not modify the original session')
          } finally { await peer.agent.cancel(peerSession.sessionId); await peerController.close() }
        }
      }
      await assert.rejects(start(sid), /still running/, 'a live transcript must reject a second writer')
      if (shutdownSignal === 'SIGTERM') {
        await current.agent.cancel(first.sessionId)
        await controller.close()
        await assert.rejects(current.client.call('managed_agent.get_session_v1',
          JSON.stringify({ session_id: first.sessionId }), ''), /unknown session_id/,
        'cancel must remove the old managed process')
      }
      await stopDaemon(shutdownSignal)
      await bootDaemon()
      await mountModel()
      if (shutdownSignal === 'SIGKILL') {
        let closeTimer: ReturnType<typeof setTimeout> | undefined
        try {
          const reason = await Promise.race([controller.closed, new Promise<never>((_resolve, reject) => {
            closeTimer = setTimeout(() => reject(new Error('Moss controller retained an obsolete execution')), 45_000)
          })])
          assert.match(reason?.message ?? '', /execution disappeared/, 'Moss must end the old attachment after a native crash')
        } finally { clearTimeout(closeTimer) }
        await controller.close()
        await assert.rejects(current.client.call('managed_agent.get_session_v1',
          JSON.stringify({ session_id: first.sessionId }), ''), /unknown session_id/,
        'daemon recovery must not restore an obsolete live process')
      }
      assert.deepEqual(JSON.parse((await operator.read(output, '')).toString()), { code: order.code, subtotal: order.subtotal })
      assert.equal((await operator.read(memoryPath, '')).toString(), memory, 'agent memory survives daemon recovery')
      await bindingDriver!.close()
      bindingStore = openBindings()
      const binding = await bindingStore.get(mossSessionId)
      assert.deepEqual(binding, { ownerId: owner, agentId, durableSessionId: sid, repositoryPath }, 'another Moss process can recover without a host locator')
      const recoveryStarted = Date.now()
      const recovered = await startCohostExecution(current.agent,
        { agentId, model, resumeSessionId: binding!.durableSessionId,
          repos: [{ hostPath: binding!.repositoryPath, alias: 'workspace' }], ...ownerField(current.identity, owner) },
        { ownerId: owner, repositoryPath: binding!.repositoryPath, controllerId: current.identity.subjectId })
      active = recovered.session
      const recoveryMs = Date.now() - recoveryStarted
      assert.equal(recovered.isResume, true)
      assert.notEqual(active.sessionId, first.sessionId)
      assert.equal(active.durableSessionId, sid)
      assert.equal(await bindingStore.bind(mossSessionId, attemptId,
        { ownerId: owner, agentId, durableSessionId: active.durableSessionId!, repositoryPath }, 'moss-owner'), true)
      const durableColumns = await bindingDriver!.all<{ name: string }>('PRAGMA table_info(cohost_sessions)')
      assert.deepEqual(durableColumns.map(column => column.name), ['session_id', 'owner_user_id', 'native_agent_id', 'durable_session_id', 'repository_path'])
      assert.notEqual(active.sessionEndpoint.channel_id, first.sessionEndpoint.channel_id)
      controller = connectController({ agent: current.agent, sessionEndpoint: active.sessionEndpoint, sessionId: active.sessionId }, allowed)
      await controller.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
      await controller.rpc('session/load', { sessionId: sid, cwd: '/', mcpServers: [] })
      assert.deepEqual(await readSession(sid), before, 'loading must preserve exact previous messages')
      await controller.rpc('session/setPermissionMode', { sessionId: sid, permissionMode: 'prompt' })
      const requestStart = requests.length
      assert.equal((await controller.rpc('session/prompt', { sessionId: sid, prompt: [{ type: 'text',
        text: `MOSS_RECOVERY_FEE ${JSON.stringify({ output: final })}\nAdd 13 to the subtotal from the previous turn and write the total.` }] })).stopReason, 'end_turn')
      assert.deepEqual(JSON.parse((await operator.read(final, '')).toString()), { code: order.code, total: order.subtotal + 13 })
      controller.assertHealthy()
      assert(controller.approvals > 0)
      assert(requests.slice(requestStart).every(request => JSON.stringify(request.messages).includes(order.code)), 'restored model requests must include the original order')
      assert(requests.slice(requestStart).every(request => JSON.stringify(request.system).includes(memoryMarker)),
        'agent memory must be loaded again after native recovery')
      const after = await readSession(sid)
      assert.deepEqual(after.slice(0, before.length), before, 'previous messages must remain an exact prefix')
      assert.equal(after.filter(m => m.role === 'user').length, 2, 'resume must add exactly one user turn')
      await current.agent.cancel(active.sessionId)
      await controller.close()
      await waitFor('owner validation after writer lease release', async () => {
        try {
          await other.agent.startSession({ agentId, model, resumeSessionId: sid,
            ...ownerField(other.identity, current === a ? ownerB : ownerA) })
          assert.fail('another owner must not restore this transcript')
        } catch (error) {
          if (/still running/.test(String(error))) return undefined
          assert.match(String(error), /ownership|bindings/)
          return true
        }
      }, 90_000)
      assert.deepEqual(await readSession(sid), after, 'a refused owner must not alter native history')
      proofs.push({ owner, durable: sid, oldPid: first.sessionId, newPid: active.sessionId, code: order.code,
        shutdownSignal, isActiveDaemonCrash: shutdownSignal === 'SIGKILL', memoryPath, memoryMarker, recoveryMs })
    } finally {
      await controller.close()
      try { await current.agent.cancel(active.sessionId) }
      catch (error) { if (!/unknown session_id/.test(String(error))) throw error }
    }
  }
  assert.notEqual(proofs[0].durable, proofs[1].durable)
  writeFileSync(join(work, 'acceptance.json'), JSON.stringify({ binary, checks: [
    'mTLS owner credentials', 'real controller approval', 'native transcript stream', 'second writer refusal',
    'wrong owner refusal', 'daemon restart with model startup hook', 'active daemon crash', 'persisted files and agent memory',
    'same durable ID and new pid/channel', 'exact prior history', 'dependent file write',
    'lost creation reply without duplicate execution', 'replacement controller discovers and resumes owned orphan',
    'obsolete execution detected on reconnect',
    'native agent memory injected before and after restart', 'other owner agent memory absent from system prompt',
    'same agent concurrent sessions share native memory', 'same owner different agents have separate native memory',
    'concurrent session transcripts remain independent',
    'Moss process restart restores shared native binding without host locator', 'durable binding has no PID or channel',
  ], proofs, modelRequests: requests.length }, null, 2))
  console.log(`PASS: two Moss owners recover exact conversations, files and memory after daemon stop/crash; evidence=${work}`)
} catch (error) {
  console.error(`Recovery acceptance failed; evidence=${work}`, error)
  throw error
} finally {
  await bindingDriver?.close()
  writeFileSync(join(work, 'daemon.log'), daemonLog)
  for (const client of clients) client.close()
  operator?.close()
  node?.close()
  vfs?.close()
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const exited = new Promise<void>(resolve => daemon!.once('exit', () => resolve()))
    daemon.kill('SIGTERM')
    await exited
  }
  await new Promise<void>(resolve => provider.close(() => resolve()))
}
