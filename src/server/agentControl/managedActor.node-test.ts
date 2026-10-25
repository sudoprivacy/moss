import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { sessionAgentName } from '../agentIdentity.js'
import { assertManagedActorCurrent, inspectManagedActor, type ManagedActorSource } from './managedActor.js'

function fixture() {
  const agentId = sessionAgentName('alice', null)
  const session = { sessionId: 'moss-session', taskId: 'task-original', orgId: 'org', userId: 'alice', role: 'user',
    assistantName: null, runtime: { type: 'cohost' as const, engine: 'scode' as const },
    desiredState: 'active' as const, currentAttemptId: 'attempt-1', deletedAt: null }
  const bound = { ownerId: 'alice', agentId, durableSessionId: 'session-durable', repositoryPath: '/agents/alice/workspace' }
  const native = { agent_id: agentId, owner_id: 'alice', workspace_path: bound.repositoryPath,
    durable_session_id: bound.durableSessionId, state: 'ready' }
  const state = { calls: [] as string[], closed: 0, allowed: true, duplicate: false, duringNative: () => {} }
  const source: ManagedActorSource = {
    session: async () => ({ ...session }), binding: async () => ({ ...bound }),
    requireAccess: async () => { if (!state.allowed) throw new Error('current Moss access revoked') },
    connect: async (ownerId, name) => {
      assert.equal(ownerId, 'alice'); assert.equal(name, agentId)
      return { authToken: 'fixture-owner-key', client: {
        async call(method: string, payload: string, token: string) {
          assert.equal(token, 'fixture-owner-key'); state.calls.push(method)
          const input = JSON.parse(payload)
          if (method === 'agent_list') {
            assert.deepEqual(input, { owner_id: 'alice', kind: 'managed' })
            return JSON.stringify({ result: (state.duplicate ? ['123.1', '123.2'] : ['123.1']).map(pid =>
              ({ pid, name: agentId, owner_id: 'alice', repos: [{ alias: 'workspace', mount_path: bound.repositoryPath }] })) })
          }
          assert.equal(method, 'managed_agent.get_session_v1')
          state.duringNative()
          return JSON.stringify({ result: { ...native, session_id: input.session_id } })
        }, close() { state.closed++ },
      } as unknown as NexusVfsClient }
    },
  }
  return { source, state, session, bound, native }
}

void test('control actors come from fresh owned native execution and preserve the actual durable SID', async () => {
  const f = fixture()
  const actor = await inspectManagedActor(f.source, 'moss-session', 'alice', 'org')
  assert.equal(actor.agentId, f.bound.agentId)
  assert.equal(actor.durableSessionId, 'session-durable')
  assert.equal(actor.executionId, '123.1')
  assert.equal(actor.taskId, 'task-original')
  assert.deepEqual(f.state.calls, ['agent_list', 'managed_agent.get_session_v1'])
  assert.equal(f.state.closed, 1)
  await assertManagedActorCurrent(f.source, actor, 'org')
  assert.equal(f.state.calls.length, 2, 'the final local fence never starts network I/O')
})

void test('wrong organization or owner never reaches the native connection', async () => {
  const f = fixture()
  for (const [owner, org] of [['bob', 'org'], ['alice', 'foreign']])
    await assert.rejects(inspectManagedActor(f.source, 'moss-session', owner!, org!))
  assert.deepEqual(f.state.calls, [])
})

void test('stored metadata cannot override a native owner, SID or execution-state mismatch', async () => {
  for (const patch of [{ owner_id: 'bob' }, { agent_id: 'forged' }, { durable_session_id: 'other-history' }, { state: 'terminated' }]) {
    const f = fixture(); Object.assign(f.native, patch)
    await assert.rejects(inspectManagedActor(f.source, 'moss-session', 'alice', 'org'))
    assert.equal(f.state.closed, 1)
  }
  const duplicate = fixture(); duplicate.state.duplicate = true
  await assert.rejects(inspectManagedActor(duplicate.source, 'moss-session', 'alice', 'org'), /Multiple managed executions/)
})

void test('resume and permission revocation during native inspection invalidate the old actor', async () => {
  for (const change of ['attempt', 'permission'] as const) {
    const f = fixture()
    f.state.duringNative = () => {
      if (change === 'attempt') f.session.currentAttemptId = 'attempt-new'
      else f.state.allowed = false
    }
    await assert.rejects(inspectManagedActor(f.source, 'moss-session', 'alice', 'org'))
    assert.equal(f.state.closed, 1)
  }
})
