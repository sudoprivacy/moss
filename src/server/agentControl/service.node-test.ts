import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { AuthService } from '../auth/service.js'
import { issueAccessToken } from '../auth/token.js'
import { createIdentityTestRepository } from '../testing/compatibilityRepositories.js'
import { AGENT_CONTROL_PROTOCOL, type ManagedControlActor } from './contract.js'
import { AgentControlService } from './service.js'
import { AgentControlStore } from './store.js'
import type { DeviceDeployEffect, DeviceDeployPort } from './deviceDeploy.js'

async function fixture(t: TestContext) {
  const raw = new DatabaseSync(':memory:'), db = new AuthCenterDb(raw)
  createIdentityTestRepository(raw, {}, db.driver)
  const auth = new AuthService(db, 3600)
  t.after(() => { auth.destroy(); raw.close() })
  await db.setConfig('issuer', 'control-fixture'); await db.setConfig('jwt_secret', 'fixture-control-signing-secret')
  await db.createOrganization('org-a', 'A', 1)
  const user = (await auth.createUser({ orgId: 'org-a', name: 'control-owner', role: 'admin', password: 'StrongPass123' })).user
  const login = await auth.issueTokenFromPassword({ username: 'control-owner', password: 'StrongPass123' })
  const actor: ManagedControlActor = { plane: 'managed-cohost', ownerId: user.id, agentId: `user-${user.id}`, sessionId: 'actor-session', taskId: 'actual-task',
    attemptId: 'attempt-original', durableSessionId: 'session-original', repositoryPath: '/agents/fixture/workspace', executionId: '123.1' }
  const store = new AgentControlStore(db.driver)
  const state = { effects: 0, lost: false, actor, actorHook: async () => {}, current: true,
    effect: async () => {}, scopes: undefined as string[] | undefined }
  const authority = auth.createAgentControlAuthority()
  const deps = { deploymentId: 'dgx-fixture', authority: { ...authority, member: async (id: string, org: string) => {
    const member = await authority.member(id, org)
    return member && state.scopes ? { ...member, scopes: state.scopes } : member
  } },
  actor: async () => { await state.actorHook(); return { ...state.actor } },
  actorCurrent: async () => { if (!state.current) throw new Error('Actor binding changed') },
  operations: {
    list: async () => ({ agents: [], unavailableOwners: [] }),
    detail: async () => { throw new Error('Fixture does not execute inspect') },
    start: async (effective: { userId: string }, ownerId: string) => {
      assert.equal(effective.userId, user.id); assert.equal(ownerId, user.id)
      state.effects++; await state.effect()
      if (state.lost) throw new Error('Response lost after the effect')
      return { sessionId: 'created-by-original-owner', workspaceUrl: null }
    },
    inspectRuntime: async () => ({ ownerId: user.id, isPresent: false, isDrifted: false, phase: 'legacy' }),
  } }
  const service = new AgentControlService(store, deps)
  const request = { actorSessionId: actor.sessionId, target: { deploymentId: 'dgx-fixture', ownerId: user.id },
    actions: ['agents.list', 'agents.spawn'], ttlSeconds: 120 }
  const issued = await service.issue(login.access_token, request)
  const token = issued.credential.accessToken
  const invocation = { protocol: AGENT_CONTROL_PROTOCOL, operationId: 'native-command-original', action: 'agents.spawn', arguments: { agent: 'existing-agent' } }
  return { raw, db, auth, user, login, actor, state, store, deps, service, request, issued, token, invocation }
}

async function deviceFixture(t: TestContext) {
  const f = await fixture(t)
  const state = { sha256: 'a'.repeat(64), submits: 0, queries: 0, lost: false, completed: false,
    effect: undefined as DeviceDeployEffect | undefined }
  const receipt = (effect: DeviceDeployEffect) => ({ ...effect, schemaVersion: 1, action: 'runtime.deploy',
    status: state.completed ? 'completed' : 'unknown', outcome: state.completed ? 'completed' : 'unknown',
    domainJoinAccepted: false, selectionAccepted: state.completed, productQualificationAccepted: state.completed,
    runnerSha256: 'c'.repeat(64), implementationSha256: 'd'.repeat(64), osUid: 1000,
    unit: 'sudo-deploy-' + 'e'.repeat(40) + '.service',
    ...(state.completed ? { originalSessionId: 'original-product-session', modelTurnsCompleted: 3,
      nativeBindingPreserved: { ownerId: f.user.id, agentId: 'original-product-agent', durableSessionId: 'original-product-sid', repositoryPath: '/original/workspace' } } : {}) })
  const deviceDeploy: DeviceDeployPort = {
    inspect: async planId => {
      if (planId !== 'product-upgrade') throw new Error('Unknown operator plan')
      return { deploymentId: 'dgx-fixture', ownerId: f.user.id, planId, planSha256: state.sha256, description: 'Original product update' }
    },
    submit: async effect => { state.submits++; state.effect = effect; if (state.lost) throw new Error('Lost systemd submission response'); return receipt(effect) },
    query: async effect => { state.queries++; assert.deepEqual(effect, state.effect); return receipt(effect) },
  }
  const deps = { ...f.deps, deviceDeploy }
  const service = new AgentControlService(f.store, deps)
  const request = { ...f.request, actions: ['runtime.deploy'], deploymentPlans: [{ planId: 'product-upgrade', sha256: state.sha256 }] }
  const issued = await service.issue(f.login.access_token, request)
  const invocation = { ...f.invocation, action: 'runtime.deploy', arguments: { planId: 'product-upgrade' } }
  return { ...f, state, deps, service, request, issued, invocation, token: issued.credential.accessToken, receipt }
}

