import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DirectConnectStore } from '../db.js'
import { isUninitializedCohostSession } from './cohostSessionState.js'
import type { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { ManagedAgentClient, type ManagedSessionSnapshot, type StartSessionResult } from '../nexus/managedAgentClient.js'
import { startCohostExecution } from './cohostRecovery.js'

const endpoint = { protocol: 'acp-mailbox/1' as const, channel_id: 'channel', agent: 'agent', controller: 'old-controller', transcript: '/conversations/0123456789abcdef0123456789abcdef/transcript' }
const snapshot: ManagedSessionSnapshot = { session_id: '43210.7', agent_id: 'agent', owner_id: 'owner',
  workspace_path: '/proc/43210.7/workspace/', durable_session_id: 'native-session', session_endpoint: endpoint }
const result: StartSessionResult = { sessionId: '43210.8', osPid: null, durableSessionId: 'native-session', sessionEndpoint: endpoint }
const input = { agentId: 'agent', model: 'model' }
const scope = { ownerId: 'owner', repositoryPath: '/agents/agent/workspaces/moss-id', controllerId: 'new-controller' }

void test('a provision failure can initialize its original unpublished Session; any startup or history prevents reset', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-cohost-initialization-'))
  const store = new DirectConnectStore(':memory:')
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  await store.createSession({ sessionId: 'moss-session', transcriptSessionId: 'moss-session',
    transcriptPath: join(root, 'transcript.jsonl'), cwd: root, userId: 'owner', orgId: 'org',
    role: 'member', scopes: [], assistantName: 'helper', runtime: { type: 'cohost', engine: 'scode' },
    status: 'active', desiredState: 'active' })
  const original = (await store.getSession('moss-session'))!
  const attempt = await store.createAttempt({ sessionId: original.sessionId, generation: 1,
    backendType: 'cohost', resumeTranscriptSessionId: original.transcriptSessionId, serverInstanceId: 'controller' })
  await store.setCurrentAttempt(original.sessionId, attempt.attemptId)
  await store.markAttemptStopped(attempt.attemptId, { runtimeState: 'failed', stopReason: 'startup_failed', errorText: 'Pod is not ready' })
  assert.equal(await isUninitializedCohostSession(store, original), true)
  let starts = 0
  const execution = await startCohostExecution({ findSession: async () => undefined, cancel: async () => {},
    startSession: async options => { assert.equal(options.resumeSessionId, undefined); starts++; return result } },
  input, scope, { isResumeRequired: true, isInitializationAllowed: await isUninitializedCohostSession(store, original) })
  assert.equal(starts, 1)
  assert.equal(execution.isResume, false)
  assert.equal((await store.getSession(original.sessionId))!.transcriptSessionId, original.transcriptSessionId)
  await writeFile(original.transcriptPath, JSON.stringify({ type: 'user', content: 'An existing request' }))
  assert.equal(await isUninitializedCohostSession(store, original), false)
  await writeFile(original.transcriptPath, '{')
  assert.equal(await isUninitializedCohostSession(store, original), false)
  await writeFile(original.transcriptPath, '')
  assert.equal(await isUninitializedCohostSession(store, original), true)
  await store.addEvent(original.sessionId, attempt.attemptId, 'attempt_spawned', {})
  assert.equal(await isUninitializedCohostSession(store, original), false)
})

void test('a durable native binding alone prevents initialization even when its UI projection is absent', async () => {
  assert.equal(await isUninitializedCohostSession({
    cohostSessions: { get: async () => ({ durableSessionId: 'original-native-history' }) },
    latestEvent: async () => assert.fail('binding is sufficient'),
  } as never, { sessionId: 'moss-session', transcriptPath: 'absent-ui-projection' }), false)
})

void test('missing durable identity during resume cannot silently create replacement history', async () => {
  let starts = 0
  const agent = { findSession: async () => undefined, cancel: async () => {},
    startSession: async () => { starts++; throw new Error('replacement history must not start') } }
  await assert.rejects(startCohostExecution(agent, input, scope, { isResumeRequired: true }), /no durable binding/)
  assert.equal(starts, 0)
})
const busy = () => new Error(JSON.stringify({ code: -32603,
  message: 'managed_agent.start_session_v1: internal: spawn agent runtime: co-host: session is still running; stop it before resuming' }))

