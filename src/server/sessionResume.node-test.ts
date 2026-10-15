import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import { DirectConnectStore } from './db.js'
import { HttpError } from './httpError.js'
import { RuntimeService, AttemptTakeoverPendingError, ServerDrainingError } from './runtimeService.js'
import { SessionStartupError } from './sessionStartup.js'
import { respondAfterSessionResume, waitForSessionResume } from './sessionResume.js'
import type { AttemptRecord, ServerConfig, SessionRecord } from './types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const ready = { session: { sessionId: 'session', desiredState: 'active' } as SessionRecord,
  attempt: { attemptId: 'attempt' } as AttemptRecord }

for (const fixedIdentity of [false, true]) {
  void test(`restart with ${fixedIdentity ? 'fixed' : 'random'} identity waits for safe recovery and shares one spawn`, { timeout: 10_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'moss-resume-'))
    const store = new DirectConnectStore(':memory:')
    const socket = createServer(client => client.end())
    t.after(async () => {
      await new Promise<void>(resolve => socket.close(() => resolve()))
      await store.close()
      await rm(root, { recursive: true, force: true })
    })
    const instanceId = fixedIdentity ? 'moss-server' : undefined
    const before = await store.registerServerInstance('old-pod', 111, instanceId)
    await store.createSession({ sessionId: 'session', transcriptSessionId: 'transcript',
      transcriptPath: join(root, 'transcript.jsonl'), userId: 'user', orgId: 'org', role: 'user', scopes: [],
      cwd: root, runtime: { type: 'host', engine: 'scode' } as never, status: 'active', desiredState: 'active' })
    const old = await store.createAttempt({ sessionId: 'session', generation: 1, backendType: 'host',
      resumeTranscriptSessionId: 'transcript', serverInstanceId: before.instanceId,
      attachPath: join(root, 'old.sock') })
    await store.setCurrentAttempt('session', old.attemptId)
    await store.updateAttemptRunner(old.attemptId, 999999999)
    await store.touchAttemptHeartbeat(old.attemptId, 'running', before.instanceId)
    await store.stopServerInstance(before.instanceId)
    const after = await store.registerServerInstance('new-pod', 222, instanceId)
    const runtime = new RuntimeService({ config: { instanceId, runtimeDir: root,
      defaultRuntime: 'host', heartbeatTimeoutMs: 30000, reattachProbeTimeoutMs: 20,
      resumeOnMissingRuntime: true } as ServerConfig, store, authService: {} as never,
      serverInstanceId: after.instanceId })
    await runtime.reconcileOnStartup()

    // Keep the real ownership, heartbeat, lost-state and ensure serialization
    // paths. Only replace the external runner launch with a controllable socket.
    let spawns = 0
    const spawnStarted = deferred<void>()
    const allowSpawn = deferred<void>()
    const mutable = runtime as unknown as { spawnAttempt(session: SessionRecord): Promise<AttemptRecord> }
    mutable.spawnAttempt = async session => {
      spawns++
      assert.equal((await store.getAttempt(old.attemptId))?.runtimeState, 'lost')
      spawnStarted.resolve()
      await allowSpawn.promise
      const attachPath = process.platform === 'win32' ? `\\\\.\\pipe\\moss-resume-${randomUUID()}` : join(root, 'new.sock')
      await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(attachPath, resolve) })
      const attempt = await store.createAttempt({ sessionId: session.sessionId, generation: 2, backendType: 'host',
        resumeTranscriptSessionId: 'transcript', serverInstanceId: after.instanceId, attachPath })
      await store.setCurrentAttempt(session.sessionId, attempt.attemptId)
      await store.touchAttemptHeartbeat(attempt.attemptId, 'running', after.instanceId)
      return attempt
    }

    let pending = 0
    const allPending = deferred<void>()
    const ensure = runtime.ensureSessionReady.bind(runtime)
    runtime.ensureSessionReady = async sessionId => {
      try { return await ensure(sessionId) }
      catch (error) {
        if (error instanceof AttemptTakeoverPendingError && ++pending >= 3) allPending.resolve()
        throw error
      }
    }
    const controller = new AbortController()
    const first = waitForSessionResume(runtime, 'session', { timeoutMs: 2000, retryDelayMs: 5 })
    const second = waitForSessionResume(runtime, 'session', { timeoutMs: 2000, retryDelayMs: 5 })
    const cancelled = waitForSessionResume(runtime, 'session', { signal: controller.signal, timeoutMs: 2000, retryDelayMs: 5 })
    const cancellation = assert.rejects(cancelled, { name: 'AbortError' })
    await allPending.promise
    assert.equal(spawns, 0, 'a fresh old heartbeat must not start a second runner')
    assert.equal((await store.getAttempt(old.attemptId))?.runtimeState, 'running')

    // The old runner is now definitively stale. Fencing remains the authority.
    store.requireSqliteDb().prepare('UPDATE session_attempts SET last_heartbeat_at=? WHERE attempt_id=?')
      .run(Date.now() - 60000, old.attemptId)
    await spawnStarted.promise
    controller.abort()
    await cancellation
    allowSpawn.resolve()
    const resumed = await Promise.all([first, second])
    assert.equal(spawns, 1, 'concurrent resume calls and one cancellation share a single spawn')
    assert.equal(resumed[0].attempt.attemptId, resumed[1].attempt.attemptId)
    assert.equal(resumed[0].attempt.generation, 2)
    assert.equal(resumed[0].attempt.serverInstanceId, after.instanceId)
  })
}

