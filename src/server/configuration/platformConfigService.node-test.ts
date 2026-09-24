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
import { AuthService } from '../auth/service.js'
import { PhoneAuthService, logPhoneVerificationCode } from '../auth/phoneAuth.js'
import { createIdentityTestRepository } from '../testing/compatibilityRepositories.js'
import { ClientPolicyRepository, ensureClientPolicySchema } from './clientPolicyRepository.js'
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


void test('mock SMS can be saved without Tencent credentials, activates on restart and cannot silently switch to real delivery', async t => {
  const { create, legacy, vault } = setup(t)
  legacy.sms = { config: { ...smsConfig, enabled: false, sdkAppId: '', signName: '', templateId: '' }, secrets: {}, sources: {} }
  const platform = create()
  await platform.initialize()
  const input = { expectedVersion: null, config: { enabled: true, mockDelivery: true } }
  assert.equal((await platform.check('sms', input)).ready, true)
  const saved = await platform.save('sms', input, 'root')
  assert.equal(platform.getActive('sms').config.enabled, false)
  assert.equal((await platform.list()).items[0]!.restartRequired, true)
  assert.equal(vault.values.size, 0)
  const restarted = create('restarted')
  await restarted.initialize()
  const config = serverFileConfigSchema().parse({}) as unknown as ServerConfig
  config.qms = resolveQmsConfig({}, {})
  const store = new ConfigStore(null)
  applyPlatformRuntime(restarted, config, store)
  assert.equal(config.phoneAuth.enabled, true)
  assert.equal(config.phoneAuth.delivery, 'log')
  assert.equal(config.sudoworkCompatibility.sms.provider, 'disabled')
  const ready = await smsReadiness(restarted, config, store, vault)
  assert.equal(ready.ready, true)
  assert.match(ready.reason!, /模拟发送/)
  await assert.rejects(restarted.save('sms', {
    expectedVersion: saved.version, config: { mockDelivery: false },
  }, 'root'), status(400))
  await assert.rejects(restarted.save('sms', {
    expectedVersion: saved.version, config: { maxVerifyAttempts: 0 },
  }, 'root'), status(400))
  assert.equal(restarted.getActive('sms').config.mockDelivery, true)
})

void test('existing managed SMS without a mock flag stays on Tencent and saved credentials survive mock mode', async t => {
  const { create, vault } = setup(t)
  const platform = create()
  await platform.initialize()
  const first = await platform.save('sms', { expectedVersion: null, config: smsConfig }, 'root')
  const real = create('real')
  await real.initialize()
  const config = serverFileConfigSchema().parse({ phoneAuth: { enabled: true, delivery: 'log' } }) as unknown as ServerConfig
  config.qms = resolveQmsConfig({}, {})
  applyPlatformRuntime(real, config, new ConfigStore(null))
  assert.equal(config.phoneAuth.delivery, 'tencent')
  const second = await real.save('sms', { expectedVersion: first.version, config: { mockDelivery: true } }, 'root')
  assert.equal(real.getActive('sms').config.mockDelivery, undefined)
  const simulated = create('simulated')
  await simulated.initialize()
  applyPlatformRuntime(simulated, config, new ConfigStore(null))
  assert.equal(config.phoneAuth.delivery, 'log')
  assert.deepEqual(simulated.getActive('sms').secrets, smsSecrets)
  await simulated.save('sms', { expectedVersion: second.version, config: { mockDelivery: false } }, 'root')
  const restored = create('restored')
  await restored.initialize()
  applyPlatformRuntime(restored, config, new ConfigStore(null))
  assert.equal(config.phoneAuth.delivery, 'tencent')
  assert.equal((await smsReadiness(restored, config, new ConfigStore(null), vault)).ready, true)
})

void test('legacy explicit log delivery imports as mock SMS and satisfies login-policy readiness', async t => {
  const { auth, vault, create } = setup(t)
  const config = serverFileConfigSchema().parse({ phoneAuth: { enabled: true, delivery: 'log', resendCooldownSec: 5 } }) as unknown as ServerConfig
  config.qms = resolveQmsConfig({}, {})
  const store = new ConfigStore(null)
  const snapshots = await legacyPlatformSnapshots(config, store, vault, new PlatformIntegrationSettingsRepository(auth.driver), {}, ['sms'])
  assert.equal(snapshots.sms!.config.enabled, true)
  assert.equal(snapshots.sms!.config.mockDelivery, true)
  assert.equal(snapshots.sms!.config.resendCooldownSec, 5)
  const platform = create()
  await platform.initialize()
  assert.equal((await smsReadiness(platform, config, store, vault)).ready, true)
})

