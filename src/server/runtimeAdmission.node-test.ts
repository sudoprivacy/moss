import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnection, createServer, type Socket } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { tmpdir } from 'node:os'
import { test, type TestContext } from 'node:test'
import { WorkAdmission, WorkAdmissionPausedError } from '@sudo/user-runtime'
import { RuntimeInputBarrier } from './runtime/runtimeInputBarrier.js'
import { RunnerInputAdmission } from './runtime/runnerInputAdmission.js'
import { RuntimeAdmissionPauses } from './runtime/runtimeAdmissionPauses.js'
import { DirectConnectStore } from './db.js'
import { RuntimeService } from './runtimeService.js'
import { getAttemptDir } from './runtimePaths.js'
import { CronService } from './services/cron/CronService.js'
import { EventTriggerService } from './services/eventTrigger/EventTriggerService.js'
import { openInternalSessionChannel } from './internalSessionChannel.js'
import { dispatchRuntimeAdmission } from './api/runtimeAdmission.js'
import { HttpError } from './httpError.js'
import type { AuthContext } from './auth/token.js'
import type { AuthService } from './auth/service.js'
import type { ServerConfig, SessionCreateInput } from './types.js'

interface RunnerFixtureOptions {
  respond?: (message: Record<string, unknown>, peer: Socket) => void
  supportsPause?: boolean
  activity?: () => Promise<{ isReady: boolean; isBusy?: boolean }>
  onResume?: (message: Record<string, unknown>, peer: Socket) => boolean
}