void test('device deploy needs current administrator scope and an explicit matching operator plan', async t => {
  const f = await deviceFixture(t)
  await assert.rejects(f.service.issue(f.login.access_token, { ...f.request, deploymentPlans: undefined }))
  await assert.rejects(f.service.issue(f.login.access_token, { ...f.request, deploymentPlans: [{ planId: 'product-upgrade', sha256: 'b'.repeat(64) }] }))
  await assert.rejects(f.service.invoke(f.token, { ...f.invocation, arguments: { planId: 'unapproved' } }))
  await assert.rejects(f.service.invoke(f.token, { ...f.invocation, arguments: { planId: 'product-upgrade', command: 'shell' } }))
  const capabilities = await f.service.capabilities(f.token)
  assert.deepEqual((capabilities.tools[0].inputSchema as any).properties.planId.enum, ['product-upgrade'])
  f.deps.authority.member = async () => ({ status: 'active', role: 'admin', scopes: ['sessions:list', 'sessions:attach'] })
  await assert.rejects(f.service.invoke(f.token, f.invocation))
  assert.equal(f.state.submits, 0)
})

void test('a device job survives controller replacement and human receipt recovery after grant revocation', async t => {
  const f = await deviceFixture(t)
  f.state.lost = true
  const initial = await f.service.invoke(f.token, f.invocation)
  assert.equal(initial.outcome, 'unknown'); assert.equal(f.state.submits, 1)
  assert.deepEqual(initial.audit.deviceEffect, f.state.effect)
  assert.match(f.state.effect!.operationId, /^moss-[a-f0-9]{64}$/)
  const restarted = new AgentControlService(new AgentControlStore(f.db.driver), f.deps)
  await restarted.revoke(f.login.access_token, f.issued.delegation.id)
  f.deps.actorCurrent = async () => { throw new Error('Original actor exited during deploy') }
  f.state.completed = true
  const recovered = await restarted.operation(f.login.access_token, f.invocation.operationId)
  assert.equal(recovered.outcome, 'completed')
  assert.equal(recovered.errorCode, undefined)
  assert.equal((recovered.result as any).originalSessionId, 'original-product-session')
  assert.equal((recovered.result as any).domainJoinAccepted, false)
  assert.equal(f.state.submits, 1); assert.equal(f.state.queries, 1)
  await assert.rejects(restarted.invoke(f.token, f.invocation))
})

void test('approval changes refuse a new deploy and a mismatched queried receipt cannot complete an existing job', async t => {
  const f = await deviceFixture(t)
  f.state.sha256 = 'b'.repeat(64)
  await assert.rejects(f.service.invoke(f.token, f.invocation))
  assert.equal(f.state.submits, 0)
  assert.equal(await f.store.operation('org-a', f.invocation.operationId), null)
  f.state.sha256 = 'a'.repeat(64)
  const pending = await f.service.invoke(f.token, f.invocation)
  assert.equal(pending.outcome, 'unknown')
  f.state.completed = true
  f.deps.deviceDeploy.query = async effect => ({ ...f.receipt(effect), planSha256: 'f'.repeat(64) })
  const recovered = await f.service.operation(f.login.access_token, f.invocation.operationId)
  assert.equal(recovered.outcome, 'unknown')
  assert.equal(f.state.submits, 1)
})

void test('concurrent original device commands reserve one external job and never replay it', async t => {
  const f = await deviceFixture(t)
  const results = await Promise.all([f.service.invoke(f.token, f.invocation), f.service.invoke(f.token, f.invocation)])
  assert.equal(f.state.submits, 1)
  assert.ok(results.every(value => value.outcome === 'unknown'))
  await f.service.invoke(f.token, f.invocation)
  assert.equal(f.state.submits, 1)
})

void test('purpose-bound real Moss credentials cannot log in or acquire undelegated tools', async t => {
  const f = await fixture(t)
  assert.equal(await f.auth.verifyAccessToken(f.token), null)
  await assert.rejects(f.service.capabilities(f.login.access_token))
  const discovered = await f.service.capabilities(f.token)
  assert.deepEqual(discovered.tools.map(tool => tool.action), ['agents.list', 'agents.spawn'])
  assert.ok(!JSON.stringify(discovered).includes(f.token))
  await assert.rejects(f.service.invoke(f.token, { ...f.invocation, action: 'runtime.inspect', arguments: {} }))
  assert.equal(f.state.effects, 0)
})

