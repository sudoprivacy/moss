import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { WorkAdmission } from '@sudo/user-runtime'
import { defaultAgentName, isUserOwnedAgentName, mossAgentName, nexusAgentReference, sessionAgentName } from './agentIdentity.js'
import type { AuthContext } from './auth/token.js'
import { ResourceAccessError } from './catalog/resourceError.js'
import { SqliteDriver } from './db/driver.js'
import { MossAgentAccess, type MossMember } from './mossAgentAccess.js'
import { requirePersonalAgent } from './personalAgentAccess.js'

function fixture() {
  const raw = new DatabaseSync(':memory:')
  const driver = new SqliteDriver(raw)
  const members = new Map<string, MossMember>([
    ['admin', { id: 'admin', orgId: 'a', role: 'admin', status: 'active' }],
    ['alice', { id: 'alice', orgId: 'a', role: 'user', status: 'active' }],
    ['bob', { id: 'bob', orgId: 'a', role: 'user', status: 'active' }],
    ['other', { id: 'other', orgId: 'b', role: 'admin', status: 'active' }],
  ])
  const lookup = async (id: string) => members.get(id) ?? null
  return { raw, driver, members, lookup, service: new MossAgentAccess(driver, lookup),
    auth: { userId: 'admin', orgId: 'a', role: 'admin', scopes: ['admin:users'] } as AuthContext }
}

void test('each authorized member has one stable Moss identity, isolated from personal identities and other tenants', async () => {
  const f = fixture()
  try {
    await f.service.initialize()
    assert.equal(await f.service.canUse('a', 'alice'), false)
    assert.equal(await f.service.canUse('a', 'admin'), true)
    assert.deepEqual(await f.service.getAccess(f.auth, 'alice'), {
      orgId: 'a', userId: 'alice', isEnabled: false, isGranted: false, source: 'role', memberStatus: 'active',
    })
    await f.service.setAccess(f.auth, 'alice', true)
    assert.equal((await f.service.getAccess(f.auth, 'alice')).source, 'explicit')
    const identities = await Promise.all(Array.from({ length: 20 }, () => f.service.getAgent('a', 'alice')))
    assert.equal(new Set(identities.map(agent => agent.ref)).size, 1)
    const identity = identities[0]!
    assert.equal(isUserOwnedAgentName(identity.ref), true)
    assert.notEqual(identity.agentName, sessionAgentName('alice', defaultAgentName('alice')))
    assert.notEqual(identity.agentName, sessionAgentName('alice', mossAgentName('b', 'alice')))
    assert.notEqual(identity.agentName, sessionAgentName('bob', mossAgentName('a', 'bob')))
    assert.match(identity.agentName, /^[A-Za-z0-9._-]+$/)
    const reopened = new MossAgentAccess(f.driver, f.lookup)
    assert.deepEqual(await reopened.getAgent('a', 'alice'), identity)
    assert.equal(await requirePersonalAgent('a', 'alice', identity.ref), null)
    for (const [org, user] of [['a', 'bob'], ['b', 'alice']]) {
      await assert.rejects(requirePersonalAgent(org!, user!, identity.ref), ResourceAccessError)
    }
  } finally { f.raw.close() }
})

void test('revocation, disabled membership and moving organizations deny use without changing the durable identity', async () => {
  const f = fixture()
  try {
    await f.service.initialize()
    await f.service.setAccess(f.auth, 'alice', true)
    const first = await f.service.getAgent('a', 'alice')
    await f.service.setAccess(f.auth, 'alice', false)
    await assert.rejects(f.service.getAgent('a', 'alice'), error => error instanceof ResourceAccessError && error.statusCode === 403)
    await f.service.setAccess(f.auth, 'alice', true)
    assert.deepEqual(await f.service.getAgent('a', 'alice'), first)
    f.members.get('alice')!.status = 'disabled'
    assert.equal(await f.service.canUse('a', 'alice'), false)
    const disabled = await f.service.getAccess(f.auth, 'alice')
    assert.equal(disabled.isGranted, true)
    assert.equal(disabled.isEnabled, false)
    f.members.get('alice')!.status = 'active'
    f.members.get('alice')!.orgId = 'b'
    assert.equal(await f.service.canUse('a', 'alice'), false)
    assert.equal(await f.service.canUse('b', 'alice'), false)
    await f.service.setAccess(f.auth, 'admin', false)
    assert.equal(await f.service.canUse('a', 'admin'), false)
  } finally { f.raw.close() }
})

