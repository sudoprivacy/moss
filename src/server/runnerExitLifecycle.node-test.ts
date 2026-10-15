import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { DirectConnectStore } from './db.js'
import { getAttachPath } from './runtimePaths.js'
import type { BackendHandle } from './sessionManager.js'
import type { RunnerManifest, ServerConfig } from './types.js'

// Load the feature configuration used by the production Node bundle.
const featureAlias = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'bun:bundle'
      ? new URL('../../scripts/bun-bundle-feature.js', import.meta.url).href
      : specifier, context)
  },
})
const [{ RuntimeBackend }, { SessionRunnerDaemon }] = await (async () => {
  try {
    return await Promise.all([import('./backends/runtimeBackend.js'), import('./sessionRunnerDaemon.js')])
  } finally {
    featureAlias.deregister()
  }
})()

interface ExitCase {
  name: string
  trigger: 'idle' | 'signal' | 'protocol' | 'runtime'
  code: number | null
  signal: NodeJS.Signals | null
  state: 'stopped' | 'failed'
  desired: 'active' | 'ended' | 'terminated'
  stderr?: string
  error?: string
}

const cases: ExitCase[] = [
  { name: 'idle managed close without an OS code', trigger: 'idle', code: null, signal: null, state: 'stopped', desired: 'active' },
  { name: 'requested SIGTERM without an exit code', trigger: 'signal', code: null, signal: 'SIGTERM', state: 'stopped', desired: 'active' },
  { name: 'explicit termination over the runner socket', trigger: 'protocol', code: null, signal: null, state: 'stopped', desired: 'terminated' },
  { name: 'natural successful exit', trigger: 'runtime', code: 0, signal: null, state: 'stopped', desired: 'ended' },
  { name: 'unexpected managed disconnect', trigger: 'runtime', code: null, signal: null, state: 'failed', desired: 'active' },
  { name: 'unexpected backend failure', trigger: 'runtime', code: 1, signal: null, state: 'failed', desired: 'active', stderr: 'backend execution failed' },
  { name: 'backend failure during requested shutdown', trigger: 'signal', code: 1, signal: null, state: 'failed', desired: 'active', stderr: 'backend cleanup failed' },
  { name: 'transport error during requested shutdown', trigger: 'signal', code: null, signal: null, state: 'failed', desired: 'active', error: 'managed transport cleanup failed' },
  { name: 'unexpected managed transport error', trigger: 'runtime', code: null, signal: null, state: 'failed', desired: 'active', error: 'managed connection lost' },
]

