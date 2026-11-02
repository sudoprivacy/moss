import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AuthContext } from './auth/token.js'
import { ResourceAccessError } from './catalog/resourceError.js'
import { RuntimeFleet, type RuntimeAuditEvent, type RuntimeFleetDependencies, type RuntimeOwner, type RuntimeState } from './runtimeFleet.js'

const GIB = 1024 ** 3

function auth(userId: string, orgId: string, role = 'admin', scopes = ['admin:settings']): AuthContext {
  return { rawToken: 't', userId, orgId, role, scopes, keyId: 'k', jti: 'j', exp: 0 }
}

function fleet(owners: Record<string, RuntimeOwner | null>, overrides: Partial<RuntimeFleetDependencies> = {}) {
  const states = new Map<string, RuntimeState>(Object.keys(owners).map(id =>
    [id, { isPresent: true, isDrifted: true, phase: 'Running', upgradeLock: null }]))
  const audits: RuntimeAuditEvent[] = []
  const calls: string[] = []
  const deps: RuntimeFleetDependencies = {
    placements: async () => [...states].filter(([, state]) => state.isPresent).map(([ownerId]) => ({ ownerId })),
    inspect: async ownerId => states.get(ownerId)!,
    owner: async ownerId => owners[ownerId] ?? null,
    upgrade: async ownerId => {
      calls.push(`upgrade ${ownerId}`)
      states.set(ownerId, { ...states.get(ownerId)!, isDrifted: false })
      return states.get(ownerId)!
    },
    retire: async ownerId => {
      calls.push(`retire ${ownerId}`)
      states.set(ownerId, { ...states.get(ownerId)!, isPresent: false, phase: 'absent' })
      return true
    },
    recoverLock: async ownerId => {
      calls.push(`recover ${ownerId}`)
      states.set(ownerId, { ...states.get(ownerId)!, upgradeLock: null })
      return true
    },
    memory: () => ({ used: 1 * GIB, total: 8 * GIB }),
    audit: async event => { audits.push(event) },
    sleep: async () => {},
    ...overrides,
  }
  return { fleet: new RuntimeFleet(deps), states, audits, calls }
}

const owners = {
  alice: { orgId: 'org-a', name: 'Alice', status: 'active' },
  disabled: { orgId: 'org-a', name: 'Dee', status: 'disabled' },
  bob: { orgId: 'org-b', name: 'Bob', status: 'active' },
  orphan: null,
}

void test('organization admins see their organization; only the platform administrator sees every organization', async () => {
  const { fleet: subject } = fleet(owners)
  const rows = await subject.list(auth('admin-a', 'org-a'), 'org')
  assert.deepEqual(rows.map(row => [row.ownerId, row.ownerStatus, row.canUpgrade, row.canRetire]),
    [['alice', 'active', true, false], ['disabled', 'disabled', false, true]])
  await assert.rejects(subject.list(auth('admin-a', 'org-a'), 'all'), (error: unknown) =>
    error instanceof ResourceAccessError && error.statusCode === 403)
  await assert.rejects(subject.list(auth('member', 'org-a', 'member', ['sessions:create']), 'org'), /settings administration/)
  const all = await subject.list(auth('root', 'org-a', 'super_admin'), 'all')
  assert.deepEqual(all.map(row => [row.ownerId, row.ownerStatus]).sort(),
    [['alice', 'active'], ['bob', 'active'], ['disabled', 'disabled'], ['orphan', 'unknown']])
})

void test('only an owner who cannot use their runtime is retired, and the change is audited', async () => {
  const { fleet: subject, calls, audits } = fleet(owners)
  const admin = auth('admin-a', 'org-a')
  await assert.rejects(subject.retire(admin, 'alice'), /disable the owner first/)
  await assert.rejects(subject.retire(admin, 'bob'), (error: unknown) =>
    error instanceof ResourceAccessError && error.statusCode === 404)
  assert.deepEqual(await subject.retire(admin, 'disabled'), { isRetired: true })
  assert.deepEqual(calls, ['retire disabled'])
  assert.deepEqual(audits.map(event => [event.action, event.ownerId, event.orgId, event.actor?.userId]),
    [['RUNTIME_RETIRED', 'disabled', 'org-a', 'admin-a']])
  // An owner without an account is visible only to the platform administrator.
  await assert.rejects(subject.retire(admin, 'orphan'), /not visible/)
  assert.deepEqual(await subject.retire(auth('root', 'org-a', 'super_admin'), 'orphan'), { isRetired: true })
})

void test('reconciliation retires runtimes of known inactive owners only', async () => {
  const { fleet: subject, calls, audits } = fleet(owners)
  assert.deepEqual(await subject.reconcile(), ['disabled'])
  assert.deepEqual(calls, ['retire disabled'])
  assert.deepEqual(audits.map(event => [event.action, event.actor, event.details]),
    [['RUNTIME_RETIRED', null, { reason: 'owner disabled' }]])
  assert.deepEqual(await subject.reconcile(), [], 'a retired runtime is not retired again')
})

void test('a rollout runs exactly the reviewed plan and refuses a plan that changed', async () => {
  const { fleet: subject, calls, audits } = fleet(owners)
  const root = auth('root', 'org-a', 'super_admin')
  await assert.rejects(subject.startRollout(auth('admin-a', 'org-a'), ['alice']), /platform administrator/)
  assert.deepEqual((await subject.plan(root)).map(row => row.ownerId).sort(), ['alice', 'bob'])
  await assert.rejects(subject.startRollout(root, ['alice']), /plan changed/)
  const rollout = await subject.startRollout(root, ['bob', 'alice'])
  await assert.rejects(subject.startRollout(root, ['bob', 'alice']), /already running|plan changed/)
  while (subject.current(root)?.finishedAt === null) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(rollout.owners.map(owner => [owner.ownerId, owner.outcome]).sort(), [['alice', 'upgraded'], ['bob', 'upgraded']])
  assert.deepEqual(calls.sort(), ['upgrade alice', 'upgrade bob'])
  assert.deepEqual(audits.map(event => event.action),
    ['RUNTIME_ROLLOUT_STARTED', 'RUNTIME_UPGRADED', 'RUNTIME_UPGRADED', 'RUNTIME_ROLLOUT_FINISHED'])
  await assert.rejects(subject.startRollout(root, []), /No runtime needs an upgrade/)
})

void test('a rollout waits for controller memory and stops before exhausting the host', async () => {
  const readings = [1, 4, 3, 5].map(gib => ({ used: gib * GIB, total: 8 * GIB }))
  const { fleet: subject, calls } = fleet({ alice: owners.alice, bob: owners.bob }, {
    memory: () => readings.shift() ?? { used: 5 * GIB, total: 8 * GIB },
    upgrade: async ownerId => {
      calls.push(`upgrade ${ownerId}`)
      if (ownerId === 'alice') throw new ResourceAccessError(409, 'Finish active Agent work before upgrading this owner')
      return { isPresent: true, isDrifted: false, phase: 'Running' }
    },
  })
  const root = auth('root', 'org-a', 'super_admin')
  const rollout = await subject.startRollout(root, ['alice', 'bob'])
  while (subject.current(root)?.finishedAt === null) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(rollout.owners.map(owner => [owner.ownerId, owner.outcome]), [['alice', 'busy'], ['bob', 'pending']])
  assert.deepEqual(rollout.stopped, { beforeOwnerId: 'bob', controllerMemory: 0.625 })
  assert.deepEqual(calls, ['upgrade alice'])
})