void test('resume waits for native recovery when its local bridge still accepts connections', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-native-resume-'))
  const store = new DirectConnectStore(':memory:')
  const attachPath = process.platform === 'win32' ? `\\\\.\\pipe\\moss-native-${randomUUID()}` : join(root, 'bridge.sock')
  let isNativeReady = false
  let probes = 0
  const server = createServer(client => {
    client.on('data', data => {
      assert.equal(JSON.parse(data.toString()).type, 'ping')
      probes++
      client.end(`${JSON.stringify({ type: 'pong', ts: Date.now(), isReady: isNativeReady })}\n`)
    })
  })
  server.listen(attachPath)
  await once(server, 'listening')
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  const instance = await store.registerServerInstance('moss', process.pid)
  await store.createSession({ sessionId: 'native', transcriptSessionId: 'transcript',
    transcriptPath: join(root, 'transcript.jsonl'), userId: 'user', orgId: 'org', role: 'user', scopes: [],
    cwd: root, runtime: { type: 'cohost', engine: 'scode' } as never, status: 'active', desiredState: 'active' })
  const old = await store.createAttempt({ sessionId: 'native', generation: 1, backendType: 'cohost',
    resumeTranscriptSessionId: 'transcript', serverInstanceId: instance.instanceId, attachPath })
  await store.setCurrentAttempt('native', old.attemptId)
  await store.touchAttemptHeartbeat(old.attemptId, 'running', instance.instanceId)
  const runtime = new RuntimeService({ config: { runtimeDir: root, heartbeatTimeoutMs: 30000,
    reattachProbeTimeoutMs: 100, resumeOnMissingRuntime: true } as ServerConfig,
    store, authService: {} as never, serverInstanceId: instance.instanceId })
  await assert.rejects(runtime.ensureSessionReady('native'), AttemptTakeoverPendingError)
  assert.equal((await store.getAttempt(old.attemptId))?.runtimeState, 'running', 'unavailability alone cannot release a writer lease')
  let isResumed = false
  const resumed = waitForSessionResume(runtime, 'native', { timeoutMs: 3000, retryDelayMs: 5 })
    .then(result => { isResumed = true; return result })
  await delay(30)
  assert.equal(isResumed, false)
  // Model the old bridge observing definitive native loss. A fresh attempt is
  // created by the existing recovery path; the logical session remains intact.
  let spawns = 0
  const mutable = runtime as unknown as { spawnAttempt(session: SessionRecord): Promise<AttemptRecord> }
  mutable.spawnAttempt = async session => {
    spawns++
    assert.equal(session.sessionId, 'native')
    const next = await store.createAttempt({ sessionId: session.sessionId, generation: 2, backendType: 'cohost',
      resumeTranscriptSessionId: 'transcript', serverInstanceId: instance.instanceId, attachPath })
    await store.setCurrentAttempt(session.sessionId, next.attemptId)
    await store.touchAttemptHeartbeat(next.attemptId, 'running', instance.instanceId)
    isNativeReady = true
    return next
  }
  await store.markAttemptStopped(old.attemptId, { runtimeState: 'failed', exitCode: null,
    exitSignal: null, stopReason: 'runtime_exit', errorText: 'native Pod disappeared' }, instance.instanceId)
  const result = await resumed
  assert.equal(spawns, 1)
  assert.equal(result.session.sessionId, 'native')
  assert.equal(result.attempt.generation, 2)
  assert(probes >= 2)
})

