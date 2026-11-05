import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { createConnection } from 'node:net'
import { DirectConnectStore } from '../db.js'
import { getAttachPath } from '../runtimePaths.js'
import type { RunnerManifest, ServerConfig } from '../types.js'
import type { BackendHandle, BackendSpawnOptions } from '../sessionManager.js'
import { StdioAcpTransport } from './acpTransport.js'
import { StandardAcpBackend, type StandardAcpLauncher } from './standardAcpBackend.js'

async function until(check: () => boolean | Promise<boolean>) {
  for (let count = 0; count < 300; count++) { if (await check()) return; await delay(10) }
  assert.fail('Timed out waiting for the controlled runtime')
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'moss-acp-backend-'))
  const store = new DirectConnectStore(join(root, 'state.db'))
  const profile = { ownerId: 'alice', orgId: 'org', profileId: 'approved', agentId: 'native-agent', authorityId: 'deployment', workspacePath: root }
  const runtime = { type: 'host' as const, engine: 'standard_acp' as const, standardAcpProfileId: profile.profileId }
  await store.createSession({ sessionId: 'session', transcriptSessionId: 'ui-history', transcriptPath: join(root, 'transcript.jsonl'), userId: 'alice', orgId: 'org',
    role: 'member', scopes: [], cwd: root, runtime, status: 'active', desiredState: 'active' })
  let generation = 0, authorized = true, completion = 'cancel', cleanupConfirmed = true, launches = 0
  const children: ChildProcess[] = [], handles: BackendHandle[] = []
  const launcher: StandardAcpLauncher = {
    prepare: async () => ({ binding: profile,
      authorize: async () => { if (!authorized) throw new Error('Native profile access revoked') },
      start: async () => {
        launches++
        const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/standard-acp-worker.mjs', import.meta.url)), 'recoverable', root, completion], {
          env: { PATH: process.env.PATH, HOME: root }, stdio: ['pipe', 'pipe', 'pipe'],
        })
        children.push(child)
        const stopped = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject) })
        return { transport: new StdioAcpTransport(child, true),
          checkReady: async () => child.exitCode === null && child.signalCode === null,
          confirmStopped: async () => { await stopped; if (!cleanupConfirmed) throw new Error('Physical writer cleanup is unconfirmed') },
        }
      },
    }),
  }
  const options = async (): Promise<BackendSpawnOptions> => {
    const attempt = await store.createAttempt({ sessionId: 'session', generation: ++generation, backendType: 'host', resumeTranscriptSessionId: 'ui-history', serverInstanceId: 'server' })
    await store.setCurrentAttempt('session', attempt.attemptId)
    return { sessionId: 'session', userId: 'alice', orgId: 'org', cwd: root, transcriptPath: join(root, 'transcript.jsonl'), runtime,
      attemptFence: { attemptId: attempt.attemptId, ownerInstanceId: 'server' } }
  }
  return { root, store, profile, launcher, options, children, handles,
    launches: () => launches, authorize: (value: boolean) => { authorized = value }, finish: () => { completion = 'finish' },
    loseOpen: () => { completion = 'lost-open' }, crashTurn: () => { completion = 'crash-turn' },
    denyCleanup: () => { cleanupConfirmed = false },
    close: async () => {
      try {
        for (const handle of handles) { try { await handle.destroy() } catch {} }
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      } finally { if (store.isOpen()) await store.close(); await rm(root, { recursive: true, force: true }) }
    },
  }
}

