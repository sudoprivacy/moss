import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { WorkAdmission } from '@sudo/user-runtime'
import { DirectConnectStore } from './db.js'
import { RuntimeAdmissionPauses } from './runtime/runtimeAdmissionPauses.js'
import { RuntimeInputBarrier } from './runtime/runtimeInputBarrier.js'
import type { BackendHandle } from './sessionManager.js'
import type { RunnerManifest, ServerConfig } from './types.js'

const featureAlias = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'bun:bundle'
      ? new URL('../../scripts/bun-bundle-feature.js', import.meta.url).href
      : specifier, context)
  },
})
const [{ RuntimeBackend }, { SessionRunnerDaemon }] = await (async () => {
  try { return await Promise.all([import('./backends/runtimeBackend.js'), import('./sessionRunnerDaemon.js')]) }
  finally { featureAlias.deregister() }
})()

async function fixture(t: TestContext, isBackendPending = false) {
  const root = await mkdtemp(join(tmpdir(), 'moss-admission-daemon-'))
  const store = new DirectConnectStore(join(root, 'moss.db'))
  const owner = await store.registerServerInstance('fixture', process.pid)
  const attachPath = process.platform === 'win32' ? '\\\\.\\pipe\\moss-admission-daemon-' + randomUUID()
    : join(root, 'runner.sock')
  await store.createSession({ sessionId: 'session', transcriptSessionId: 'durable-transcript',
    transcriptPath: join(root, 'transcript.jsonl'), userId: 'owner', orgId: 'org', role: 'user', scopes: [],
    cwd: root, runtime: { type: 'cohost', engine: 'scode' }, status: 'active', desiredState: 'active' })
  const attempt = await store.createAttempt({ sessionId: 'session', generation: 1, backendType: 'cohost',
    resumeTranscriptSessionId: 'durable-transcript', serverInstanceId: owner.instanceId, attachPath })
  await store.setCurrentAttempt('session', attempt.attemptId)
  const session = await store.getSession('session')
  assert(session)
  const manifest: RunnerManifest = {
    config: { heartbeatTimeoutMs: 30_000, idleTimeoutMs: 0, instanceId: owner.instanceId } as ServerConfig,
    session: { sessionId: session.sessionId, transcriptSessionId: session.transcriptSessionId,
      transcriptPath: session.transcriptPath, userId: session.userId, orgId: session.orgId,
      role: session.role, scopes: session.scopes, cwd: root, runtime: session.runtime,
      resumeFromTranscript: false, dangerouslySkipPermissions: false },
    attempt: { attemptId: attempt.attemptId, serverInstanceId: owner.instanceId, generation: 1,
      runtimeDir: root, attachPath, statusPath: join(root, 'status.json'),
      stdoutLogPath: join(root, 'stdout.log'), stderrLogPath: join(root, 'stderr.log') },
  }
  let isBusy = false
  let destroys = 0
  const inputs: string[] = []
  let completeBackend!: () => void
  const backendReady = new Promise<void>(resolve => { completeBackend = resolve })
  let onSpawning!: () => void
  const spawning = new Promise<void>(resolve => { onSpawning = resolve })
  const handle: BackendHandle = {
    workDir: root, runtime: session.runtime, checkReady: async () => true, isBusy: () => isBusy,
    writeStdin: data => { inputs.push(data); isBusy = true },
    onStdoutLine: () => () => {}, onStderrLine: () => () => {}, onExit: () => () => {},
    destroy: async () => { destroys++ },
  }
  t.mock.method(RuntimeBackend.prototype, 'spawn', async () => {
    onSpawning()
    if (isBackendPending) await backendReady
    return handle
  })
  const daemon = new SessionRunnerDaemon(manifest, store)
  const barrier = new RuntimeInputBarrier(async () => [{ attemptId: attempt.attemptId, attachPath, isOwned: true }])
  const gate = new WorkAdmission()
  const pauses = new RuntimeAdmissionPauses(owner.instanceId, gate, barrier)
  const clients = new Set<Socket>()
  const started = daemon.start()
  t.after(async () => {
    completeBackend()
    await started.catch(() => {})
    barrier.close()
    for (const socket of clients) socket.destroy()
    await daemon.shutdown()
    assert(root.startsWith(join(tmpdir(), 'moss-admission-daemon-')))
    await rm(root, { recursive: true, force: true })
  })
  await spawning
  if (!isBackendPending) await started
  await writeFile(join(root, 'kept.txt'), 'retained workspace')
  const connect = async () => {
    const socket = createConnection(attachPath)
    clients.add(socket)
    socket.setEncoding('utf8')
    const events = new EventEmitter()
    const frames: Array<Record<string, unknown>> = []
    let buffer = ''
    socket.on('data', chunk => {
      buffer += String(chunk)
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        frames.push(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>)
        buffer = buffer.slice(index + 1)
        events.emit('frame')
      }
    })
    const next = async (type: string) => {
      for (;;) {
        const index = frames.findIndex(frame => frame.type === type)
        if (index >= 0) return frames.splice(index, 1)[0]!
        await once(events, 'frame')
      }
    }
    await once(socket, 'connect')
    const hello = await next('hello')
    assert.equal(hello.attemptId, attempt.attemptId)
    assert.equal(hello.inputPauseSupported, true)
    return { socket, next }
  }
  return { store, root, attempt, gate, pauses, inputs, connect,
    completeBackend: async () => { completeBackend(); await started },
    finishTurn: () => { isBusy = false }, destroys: () => destroys }
}