void test('ordinary creation starts once; an owned orphan resumes its original durable session', async () => {
  const cancelled: string[] = []
  const starts: Array<Parameters<ManagedAgentClient['startSession']>[0]> = []
  let existing: ManagedSessionSnapshot | undefined
  const agent = {
    findSession: async () => existing,
    cancel: async (id: string) => { cancelled.push(id) },
    startSession: async (value: Parameters<ManagedAgentClient['startSession']>[0]) => { starts.push(value); return result },
  }
  assert.equal((await startCohostExecution(agent, input, scope)).isResume, false)
  existing = snapshot
  assert.equal((await startCohostExecution(agent, input, scope)).isResume, true)
  assert.deepEqual(cancelled, ['43210.7'])
  assert.equal(starts[1]?.resumeSessionId, 'native-session')
})

void test('workspace preparation completes after orphan cancellation and before native skill discovery', async () => {
  const order: string[] = []
  const agent = {
    findSession: async () => snapshot,
    cancel: async () => { order.push('cancel') },
    startSession: async () => { order.push('start'); return result },
  }
  await startCohostExecution(agent, input, scope, { prepareWorkspace: async () => { order.push('prepare') } })
  assert.deepEqual(order, ['cancel', 'prepare', 'start'])
  order.length = 0
  await assert.rejects(startCohostExecution(agent, input, scope, {
    prepareWorkspace: async () => { throw new Error('Incomplete skill payload') },
  }), /Incomplete skill payload/)
  assert.deepEqual(order, ['cancel'], 'an engine must not discover a partially installed catalog')
})

void test('the original controller recovers a lost creation reply without creating a second process', async () => {
  const recovered = await startCohostExecution({
    findSession: async () => snapshot,
    cancel: async () => assert.fail('must not cancel the same controller'),
    startSession: async () => assert.fail('must not create a duplicate'),
  }, input, { ...scope, controllerId: endpoint.controller })
  assert.equal(recovered.session.sessionId, '43210.7')
  assert.equal(recovered.session.durableSessionId, 'native-session')
})

void test('recovery retries only the explicit writer lease refusal and preserves the selected session', async () => {
  let calls = 0
  const recovered = await startCohostExecution({
    findSession: async () => undefined, cancel: async () => {},
    startSession: async value => {
      assert.equal(value.resumeSessionId, 'native-session')
      if (++calls < 3) throw busy()
      return result
    },
  }, { ...input, resumeSessionId: 'native-session' }, scope, { retryMs: 1 })
  assert.equal(calls, 3)
  assert.equal(recovered.isResume, true)
  for (const failure of [new Error('permission denied'), new Error('session is still running')]) {
    let attempts = 0
    await assert.rejects(startCohostExecution({ findSession: async () => undefined, cancel: async () => {},
      startSession: async () => { attempts++; throw failure } },
    { ...input, resumeSessionId: 'native-session' }, scope), error => error === failure)
    assert.equal(attempts, 1)
  }
})

void test('recovery honors cancellation, its deadline and cleanup after a cancelled creation', async () => {
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(startCohostExecution({ findSession: async () => undefined, cancel: async () => {},
    startSession: async () => { calls++; controller.abort(); throw busy() } },
  { ...input, resumeSessionId: 'native-session' }, scope, { signal: controller.signal }), /abort/i)
  assert.equal(calls, 1)
  await assert.rejects(startCohostExecution({ findSession: async () => undefined, cancel: async () => {},
    startSession: async () => { throw busy() } },
  { ...input, resumeSessionId: 'native-session' }, scope, { timeoutMs: 0 }), /still running/)
  const aborted = new AbortController()
  const cancelled: string[] = []
  await assert.rejects(startCohostExecution({ findSession: async () => undefined,
    cancel: async id => { cancelled.push(id) }, startSession: async () => { aborted.abort(); return result } },
  input, scope, { signal: aborted.signal }), /abort/i)
  assert.deepEqual(cancelled, ['43210.8'])
})

