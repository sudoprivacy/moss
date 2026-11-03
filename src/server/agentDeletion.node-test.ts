import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentManager, type RuntimeAgentNamespace } from './agentManager.js'
import { AgentManagementOperations, type AgentManagementDependencies } from './agentManagementOperations.js'
import { defaultAgentName, userCreatedAgentName } from './agentIdentity.js'
import type { AuthContext } from './auth/token.js'

const admin: AuthContext = { userId: 'admin', orgId: 'org-a', role: 'admin', scopes: ['*'],
  rawToken: '', keyId: '', jti: '', exp: 0 }
const alice: AuthContext = { ...admin, userId: 'alice', role: 'user',
  scopes: ['sessions:list', 'sessions:create', 'sessions:attach'] }
const moss = `moss-${'a'.repeat(64)}`
const namespace: RuntimeAgentNamespace = { isOwnerConfined: true,
  names: ['persistent', moss], managedNames: ['persistent', moss], executions: [] }

function operations() {
  const calls = { runtime: [] as string[][], identities: [] as string[][], audits: [] as unknown[] }
  const manager = new AgentManager({
    visibleOwners: async actor => actor.userId === 'admin'
      ? [{ id: 'alice', displayName: 'Alice', isActive: true }]
      : [{ id: actor.userId, displayName: actor.userId, isActive: true }],
    personalAgents: async owner => [
      { ref: defaultAgentName(owner.id), agentName: `user-${owner.id}`, displayName: owner.displayName, kind: 'default' },
      { ref: userCreatedAgentName('p1'), agentName: `u-${owner.id}--p1`, displayName: 'Probe', kind: 'own' },
    ],
    namespace: async () => namespace,
  })
  const deps = {
    manager,
    runtime: {
      deleteOwnerAgent: async (ownerId: string, orgId: string, name: string) => {
        calls.runtime.push([ownerId, orgId, name])
        return { sessions: 2, isNativeDeleted: true }
      },
    },
    deleteUserAgent: async (orgId: string, ownerId: string, id: string) => {
      calls.identities.push([orgId, ownerId, id])
      return true
    },
    audit: async (event: unknown) => { calls.audits.push(event) },
    record: () => {},
  } as unknown as AgentManagementDependencies
  return { operations: new AgentManagementOperations(deps), calls }
}

void test('an owner deletes their own Agent: runtime data, sessions and identity, audited', async () => {
  const { operations: agents, calls } = operations()
  assert.deepEqual(await agents.deleteAgent(alice, 'alice', 'u-alice--p1'),
    { name: 'u-alice--p1', sessions: 2, isNativeDeleted: true, isIdentityDeleted: true })
  assert.deepEqual(calls.runtime, [['alice', 'org-a', 'u-alice--p1']])
  assert.deepEqual(calls.identities, [['org-a', 'alice', 'p1']])
  assert.deepEqual(calls.audits, [{ actorUserId: 'alice', orgId: 'org-a', ownerId: 'alice', agentName: 'u-alice--p1',
    details: { sessions: 2, isNativeDeleted: true, isIdentityDeleted: true } }])
})

void test('a settings administrator deletes a template Agent, which has no identity to remove', async () => {
  const { operations: agents, calls } = operations()
  assert.equal((await agents.deleteAgent(admin, 'alice', 'persistent')).isIdentityDeleted, false)
  assert.deepEqual(calls.runtime, [['alice', 'org-a', 'persistent']])
  assert.deepEqual(calls.identities, [])
})

void test('the default and Moss Agents stay, and nobody deletes what they cannot manage or see', async () => {
  const { operations: agents, calls } = operations()
  await assert.rejects(agents.deleteAgent(alice, 'alice', 'user-alice'), { statusCode: 409 })
  await assert.rejects(agents.deleteAgent(admin, 'alice', moss), { statusCode: 409 })
  await assert.rejects(agents.deleteAgent(alice, 'bob', 'persistent'), { statusCode: 403 })
  await assert.rejects(agents.deleteAgent(admin, 'bob', 'persistent'), { statusCode: 404 })
  await assert.rejects(agents.deleteAgent(alice, 'alice', 'missing'), { statusCode: 404 })
  assert.deepEqual(calls, { runtime: [], identities: [], audits: [] })
})
