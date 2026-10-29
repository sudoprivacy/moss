import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { DirectConnectStore } from '../db.js'
import { getAttachPath } from '../runtimePaths.js'
import type { BackendHandle, BackendSpawnOptions } from '../sessionManager.js'
import type { RunnerManifest, ServerConfig } from '../types.js'
import type { OntologyContextPorts } from './projectRegistry.js'

const alias = registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === 'bun:bundle'
    ? new URL('../../../scripts/bun-bundle-feature.js', import.meta.url).href : specifier, context)
} })
const [{ SessionRunnerDaemon }, { RuntimeBackend }] = await (async () => {
  try { return await Promise.all([import('../sessionRunnerDaemon.js'), import('../backends/runtimeBackend.js')]) }
  finally { alias.deregister() }
})()

async function fixture(t: TestContext, isBound = true) {
  const root = await mkdtemp(join(tmpdir(), 'moss-ontology-runner-'))
  const path = join(root, 'host.db')
  let store = new DirectConnectStore(path)
  const reader = new DirectConnectStore(path)
  await store.createSession({ sessionId: 'session', transcriptSessionId: 'kept-history',
    transcriptPath: join(root, 'transcript.jsonl'), userId: 'alice', orgId: 'org', role: 'user', scopes: [],
    cwd: root, runtime: { type: 'cohost', engine: 'scode' }, status: 'active', desiredState: 'active' })
  let isAllowed = true
  let text = 'Current revision A'
  let reads = 0
  const ports: OntologyContextPorts = {
    authorize: async binding => {
      assert.equal(binding.orgId, 'org')
      assert.equal(binding.userId, 'alice')
      if (!isAllowed) throw new Error('Current resource access revoked')
    },
    readContext: async () => { reads++; return {
      format: 'sudograph-agent-context/v1', revision: 'a'.repeat(64), context_digest: 'b'.repeat(64), text,
    } },
  }
  if (isBound) {
    const project = await store.ontologyProjects.register({ orgId: 'org', authorityRef: 'authority',
      workerRef: 'worker', modelRef: 'model', sourceRefs: ['source'] })
    await store.ontologyProjects.bind({ sessionId: 'session', projectId: project.projectId, orgId: 'org', userId: 'alice' }, ports)
  }
  // No callback or context text survives this database close/reopen.
  await store.close()
  store = new DirectConnectStore(path)
  const owner = await store.registerServerInstance('fixture', process.pid)
  const attachPath = process.platform === 'win32'
    ? getAttachPath({ instanceId: randomUUID() } as ServerConfig, 'session', 1) : join(root, 'runner.sock')
  const attempt = await store.createAttempt({ sessionId: 'session', generation: 1, backendType: 'cohost',
    resumeTranscriptSessionId: 'kept-history', serverInstanceId: owner.instanceId, attachPath })
  await store.setCurrentAttempt('session', attempt.attemptId)
  const manifest: RunnerManifest = {
    config: { instanceId: owner.instanceId, heartbeatTimeoutMs: 30_000, idleTimeoutMs: 0 } as ServerConfig,
    session: { sessionId: 'session', transcriptSessionId: 'kept-history', transcriptPath: join(root, 'transcript.jsonl'),
      orgId: 'org', userId: 'alice', role: 'user', scopes: [], cwd: root, runtime: { type: 'cohost', engine: 'scode' },
      resumeFromTranscript: true, dangerouslySkipPermissions: false },
    attempt: { attemptId: attempt.attemptId, serverInstanceId: owner.instanceId, generation: 1, runtimeDir: root,
      attachPath, statusPath: join(root, 'status.json'), stdoutLogPath: join(root, 'stdout.log'), stderrLogPath: join(root, 'stderr.log') },
  }
  let spawned: BackendSpawnOptions | undefined
  const handle: BackendHandle = {
    workDir: root, runtime: manifest.session.runtime, writeStdin: () => {},
    onStdoutLine: () => () => {}, onStderrLine: () => () => {}, onExit: () => () => {}, destroy: async () => {},
  }
  t.mock.method(RuntimeBackend.prototype, 'spawn', async (options: BackendSpawnOptions) => { spawned = options; return handle })
  let daemon: InstanceType<typeof SessionRunnerDaemon> | undefined
  t.after(async () => {
    if (daemon && store.isOpen()) await daemon.shutdown()
    else if (store.isOpen()) await store.close()
    await reader.close()
    assert.ok(root.startsWith(join(tmpdir(), 'moss-ontology-runner-')))
    await rm(root, { recursive: true, force: true })
  })
  return { store, reader, ports, manifest, root,
    start(context?: OntologyContextPorts) { daemon = new SessionRunnerDaemon(manifest, store, { ontologyContext: context }); return daemon.start() },
    deny() { isAllowed = false }, change() { text = 'Current revision B' },
    get spawned() { return spawned }, get reads() { return reads },
  }
}

void test('an actual recovered runner injects the fresh reader into its existing native backend', async t => {
  const f = await fixture(t)
  await f.start(f.ports)
  const reader = f.spawned?.resolveHostContext
  assert.ok(reader)
  const request = { sessionId: 'session', nativeSessionId: 'native' }
  assert.equal(await reader(request), 'Current revision A')
  f.change()
  assert.equal(await reader(request), 'Current revision B')
  f.deny()
  await assert.rejects(reader(request), /access revoked/)
  assert.equal(f.reads, 2)
  assert.equal((await f.reader.getSession('session'))?.transcriptSessionId, 'kept-history')
})

void test('a bound runner without a worker/policy adapter fails visibly before native startup', async t => {
  const f = await fixture(t)
  await assert.rejects(f.start(), /worker and policy are not configured/)
  assert.equal(f.spawned, undefined)
  assert.equal(f.reads, 0)
  const status = JSON.parse(await readFile(f.manifest.attempt.statusPath, 'utf8'))
  assert.equal(status.state, 'failed')
  assert.match(status.error, /worker and policy are not configured/)
  assert.ok(await f.reader.ontologyProjects.resolveSession('session'))
  assert.equal((await f.reader.getSession('session'))?.transcriptSessionId, 'kept-history')
})

for (const key of ['orgId', 'userId'] as const) {
  void test(`a recovered runner cannot select a foreign ${key} through manifest metadata`, async t => {
    const f = await fixture(t)
    f.manifest.session[key] = 'foreign'
    await assert.rejects(f.start(f.ports), /binding is unavailable/)
    assert.equal(f.spawned, undefined)
    assert.equal(f.reads, 0)
  })
}

void test('revoked model access refuses native startup before any worker read', async t => {
  const f = await fixture(t)
  f.deny()
  await assert.rejects(f.start(f.ports), /access revoked/)
  assert.equal(f.spawned, undefined)
  assert.equal(f.reads, 0)
})

void test('an ordinary conversation keeps its existing backend without model context', async t => {
  const f = await fixture(t, false)
  await f.start()
  assert.ok(f.spawned)
  assert.equal(f.spawned.resolveHostContext, undefined)
  assert.equal(f.reads, 0)
})