async function fencingFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'moss-fencing-generation-'))
  const store = new DirectConnectStore(':memory:')
  const attachPath = process.platform === 'win32' ? `\\\\.\\pipe\\moss-fence-${randomUUID()}` : join(root, 'bridge.sock')
  let isNativeReady = false
  const server = createServer(client => {
    client.on('data', () => client.end(`${JSON.stringify({ type: 'pong', ts: Date.now(), isReady: isNativeReady })}\n`))
  })
  server.listen(attachPath)
  await once(server, 'listening')
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  const instance = await store.registerServerInstance('moss', process.pid)
  await store.createSession({ sessionId: 'native', transcriptSessionId: 'transcript',
    transcriptPath: join(root, 'transcript.jsonl'), userId: 'user', orgId: 'org', role: 'user', scopes: [],
    cwd: root, runtime: { type: 'cohost', engine: 'scode' } as never, status: 'active', desiredState: 'active' })
  const createAttempt = async (generation: number) => {
    const attempt = await store.createAttempt({ sessionId: 'native', generation, backendType: 'cohost',
      resumeTranscriptSessionId: 'transcript', serverInstanceId: instance.instanceId, attachPath })
    await store.setCurrentAttempt('native', attempt.attemptId)
    await store.touchAttemptHeartbeat(attempt.attemptId, 'running', instance.instanceId)
    return attempt
  }
  const old = await createAttempt(1)
  const runtime = new RuntimeService({ config: { runtimeDir: root, defaultRuntime: 'cohost',
    heartbeatTimeoutMs: 30_000, reattachProbeTimeoutMs: 20, resumeOnMissingRuntime: true } as ServerConfig,
  store, authService: {} as never, serverInstanceId: instance.instanceId })
  const mutable = runtime as unknown as { spawnAttempt(session: SessionRecord): Promise<AttemptRecord> }
  mutable.spawnAttempt = async () => { throw new Error('Unexpected external runner launch') }
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve))
  }
  return { runtime, store, instance, old, createAttempt, flush,
    setReady: () => { isNativeReady = true } }
}

void test('a fencing deadline cannot retire the healthy replacement of its original attempt', async t => {
  const f = await fencingFixture(t)
  const started = Date.now()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: started })
  try {
    await assert.rejects(f.runtime.ensureSessionReady('native'), AttemptTakeoverPendingError)
    t.mock.timers.setTime(started + 100_000)
    const next = await f.createAttempt(2)
    t.mock.timers.tick(5000)
    await f.flush()
    assert.equal((await f.store.getAttempt(next.attemptId))?.runtimeState, 'running')
    assert.equal((await f.store.getSession('native'))?.currentAttemptId, next.attemptId)
  } finally { t.mock.timers.reset() }
})

for (const isNonBlocking of [false, true]) {
  void test(`${isNonBlocking ? 'background' : 'foreground'} native readiness cancels its obsolete fencing deadline`, async t => {
    const f = await fencingFixture(t)
    const started = Date.now()
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: started })
    try {
      await assert.rejects(f.runtime.ensureSessionReady('native'), AttemptTakeoverPendingError)
      f.setReady()
      if (isNonBlocking) await f.runtime.ensureSessionReadyNonBlocking('native')
      else await f.runtime.ensureSessionReady('native')
      t.mock.timers.setTime(started + 100_000)
      await f.store.touchAttemptHeartbeat(f.old.attemptId, 'running', f.instance.instanceId)
      t.mock.timers.tick(5000)
      await f.flush()
      assert.equal((await f.store.getAttempt(f.old.attemptId))?.runtimeState, 'running')
      assert.equal((await f.store.getSession('native'))?.currentAttemptId, f.old.attemptId)
    } finally { t.mock.timers.reset() }
  })
}

void test('a fencing deadline yields when another controller has claimed the same attempt', async t => {
  const f = await fencingFixture(t)
  const started = Date.now()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: started })
  try {
    await assert.rejects(f.runtime.ensureSessionReady('native'), AttemptTakeoverPendingError)
    await f.store.stopServerInstance(f.instance.instanceId)
    const other = await f.store.registerServerInstance('other-moss', process.pid)
    assert.equal(await f.store.claimAttempt(f.old.attemptId, other.instanceId, 30_000), true)
    t.mock.timers.setTime(started + 100_000)
    await f.store.touchAttemptHeartbeat(f.old.attemptId, 'running', other.instanceId)
    t.mock.timers.tick(5000)
    await f.flush()
    assert.equal((await f.store.getAttempt(f.old.attemptId))?.runtimeState, 'running')
    assert.equal((await f.store.getAttempt(f.old.attemptId))?.serverInstanceId, other.instanceId)
    assert.equal(await f.store.latestEvent('native', 'attempt_lost'), null)
  } finally { t.mock.timers.reset() }
})