async function runner(t: TestContext, options: RunnerFixtureOptions = {}) {
  const peers = new Set<Socket>()
  const lines: string[] = []
  let isBusy = false
  let controlPeer: Socket | undefined
  const admission = new RunnerInputAdmission({ clients: () => peers,
    activity: options.activity ?? (async () => ({ isReady: true, isBusy })) })
  const server = createServer(peer => {
    peers.add(peer)
    peer.setEncoding('utf8')
    peer.on('close', () => { peers.delete(peer); admission.disconnected(peer) })
    const send = (value: Record<string, unknown>): void => {
      if (!peer.destroyed && peer.writable) peer.write(JSON.stringify(value) + '\n')
    }
    send({ type: 'hello', attemptId: 'attempt', inputPauseSupported: options.supportsPause !== false ? true : undefined })
    let buffer = ''
    peer.on('data', chunk => {
      buffer += String(chunk)
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const message = JSON.parse(line) as Record<string, unknown>
        lines.push(String(message.type))
        if (message.type === 'resume_input') {
          admission.resume(String(message.pauseId))
          if (options.onResume?.(message, peer)) continue
          send({ type: 'input_resumed', requestId: message.requestId, attemptId: 'attempt' })
          continue
        }
        if (message.type === 'pause_input') controlPeer = peer
        if (options.respond) { options.respond(message, peer); continue }
        if (message.type === 'stdin') {
          if (!admission.allowsInput(peer)) { send({ type: 'error', message: 'runtime_input_paused' }); continue }
          isBusy = true
          send({ type: 'stdin_ack' })
        }
        if (message.type === 'pause_input') {
          void admission.pause(String(message.pauseId), peer).then(result =>
            send({ type: 'input_paused', requestId: message.requestId, attemptId: 'attempt', ...result }))
        }
      }
    })
  })
  const address = process.platform === 'win32' ? '\\\\.\\pipe\\moss-admission-' + randomUUID()
    : join(tmpdir(), 'moss-admission-' + randomUUID() + '.sock')
  server.listen(address)
  await once(server, 'listening')
  const socket = createConnection(address)
  await once(socket, 'connect')
  socket.resume()
  t.after(async () => {
    inputs.close()
    socket.destroy()
    for (const peer of peers) peer.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const inputs = new RuntimeInputBarrier(async () => [{ attemptId: 'attempt', attachPath: address, isOwned: true }])
  return { socket, inputs, lines, admission, controlPeer: () => controlPeer, isBusy: () => isBusy }
}

void test('maintenance flushes already accepted input before accepting an idle observation', async t => {
  const f = await runner(t)
  const gate = new WorkAdmission()
  const pauses = new RuntimeAdmissionPauses('controller', gate, f.inputs)
  f.socket.cork()
  await gate.run(() => f.socket.write(`${JSON.stringify({ type: 'stdin', data: 'new turn' })}\n`))
  const preparing = pauses.pause('operator')
  assert.equal(gate.tryRun(() => assert.fail('new input')), undefined)
  f.socket.uncork()
  const receipt = await preparing
  assert.equal(receipt.isInputDrained, false)
  assert.equal(receipt.isPaused, false, 'busy work must remain usable after refusing maintenance')
  assert.deepEqual(receipt.connections, [{ attemptId: 'attempt', state: 'busy' }])
  assert.deepEqual(f.lines, ['stdin', 'pause_input', 'resume_input'], 'maintenance must not interrupt, shut down or replay work')
})

void test('idle fences are idempotent and releasing one operator preserves another fence', async t => {
  const f = await runner(t)
  const gate = new WorkAdmission()
  const pauses = new RuntimeAdmissionPauses('controller', gate, f.inputs)
  const [one, same] = await Promise.all([pauses.pause('one'), pauses.pause('one')])
  assert.equal(one.isInputDrained, true)
  assert.deepEqual(one, same)
  assert.deepEqual(f.lines, ['pause_input'])
  assert.equal((await pauses.pause('two')).isInputDrained, true)
  assert.equal((await pauses.resume('one')).isPaused, true)
  assert.equal((await pauses.resume('two')).isPaused, false)
})

void test('simultaneous maintenance preparations retain both daemon control holders', { timeout: 15_000 }, async t => {
  let release!: () => void
  let onBoth!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const both = new Promise<void>(resolve => { onBoth = resolve })
  t.after(() => release())
  let observations = 0
  const f = await runner(t, { activity: async () => {
    if (++observations <= 2) {
      if (observations === 2) onBoth()
      await wait
    }
    return { isReady: true, isBusy: false }
  } })
  const pauses = new RuntimeAdmissionPauses('controller', new WorkAdmission(), f.inputs)
  const preparing = Promise.all([pauses.pause('one'), pauses.pause('two')])
  await both
  release()
  assert.deepEqual((await preparing).map(state => state.isInputDrained), [true, true])
  assert.equal((await pauses.resume('one')).isPaused, true)
  assert.equal((await pauses.pause('two')).isInputDrained, true, 'the remaining control connection must stay live')
  assert.equal((await pauses.resume('two')).isPaused, false)
})

void test('an initially idle daemon waits for queued client bytes before reporting preparation', async t => {
  let fixture!: Awaited<ReturnType<typeof runner>>
  let observations = 0
  fixture = await runner(t, { activity: async () => {
    if (++observations === 1) {
      queueMicrotask(() => fixture.socket.uncork())
      return { isReady: true, isBusy: false }
    }
    return { isReady: true, isBusy: fixture.isBusy() }
  } })
  fixture.socket.cork()
  fixture.socket.write(`${JSON.stringify({ type: 'stdin', data: 'accepted but not consumed yet' })}\n`)
  const pauses = new RuntimeAdmissionPauses('controller', new WorkAdmission(), fixture.inputs)
  const state = await pauses.pause('operator')
  assert.equal(observations, 2)
  assert.equal(state.isInputDrained, false)
  assert.equal(state.isPaused, false)
  assert.deepEqual(state.connections, [{ attemptId: 'attempt', state: 'busy' }])
  assert.equal(fixture.lines.filter(type => type === 'stdin').length, 1)
})

void test('a disconnected browser cannot hide work already consumed by its daemon', async t => {
  const f = await runner(t)
  f.socket.end(`${JSON.stringify({ type: 'stdin', data: 'accepted before disconnect' })}\n`)
  await once(f.socket, 'close')
  const pauses = new RuntimeAdmissionPauses('controller', new WorkAdmission(), f.inputs)
  const state = await pauses.pause('operator')
  assert.equal(state.isInputDrained, false)
  assert.deepEqual(state.connections, [{ attemptId: 'attempt', state: 'busy' }])
  assert.equal(f.lines.filter(type => type === 'stdin').length, 1)
})

void test('resume during a slow readiness check cannot install a late daemon fence', async t => {
  let entered!: () => void
  let release!: () => void
  const isEntered = new Promise<void>(resolve => { entered = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  const f = await runner(t, { activity: async () => {
    entered()
    await wait
    return { isReady: true, isBusy: false }
  } })
  const preparing = f.inputs.pause('operator', 5000)
  await isEntered
  const control = f.controlPeer()
  assert(control)
  f.admission.resume('operator')
  release()
  assert.equal((await preparing)[0]?.state, 'unavailable')
  assert.equal(f.admission.allowsInput(control), true)
  await f.inputs.resume('operator')
})

void test('a new preparation waits for an earlier release of the same operator id', async t => {
  const f = await runner(t)
  const gate = new WorkAdmission()
  const pauses = new RuntimeAdmissionPauses('controller', gate, f.inputs)
  const first = pauses.pause('operator')
  const resume = pauses.resume('operator')
  const next = pauses.pause('operator')
  assert.equal((await first).isInputDrained, true)
  assert.equal((await resume).isPaused, false)
  assert.equal((await next).isInputDrained, true)
  assert.equal(gate.isPaused, true)
  await pauses.resume('operator')
})

void test('an unconfirmed release retains the controller fence and supports an idempotent retry', async t => {
  let resumeRequests = 0
  const f = await runner(t, { onResume: (_message, peer) => {
    if (resumeRequests++ === 0) { peer.destroy(); return true }
    return false
  } })
  const gate = new WorkAdmission()
  const pauses = new RuntimeAdmissionPauses('controller', gate, f.inputs)
  assert.equal((await pauses.pause('operator')).isInputDrained, true)
  await assert.rejects(pauses.resume('operator'), /release is unconfirmed/)
  assert.equal(gate.isPaused, true)
  assert.deepEqual(pauses.snapshot().pauseIds, ['operator'])
  assert.equal((await pauses.resume('operator')).isPaused, false)
  assert.equal(resumeRequests, 2)
})

void test('controller closure cancels pending preparation without reopening control channels', async t => {
  let entered!: () => void
  let release!: () => void
  const isEntered = new Promise<void>(resolve => { entered = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  const f = await runner(t, { activity: async () => {
    entered()
    await wait
    return { isReady: true, isBusy: false }
  } })
  const preparing = f.inputs.pause('operator', 5000)
  const refusal = assert.rejects(preparing, /services are closed/)
  await isEntered
  f.inputs.close()
  release()
  await refusal
  await assert.rejects(f.inputs.pause('later', 5000), /services are closed/)
  assert.equal(f.lines.filter(type => type === 'pause_input').length, 1)
})

for (const mode of ['old-protocol', 'wrong-attempt', 'not-ready', 'missing-activity', 'disconnected'] as const) {
  void test(`maintenance refuses an uncertain runner: ${mode}`, async t => {
    const f = await runner(t, { respond: (message, peer) => {
      if (mode === 'disconnected') { peer.destroy(); return }
      peer.write(`${JSON.stringify({ type: 'input_paused', requestId: mode === 'old-protocol' ? undefined : message.requestId,
        attemptId: mode === 'wrong-attempt' ? 'another' : 'attempt',
        isInputDrained: mode !== 'not-ready',
        isReady: mode !== 'not-ready', isBusy: mode === 'missing-activity' ? undefined : false })}\n`)
    }, supportsPause: mode !== 'old-protocol' })
    const gate = new WorkAdmission()
    const pauses = new RuntimeAdmissionPauses('controller', gate, f.inputs, 100)
    const state = await pauses.pause('operator')
    assert.equal(state.isInputDrained, false)
    assert.equal(state.isPaused, false)
    assert.equal(state.connections?.[0]?.state, 'unavailable')
  })
}

void test('maintenance requires a verified manifest creator and respects automatically assigned instance IDs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-admission-creator-'))
  const store = new DirectConnectStore(':memory:')
  t.after(async () => {
    await store.close()
    assert(root.startsWith(join(tmpdir(), 'moss-admission-creator-')))
    await rm(root, { recursive: true, force: true })
  })
  const config = { runtimeDir: root } as ServerConfig
  const runtime = new RuntimeService({ store, config, authService: {} as AuthService, serverInstanceId: 'controller' })
  await store.createSession({ sessionId: 'session', transcriptSessionId: 'durable', transcriptPath: join(root, 'transcript.jsonl'),
    userId: 'owner', orgId: 'org', role: 'user', scopes: [],
    cwd: root, runtime: { type: 'cohost', engine: 'scode' }, status: 'active', desiredState: 'active' })
  const attempt = await store.createAttempt({ sessionId: 'session', generation: 1, backendType: 'cohost', resumeTranscriptSessionId: 'durable',
    serverInstanceId: 'controller', attachPath: 'unused-while-unverified' })
  const expected = [{ attemptId: attempt.attemptId, attachPath: attempt.attachPath, isOwned: false }]
  assert.deepEqual(await runtime.listRuntimeInputEndpoints(), expected, 'missing creator cannot authorize maintenance')
  const directory = getAttemptDir(config, 'session', 1)
  await mkdir(directory, { recursive: true })
  for (const fixture of [
    { manifest: '{', isOwned: false },
    { manifest: '{}', isOwned: false },
    { manifest: JSON.stringify({ attempt: { serverInstanceId: 7 } }), isOwned: false },
    { manifest: JSON.stringify({ config: { instanceId: 'peer' } }), isOwned: false },
    { manifest: JSON.stringify({ attempt: { serverInstanceId: 'peer' }, config: { instanceId: 'controller' } }), isOwned: false },
    { manifest: JSON.stringify({ attempt: { serverInstanceId: 'controller' }, config: { instanceId: 'peer' } }), isOwned: true },
    { manifest: JSON.stringify({ attempt: { serverInstanceId: 'controller' }, config: {} }), isOwned: true },
    { manifest: JSON.stringify({ config: { instanceId: 'controller' } }), isOwned: true },
  ]) {
    await writeFile(join(directory, 'manifest.json'), fixture.manifest)
    assert.deepEqual(await runtime.listRuntimeInputEndpoints(), [{ ...expected[0]!, isOwned: fixture.isOwned }])
  }
  assert.deepEqual(await store.getAttempt(attempt.attemptId), attempt, 'discovery must not adopt or mutate the attempt')
})

void test('paused runtime refuses Session creation and leaves queued work and schedules untouched', async t => {
  const store = new DirectConnectStore(':memory:')
  t.after(() => store.close())
  const runtime = new RuntimeService({ store, config: { maxSessions: 0 } as ServerConfig,
    authService: {} as AuthService, serverInstanceId: 'controller' })
  const config = { runtimeService: runtime, runtimeDir: tmpdir(), defaultRuntime: 'host' as const,
    dockerContainerMode: 'session' as const, getUserAuth: async () => null }
  const cron = new CronService(store.driver, config)
  const events = new EventTriggerService(store.driver, config)
  const job = await cron.getStore().insert({ orgId: 'org', userId: 'user', name: 'scheduled',
    schedule: { kind: 'every', value: '1m' }, conversationMode: 'new', payloadMessage: 'work' })
  await cron.getStore().updateNextRunAt(job.id, 1)
  const { trigger } = await events.getStore().insert({ orgId: 'org', userId: 'user', name: 'event', promptTemplate: 'work' })
  const queued = await events.getStore().createRun({ triggerId: trigger.id, orgId: 'org', userId: 'user', payloadJson: '{}' })
  assert(queued)
  const before = await cron.getStore().getById(job.id)
  runtime.workAdmission.pause()
  await assert.rejects(runtime.createSession({ orgId: 'org', userId: 'user' } as SessionCreateInput), WorkAdmissionPausedError)
  await assert.rejects(cron.triggerJob(job.id), WorkAdmissionPausedError)
  await (cron as unknown as { executeDueJob(id: string): Promise<void> }).executeDueJob(job.id)
  await events.tickOnce()
  assert.deepEqual(await cron.getStore().getById(job.id), before)
  assert.deepEqual(await cron.getStore().listRunsByJob(job.id), [])
  assert.deepEqual(await events.getStore().getRunById(queued.id), queued)
  assert.deepEqual(await store.listSessions({ orgId: 'org' }), [])
})

void test('operator controls reject unauthorized actors, stale instances and live peers before pausing', async () => {
  const gate = new WorkAdmission()
  const pauses = new RuntimeAdmissionPauses('controller', gate, new RuntimeInputBarrier(async () => []))
  const path = '/api/v1/admin/runtime-admission/pauses/00000000-0000-0000-0000-000000000001'
  let isAuthorized = false
  let peers = 0
  const context = { instanceId: 'controller', pauses, countLiveOtherInstances: async () => peers,
    authService: { requireSuperAdmin: async () => { if (!isAuthorized) throw new HttpError(403, 'Forbidden') } } }
  const auth = {} as AuthContext
  const body = { instanceId: 'controller', epochId: gate.epochId }
  assert.equal(typeof body.epochId, 'string')
  await assert.rejects(dispatchRuntimeAdmission(auth, 'PUT', path, body, context),
    (error: unknown) => error instanceof HttpError && error.statusCode === 403)
  assert.equal(gate.isPaused, false)
  isAuthorized = true
  await assert.rejects(dispatchRuntimeAdmission(auth, 'PUT', path, { ...body, instanceId: 'old-controller' }, context), /Controller instance changed/)
  assert.equal(gate.isPaused, false)
  peers = 1
  await assert.rejects(dispatchRuntimeAdmission(auth, 'PUT', path, body, context), /Drain peer Moss/)
  assert.equal(gate.isPaused, false)
  peers = 0
  const result = await dispatchRuntimeAdmission(auth, 'PUT', path, body, context)
  assert.equal(result.status, 200)
  assert.equal(result.body.isInputDrained, true)
  const restarted = new WorkAdmission()
  const nextPauses = new RuntimeAdmissionPauses('controller', restarted, new RuntimeInputBarrier(async () => []))
  await nextPauses.pause('new-operator')
  await assert.rejects(dispatchRuntimeAdmission(auth, 'DELETE', path, body, { ...context, pauses: nextPauses }), /Controller instance changed/)
  assert.equal(restarted.isPaused, true, 'a stale request cannot release a new controller fence')
  await nextPauses.resume('new-operator')
  assert.equal((await dispatchRuntimeAdmission(auth, 'DELETE', path, body, context)).body.isPaused, false)
})

void test('an admitted job continues over its authenticated real WebSocket after a pause', { timeout: 15_000 }, async t => {
  const gate = new WorkAdmission()
  const server = createHttpServer()
  const sockets = new WebSocketServer({ noServer: true })
  let acceptedFrames = 0
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.authorization !== 'Bearer fixture') { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return }
    const continuation = req.headers['x-moss-work-admission']
    assert.equal(typeof continuation, 'string')
    const accepted = gate.tryRunContinuation(continuation as string, () => sockets.handleUpgrade(req, socket, head, peer => {
      peer.on('message', () => {
        const frame = gate.tryRunContinuation(continuation as string, () => { acceptedFrames++; peer.send('accepted') })
        if (!frame) peer.send('refused')
      })
    }))
    if (!accepted) socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  t.after(async () => {
    for (const client of sockets.clients) client.terminate()
    sockets.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  let channel!: Awaited<ReturnType<typeof openInternalSessionChannel>>
  await gate.run(async () => {
    const admissionContinuation = gate.captureContinuation()
    assert(admissionContinuation)
    gate.pause()
    channel = await openInternalSessionChannel({ admissionContinuation,
      authService: { issueInternalChannelToken: async () => ({ access_token: 'fixture' }) } as unknown as AuthService,
      store: { getSession: async () => ({ userId: 'user', orgId: 'org' }) } as unknown as DirectConnectStore,
      config: { host: '127.0.0.1', port: address.port } as ServerConfig,
    }, 'session', { maxAttempts: 1, handshakeTimeoutMs: 5000 })
    const first = once(channel, 'data')
    channel.write(JSON.stringify({ type: 'stdin', data: 'accepted job' }))
    assert.match(String((await first)[0]), /accepted/)
  })
  const late = once(channel, 'data')
  channel.write(JSON.stringify({ type: 'stdin', data: 'expired job' }))
  assert.match(String((await late)[0]), /refused/)
  assert.equal(acceptedFrames, 1)
  channel.end()
})