void test('native BackendHandle streams literal input, cancels, recovers the exact history and rejects replay', { timeout: 15000 }, async t => {
  const f = await fixture(); t.after(f.close)
  const backend = new StandardAcpBackend(f.store, f.launcher), first = await backend.spawn(await f.options()); f.handles.push(first)
  const output: Record<string, any>[] = []
  first.onStdoutLine(line => output.push(JSON.parse(line)))
  assert.equal(await first.checkReady!(), true)
  const text = 'Do this actual task\n保持原文 🙂'
  first.writeStdin(JSON.stringify({ type: 'user', uuid: 'input-one', message: { content: text } }))
  assert.throws(() => first.writeStdin('Another concurrent turn'), /pending/)
  await until(() => output.some(value => value.delta))
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'literal-input.json'), 'utf8')), [{ type: 'text', text }])
  first.writeStdin(JSON.stringify({ type: 'control_request', request: { subtype: 'interrupt' } }))
  await until(() => output.some(value => value.type === 'result'))
  assert.equal(output.find(value => value.type === 'result')?.status, 'cancelled')
  await first.destroy()
  assert.equal((await f.store.standardAcpSessions.read('session', 'alice', 'org'))?.writerReleased, true)
  assert.equal((await f.store.getSession('session'))?.transcriptSessionId, 'ui-history')
  const transcript = (await readFile(join(f.root, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(transcript.filter(value => value.type === 'user').length, 1)
  assert.equal(transcript.find(value => value.type === 'assistant')?.partial, true)

  f.finish()
  const second = await backend.spawn(await f.options()); f.handles.push(second)
  const restored: Record<string, any>[] = []; second.onStdoutLine(line => restored.push(JSON.parse(line)))
  assert.equal(restored[0].nativeSessionId, 'fixture-recoverable')
  second.writeStdin(JSON.stringify({ type: 'user', uuid: 'input-one', message: { content: 'Do not replay' } }))
  await until(() => restored.some(value => value.type === 'result'))
  assert.equal(restored.find(value => value.type === 'result')?.outcome, 'unconfirmed')
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'literal-input.json'), 'utf8')), [{ type: 'text', text }])
  second.writeStdin(JSON.stringify({ type: 'user', uuid: 'input-two', message: { content: 'Continue literally' } }))
  await until(() => restored.some(value => value.type === 'result' && value.status === 'success'))
  await second.destroy()
  const result = await f.store.latestEvent('session', 'standard_acp_turn_result')
  assert.equal(result?.payload.inputId, 'input-two')
  assert.equal(f.launches(), 2)
})

void test('native admission rejects foreign identity, unsupported capabilities and revoked profiles before launch', async t => {
  const f = await fixture(); t.after(f.close)
  const backend = new StandardAcpBackend(f.store, f.launcher), options = await f.options()
  await assert.rejects(backend.spawn({ ...options, orgId: 'foreign' }), /not owned/)
  await assert.rejects(backend.spawn({ ...options, agentInstructions: 'Silently inject this' }), /capabilities/)
  f.authorize(false)
  await assert.rejects(backend.spawn(options), /revoked/)
  assert.equal(f.launches(), 0)
})

void test('native cleanup must positively finish before a replacement writer can start', { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(f.close)
  const backend = new StandardAcpBackend(f.store, f.launcher), first = await backend.spawn(await f.options()); f.handles.push(first)
  f.denyCleanup()
  await assert.rejects(Promise.resolve(first.destroy()), /cleanup is unconfirmed/)
  assert.equal((await f.store.standardAcpSessions.read('session', 'alice', 'org'))?.writerReleased, false)
  await assert.rejects(backend.spawn(await f.options()), /cleanup/)
  assert.equal(f.launches(), 1)
})

void test('idle producer disconnect finalizes the backend and confirms writer cleanup', { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(f.close)
  const handle = await new StandardAcpBackend(f.store, f.launcher).spawn(await f.options()); f.handles.push(handle)
  let failure: Error | undefined
  const exited = new Promise<void>(resolve => handle.onExit((_code, _signal, error) => { failure = error; resolve() }))
  f.children[0].kill('SIGKILL')
  await exited
  assert.ok(failure)
  assert.equal(await handle.checkReady!(), false)
  assert.equal((await f.store.standardAcpSessions.read('session', 'alice', 'org'))?.writerReleased, true)
})

void test('a lost first-open response never launches a replacement history automatically', { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(f.close); f.loseOpen()
  const backend = new StandardAcpBackend(f.store, f.launcher), options = await f.options()
  await assert.rejects(backend.spawn(options), /unknown/)
  assert.equal((await f.store.standardAcpSessions.read('session', 'alice', 'org'))?.nativeSessionId, undefined)
  await assert.rejects(backend.spawn(options), /first-open outcome is unknown/)
  assert.equal(f.launches(), 1)
})

void test('disconnect during a turn retains partial output and unknown outcome without replay', { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(f.close); f.crashTurn()
  const backend = new StandardAcpBackend(f.store, f.launcher), handle = await backend.spawn(await f.options()); f.handles.push(handle)
  const output: Record<string, any>[] = []; handle.onStdoutLine(line => output.push(JSON.parse(line)))
  const exited = new Promise<void>(resolve => handle.onExit(() => resolve()))
  handle.writeStdin(JSON.stringify({ type: 'user', uuid: 'lost-input', message: { content: 'Run only once' } }))
  await exited
  assert.equal(output.find(value => value.type === 'result')?.outcome, 'unconfirmed')
  assert.equal((await f.store.latestEvent('session', 'standard_acp_turn_unconfirmed'))?.payload.inputId, 'lost-input')
  assert.match(await readFile(join(f.root, 'transcript.jsonl'), 'utf8'), /controlled partial/)
  f.finish()
  const resumed = await backend.spawn(await f.options()); f.handles.push(resumed)
  const restored: Record<string, any>[] = []; resumed.onStdoutLine(line => restored.push(JSON.parse(line)))
  resumed.writeStdin(JSON.stringify({ type: 'user', uuid: 'lost-input', message: { content: 'Do not repeat the uncertain work' } }))
  await until(() => restored.some(value => value.type === 'result'))
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'literal-input.json'), 'utf8')), [{ type: 'text', text: 'Run only once' }])
})

