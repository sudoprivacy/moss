import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentManager, type RuntimeAgentNamespace } from './agentManager.js'
import { defaultAgentName, nexusAgentName, nexusAgentReference, sessionAgentName } from './agentIdentity.js'
import { agentWorkspaceUrl } from './agentWorkspaceUrl.js'
import type { AuthContext } from './auth/token.js'

const auth: AuthContext = { userId: 'admin', orgId: 'org-a', role: 'admin', scopes: ['*'],
  rawToken: '', keyId: '', jti: '', exp: 0 }
const namespace: RuntimeAgentNamespace = { isOwnerConfined: true,
  names: ['persistent', 'worker', 'live'], managedNames: ['persistent'],
  executions: [{ name: 'worker', ownerId: 'alice', state: 'ready', kind: 'worker' },
    { name: 'live', ownerId: 'alice', state: 'busy', kind: 'managed' }] }
function manager(value = namespace) {
  return new AgentManager({
    visibleOwners: async actor => actor.userId === 'admin'
      ? [{ id: 'alice', displayName: 'Alice', isActive: true }, { id: 'bob', displayName: 'Bob', isActive: true }]
      : [{ id: actor.userId, displayName: actor.userId, isActive: true }],
    personalAgents: async owner => [{ ref: defaultAgentName(owner.id), agentName: `user-${owner.id}`,
      displayName: owner.displayName, kind: 'default' }],
    namespace: async ownerId => ({ ...value, executions: value.executions.map(record => ({ ...record, ownerId })) }),
  })
}

void test('organization manager discovers stopped Agents and keeps same names in separate owner boxes', async () => {
  const { agents } = await manager().list(auth)
  assert.equal(agents.length, 8)
  assert.equal(agents.filter(agent => agent.name === 'persistent').length, 2)
  const stopped = await manager().requireStart(auth, 'alice', 'persistent')
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.path, '/agents/persistent')
  assert.equal(sessionAgentName('alice', stopped.reference), 'persistent')
  assert.equal((await manager().get(auth, 'alice', 'worker')).canStart, false)
  await assert.rejects(manager().requireStart(auth, 'alice', 'worker'), { statusCode: 403 })
})

void test('listing permission alone never grants another owner conversation or exposes foreign owners', async () => {
  const viewer = { ...auth, scopes: ['sessions:list:any', 'sessions:create'] }
  assert.equal((await manager().get(viewer, 'alice', 'persistent')).canStart, false)
  await assert.rejects(manager().requireStart(viewer, 'alice', 'persistent'), { statusCode: 403 })
  await assert.rejects(manager().get(auth, 'foreign-org-owner', 'persistent'), { statusCode: 404 })
  const alice = { ...auth, userId: 'alice', role: 'user', scopes: ['sessions:list', 'sessions:create', 'sessions:attach'] }
  assert.equal((await manager().requireStart(alice, 'alice', 'persistent')).ownerId, 'alice')
  await assert.rejects(manager().get(alice, 'bob', 'persistent'), { statusCode: 404 })
  await assert.rejects(manager().list({ ...alice, scopes: [] }), { statusCode: 403 })
})

void test('shared legacy directory names are not attributed to each member without owner evidence', async () => {
  const { agents } = await manager({ ...namespace, isOwnerConfined: false, managedNames: [],
    executions: namespace.executions.filter(record => record.name === 'live') }).list(auth)
  assert.equal(agents.some(agent => agent.name === 'persistent' || agent.name === 'worker'), false)
  assert.equal(agents.filter(agent => agent.name === 'live').length, 2)
})

void test('failed native discovery is explicit and cannot grant unknown Agents', async () => {
  const service = new AgentManager({ visibleOwners: async () => [{ id: 'alice', displayName: 'Alice', isActive: true }],
    personalAgents: async () => [], namespace: async () => { throw new Error('runtime unavailable') } })
  assert.deepEqual(await service.list(auth), { agents: [], unavailableOwners: ['alice'] })
  await assert.rejects(service.requireStart(auth, 'alice', 'persistent'), { statusCode: 404 })
})

void test('organization pagination bounds runtime discovery and carries no foreign-owner authority', async () => {
  const first = await manager().list(auth, undefined, { limit: 1 })
  assert.equal(first.nextCursor, 'alice')
  assert.ok(first.agents.every(agent => agent.ownerId === 'alice'))
  const second = await manager().list(auth, undefined, { limit: 1, after: first.nextCursor! })
  assert.equal(second.nextCursor, null)
  assert.ok(second.agents.every(agent => agent.ownerId === 'bob'))
})

void test('disabled owners remain visible but cannot start a conversation', async () => {
  const service = new AgentManager({
    visibleOwners: async () => [{ id: 'alice', displayName: 'Alice', isActive: false }, { id: 'bob', displayName: 'Bob', isActive: true }],
    personalAgents: async () => [], namespace: async () => namespace,
  })
  const { agents } = await service.list(auth)
  assert(agents.some(agent => agent.ownerId === 'alice'))
  assert(agents.filter(agent => agent.ownerId === 'alice').every(agent => !agent.isOwnerActive && !agent.canStart))
  assert.equal((await service.get(auth, 'bob', 'persistent')).canStart, true)
  await assert.rejects(service.requireStart(auth, 'alice', 'persistent'), { statusCode: 403 })
})

void test('Agent references round trip Unicode and refuse path traversal or malformed base64', async () => {
  const reference = nexusAgentReference('质量 Agent #1')
  assert.equal(nexusAgentName(reference), '质量 Agent #1')
  for (const name of ['..', '../alice', 'a/b', 'a\\b', '\0', '']) {
    assert.throws(() => nexusAgentReference(name), { statusCode: 400 })
  }
  assert.throws(() => nexusAgentName(`${reference}=`), { statusCode: 400 })
  await assert.rejects(manager().get(auth, 'alice', '../bob'), { statusCode: 400 })
})

void test('workbench links use the configured secure origin and contain no credential parameters', () => {
  assert.equal(agentWorkspaceUrl('session-1', 'https://webui.sudoprivacy.com', 'org-2'), 'https://webui.sudoprivacy.com/#/conversation/session-1?org_id=org-2')
  for (const orgId of ['../org', 'org&token=secret', 'x'.repeat(129)]) assert.equal(agentWorkspaceUrl('session-1', 'https://webui.sudoprivacy.com', orgId), null)
  assert.equal(agentWorkspaceUrl('session-1', 'https://webui.sudoprivacy.com'), 'https://webui.sudoprivacy.com/#/conversation/session-1')
  assert.equal(agentWorkspaceUrl('session-1', 'http://localhost:26808'), 'http://localhost:26808/#/conversation/session-1')
  assert.equal(agentWorkspaceUrl('session-1', 'https://example.com/workspace/'), 'https://example.com/workspace/#/conversation/session-1')
  for (const url of ['http://unsafe.example', 'https://admin:secret@example.com', 'https://example.com?token=x', 'javascript:alert(1)', '']) {
    assert.equal(agentWorkspaceUrl('session-1', url), null)
  }
})
