import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { EgressPolicyRepository, createEgressPolicy, type EgressPolicyStatus } from '@sudo/egress-policy'
import { SqliteDriver } from '../db/driver.js'
import { EgressPolicyService } from './egressPolicyService.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { readEgressPolicyFile } from '@sudo/user-runtime'
import { DirectConnectStore } from '../db.js'
import { RuntimeService } from '../runtimeService.js'
import { EgressPolicyNotAppliedError, SessionStartupError } from '../sessionStartup.js'
import type { ServerConfig } from '../types.js'

function assertPolicyAdmissionFailure(error: unknown): true {
  assert(error instanceof EgressPolicyNotAppliedError)
  const attemptId = '00000000-0000-4000-8000-000000000001'
  const startup = new SessionStartupError(error, 'policy-session', attemptId)
  assert.equal(startup.statusCode, 503)
  assert.equal(startup.failure.code, 'EGRESS_POLICY_NOT_APPLIED')
  assert.equal(startup.failure.isRetryable, true)
  assert.equal(startup.failure.sessionId, 'policy-session')
  assert.equal(startup.failure.attemptId, attemptId)
  assert.equal(startup.cause, error)
  assert.match(startup.message, /Retry policy delivery or update the runtime/)
  assert.doesNotMatch(JSON.stringify(startup.failure), /Assistant|skill|Invalid native policy|Policy RPC/)
  return true
}

void test('controller restart restores the saved local policy and refuses model admission without an applied receipt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-egress-recovery-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert(root.startsWith(join(resolve(tmpdir()), 'moss-egress-recovery-')))
    await rm(root, { recursive: true })
  })
  const store = new DirectConnectStore(':memory:')
  t.after(() => store.close())
  const filename = join(root, 'policy.json')
  const config = { runtimeDir: root, defaultRuntime: 'cohost', heartbeatTimeoutMs: 30_000,
    egressGate: { localPolicyFile: filename, localOrganizationId: 'org-a' } } as ServerConfig
  const options = { config, store, serverInstanceId: 'egress-recovery-fixture',
    authService: { listEgressPolicyOwners: async () => [] } as never }
  const first = new RuntimeService(options)
  const initial = await first.egressPolicies.policy('org-a')
  const saved = await first.egressPolicies.save('org-a', { ...initial, enabled: true, modelMounts: ['/cloud-model'] }, initial.revision, 'admin-a')
  await writeFile(filename, JSON.stringify(initial))
  const restarted = new RuntimeService(options)
  t.after(() => restarted.closeRuntimeServices())
  await restarted.reconcileOnStartup()
  assert.deepEqual(readEgressPolicyFile(filename), saved.policy)
  t.mock.method(store, 'getUserOrgId', async () => 'org-a')
  const previous = process.env.MOSS_COHOST_CONNECTION
  process.env.MOSS_COHOST_CONNECTION = '{"invalid":true}'
  t.after(() => { if (previous === undefined) delete process.env.MOSS_COHOST_CONNECTION; else process.env.MOSS_COHOST_CONNECTION = previous })
  await assert.rejects(restarted.resolveCohostConnection('owner-a', 'agent-a', { 'sudocode.json': '{}', 'backend-config.json': '{"mounts":[]}' }),
    assertPolicyAdmissionFailure)
})

void test('saved policy remains pending until the actual runtime reports its version', async (t) => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const deliveries: unknown[] = []
  const repository = new EgressPolicyRepository(
    new SqliteDriver(db),
    createEgressPolicy({ modelMounts: ['/model'] }),
  )
  const service = new EgressPolicyService(repository, {
    targets: async () => [{ ownerId: 'owner-a', organizationId: 'org-a' }],
    observe: async (_target, desired) => {
      if (desired) deliveries.push(desired)
      return [
        {
          ownerId: 'owner-a',
          allocationId: 'primary',
          isPresent: true,
          status: {
            ...createEgressPolicy({ modelMounts: ['/model'] }),
            error: null,
          },
        },
      ]
    },
  })
  const initial = await service.view('org-a')
  assert.equal(initial.policy.enabled, false)
  assert.equal(deliveries.length, 0, 'GET must not distribute configuration')
  const result = await service.save(
    'org-a',
    { ...initial.policy, enabled: true },
    initial.policy.revision,
    'admin-a',
  )
  assert.equal(result.policy.enabled, true)
  assert.equal(result.runtimes[0]?.state, 'pending')
  assert.equal(deliveries.length, 1)
})