void test('live discovery checks both registry and execution ownership and refuses ambiguous results', async () => {
  let records = [{ pid: '43210.7', name: 'agent', owner_id: 'owner', repos: [{ alias: 'workspace', mount_path: scope.repositoryPath }] }]
  let current = snapshot
  const client = new ManagedAgentClient({
    call: async (method: string, raw: string) => {
      if (method === 'agent_list') {
        assert.deepEqual(JSON.parse(raw), { owner_id: 'owner', kind: 'managed' })
        return JSON.stringify({ result: records })
      }
      assert.equal(method, 'managed_agent.get_session_v1')
      return JSON.stringify({ ...current, session_id: JSON.parse(raw).session_id })
    },
  } as unknown as NexusVfsClient, '')
  assert.equal((await client.findSession({ ...scope, agentId: 'agent' }))?.durable_session_id, 'native-session')
  current = { ...snapshot, owner_id: 'different-owner' }
  await assert.rejects(client.findSession({ ...scope, agentId: 'agent' }), /does not belong/)
  current = snapshot
  records = [...records, { ...records[0]!, pid: 'pid-another' }]
  await assert.rejects(client.findSession({ ...scope, agentId: 'agent' }), /Multiple managed executions/)
})

void test('live discovery skips a process reaped between registry enumeration and its snapshot', async () => {
  const client = new ManagedAgentClient({ call: async (method: string) => {
    if (method === 'agent_list') return JSON.stringify({ result: [{ pid: 'pid-gone', name: 'agent', owner_id: 'owner', repos: [] }] })
    throw new Error(JSON.stringify({ code: -32603, message: 'managed_agent.get_session_v1: invalid argument: unknown session_id "pid-gone"' }))
  } } as unknown as NexusVfsClient, '')
  assert.equal(await client.findSession({ ownerId: 'owner', agentId: 'agent', durableSessionId: 'native-session' }), undefined)
})

void test('live discovery ignores retained terminated executions in the same workspace', async () => {
  let isLivePresent = false
  const client = new ManagedAgentClient({ call: async (method: string, raw: string) => {
    if (method === 'agent_list') {
      const pids = ['pid-stopped', ...(isLivePresent ? ['pid-current'] : [])]
      return JSON.stringify({ result: pids.map(pid => ({ pid, name: 'agent', owner_id: 'owner',
        repos: [{ alias: 'workspace', mount_path: scope.repositoryPath }] })) })
    }
    const { session_id: id } = JSON.parse(raw) as { session_id: string }
    return JSON.stringify(id === 'pid-stopped'
      ? { session_id: id, agent_id: 'agent', owner_id: 'owner', workspace_path: '/proc/pid-stopped/workspace/', state: 'terminated' }
      : { ...snapshot, session_id: id, state: 'ready' })
  } } as unknown as NexusVfsClient, '')
  assert.equal(await client.findSession({ ...scope, agentId: 'agent' }), undefined)
  isLivePresent = true
  assert.equal((await client.findSession({ ...scope, agentId: 'agent' }))?.session_id, 'pid-current')
  assert.equal((await client.findSession({ ...scope, agentId: 'agent', durableSessionId: 'native-session' }))?.session_id, 'pid-current')
})

void test('terminated execution snapshots still require matching registry ownership', async () => {
  const client = new ManagedAgentClient({ call: async (method: string) => {
    if (method === 'agent_list') return JSON.stringify({ result: [{ pid: 'pid-stopped', name: 'agent', owner_id: 'owner',
      repos: [{ alias: 'workspace', mount_path: scope.repositoryPath }] }] })
    return JSON.stringify({ ...snapshot, session_id: 'pid-stopped', state: 'terminated', owner_id: 'different-owner' })
  } } as unknown as NexusVfsClient, '')
  await assert.rejects(client.findSession({ ...scope, agentId: 'agent' }), /does not belong/)
})
