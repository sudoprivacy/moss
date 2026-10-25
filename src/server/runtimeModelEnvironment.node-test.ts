import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { test, type TestContext } from 'node:test'
import { DirectConnectStore } from './db.js'
import { RuntimeService } from './runtimeService.js'
import { clearModelCache } from './modelListCache.js'
import { ResourceAccessError } from './catalog/resourceError.js'
import { normalizeModelProviders } from './modelProviders.js'
import { clearUserModelPreference, getUserModelPreference, setUserModelPreference } from './userModelPreference.js'
import type { ServerConfig, SessionRecord } from './types.js'
import type { SystemSettingsPayload } from './systemSettings.js'

async function fixture(t: TestContext, catalogStatus = 200, cohostModelRouting?: 'provider-qualified') {
  const ownerId = randomUUID()
  let catalogRequests = 0
  const catalog = createServer((_request, response) => {
    catalogRequests++
    response.writeHead(catalogStatus, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'available-model' }] }))
  })
  await new Promise<void>(resolve => catalog.listen(0, '127.0.0.1', resolve))
  const address = catalog.address()
  assert(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}/v1`
  const settings = { model: 'retired-model', apiKey: 'shared-key-must-not-be-used',
    modelProviders: normalizeModelProviders([], endpoint), defaultModelProviderId: 'legacy-default' } as SystemSettingsPayload
  const store = new DirectConnectStore(':memory:')
  let userKey: string | undefined = 'owner-only-test-key'
  const upgrades: Array<Record<string, string> | undefined> = []
  const placement = {
    async upgrade(observedOwner: string, drain: (previous: undefined) => Promise<void>, configuration?: Record<string, string>) {
      assert.equal(observedOwner, ownerId)
      await drain(undefined)
      upgrades.push(configuration)
    },
    async inspect(observedOwner: string) {
      assert.equal(observedOwner, ownerId)
      return { ownerId, phase: 'Running', isPresent: true, isDrifted: false }
    },
  }
  const service = new RuntimeService({ store, serverInstanceId: 'maintenance-test',
    config: { defaultRuntime: 'cohost', heartbeatTimeoutMs: 30_000, cohostModelRouting } as ServerConfig,
    userPodService: { forAllocation: () => placement } as never,
    authService: {
      getAgentOwner: async () => ({ id: ownerId, status: 'active', role: 'user', scopes: [] }),
      buildVisibilityFilter: async () => ({ userId: ownerId, isAdmin: false }),
      getOrganizationSystemSettings: async () => settings,
      getUserModelCredential: async () => ({ sudorouterKey: userKey }),
      getOrganizationBillingService: () => ({ isShared: async () => true, router: { modelBaseUrl: endpoint } }),
      isSudorouterManaged: async () => true,
    } as never,
  })
  await setUserModelPreference(ownerId, 'legacy-default:retired-model')
  const model = service as unknown as {
    buildRunnerModelEnvironment(session: Pick<SessionRecord, 'userId' | 'orgId' | 'sessionId' | 'runtime'>): Promise<Record<string, string>>
  }
  t.after(async () => {
    clearModelCache()
    await clearUserModelPreference(ownerId)
    await store.close()
    catalog.closeAllConnections()
    await new Promise<void>((resolve, reject) => catalog.close(error => error ? reject(error) : resolve()))
  })
  return { service, ownerId, endpoint, settings, upgrades,
    requestCount: () => catalogRequests,
    removeOwnerKey: () => { userKey = undefined },
    startModel: () => model.buildRunnerModelEnvironment({ userId: ownerId, orgId: 'org',
      sessionId: 'session', runtime: { type: 'cohost', engine: 'scode' } }),
  }
}

for (const status of [200, 503]) {
  void test(`runtime upgrade retains the owner route without model discovery (catalog HTTP ${status})`, async t => {
    const f = await fixture(t, status)
    const preference = await getUserModelPreference(f.ownerId)
    const state = await f.service.upgradeUserRuntime(f.ownerId, 'org')
    assert.equal(state.phase, 'Running')
    assert.equal(f.requestCount(), 0)
    assert.equal(f.upgrades.length, 1)
    const config = f.upgrades[0]!
    const backend = JSON.parse(config['backend-config.json']).mounts[0].backend_params
    assert.equal(backend.openai_base_url, f.endpoint)
    assert.equal(backend.api_key, 'owner-only-test-key')
    const engine = JSON.parse(config['sudocode.json'])
    assert.equal(engine.auth_modes.proxy['moss-proxy'].baseUrl, 'nexus:///model')
    assert(engine.models['retired-model'])
    assert.deepEqual(await getUserModelPreference(f.ownerId), preference)
    await assert.rejects(f.startModel(), status === 200
      ? /Model retired-model is not currently available/
      : /503/)
    assert.equal(f.requestCount(), 1, 'actual session admission still checks the selected provider')
    assert.equal(f.upgrades.length, 1)
  })
}

void test('a deployment-qualified model keeps its provider alias through a controlled runtime upgrade', async t => {
  const f = await fixture(t, 503, 'provider-qualified')
  await f.service.upgradeUserRuntime(f.ownerId, 'org')
  const engine = JSON.parse(f.upgrades[0]!['sudocode.json'])
  assert.deepEqual(engine.models['legacy-default:retired-model'].providers.proxy, { model: 'retired-model' })
  assert.equal(engine.models['retired-model'], undefined)
  assert.equal(f.requestCount(), 0)
})

void test('runtime upgrade refuses missing owner model credentials without a shared-key fallback', async t => {
  const f = await fixture(t)
  f.removeOwnerKey()
  await assert.rejects(f.service.upgradeUserRuntime(f.ownerId, 'org'), /用户模型凭据不可用/)
  assert.equal(f.requestCount(), 0)
  assert.equal(f.upgrades.length, 0)
  assert.equal(f.service.isUserRuntimeUpgrading(f.ownerId), false)
})

void test('runtime upgrade refuses a disabled provider before changing placement', async t => {
  const f = await fixture(t)
  f.settings.modelProviders[0]!.enabled = false
  await assert.rejects(f.service.upgradeUserRuntime(f.ownerId, 'org'), error =>
    error instanceof ResourceAccessError && error.statusCode === 409 &&
    error.message === 'Selected model provider is unavailable; select an available provider')
  assert.equal(f.requestCount(), 0)
  assert.equal(f.upgrades.length, 0)
  assert.equal(f.service.isUserRuntimeUpgrading(f.ownerId), false)
})

void test('an explicit runtime configuration does not resolve an unrelated preferred model', async t => {
  const f = await fixture(t, 503)
  const config = { 'sudocode.json': '{}', 'backend-config.json': '{"mounts":[]}' }
  await f.service.upgradeUserRuntime(f.ownerId, 'org', config)
  assert.equal(f.requestCount(), 0)
  assert.equal(f.upgrades.length, 1)
  assert.deepEqual(f.upgrades[0], { ...config, 'egress-policy.json': JSON.stringify(await f.service.egressPolicies.policy('org')) })
  assert.deepEqual(config, { 'sudocode.json': '{}', 'backend-config.json': '{"mounts":[]}' }, 'Policy delivery must not mutate caller model configuration')
})

for (const isRemoved of [false, true]) {
  void test(`a ${isRemoved ? 'removed' : 'disabled'} preferred provider cannot route runtime configuration to another provider`, async t => {
    const f = await fixture(t)
    const provider = f.settings.modelProviders[0]!
    f.settings.modelProviders = [{ ...provider, id: 'other-provider' },
      ...(isRemoved ? [] : [{ ...provider, enabled: false }])]
    f.settings.defaultModelProviderId = 'other-provider'
    await assert.rejects(f.service.upgradeUserRuntime(f.ownerId, 'org'), /Selected model provider is unavailable/)
    await assert.rejects(f.startModel(), /Selected model provider is unavailable/)
    assert.equal(f.requestCount(), 0)
    assert.equal(f.upgrades.length, 0)
  })
}

for (const isPreference of [false, true]) {
  void test(`a colon in a ${isPreference ? 'qualified preferred' : 'raw default'} model ID preserves the configured provider`, async t => {
    const f = await fixture(t)
    f.settings.model = 'qwen:8b'
    if (isPreference) await setUserModelPreference(f.ownerId, 'legacy-default:qwen:8b')
    else await clearUserModelPreference(f.ownerId)
    await f.service.upgradeUserRuntime(f.ownerId, 'org')
    const config = f.upgrades[0]!
    assert(JSON.parse(config['sudocode.json']).models['qwen:8b'])
    const backend = JSON.parse(config['backend-config.json']).mounts[0].backend_params
    assert.equal(backend.openai_base_url, f.endpoint)
    assert.equal(backend.api_key, 'owner-only-test-key')
    assert.equal(f.requestCount(), 0)
  })
}