for (const state of ['applied', 'stale', 'wrong-mode', 'native-error', 'unavailable', 'disabled'] as const) {
  void test(`managed model admission checks the selected runtime receipt: ${state}`, async t => {
    const store = new DirectConnectStore(':memory:')
    t.after(() => store.close())
    t.mock.method(store, 'getUserOrgId', async () => 'org-a')
    const connection = { endpoint: 'http://127.0.0.1:1', authToken: '', tls: null }
    const configurations: Array<Record<string, string> | undefined> = []
    const runtime = new RuntimeService({ store, serverInstanceId: 'managed-egress-admission',
      config: { defaultRuntime: 'cohost', heartbeatTimeoutMs: 30_000 } as ServerConfig,
      authService: { listEgressPolicyOwners: async () => [] } as never,
      userPodService: { forAllocation: () => ({
        resolve: async (_owner: string, configuration?: Record<string, string>) => {
          configurations.push(configuration)
          return connection
        },
      }), close: async () => {} } as never,
    })
    t.after(() => runtime.closeRuntimeServices())
    const initial = await runtime.egressPolicies.policy('org-a')
    const { policy } = await runtime.egressPolicies.save('org-a', { ...initial,
      enabled: state !== 'disabled', modelMounts: ['/model'] }, initial.revision, 'admin-a')
    let observations = 0
    t.mock.method(runtime as unknown as { readRuntimeEgressStatus: (config: unknown, ownerId: string) => Promise<EgressPolicyStatus> },
      'readRuntimeEgressStatus', async (observed: unknown, ownerId: string) => {
        observations++
        assert.equal(observed, connection)
        assert.equal(ownerId, 'owner-a')
        assert.equal(configurations.length, 1, 'The selected owner allocation must exist before its receipt is checked')
        if (state === 'unavailable') throw new Error('Policy RPC is unavailable')
        return { ...policy, revision: state === 'stale' ? policy.revision - 1 : policy.revision,
          mode: state === 'wrong-mode' ? 'deny' : policy.mode, error: state === 'native-error' ? 'Invalid native policy' : null }
      })
    const configure = () => runtime.resolveCohostConnection('owner-a', 'agent-a', { 'sudocode.json': '{}', 'backend-config.json': '{"mounts":[]}' })
    if (state === 'applied' || state === 'disabled') assert.equal(await configure(), connection)
    else await assert.rejects(configure(), assertPolicyAdmissionFailure)
    assert.equal(observations, state === 'disabled' ? 0 : 1)
    assert.equal(configurations[0]?.['egress-policy.json'], JSON.stringify(policy))
  })
}

void test('platform propagation respects organization overrides and runtime failures remain visible', async (t) => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const repository = new EgressPolicyRepository(
    new SqliteDriver(db),
    createEgressPolicy({ modelMounts: ['/model'] }),
  )
  const delivered = new Map<string, boolean>()
  const service = new EgressPolicyService(repository, {
    targets: async (scope) =>
      ['org-a', 'org-b']
        .filter((org) => !scope || scope === org)
        .map((organizationId) => ({ ownerId: organizationId, organizationId })),
    observe: async (target, policy) => {
      if (policy) delivered.set(target.organizationId, policy.enabled)
      return [
        {
          ownerId: target.ownerId,
          allocationId: 'primary',
          isPresent: true,
          error: 'Runtime upgrade required',
        },
      ]
    },
  })
  const initial = await service.policy('org-a')
  await service.save('org-a', initial, initial.revision, 'admin-a')
  const platform = await service.policy()
  const result = await service.save(
    undefined,
    { ...platform, enabled: true },
    platform.revision,
    'root',
  )
  assert.equal(delivered.get('org-a'), false)
  assert.equal(delivered.get('org-b'), true)
  assert.equal(result.runtimes[0]?.state, 'error')
})