void test('mock SMS exercises registration, one-time code login and organization policy without calling a provider', async t => {
  const { db, auth: authDb, create, vault, legacy } = setup(t)
  legacy.sms.secrets = {}
  const platform = create()
  await platform.initialize()
  await platform.save('sms', { expectedVersion: null, config: { ...smsConfig, mockDelivery: true } }, 'root')
  const restarted = create('restarted')
  await restarted.initialize()
  const config = serverFileConfigSchema().parse({}) as unknown as ServerConfig
  config.qms = resolveQmsConfig({}, {})
  const store = new ConfigStore(null)
  applyPlatformRuntime(restarted, config, store)
  createIdentityTestRepository(db, {}, authDb.driver)
  ensureClientPolicySchema(db)
  await authDb.setConfig('issuer', 'mock-sms-test')
  await authDb.setConfig('jwt_secret', 'mock-sms-test-secret')
  const forbiddenSender = t.mock.fn(async () => { throw new Error('Real SMS must never be called') })
  const auth = new AuthService(authDb, 3600, config.phoneAuth, forbiddenSender)
  // Registered after setup's close hook; destroy does not access the database.
  t.after(() => auth.destroy())
  const org = (await auth.createOrganization({ name: 'SMS Test' })).organization
  const other = (await auth.createOrganization({ name: 'Password Test' })).organization
  const system = auth.createSudoworkSystemConfigService({
    loginMethod: 'password', skillhubBaseUrl: '', secrets: store,
    getSmsReadiness: () => smsReadiness(restarted, config, store, vault),
  })
  const actor = { userId: 'root', orgId: org.id, role: 'super_admin', organizationScoped: true }
  await system.update(actor, { login_method: 0 })
  assert.equal(await system.getLoginMethod(org.id), 'sms')
  assert.equal(await system.getLoginMethod(other.id), 'password')
  await auth.createOrganizationIdentityService().createInvitations({ orgId: org.id, count: 1 }, () => 'MOCK-INVITE')
  const phone = '13800138009'
  let output = ''
  t.mock.method(console, 'warn', (...args: unknown[]) => { output = args.map(String).join(' ') })
  const send = await auth.phoneAuth.sendCode(phone)
  assert.equal(send.delivery, 'log')
  assert.equal(forbiddenSender.mock.callCount(), 0)
  const code = output.match(/is (\d{6})\./)?.[1]
  assert(code)
  assert.equal(output.includes(phone), false)
  assert.equal(await auth.phoneAuth.verifyCode(phone, code), true)
  assert.equal(await auth.phoneAuth.verifyCode(phone, code), false)
  await assert.rejects(auth.registerWithPhone({ phone, nickname: 'Test', invitationCode: 'BAD' }), /Invitation/)
  const registered = await auth.registerWithPhone({ phone, nickname: 'Test', invitationCode: 'MOCK-INVITE' })
  assert.equal(registered.user.orgId, org.id)
  assert.equal(registered.user.role, 'user')
  await auth.phoneAuth.sendCode(phone)
  const loginCode = output.match(/is (\d{6})\./)?.[1]
  assert(loginCode)
  assert.equal(await auth.phoneAuth.verifyCode(phone, loginCode), true)
  assert.equal((await auth.issueTokenFromPhone(phone)).user.id, registered.user.id)
  await assert.rejects(auth.issueTokenFromPassword({ username: phone, password: phone }), /does not allow password/)
  assert.equal((await auth.issueMossTokenFromPassword({ username: phone, password: phone })).user.id, registered.user.id)
  await system.update(actor, { login_method: 1 })
  await assert.rejects(auth.issueTokenFromPhone(phone), /does not allow phone/)
  assert.equal((await auth.issueTokenFromPassword({ username: phone, password: phone })).user.id, registered.user.id)
  assert.equal(forbiddenSender.mock.callCount(), 0)
  logPhoneVerificationCode(phone, '123456')
  assert.match(output, /is 123456\./)
  // The log transport must ignore a wired sender even when a credential is present.
  const verification = new PhoneAuthService(authDb, config.phoneAuth, 'test-secret', forbiddenSender)
  await verification.sendCode('13800138008')
  assert.equal(forbiddenSender.mock.callCount(), 0)
})
