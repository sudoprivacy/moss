import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { ConfigStore } from '../configStore/configStore.js'
import { resolveQmsConfig } from '../qms/config.js'
import { serverFileConfigSchema, type ServerConfig } from '../types.js'
import { PLATFORM_PROVIDERS, type PlatformProvider } from './platformConfigDefinition.js'
import { ensurePlatformIntegrationSettingsSchema, PlatformIntegrationSettingsRepository } from './platformIntegrationSettingsRepository.js'
import { PlatformConfigService, PlatformConfigError, type PlatformVault, type PlatformSnapshot } from './platformConfigService.js'
import { applyPlatformRuntime, legacyPlatformSnapshots, platformEnvironment, platformInfrastructure, resolveNativeSmsCredentials, smsReadiness } from './platformConfigRuntime.js'
import { resolveSudorouterRuntimeConfig } from '../billing/billingRuntimeConfig.js'
import { SudoworkSystemConfigService } from '../api/compat/sudowork/systemConfigService.js'
import { ClientPolicyRepository } from './clientPolicyRepository.js'
import { IdentityRepository } from '../identity/identityRepository.js'

class Vault implements PlatformVault {
  values = new Map<string, string>()
  failWrite = false
  failRead = false
  async getSecret(namespace: string, key: string) {
    if (this.failRead) throw new Error('vault unavailable')
    return { value: this.values.get(`${namespace}:${key}`) ?? null }
  }
  async putSecret(namespace: string, key: string, value: string) {
    if (this.failWrite) throw new Error('vault unavailable')
    this.values.set(`${namespace}:${key}`, value)
  }
  async deleteSecret(namespace: string, key: string) { this.values.delete(`${namespace}:${key}`) }
}
const smsConfig = { enabled: true, sdkAppId: 'app', signName: 'sign', templateId: 'template', region: 'ap-beijing', templateParams: ['{code}'], codeTtlSec: 300, resendCooldownSec: 60, maxSendsPerHour: 5, maxVerifyAttempts: 5 }
const smsSecrets = { secretId: 'test-secret-id', secretKey: 'test-secret-key' }
function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:')
  const auth = new AuthCenterDb(db)
  ensurePlatformIntegrationSettingsSchema(db)
  t.after(() => db.close())
  const vault = new Vault()
  const legacy = Object.fromEntries(PLATFORM_PROVIDERS.map(id => [id, { config: { enabled: false }, secrets: {}, sources: {} }])) as unknown as Record<PlatformProvider, PlatformSnapshot>
  legacy.sms = { config: smsConfig, secrets: smsSecrets, sources: { secretKey: 'legacy' } }
  const create = (instanceId = 'one') => new PlatformConfigService({ driver: auth.driver, vault, legacy: async () => legacy, instanceId })
  return { db, auth, vault, legacy, create }
}
const status = (code: number) => (error: unknown) => error instanceof PlatformConfigError && error.statusCode === code

void test('platform save is redacted, atomic, version checked and only activates on restart', async t => {
  const { db, vault, create } = setup(t)
  const service = create()
  await service.initialize()
  assert.equal(service.isManaged('sms'), false)
  const saved = await service.save('sms', { expectedVersion: null, config: { ...smsConfig, templateId: 'new-template' } }, 'super-admin')
  assert.equal(service.getActive('sms').config.templateId, 'template')
  const list = await service.list()
  assert.equal(list.items[0]!.restartRequired, true)
  assert.equal(list.items[0]!.secrets.secretKey, true)
  assert.equal(JSON.stringify(list).includes(smsSecrets.secretKey), false)
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM platform_integration_settings').all()).includes(smsSecrets.secretKey), false)
  await assert.rejects(service.save('sms', { expectedVersion: null, config: smsConfig }, 'another-root'), status(409))
  vault.failWrite = true
  await assert.rejects(service.save('sms', { expectedVersion: saved.version, config: smsConfig }, 'super-admin'))
  vault.failWrite = false
  assert.equal((await service.list()).items[0]!.version, saved.version)
  const restarted = create('two')
  await restarted.initialize()
  assert.equal(restarted.getActive('sms').config.templateId, 'new-template')
  assert.equal((await restarted.list()).items[0]!.restartRequired, false)
  assert.equal((await restarted.list()).instances.length, 2)
})

