import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { NexusVfsClient, NexusSessionTransport } from '@nexus-ai-fs/vfs-client'
import type { SessionRuntimeConnection } from '../nexus/sessionConnection.js'
import type { ManagedAgentClient, ManagedSessionSnapshot, StartSessionResult } from '../nexus/managedAgentClient.js'
import type { BackendSpawnOptions } from '../sessionManager.js'
import { StdioAcpTransport } from './acpTransport.js'
import { StandardAcpDriver } from './standardAcpDriver.js'
import { NexusStandardAcpLauncher, type NexusStandardAcpDeployment, type StandardAcpRuntimeLease } from './nexusStandardAcpLauncher.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'moss-nexus-acp-'))
  const binding = { ownerId: 'owner', orgId: 'org', profileId: 'profile', agentId: 'approved-agent', authorityId: 'allocation', workspacePath: root }
  const options: BackendSpawnOptions = { sessionId: 'moss-session', userId: 'owner', orgId: 'org', cwd: root,
    runtime: { type: 'host', engine: 'standard_acp', standardAcpProfileId: 'profile' } }
  const endpoint: StartSessionResult['sessionEndpoint'] = { protocol: 'acp-mailbox/1', agent: 'approved-agent', controller: 'controller',
    channel_id: 'owned-channel', transcript: `/conversations/${'a'.repeat(32)}/transcript` }
  const record: ManagedSessionSnapshot = { session_id: '123.1', agent_id: binding.agentId, owner_id: binding.ownerId,
    workspace_path: root, session_endpoint: endpoint, state: 'ready' }
  let held = false, releases = 0, closed = false, cancelled = 0, authorized = true, delegated = true
  let loseReply = false, pretendLive = false, unknown = false, readDenied = false, physicalDenied = false
  const quarantined: string[] = [], calls: Parameters<ManagedAgentClient['startSession']>[0][] = []
  let child: ChildProcess | undefined
  let afterStart: (() => void) | undefined
  const lease: StandardAcpRuntimeLease = {
    assertCurrent: async () => { assert.equal(held, true) },
    confirmWriterStopped: async execution => {
      assert.deepEqual(execution, { processId: '123.1', channelId: 'owned-channel' })
      if (physicalDenied) throw new Error('Physical writer still exists')
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => child!.once('exit', () => resolve()))
      }
    },
    release: async () => { releases++; held = false },
    quarantine: async reason => { quarantined.push(reason) },
  }
  const connection = (): SessionRuntimeConnection => ({ client: { close: () => { closed = true } } as NexusVfsClient,
    authToken: '', identity: delegated ? { subjectId: 'controller' } as SessionRuntimeConnection['identity'] : null })
  const agent: Pick<ManagedAgentClient, 'startSession' | 'getSession' | 'cancel' | 'openSession' | 'verifySessionEndpoint' | 'close'> = {
    startSession: async input => {
      calls.push(input)
      child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/standard-acp-worker.mjs', import.meta.url)), 'recoverable', root, 'finish'], {
        env: { PATH: process.env.PATH, HOME: root }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      })
      // Establish the fixture's claimed ready state before testing cancellation.
      // Otherwise Node startup competes with the unchanged cleanup deadline.
      const [ready] = await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(() => { throw new Error('ACP worker exited before readiness') }),
      ])
      assert.deepEqual(ready, { type: 'standard-acp-fixture-ready' })
      afterStart?.()
      if (loseReply) throw new Error('Lost RPC reply')
      return { sessionId: record.session_id, osPid: child.pid!, sessionEndpoint: endpoint }
    },
    getSession: async () => {
      assert.equal(closed, false, 'Control reads must remain available after transport cancellation')
      if (readDenied) throw new Error('Control-plane permission denied')
      if (unknown) throw new Error(JSON.stringify({ code: -32603, message: 'managed_agent.get_session_v1: invalid argument: unknown session_id "123.1"' }))
      return { ...record, state: !pretendLive && child && (child.exitCode !== null || child.signalCode !== null) ? 'terminated' : record.state }
    },
    cancel: async () => { cancelled++; child?.stdin?.end() },
    verifySessionEndpoint: async () => { assert.equal(closed, false) },
    openSession: (_endpoint, events) => {
      const transport = new StdioAcpTransport(child!, true)
      return { get connected() { return transport.connected },
        start: () => transport.start({ onMessage: events.onMessage, onStderr: () => {}, onClose: (_code, _signal, error) => events.onClose(error) }),
        send: transport.send.bind(transport), close: transport.close.bind(transport),
      } as unknown as NexusSessionTransport
    },
    close: () => { closed = true },
  }
  const deployment: NexusStandardAcpDeployment = { binding,
    connection: { endpoint: 'http://127.0.0.1:1', tls: null, authToken: '' },
    spawnSpec: { cmd: '/opt/approved/launch', args: ['--binding', '/private/binding.json'], env: {}, cwd: root },
    authorize: async () => { if (!authorized) throw new Error('Access revoked') },
    acquire: async () => { if (held) throw new Error('Account/PVC is already leased'); held = true; return lease },
  }
  const launcher = new NexusStandardAcpLauncher(async () => deployment,
    { connect: async () => connection(), agent: () => agent }, { timeoutMs: 100, pollMs: 5 })
  return { launcher, deployment, options, record, calls, quarantined,
    status: () => ({ held, releases, closed, cancelled }), revoke: () => { authorized = false },
    undelegate: () => { delegated = false }, lose: () => { loseReply = true }, live: () => { pretendLive = true },
    unknown: () => { unknown = true }, denyRead: () => { readDenied = true }, denyPhysical: () => { physicalDenied = true },
    afterStart: (callback: () => void) => { afterStart = callback },
    cleanup: async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()))
        child.kill('SIGKILL'); await exited
      }
      await rm(root, { recursive: true, force: true })
    },
  }
}

