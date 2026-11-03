import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isMossOwnedExecution } from './mossOwnedExecution.js'

const binding = { ownerId: 'alice', agentId: 'user-alice', durableSessionId: 'durable-1', repositoryPath: '/agents/user-alice' }
const snapshot = { session_id: '41.1', agent_id: 'user-alice', owner_id: 'alice', workspace_path: '/w',
  durable_session_id: 'durable-1', session_endpoint: { channel_id: 'c' } as never }

void test('an execution of a session Moss bound is Moss-owned, live or ended', () => {
  assert.equal(isMossOwnedExecution(snapshot, 'alice', [binding]), true)
  assert.equal(isMossOwnedExecution(snapshot, 'alice', [undefined, binding]), true)
})

void test('an execution Moss never bound, or of another owner or agent, is external', () => {
  assert.equal(isMossOwnedExecution(snapshot, 'alice', []), false)
  assert.equal(isMossOwnedExecution({ ...snapshot, durable_session_id: 'durable-2' }, 'alice', [binding]), false)
  assert.equal(isMossOwnedExecution({ ...snapshot, agent_id: 'u-alice--other' }, 'alice', [binding]), false)
  assert.equal(isMossOwnedExecution({ ...snapshot, owner_id: 'bob' }, 'alice', [binding]), false)
  assert.equal(isMossOwnedExecution({ ...snapshot, session_endpoint: undefined }, 'alice', [binding]), false)
})