void test('termination cancels a pending fencing deadline without restarting the session', async t => {
  const f = await fencingFixture(t)
  const started = Date.now()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: started })
  try {
    await assert.rejects(f.runtime.ensureSessionReady('native'), AttemptTakeoverPendingError)
    await f.store.markSessionEnded('native', 'terminated', 'terminated')
    t.mock.timers.setTime(started + 100_000)
    await f.store.touchAttemptHeartbeat(f.old.attemptId, 'running', f.instance.instanceId)
    t.mock.timers.tick(5000)
    await f.flush()
    assert.equal((await f.store.getSession('native'))?.desiredState, 'terminated')
    assert.equal((await f.store.getSession('native'))?.currentAttemptId, f.old.attemptId)
    assert.equal((await f.store.getAttempt(f.old.attemptId))?.runtimeState, 'running')
  } finally { t.mock.timers.reset() }
})

void test('a still unreachable original attempt is fenced and resumed at its own deadline', async t => {
  const f = await fencingFixture(t)
  const started = Date.now()
  let spawns = 0
  const mutable = f.runtime as unknown as { spawnAttempt(session: SessionRecord): Promise<AttemptRecord> }
  mutable.spawnAttempt = async () => { spawns++; return f.createAttempt(2) }
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: started })
  try {
    await assert.rejects(f.runtime.ensureSessionReady('native'), AttemptTakeoverPendingError)
    t.mock.timers.setTime(started + 100_000)
    await f.store.touchAttemptHeartbeat(f.old.attemptId, 'running', f.instance.instanceId)
    t.mock.timers.tick(5000)
    await f.flush()
    assert.equal((await f.store.getAttempt(f.old.attemptId))?.runtimeState, 'lost')
    assert.equal(spawns, 1)
    assert.notEqual((await f.store.getSession('native'))?.currentAttemptId, f.old.attemptId)
  } finally { t.mock.timers.reset() }
})

void test('a superseded poll cannot remove or shorten the replacement attempt fencing wait', async t => {
  const f = await fencingFixture(t)
  const started = Date.now()
  let spawns = 0
  const mutable = f.runtime as unknown as { spawnAttempt(session: SessionRecord): Promise<AttemptRecord> }
  mutable.spawnAttempt = async () => { spawns++; return f.createAttempt(3) }
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: started })
  try {
    await assert.rejects(f.runtime.ensureSessionReady('native'), AttemptTakeoverPendingError)
    t.mock.timers.setTime(started + 50_000)
    const next = await f.createAttempt(2)
    await assert.rejects(f.runtime.ensureSessionReady('native'), AttemptTakeoverPendingError)
    t.mock.timers.setTime(started + 100_000)
    await f.store.touchAttemptHeartbeat(next.attemptId, 'running', f.instance.instanceId)
    t.mock.timers.tick(5000)
    await f.flush()
    assert.equal((await f.store.getAttempt(next.attemptId))?.runtimeState, 'running')
    assert.equal(spawns, 0, 'the old deadline cannot fence the replacement early')
    t.mock.timers.setTime(started + 150_000)
    await f.store.touchAttemptHeartbeat(next.attemptId, 'running', f.instance.instanceId)
    t.mock.timers.tick(5000)
    await f.flush()
    assert.equal((await f.store.getAttempt(next.attemptId))?.runtimeState, 'lost')
    assert.equal(spawns, 1, 'the replacement keeps its own deadline')
  } finally { t.mock.timers.reset() }
})

void test('resume only retries takeover; resource, startup and draining errors remain immediate', async () => {
  for (const failure of [new HttpError(403, 'Forbidden'), new SessionStartupError(new Error('startup failed')),
    new ServerDrainingError(), new Error('Unexpected failure')]) {
    let calls = 0
    const runtime = { getSession: async () => ready.session,
      ensureSessionReady: async () => { calls++; throw failure } }
    await assert.rejects(waitForSessionResume(runtime, 'session'), error => error === failure)
    assert.equal(calls, 1)
  }
})