void test('canonical daemon uses the native backend over its real input socket and records exit lifecycle', { timeout: 15000 }, async t => {
  const alias = registerHooks({ resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'bun:bundle' ? new URL('../../../scripts/bun-bundle-feature.js', import.meta.url).href : specifier, context)
  } })
  const { SessionRunnerDaemon } = await (async () => { try { return await import('../sessionRunnerDaemon.js') } finally { alias.deregister() } })()
  const f = await fixture(), options = await f.options()
  const { RuntimeBackend } = await import('./runtimeBackend.js')
  await assert.rejects(new RuntimeBackend().spawn(options), /not registered/)
  const reader = new DirectConnectStore(join(f.root, 'state.db'))
  const config = { heartbeatTimeoutMs: 30000, idleTimeoutMs: 0, instanceId: 'server' } as ServerConfig
  const attachPath = process.platform === 'win32' ? getAttachPath(config, 'session', 1) : join(f.root, 'r.sock')
  const session = (await f.store.getSession('session'))!
  const manifest: RunnerManifest = { config,
    session: { sessionId: session.sessionId, transcriptSessionId: session.transcriptSessionId, transcriptPath: session.transcriptPath,
      userId: session.userId, orgId: session.orgId, role: session.role, scopes: [], cwd: session.cwd, runtime: session.runtime,
      resumeFromTranscript: false, dangerouslySkipPermissions: false },
    attempt: { attemptId: options.attemptFence!.attemptId, serverInstanceId: 'server', generation: 1, runtimeDir: f.root,
      attachPath, statusPath: join(f.root, 'status.json'), stdoutLogPath: join(f.root, 'stdout.log'), stderrLogPath: join(f.root, 'stderr.log') },
  }
  const daemon = new SessionRunnerDaemon(manifest, f.store, { standardAcpLauncher: f.launcher })
  let socket: ReturnType<typeof createConnection> | undefined
  let resolveClosed!: () => void
  const closed = new Promise<void>(resolve => { resolveClosed = resolve })
  const close = f.store.close.bind(f.store)
  t.mock.method(f.store, 'close', async () => { await close(); resolveClosed() })
  const initialSignals = process.listeners('SIGTERM')
  t.after(async () => {
    socket?.destroy()
    if (f.store.isOpen()) { f.children[0]?.kill('SIGKILL'); await closed }
    await reader.close(); await f.close()
    assert.deepEqual(process.listeners('SIGTERM'), initialSignals)
  })
  await daemon.start()
  socket = createConnection(attachPath)
  await new Promise<void>((resolve, reject) => { socket!.once('connect', resolve); socket!.once('error', reject) })
  const messages: Record<string, any>[] = []; let buffer = ''
  socket.on('data', chunk => {
    buffer += String(chunk)
    for (;;) { const index = buffer.indexOf('\n'); if (index < 0) return; messages.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1) }
  })
  const send = (value: unknown) => socket!.write(JSON.stringify(value) + '\n')
  send({ type: 'ping' })
  await until(() => messages.some(message => message.type === 'pong' && message.isReady))
  send({ type: 'stdin', data: JSON.stringify({ type: 'user', uuid: 'daemon-input', message: { content: 'Literal native daemon task' } }) })
  await until(() => messages.some(message => message.type === 'stdout' && JSON.parse(message.line).delta))
  send({ type: 'stdin', data: JSON.stringify({ type: 'control_request', request: { subtype: 'unsupported' } }) })
  await until(() => messages.some(message => message.type === 'error'))
  send({ type: 'stdin', data: JSON.stringify({ type: 'control_request', request: { subtype: 'interrupt' } }) })
  await until(() => messages.some(message => message.type === 'stdout' && JSON.parse(message.line).status === 'cancelled'))
  assert.equal((await reader.getSession('session'))?.runtime.engine, 'standard_acp')
  assert.equal((await reader.getSession('session'))?.transcriptSessionId, 'ui-history')
  const signal = process.listeners('SIGTERM').find(listener => !initialSignals.includes(listener))!
  signal('SIGTERM')
  await closed
  assert.equal((await reader.getAttempt(options.attemptFence!.attemptId))?.runtimeState, 'stopped')
  assert.equal((await reader.latestEvent('session', 'attempt_exited'))?.payload.code, 0)
  assert.equal((await reader.standardAcpSessions.read('session', 'alice', 'org'))?.writerReleased, true)
})