void test('actor, target and scopes come from current authority rather than request fields or admin role', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.issue(f.login.access_token, { ...f.request, actorSessionId: 'someone-else' }))
  await assert.rejects(f.service.issue(f.login.access_token, { ...f.request, target: { ...f.request.target, deploymentId: 'other-device' } }))
  for (const patch of [{ actor: { ownerId: 'forged' } }, { target: { ownerId: 'forged' } }])
    await assert.rejects(f.service.invoke(f.token, { ...f.invocation, ...patch }))
  await assert.rejects(f.service.invoke(f.token, { ...f.invocation, arguments: { agent: 'existing-agent', ownerId: 'forged' } }))
  const restricted = issueAccessToken({ iss: f.db.getIssuer(), sub: f.user.id, org_id: 'org-a', role: 'admin',
    scopes: ['sessions:list', 'sessions:attach'], key_id: 'fixture-narrow-key' }, f.db.getJwtSecret()).token
  await assert.rejects(f.service.issue(restricted, f.request))
  assert.equal(f.state.effects, 0)
})

void test('an attenuated control credential cannot borrow its stored delegation permissions', async t => {
  const f = await fixture(t)
  const verify = f.deps.authority.control
  f.deps.authority.control = async token => {
    const current = await verify(token)
    return current && { ...current, scopes: [] }
  }
  await assert.rejects(f.service.capabilities(f.token))
  await assert.rejects(f.service.invoke(f.token, f.invocation))
  assert.equal(f.state.effects, 0)
})

void test('response loss keeps one effect and its real actor audit across a fresh controller', async t => {
  const f = await fixture(t); f.state.lost = true
  const first = await f.service.invoke(f.token, f.invocation)
  assert.equal(first.outcome, 'unknown'); assert.equal(f.state.effects, 1)
  assert.deepEqual(first.audit.actor, f.actor)
  assert.equal(first.audit.initiatedBy, f.user.id)
  assert.match(first.audit.requestedInputSha256, /^sha256:[a-f0-9]{64}$/)
  const next = new AgentControlService(new AgentControlStore(f.db.driver), f.deps)
  const repeated = await next.invoke(f.token, f.invocation)
  assert.deepEqual(repeated, first); assert.equal(f.state.effects, 1)
  assert.equal((await next.operation(f.token, f.invocation.operationId)).outcome, 'unknown')
  await assert.rejects(next.invoke(f.token, { ...f.invocation, arguments: { agent: 'different-agent' } }))
  assert.equal(f.state.effects, 1)
})

void test('concurrent identical commands share the same durable operation and execute once', async t => {
  const f = await fixture(t)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(r => { entered = r }), gate = new Promise<void>(r => { release = r })
  f.state.effect = async () => { entered(); await gate }
  const first = f.service.invoke(f.token, f.invocation)
  await started
  try {
    const second = await f.service.invoke(f.token, f.invocation)
    assert.equal(second.outcome, 'unknown'); assert.equal(f.state.effects, 1)
  } finally { release() }
  assert.equal((await first).outcome, 'completed')
  assert.equal((await f.service.invoke(f.token, f.invocation)).outcome, 'completed')
  assert.equal(f.state.effects, 1)
})

void test('delegation revocation during native inspection refuses final admission without an effect', async t => {
  const f = await fixture(t)
  f.state.actorHook = async () => { await f.store.revoke('org-a', f.issued.delegation.id, f.user.id) }
  const result = await f.service.invoke(f.token, f.invocation)
  assert.equal(result.outcome, 'not_submitted'); assert.equal(f.state.effects, 0)
})

void test('current role, parent logout and resumed native execution independently invalidate the capability', async t => {
  for (const change of ['role', 'logout', 'resume'] as const) {
    await t.test(change, async s => {
      const f = await fixture(s)
      if (change === 'role') await f.db.driver.run("UPDATE users SET role = 'user' WHERE id = ?", [f.user.id])
      else if (change === 'logout') {
        const parent = await f.auth.verifyAccessToken(f.login.access_token)
        assert.ok(parent); await f.db.revokeToken(parent.jti, parent.exp)
      } else f.state.actor = { ...f.actor, attemptId: 'attempt-new', executionId: '123.2' }
      await assert.rejects(f.service.invoke(f.token, f.invocation))
      assert.equal(f.state.effects, 0)
    })
  }
})

void test('a late local actor change or scope reduction is refused before dispatch', async t => {
  for (const change of ['actor', 'scopes'] as const) {
    await t.test(change, async s => {
      const f = await fixture(s)
      f.state.actorHook = async () => {
        if (change === 'actor') f.state.current = false
        else f.state.scopes = ['sessions:list', 'sessions:attach']
      }
      const result = await f.service.invoke(f.token, f.invocation)
      assert.equal(result.outcome, 'not_submitted'); assert.equal(f.state.effects, 0)
    })
  }
})