void test('resume deadline bounds an in-flight ensure and tolerates its later rejection', async () => {
  const pending = deferred<void>()
  let calls = 0
  const runtime = { getSession: async () => ready.session, ensureSessionReady: async () => {
    calls++
    await pending.promise
    throw new Error('late shared spawn failure')
  } }
  await assert.rejects(waitForSessionResume(runtime, 'session', { timeoutMs: 20 }), AttemptTakeoverPendingError)
  pending.resolve()
  await delay(10)
  assert.equal(calls, 1)
})

void test('resume deadline and disconnect stop takeover polling', async () => {
  for (const disconnect of [false, true]) {
    const controller = new AbortController()
    let calls = 0
    const started = deferred<void>()
    const runtime = { getSession: async () => ready.session, ensureSessionReady: async () => {
      calls++
      started.resolve()
      throw new AttemptTakeoverPendingError('session')
    } }
    const waiting = waitForSessionResume(runtime, 'session', { signal: controller.signal, timeoutMs: 20, retryDelayMs: 1000 })
    const rejected = assert.rejects(waiting, disconnect ? { name: 'AbortError' } : AttemptTakeoverPendingError)
    await started.promise
    if (disconnect) controller.abort()
    await rejected
    await delay(10)
    assert.equal(calls, 1)
  }
})

void test('an already disconnected resume never calls the runtime', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(waitForSessionResume({ getSession: async () => ready.session,
    ensureSessionReady: async () => { assert.fail('must not start work'); return ready } }, 'session',
  { signal: controller.signal }), { name: 'AbortError' })
})

void test('termination while waiting wins over the earlier resume intent', async () => {
  let calls = 0
  const runtime = { getSession: async () => ({ ...ready.session, desiredState: 'terminated' as const }),
    ensureSessionReady: async () => { calls++; throw new AttemptTakeoverPendingError('session') } }
  await assert.rejects(waitForSessionResume(runtime, 'session', { retryDelayMs: 1 }),
    error => error instanceof HttpError && error.statusCode === 409)
  assert.equal(calls, 1, 'a terminate must not be followed by another ensure')
})

void test('response owner metadata shares the resume deadline and cannot reply after expiry', async () => {
  const ownerLookup = deferred<void>()
  let replied = false
  await assert.rejects(waitForSessionResume({ getSession: async () => ready.session,
    ensureSessionReady: async () => ready }, 'session', {
    timeoutMs: 20,
    complete: async (_ready, signal) => {
      await ownerLookup.promise
      signal.throwIfAborted()
      replied = true
    },
  }), AttemptTakeoverPendingError)
  ownerLookup.resolve()
  await delay(10)
  assert.equal(replied, false)
})

for (const disconnect of [false, true]) {
  void test(`HTTP ${disconnect ? 'disconnect cancels waiting' : 'normal request end preserves waiting'}`, { timeout: 10_000 }, async t => {
    const started = deferred<void>()
    const requestEnded = deferred<void>()
    const recovered = deferred<void>()
    const handled = deferred<void>()
    let calls = 0
    let responded = false
    let handlerError: unknown
    const runtime = { getSession: async () => ready.session, ensureSessionReady: async () => {
      calls++
      started.resolve()
      await recovered.promise
      return ready
    } }
    const server = createHttpServer((req, res) => {
      req.once('end', () => requestEnded.resolve())
      req.resume()
      void respondAfterSessionResume(runtime, 'session', req, res, async (_ready, signal) => {
        signal.throwIfAborted()
        responded = true
        res.end('ready')
      }, { timeoutMs: 1000 }).catch(error => { handlerError = error }).finally(() => handled.resolve())
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(async () => {
      recovered.resolve()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const req = httpRequest({ hostname: '127.0.0.1', port: address.port, method: 'POST',
      path: '/api/v1/sessions/session/resume', headers: { 'content-type': 'application/json' } })
    req.on('error', () => {})
    const response = disconnect ? undefined : new Promise<string>((resolve, reject) => {
      req.once('error', reject)
      req.once('response', res => {
        let body = ''
        res.on('data', chunk => { body += chunk })
        res.once('end', () => resolve(body))
      })
    })
    req.end('{}')
    await Promise.all([started.promise, requestEnded.promise])
    assert.equal(responded, false)
    if (disconnect) {
      req.destroy()
      await handled.promise
      recovered.resolve()
      await delay(10)
      assert.equal(responded, false, 'a late shared ensure must not reply to a disconnected HTTP request')
    } else {
      recovered.resolve()
      assert.equal(await response, 'ready')
      await handled.promise
      assert.equal(responded, true)
    }
    assert.equal(handlerError, undefined)
    assert.equal(calls, 1)
  })
}