void test('failed DB commit never publishes staged credentials; missing managed credentials fail closed', async t => {
  const { auth, vault, create } = setup(t)
  const service = create()
  await service.initialize()
  const original = auth.driver.tryRunExclusive.bind(auth.driver)
  t.mock.method(auth.driver, 'tryRunExclusive', async () => { throw new Error('DB unavailable') })
  await assert.rejects(service.save('sms', { expectedVersion: null, config: smsConfig }, 'root'))
  assert.equal(await service.hasSaved('sms'), false)
  assert.deepEqual(service.getActive('sms').secrets, smsSecrets)
  t.mock.method(auth.driver, 'tryRunExclusive', original)
  await service.save('sms', { expectedVersion: null, config: smsConfig }, 'root')
  vault.values.clear()
  await assert.rejects(create().initialize(), status(503))
})

void test('managed groups skip obsolete loaders and cleared secrets never fall back to environment', async t => {
  const { auth, vault, create } = setup(t)
  const service = create()
  await service.initialize()
  await service.save('sms', { expectedVersion: null, config: { ...smsConfig, enabled: false }, secrets: { secretId: null, secretKey: null } }, 'root')
  await service.save('sudorouter', { expectedVersion: null, config: { enabled: false }, secrets: { apiToken: null } }, 'root')
  const restarted = new PlatformConfigService({ driver: auth.driver, vault, instanceId: 'restart', legacy: async ids => {
    assert.equal(ids.includes('sms'), false)
    assert.equal(ids.includes('sudorouter'), false)
    return Object.fromEntries(ids.map(id => [id, { config: { enabled: false }, secrets: {}, sources: {} }]))
  } })
  await restarted.initialize()
  const store = new ConfigStore(null)
  const config = serverFileConfigSchema().parse({}) as unknown as ServerConfig
  config.qms = resolveQmsConfig({}, {})
  applyPlatformRuntime(restarted, config, store)
  assert.equal(store.isManaged('server.sms-secret-id'), true)
  assert.equal(store.get('server.sms-secret-id'), undefined)
  assert.deepEqual(await resolveNativeSmsCredentials(config, store, vault, { TENCENT_SECRET_ID: 'old', TENCENT_SECRET_KEY: 'old-key' }), { secretId: '', secretKey: '' })
  assert.deepEqual(platformEnvironment(restarted, { SUDOROUTER_API_TOKEN: 'old', OTHER: 'keep' }), { OTHER: 'keep' })
  assert.equal(config.phoneAuth.enabled, false)
  assert.equal(config.systemConfig.sudorouterEnabled, false)
})

void test('production-shaped phoneAuth works with compatibility off and no signId; incomplete credential pairs cannot mix', async t => {
  const { auth, vault, create } = setup(t)
  const service = create()
  await service.initialize()
  const store = new ConfigStore(null)
  const config = serverFileConfigSchema().parse({ phoneAuth: { enabled: true, delivery: 'tencent', tencent: { sdkAppId: 'app', signName: 'sign', templateId: 'template', region: 'ap-beijing', vaultNamespace: 'old', secretIdKey: 'id', secretKeyKey: 'key', templateParams: ['{code}'] } } }) as unknown as ServerConfig
  vault.values.set('old:id', 'legacy-id'); vault.values.set('old:key', 'legacy-key')
  assert.equal(config.sudoworkCompatibility.enabled, false)
  assert.equal((await smsReadiness(service, config, store, vault)).ready, true)
  const legacy = await legacyPlatformSnapshots(config, store, vault, new PlatformIntegrationSettingsRepository(auth.driver), {}, ['sms'])
  assert.deepEqual(legacy.sms!.secrets, { secretId: 'legacy-id', secretKey: 'legacy-key' })
  assert.deepEqual(await resolveNativeSmsCredentials(config, store, vault, { TENCENT_SECRET_ID: 'partial' }), { secretId: 'partial', secretKey: '' })
  vault.failRead = true
  assert.match((await smsReadiness(service, config, store, vault)).reason!, /不可读取/)
})

void test('conflicting legacy accounts require explicit credentials; protected historical keys cannot be changed', async t => {
  const { legacy, create } = setup(t)
  legacy.sms.conflicts = ['secretId', 'secretKey']
  legacy.qms = { config: { enabled: false }, secrets: { privateKeyPem: 'existing-key' }, sources: {} }
  const service = create()
  await service.initialize()
  await assert.rejects(service.save('sms', { expectedVersion: null, config: smsConfig }, 'root'), status(409))
  await service.save('sms', { expectedVersion: null, config: smsConfig, secrets: smsSecrets }, 'root')
  const saved = await service.save('qms', { expectedVersion: null, config: { enabled: false } }, 'root')
  await assert.rejects(service.save('qms', { expectedVersion: saved.version, config: { enabled: false }, secrets: { privateKeyPem: null } }, 'root'), status(409))
})

