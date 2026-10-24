import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { EgressPolicyRepository, createEgressPolicy } from '@sudo/egress-policy'
import { SqliteDriver } from '../db/driver.js'
import { EgressPolicyService } from './egressPolicyService.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { readEgressPolicyFile } from '@sudo/user-runtime'
import { DirectConnectStore } from '../db.js'
import { RuntimeService } from '../runtimeService.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import type { ServerConfig } from '../types.js'

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
    error => error instanceof ResourceAccessError && error.statusCode === 503 && /policy is not applied/.test(error.message))
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