void test('Nexus launcher uses one delegated spawn, actual stdio ACP and positive physical cleanup', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const plan = await f.launcher.prepare(f.options), execution = await plan.start()
  const driver = new StandardAcpDriver(execution.transport)
  const id = await driver.open({ cwd: f.deployment.binding.workspacePath })
  assert.equal((await driver.prompt(id, 'Literal task, no intermediate inference')).stopReason, 'end_turn')
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0], { agentId: 'approved-agent', repos: [{ hostPath: f.deployment.binding.workspacePath, alias: 'workspace' }], spawnSpec: f.deployment.spawnSpec })
  await driver.close()
  assert.equal(f.status().closed, false)
  assert.equal(f.status().releases, 0, 'A cancel acknowledgement cannot release the account/PVC')
  await execution.confirmStopped()
  await execution.confirmStopped()
  assert.deepEqual(f.status(), { held: false, releases: 1, closed: true, cancelled: 1 })
})

void test('a competing account/PVC writer is refused before a second launch', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const one = await f.launcher.prepare(f.options); await one.start()
  const two = await f.launcher.prepare({ ...f.options, sessionId: 'another-moss-session' })
  await assert.rejects(two.start(), /already leased/)
  assert.equal(f.calls.length, 1)
})

void test('lost launch RPC stays quarantined and cannot be retried or have its lease released', async t => {
  const f = await fixture(); t.after(f.cleanup); f.lose()
  const plan = await f.launcher.prepare(f.options)
  await assert.rejects(plan.start(), /Lost RPC reply/)
  await assert.rejects(plan.start(), /already been attempted/)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.quarantined, ['start_unconfirmed'])
  assert.equal(f.status().held, true)
  assert.equal(f.status().releases, 0)
})

void test('foreign execution replies are never cancelled or released by this controller', async t => {
  const f = await fixture(); t.after(f.cleanup); f.record.owner_id = 'another-owner'
  const plan = await f.launcher.prepare(f.options)
  await assert.rejects(plan.start(), /unowned/)
  assert.equal(f.status().cancelled, 0)
  assert.equal(f.status().releases, 0)
  assert.deepEqual(f.quarantined, ['start_unconfirmed'])
})

void test('cleanup acknowledgement without stopped state retains the global lease', async t => {
  const f = await fixture(); t.after(f.cleanup); f.live()
  const execution = await (await f.launcher.prepare(f.options)).start()
  await execution.transport.close()
  await assert.rejects(execution.confirmStopped(), /termination is unconfirmed/)
  assert.equal(f.status().releases, 0)
  assert.equal(f.status().held, true)
  assert.deepEqual(f.quarantined, ['cleanup_unconfirmed'])
})

void test('explicit reaped-process status plus supervisor confirmation permits cleanup', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const execution = await (await f.launcher.prepare(f.options)).start()
  await execution.transport.close(); f.unknown()
  await execution.confirmStopped()
  assert.equal(f.status().releases, 1)
})

void test('a registry tombstone cannot substitute for supervisor confirmation', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const execution = await (await f.launcher.prepare(f.options)).start()
  await execution.transport.close(); f.unknown(); f.denyPhysical()
  await assert.rejects(execution.confirmStopped(), /Physical writer still exists/)
  assert.equal(f.status().releases, 0)
  assert.deepEqual(f.quarantined, ['cleanup_unconfirmed'])
})

void test('control-plane authorization failures are never interpreted as a reaped writer', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const execution = await (await f.launcher.prepare(f.options)).start()
  await execution.transport.close(); f.denyRead()
  await assert.rejects(execution.confirmStopped(), /permission denied/)
  assert.equal(f.status().releases, 0)
  assert.deepEqual(f.quarantined, ['cleanup_unconfirmed'])
})

void test('foreign profile, revoked access, invalid cwd and missing owner credentials fail before spawn', async t => {
  const f = await fixture(); t.after(f.cleanup)
  await assert.rejects(f.launcher.prepare({ ...f.options, orgId: 'foreign' }), /does not match/)
  f.deployment.spawnSpec.cwd = '/unapproved'
  await assert.rejects(f.launcher.prepare(f.options), /bound workspace/)
  f.deployment.spawnSpec.cwd = f.deployment.binding.workspacePath
  const plan = await f.launcher.prepare(f.options); f.undelegate()
  await assert.rejects(plan.start(), /owner-delegated/)
  assert.equal(f.status().releases, 1)
  const revoked = await f.launcher.prepare(f.options); f.revoke()
  await assert.rejects(revoked.start(), /revoked/)
  assert.equal(f.calls.length, 0)
})

void test('cancellation after a known launch stops the owned process and confirms cleanup', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const controller = new AbortController()
  f.afterStart(() => controller.abort(new Error('Launch cancelled')))
  const plan = await f.launcher.prepare(f.options)
  await assert.rejects(plan.start(controller.signal), /Launch cancelled/)
  assert.deepEqual(f.status(), { held: false, releases: 1, closed: true, cancelled: 1 })
})
