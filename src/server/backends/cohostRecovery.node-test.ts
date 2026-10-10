import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { ManagedAgentClient, type ManagedSessionSnapshot, type StartSessionResult } from '../nexus/managedAgentClient.js'
import { startCohostExecution } from './cohostRecovery.js'

const endpoint = { protocol: 'acp-mailbox/1' as const, channel_id: 'channel', agent: 'agent', controller: 'old-controller', transcript: '/conversations/0123456789abcdef0123456789abcdef/transcript' }
const snapshot: ManagedSessionSnapshot = { session_id: 'pid-old', agent_id: 'agent', owner_id: 'owner',
  workspace_path: '/proc/pid-old/workspace/', durable_session_id: 'native-session', session_endpoint: endpoint }
const result: StartSessionResult = { sessionId: 'pid-new', osPid: null, durableSessionId: 'native-session', sessionEndpoint: endpoint }
const input = { agentId: 'agent', model: 'model' }
const scope = { ownerId: 'owner', repositoryPath: '/agents/agent/workspaces/moss-id', controllerId: 'new-controller' }

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
  assert.deepEqual(cancelled, ['pid-old'])
  assert.equal(starts[1]?.resumeSessionId, 'native-session')
})

void test('the original controller recovers a lost creation reply without creating a second process', async () => {
  const recovered = await startCohostExecution({
    findSession: async () => snapshot,
    cancel: async () => assert.fail('must not cancel the same controller'),
    startSession: async () => assert.fail('must not create a duplicate'),
  }, input, { ...scope, controllerId: endpoint.controller })
  assert.equal(recovered.session.sessionId, 'pid-old')
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
  assert.deepEqual(cancelled, ['pid-new'])
})

void test('live discovery checks both registry and execution ownership and refuses ambiguous results', async () => {
  let records = [{ pid: 'pid-old', name: 'agent', owner_id: 'owner', repos: [{ alias: 'workspace', mount_path: scope.repositoryPath }] }]
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