void test('ordinary members, forged roles, stale admin JWTs and foreign-organization grants are refused', async () => {
  const f = fixture()
  try {
    await f.service.initialize()
    await assert.rejects(f.service.setAccess({ ...f.auth, userId: 'alice', role: 'super_admin' }, 'bob', true), ResourceAccessError)
    await assert.rejects(f.service.setAccess(f.auth, 'other', true), error => error instanceof ResourceAccessError && error.statusCode === 404)
    await assert.rejects(f.service.setAccess({ ...f.auth, orgId: 'b' }, 'other', true), ResourceAccessError)
    await assert.rejects(f.service.setAccess({ ...f.auth, scopes: [] }, 'alice', true), ResourceAccessError)
    for (const actor of [{ ...f.auth, userId: 'alice', role: 'super_admin' }, { ...f.auth, scopes: [] }]) {
      await assert.rejects(f.service.getAccess(actor, 'alice'), ResourceAccessError)
    }
    await assert.rejects(f.service.getAccess(f.auth, 'other'), error => error instanceof ResourceAccessError && error.statusCode === 404)
    f.members.get('admin')!.role = 'super_admin'
    assert.equal((await f.service.getAccess({ ...f.auth, orgId: 'b' }, 'other')).orgId, 'b',
      'a current super-admin may manage the explicitly selected organization')
    f.members.get('admin')!.role = 'user'
    await assert.rejects(f.service.setAccess(f.auth, 'alice', true), ResourceAccessError)
    await assert.rejects(f.service.getAccess(f.auth, 'alice'), ResourceAccessError)
    assert.equal(await f.service.canUse('a', 'admin'), false)
    assert.equal(await f.service.canUse('a', 'bob'), false)
  } finally { f.raw.close() }
})

void test('database errors and malformed/foreign references cannot fall back to an implicit personal or shared Agent', async () => {
  const f = fixture()
  await f.service.initialize()
  f.raw.close()
  await assert.rejects(f.service.getAgent('a', 'admin'))
  assert.throws(() => sessionAgentName('alice', 'moss-agent:operator:invalid'), ResourceAccessError)
  assert.throws(() => sessionAgentName('bob', mossAgentName('a', 'alice')), ResourceAccessError)
})

void test('the runtime guard also rejects revoked or foreign Moss identities addressed through native Nexus references', async () => {
  const { RuntimeService } = await import('./runtimeService.js')
  const f = fixture()
  try {
    await f.service.initialize()
    await f.service.setAccess(f.auth, 'alice', true)
    const agent = await f.service.getAgent('a', 'alice')
    const runtime = { authService: { mossAgents: f.service } } as unknown as InstanceType<typeof RuntimeService>
    const check = (ref: string, orgId = 'a', userId = 'alice', role = 'user') =>
      RuntimeService.prototype.requireSessionAgentAccess.call(runtime, { orgId, userId, role, assistantName: ref })
    const native = nexusAgentReference(agent.agentName)
    await check(agent.ref)
    await check(native)
    f.members.get('alice')!.role = 'admin'
    for (const reference of [agent.ref, native]) {
      await assert.rejects(check(reference), error => error instanceof ResourceAccessError && error.statusCode === 403)
      await check(reference, 'a', 'alice', 'admin')
    }
    f.members.get('alice')!.role = 'user'
    for (const reference of [agent.ref, native]) {
      await assert.rejects(check(reference, 'a', 'alice', 'admin'), error => error instanceof ResourceAccessError && error.statusCode === 403)
    }
    for (const reference of [agent.ref, native]) {
      await assert.rejects(check(reference, 'b'), error => error instanceof ResourceAccessError && error.statusCode === 404)
      await assert.rejects(check(reference, 'a', 'bob'), error => error instanceof ResourceAccessError && error.statusCode === 404)
    }
    await f.service.setAccess(f.auth, 'alice', false)
    for (const reference of [agent.ref, native]) {
      await assert.rejects(check(reference), error => error instanceof ResourceAccessError && error.statusCode === 403)
    }
    await check(defaultAgentName('alice'))
  } finally { f.raw.close() }
})

void test('Moss sessions keep their true source and owner while carrying trusted workbench presentation', async () => {
  const { RuntimeService } = await import('./runtimeService.js')
  const f = fixture()
  try {
    await f.service.initialize()
    await f.service.setAccess(f.auth, 'alice', true)
    f.members.get('alice')!.displayName = 'Alice'
    const agent = await f.service.getAgent('a', 'alice')
    const runtime = {
      workAdmission: new WorkAdmission(),
      createAdmittedSession: RuntimeService.prototype['createAdmittedSession'],
      draining: false, upgradingOwners: new Set(), options: { config: { defaultRuntime: 'cohost' } },
      authService: { mossAgents: f.service },
      resourceScope: async () => ({ orgId: 'a', userId: 'alice', role: 'user', scopes: [] }),
      requireSessionAgentAccess: async () => {},
      createSessionInResourceScope: async (input: Record<string, unknown>) => input,
    } as unknown as InstanceType<typeof RuntimeService>
    for (const source of ['lark', 'agent-manager']) {
      const session = await RuntimeService.prototype.createSession.call(runtime, {
        orgId: 'a', userId: 'alice', role: 'user', scopes: [], assistantName: agent.ref,
        dangerouslySkipPermissions: false, runtime: { type: 'cohost', engine: 'scode' }, source,
        ...(source === 'agent-manager' ? { managementActorId: 'admin' } : {}),
      }) as unknown as Record<string, unknown>
      assert.equal(session.source, source)
      assert.equal(session.userId, 'alice')
      assert.equal(session.managementActorId, source === 'lark' ? 'alice' : 'admin')
      assert.deepEqual(session.managementAgent, { name: agent.agentName, displayName: 'Moss', ownerName: 'Alice' })
    }
  } finally { f.raw.close() }
})