for (const scenario of cases) {
  void test(`runner exit preserves SQLite lifecycle: ${scenario.name}`, { timeout: 15_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'moss-runner-exit-'))
    const database = join(root, 'moss.db')
    const store = new DirectConnectStore(database)
    const reader = new DirectConnectStore(database)
    const owner = await store.registerServerInstance('fixture', process.pid)
    const attachPath = process.platform === 'win32'
      ? getAttachPath({ instanceId: randomUUID() } as ServerConfig, 'session', 1)
      : join(root, 'runner.sock')
    await store.createSession({ sessionId: 'session', transcriptSessionId: 'durable-transcript',
      transcriptPath: join(root, 'transcript.jsonl'), userId: 'owner', orgId: 'org', role: 'user', scopes: [],
      cwd: root, runtime: { type: 'cohost', engine: 'scode' }, status: 'active', desiredState: 'active' })
    const attempt = await store.createAttempt({ sessionId: 'session', generation: 1, backendType: 'cohost',
      resumeTranscriptSessionId: 'durable-transcript', serverInstanceId: owner.instanceId, attachPath })
    await store.setCurrentAttempt('session', attempt.attemptId)
    const session = await store.getSession('session')
    assert.ok(session)
    const manifest: RunnerManifest = {
      config: { heartbeatTimeoutMs: 30_000, idleTimeoutMs: scenario.trigger === 'idle' ? 20 : 0,
        instanceId: owner.instanceId } as ServerConfig,
      session: { sessionId: session.sessionId, transcriptSessionId: session.transcriptSessionId,
        transcriptPath: session.transcriptPath, userId: session.userId, orgId: session.orgId,
        role: session.role, scopes: session.scopes, cwd: session.cwd, runtime: session.runtime,
        resumeFromTranscript: false, dangerouslySkipPermissions: false },
      attempt: { attemptId: attempt.attemptId, serverInstanceId: owner.instanceId, generation: 1,
        runtimeDir: root, attachPath, statusPath: join(root, 'status.json'),
        stdoutLogPath: join(root, 'stdout.log'), stderrLogPath: join(root, 'stderr.log') },
    }
    const initialSignals = process.listeners('SIGTERM')
    let exit!: Parameters<BackendHandle['onExit']>[0]
    let stderr!: Parameters<BackendHandle['onStderrLine']>[0]
    const failure = scenario.error ? new Error(scenario.error) : undefined
    const handle: BackendHandle = {
      workDir: root, runtime: manifest.session.runtime, writeStdin: () => {},
      onStdoutLine: () => () => {},
      onStderrLine: callback => { stderr = callback; return () => {} },
      onExit: callback => { exit = callback; return () => {} },
      destroy: async () => { await exit(scenario.code, scenario.signal, failure) },
    }
    t.mock.method(RuntimeBackend.prototype, 'spawn', async () => handle)
    let onClosed!: () => void
    const closed = new Promise<void>(resolve => { onClosed = resolve })
    const closeStore = store.close.bind(store)
    t.mock.method(store, 'close', async () => { await closeStore(); onClosed() })
    const daemon = new SessionRunnerDaemon(manifest, store)
    let socket: ReturnType<typeof createConnection> | undefined
    t.after(async () => {
      socket?.destroy()
      if (store.isOpen()) await daemon.shutdown()
      else await closed
      await reader.close()
      assert.ok(root.startsWith(join(tmpdir(), 'moss-runner-exit-')))
      await rm(root, { recursive: true, force: true })
    })
    await writeFile(join(root, 'kept.txt'), 'retained workspace')
    await daemon.start()
    if (scenario.stderr) stderr(scenario.stderr)
    if (scenario.trigger === 'runtime') {
      await exit(scenario.code, scenario.signal, failure)
    } else if (scenario.trigger !== 'idle') {
      const onSignal = process.listeners('SIGTERM').find(listener => !initialSignals.includes(listener))
      assert.ok(onSignal)
      if (scenario.trigger === 'protocol') {
        t.mock.method(process, 'kill', () => { onSignal('SIGTERM'); return true })
        socket = createConnection(attachPath)
        await new Promise<void>((resolve, reject) => { socket!.once('connect', resolve); socket!.once('error', reject) })
        socket.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
      } else onSignal('SIGTERM')
    }
    await closed
    let status: { state: string; error: string | null } | undefined
    for (let count = 0; count < 100; count++) {
      try {
        const candidate = JSON.parse(await readFile(manifest.attempt.statusPath, 'utf8'))
        if (candidate.state === scenario.state) { status = candidate; break }
      } catch {}
      await delay(10)
    }
    assert.ok(status, 'The final status file must agree with the actual exit')
    const ended = await reader.getAttempt(attempt.attemptId)
    const retained = await reader.getSession('session')
    const event = await reader.latestEvent('session', 'attempt_exited')
    assert.equal(ended?.runtimeState, scenario.state)
    assert.equal(ended?.exitCode, scenario.code)
    assert.equal(ended?.exitSignal, scenario.signal)
    assert.equal(retained?.desiredState, scenario.desired)
    assert.equal(retained?.status, scenario.desired === 'terminated' ? 'terminated' : scenario.trigger === 'runtime' && scenario.state === 'failed' ? 'failed' : 'ended')
    assert.equal(retained?.transcriptSessionId, 'durable-transcript')
    assert.equal(await readFile(join(root, 'kept.txt'), 'utf8'), 'retained workspace')
    assert.equal(event?.payload.code, scenario.code)
    if (scenario.state === 'stopped') {
      assert.equal(ended?.errorText, null)
      assert.equal(status.error, null)
      assert.equal(event?.payload.errorText, null)
    } else {
      assert.match(ended?.errorText ?? '', new RegExp(scenario.error ?? scenario.stderr ?? 'Runtime exited'))
      assert.equal(status.error, ended?.errorText)
      assert.equal(event?.payload.errorText, ended?.errorText)
    }
    if (scenario.trigger === 'idle') assert.equal(ended?.stopReason, 'idle_timeout')
    assert.deepEqual(process.listeners('SIGTERM'), initialSignals)
  })
}