void test('old saved Router model fields are ignored and stale admin payloads cannot restore them', async t => {
  const { auth, create } = setup(t)
  const platform = create()
  await platform.initialize()
  const saved = await platform.save('sudorouter', {
    expectedVersion: null,
    config: { enabled: true, baseUrl: 'https://admin.test', adminUserId: '76', timeoutMs: 1000 },
    secrets: { apiToken: 'test-admin-token' },
  }, 'root')
  const repository = new PlatformIntegrationSettingsRepository(auth.driver)
  const old = (await repository.get('platform.v1.sudorouter'))!
  old.config = { ...(old.config as Record<string, unknown>), modelServiceUrl: 'https://old-global.test/v1', modelsApiUrl: 'https://old-global.test/models' }
  await repository.put('platform.v1.sudorouter', old, 'legacy')
  const restarted = create('restart')
  await restarted.initialize()
  const item = (await restarted.list()).items.find(value => value.id === 'sudorouter')!
  assert.equal(item.fields.some(field => field.key === 'modelServiceUrl' || field.key === 'modelsApiUrl'), false)
  assert.equal('modelServiceUrl' in item.config, false)
  assert.equal('modelsApiUrl' in restarted.getActive('sudorouter').config, false)
  assert.deepEqual(await repository.get('platform.v1.sudorouter'), old, 'Reads leave the historical record intact')
  const store = new ConfigStore(null)
  const config = serverFileConfigSchema().parse({}) as unknown as ServerConfig
  config.qms = resolveQmsConfig({}, {})
  applyPlatformRuntime(restarted, config, store)
  const system = new SudoworkSystemConfigService({
    db: auth.driver, policies: new ClientPolicyRepository(auth.driver), identities: new IdentityRepository(auth.driver),
    defaults: { loginMethod: 'password', skillhubBaseUrl: '' }, secrets: store,
    resolveInfrastructure: legacy => platformInfrastructure(restarted, legacy),
  })
  const infrastructure = await system.getInfrastructureConfig()
  assert.equal(infrastructure.billing.sudorouter.modelServiceUrl, '')
  assert.deepEqual(resolveSudorouterRuntimeConfig({
    infrastructure: infrastructure.billing.sudorouter,
    environment: platformEnvironment(restarted, { SUDOROUTER_API_TOKEN: 'obsolete', SUDOROUTER_BASE_URL: 'https://obsolete.test' }),
    getSecret: key => store.get(key),
  }), { baseUrl: 'https://admin.test', adminUserId: '76', timeoutMs: 1000, initialQuota: infrastructure.billing.sudorouter.initialQuota, apiToken: 'test-admin-token' })
  await restarted.save('sudorouter', {
    expectedVersion: saved.version,
    config: { baseUrl: 'https://new-admin.test', modelServiceUrl: 'https://stale-page.test/v1', modelsApiUrl: '' },
  }, 'root')
  const updated = (await repository.get('platform.v1.sudorouter'))!.config as Record<string, unknown>
  assert.equal(updated.baseUrl, 'https://new-admin.test')
  assert.equal('modelServiceUrl' in updated, false)
  assert.equal('modelsApiUrl' in updated, false)
  const secondRestart = create('second-restart')
  await secondRestart.initialize()
  assert.equal(secondRestart.getActive('sudorouter').config.baseUrl, 'https://new-admin.test')
  assert.equal(secondRestart.getActive('sudorouter').secrets.apiToken, 'test-admin-token')
})

void test('legacy Router import contains only management connection fields', async t => {
  const { auth, vault } = setup(t)
  const config = serverFileConfigSchema().parse({}) as unknown as ServerConfig
  const snapshots = await legacyPlatformSnapshots(config, new ConfigStore(null), vault,
    new PlatformIntegrationSettingsRepository(auth.driver), {
      SUDOROUTER_BASE_URL: 'https://admin.test', SUDOROUTER_API_TOKEN: 'admin-token', SUDOROUTER_ADMIN_USER_ID: '76',
      SUDOROUTER_MODEL_SERVICE_URL: 'https://model.test/v1', SUDOROUTER_MODELS_API_URL: 'https://model.test/models',
    }, ['sudorouter'])
  assert.deepEqual(snapshots.sudorouter!.config, { enabled: true, baseUrl: 'https://admin.test', adminUserId: '76', timeoutMs: 10000 })
})