void test('real daemon maintenance preserves detached work and holds fresh stdin until every pause releases', { timeout: 15_000 }, async t => {
  const f = await fixture(t)
  const original = await f.connect()
  original.socket.end(JSON.stringify({ type: 'stdin', data: '保留原始输入' }) + '\n')
  await once(original.socket, 'close')
  assert.deepEqual(f.inputs, ['保留原始输入'])
  const busy = await f.pauses.pause('operator-one')
  assert.equal(busy.isInputDrained, false)
  assert.deepEqual(busy.connections, [{ attemptId: f.attempt.attemptId, state: 'busy' }])
  assert.equal(f.gate.isPaused, false)
  f.finishTurn()
  assert.equal((await f.pauses.pause('operator-one')).isInputDrained, true)
  const blocked = await f.connect()
  blocked.socket.write(JSON.stringify({ type: 'stdin', data: 'must be refused' }) + '\n')
  assert.equal((await blocked.next('error')).message, 'runtime_input_paused')
  assert.deepEqual(f.inputs, ['保留原始输入'])
  assert.equal((await f.pauses.pause('operator-two')).isInputDrained, true)
  assert.equal((await f.pauses.resume('operator-one')).isPaused, true)
  assert.equal((await f.pauses.resume('operator-two')).isPaused, false)
  const resumed = await f.connect()
  resumed.socket.write(JSON.stringify({ type: 'stdin', data: 'explicit new input' }) + '\n')
  await resumed.next('stdin_ack')
  assert.deepEqual(f.inputs, ['保留原始输入', 'explicit new input'])
  assert.equal(f.destroys(), 0, 'maintenance must never cancel the backend')
  assert.equal((await f.store.getSession('session'))?.transcriptSessionId, 'durable-transcript')
  assert.equal((await f.store.getSession('session'))?.currentAttemptId, f.attempt.attemptId)
  assert.equal(await readFile(join(f.root, 'kept.txt'), 'utf8'), 'retained workspace')
})

void test('real daemon refuses maintenance during startup and consumes accepted buffered input exactly once', { timeout: 15_000 }, async t => {
  const f = await fixture(t, true)
  const client = await f.connect()
  client.socket.write(JSON.stringify({ type: 'stdin', data: 'accepted before backend ready' }) + '\n')
  await client.next('stdin_ack')
  assert.deepEqual(f.inputs, [])
  const starting = await f.pauses.pause('operator')
  assert.equal(starting.isInputDrained, false)
  assert.equal(f.gate.isPaused, false)
  await f.completeBackend()
  assert.deepEqual(f.inputs, ['accepted before backend ready'])
  assert.equal((await f.pauses.pause('operator')).isInputDrained, false)
  assert.deepEqual(f.inputs, ['accepted before backend ready'])
  assert.equal(f.destroys(), 0)
})
