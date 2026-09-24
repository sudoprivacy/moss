import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { AuthService, AuthServiceError } from '../auth/service.js'
import { ClientPolicyRepository } from '../configuration/clientPolicyRepository.js'
import { OrganizationModelSettingsRepository } from '../configuration/organizationModelSettingsRepository.js'
import { ensurePlatformIntegrationSettingsSchema } from '../configuration/platformIntegrationSettingsRepository.js'
import { PlatformConfigService } from '../configuration/platformConfigService.js'
import { applyPlatformRuntime, platformEnvironment, platformInfrastructure } from '../configuration/platformConfigRuntime.js'
import { ConfigStore } from '../configStore/configStore.js'
import { serverFileConfigSchema, type ServerConfig } from '../types.js'
import { SudoworkSystemConfigService } from '../api/compat/sudowork/systemConfigService.js'
import { resolveSudorouterRuntimeConfig } from '../billing/billingRuntimeConfig.js'
import { SudorouterAdapter } from '../billing/sudorouterAdapter.js'
import { resolveQmsConfig } from '../qms/config.js'
import { createIdentityTestRepository, createBillingTestRepository } from '../testing/compatibilityRepositories.js'
import { migrateLegacySudorouterCredentials } from './legacySudorouterCredentials.js'

async function setup(withAccount = true) {
  const auth = new AuthCenterDb(':memory:')
  const db = auth.db!
  const identities = createIdentityTestRepository(db, {}, auth.driver)
  const billing = createBillingTestRepository(db, auth.driver)
  await auth.createOrganization('org-1', 'Existing organization', 1)
  await auth.createUser({
    id: 'user-1', orgId: 'org-1', email: 'user@example.test', name: 'user', displayName: null,
    departmentId: null, role: 'user', status: 'active', localAuth: false, tokenLimit: null,
    createdAt: 1, passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null,
  })
  await auth.setUserModelCredential('user-1', { sudorouterUserId: '40', sudorouterKey: 'original-key' })
  await identities.createWallet('user', 'user-1', 0)
  if (withAccount) await billing.upsertExternalAccount({
    provider: 'sudorouter', ownerType: 'user', ownerId: 'user-1', externalAccountId: '40',
    quotaUnits: -3076, usedQuotaUnits: 2503076, updatedAt: 1,
  })
  const values = new Map<string, string>()
  const counters = { reads: 0, puts: 0 }
  const secrets = {
    async getSecret(namespace: string, key: string, subject?: string) {
      assert.equal(subject, 'org:org-1')
      const value = values.get(`${namespace}/${key}`)
      return value === undefined ? null : { value, status: 'enabled', version: 1 }
    },
    async putSecret(namespace: string, key: string, value: string, subject?: string) {
      assert.equal(subject, 'org:org-1')
      counters.puts += 1
      values.set(`${namespace}/${key}`, value)
    },
  }
  const provider = {
    async getUser(id: string) {
      counters.reads += 1
      assert.equal(id, '40')
      return { externalUserId: '40', quotaUnits: 250000, usedQuotaUnits: 12 }
    },
  }
  return { auth, identities, billing, values, counters, secrets, provider }
}

void test('离线绑定迁入组织凭据后可重复启动，保留欠费额度及旧 Key', async () => {
  const c = await setup()
  try {
    assert.deepEqual(await migrateLegacySudorouterCredentials(c.auth.driver, c.provider, c.secrets), { imported: 1 })
    assert.deepEqual(await migrateLegacySudorouterCredentials(c.auth.driver, c.provider, c.secrets), { imported: 0 })
    const account = await c.billing.getExternalAccount('sudorouter', 'user', 'user-1')
    assert.equal(account?.tokenSecretRef, 'nexus://moss:sudorouter-users/user-1')
    assert.equal(account?.quotaUnits, -3076)
    assert.equal(c.values.get('moss:sudorouter-users/user-1'), 'sk-original-key')
    assert.deepEqual(c.counters, { reads: 0, puts: 1 })
  } finally { c.auth.close() }
})

void test('原生独有用户只读取得现有 Router 余额，幂等记期初账而非充值', async () => {
  const c = await setup(false)
  try {
    await migrateLegacySudorouterCredentials(c.auth.driver, c.provider, c.secrets)
    await migrateLegacySudorouterCredentials(c.auth.driver, c.provider, c.secrets)
    assert.equal((await c.billing.getWallet('user', 'user-1'))?.balanceUnits, 500)
    assert.equal(await c.billing.countOwnerLedgerEntries('user', 'user-1'), 1)
    assert.deepEqual(c.counters, { reads: 1, puts: 1 })
  } finally { c.auth.close() }
})

void test('绑定冲突不能覆盖现有账户，也不写 Nexus', async () => {
  const c = await setup()
  try {
    await c.auth.driver.run("UPDATE billing_external_accounts SET external_account_id = '99'")
    await assert.rejects(migrateLegacySudorouterCredentials(c.auth.driver, c.provider, c.secrets), /binding conflict/)
    assert.deepEqual(c.counters, { reads: 0, puts: 0 })
  } finally { c.auth.close() }
})

void test('零余额原生账户正常绑定，不生成非法零金额流水', async () => {
  const c = await setup(false)
  try {
    assert.deepEqual(await migrateLegacySudorouterCredentials(c.auth.driver, {
      getUser: async () => ({ externalUserId: '40', quotaUnits: 0, usedQuotaUnits: 100 }),
    }, c.secrets), { imported: 1 })
    assert.equal((await c.billing.getWallet('user', 'user-1'))?.balanceUnits, 0)
    assert.equal(await c.billing.countOwnerLedgerEntries('user', 'user-1'), 0)
  } finally { c.auth.close() }
})

void test('未完成迁移时发现 vault 内不同 Key 会阻断，完整绑定保留后续轮换', async () => {
  const c = await setup()
  try {
    c.values.set('moss:sudorouter-users/user-1', 'sk-rotated-key')
    await assert.rejects(migrateLegacySudorouterCredentials(c.auth.driver, c.provider, c.secrets), /secret conflict/)
    await c.auth.driver.run("UPDATE billing_external_accounts SET token_secret_ref = 'nexus://moss:sudorouter-users/user-1'")
    assert.deepEqual(await migrateLegacySudorouterCredentials(c.auth.driver, c.provider, c.secrets), { imported: 0 })
    assert.equal(c.values.get('moss:sudorouter-users/user-1'), 'sk-rotated-key')
  } finally { c.auth.close() }
})

void test('Nexus 写入未能读回时不发布引用，重试可恢复', async () => {
  const c = await setup()
  try {
    await assert.rejects(migrateLegacySudorouterCredentials(c.auth.driver, c.provider, {
      ...c.secrets, putSecret: async () => {},
    }), /secret verification failed/)
    assert.equal((await c.billing.getExternalAccount('sudorouter', 'user', 'user-1'))?.tokenSecretRef, undefined)
    assert.deepEqual(await migrateLegacySudorouterCredentials(c.auth.driver, c.provider, c.secrets), { imported: 1 })
  } finally { c.auth.close() }
})

void test('Router 中不存在的历史用户不推测额度、不写密钥', async () => {
  const c = await setup(false)
  try {
    await assert.rejects(migrateLegacySudorouterCredentials(c.auth.driver, {
      getUser: async () => null,
    }, c.secrets), /account unavailable/)
    assert.equal(c.counters.puts, 0)
    assert.equal(await c.billing.getExternalAccount('sudorouter', 'user', 'user-1'), null)
  } finally { c.auth.close() }
})

void test('没有历史凭据的新安装不读 Router、不写 Nexus 或账户', async () => {
  const c = await setup(false)
  try {
    await c.auth.driver.run('UPDATE users SET sudorouter_user_id = NULL, sudorouter_key = NULL')
    assert.deepEqual(await migrateLegacySudorouterCredentials(c.auth.driver, c.provider, c.secrets), { imported: 0 })
    assert.deepEqual(c.counters, { reads: 0, puts: 0 })
    assert.equal(await c.billing.getExternalAccount('sudorouter', 'user', 'user-1'), null)
  } finally { c.auth.close() }
})

void test('已有钱包余额不被 Router 快照覆盖或重复记账', async () => {
  const c = await setup(false)
  try {
    await c.auth.driver.run("DELETE FROM wallets WHERE owner_type = 'user' AND owner_id = 'user-1'")
    await c.identities.createWallet('user', 'user-1', 73)
    await migrateLegacySudorouterCredentials(c.auth.driver, c.provider, c.secrets)
    assert.equal((await c.billing.getWallet('user', 'user-1'))?.balanceUnits, 73)
    assert.equal(await c.billing.countOwnerLedgerEntries('user', 'user-1'), 0)
  } finally { c.auth.close() }
})

void test('非法快照阻止凭据和账务写入', async () => {
  const c = await setup(false)
  try {
    for (const snapshot of [
      { externalUserId: '41', quotaUnits: 0, usedQuotaUnits: 0 },
      { externalUserId: '40', quotaUnits: Number.NaN, usedQuotaUnits: 0 },
      { externalUserId: '40', quotaUnits: 0, usedQuotaUnits: -1 },
    ]) {
      await assert.rejects(migrateLegacySudorouterCredentials(c.auth.driver, {
        getUser: async () => snapshot,
      }, c.secrets), /account unavailable|quota invalid/)
    }
    assert.equal(c.counters.puts, 0)
    assert.equal(await c.billing.countOwnerLedgerEntries('user', 'user-1'), 0)
    assert.equal(await c.billing.getExternalAccount('sudorouter', 'user', 'user-1'), null)
  } finally { c.auth.close() }
})

void test('迁移锁被占用时阻止启动，不接管未完成的凭据', async t => {
  const c = await setup()
  try {
    t.mock.method(c.auth.driver, 'tryRunExclusiveSession', async () => null)
    await assert.rejects(migrateLegacySudorouterCredentials(c.auth.driver, c.provider, c.secrets), /another instance/)
    assert.deepEqual(c.counters, { reads: 0, puts: 0 })
  } finally { c.auth.close() }
})

void test('迁移后欠费账户复用凭据，保留组织模型配置、登录隔离及本地执行授权', async () => {
  const c = await setup()
  const service = new AuthService(c.auth, 3600)
  try {
    await c.auth.setConfig('issuer', 'migration-test')
    await c.auth.setConfig('jwt_secret', 'migration-test-secret')
    await service.initializeCompatibilityRecords()
    await service.setUserPassword({ orgId: 'org-1', userId: 'user-1', password: 'Test-password-123' })
    await c.auth.driver.run("UPDATE users SET phone = '13800000000' WHERE id = 'user-1'")
    await c.auth.driver.run("DELETE FROM wallets WHERE owner_type = 'user' AND owner_id = 'user-1'")
    await c.identities.createWallet('user', 'user-1', -6)
    await c.auth.setLocalExecutionAllowed('user-1', 'org-1', false)
    const policies = new ClientPolicyRepository(c.auth.driver)
    await policies.putOrganization('org-1', { loginMethod: 0 }, 'admin')
    const settings = new OrganizationModelSettingsRepository(c.auth.driver)
    await settings.put('org-1', { modelProviders: [
      { id: 'legacy-default', name: 'Router', type: 'openai-compatible', baseUrl: 'https://old.test/v1', enabled: true },
      { id: 'private', name: 'Private', type: 'openai-compatible', baseUrl: 'https://private.test/v1', enabled: true },
    ] }, 'admin')
    const beforeUser = await c.auth.getUserById('user-1')
    const beforeSettings = await settings.get('org-1')
    const unexpectedWrite = async (): Promise<never> => { throw new Error('Must not provision or change Router quotas') }
    const provisioner = service.createSudorouterAccountService({
      secrets: c.secrets,
      provider: { ...c.provider, findUserByUsername: unexpectedWrite, createUser: unexpectedWrite,
        createToken: unexpectedWrite, changeQuota: unexpectedWrite },
    })
    await migrateLegacySudorouterCredentials(c.auth.driver, c.provider, c.secrets)
    assert.deepEqual(await c.auth.getUserById('user-1'), beforeUser)
    assert.deepEqual(await settings.get('org-1'), beforeSettings)
    assert.deepEqual(await policies.getOrganization('org-1'), { loginMethod: 0 })
    service.configureSudorouterAccounts({ accountProvisioner: provisioner, initialQuotaUnits: 5000000 })
    assert.equal(await service.ensureUserSudorouterAccount('user-1'), true)
    assert.deepEqual(await service.getUserModelCredential('user-1'), {
      sudorouterUserId: '40', sudorouterKey: 'sk-original-key',
    })
    assert.equal((await service.issueMossTokenFromPassword({ username: 'user', password: 'Test-password-123' })).user.id, 'user-1')
    assert.equal((await service.issueTokenFromPhone('13800000000')).user.id, 'user-1')
    await assert.rejects(service.issueTokenFromPassword({ username: 'user', password: 'Test-password-123' }),
      (error: unknown) => error instanceof AuthServiceError && error.statusCode === 403)
    assert.equal(await service.isUserLocalExecutionAllowed('user-1'), false)
    const providers = (await service.getOrganizationSystemSettings('org-1')).modelProviders
    assert.equal(providers.find(p => p.id === 'legacy-default')?.baseUrl, 'https://old.test/v1')
    assert.equal(providers.find(p => p.id === 'private')?.baseUrl, 'https://private.test/v1')
    assert.equal((await c.billing.getWallet('user', 'user-1'))?.balanceUnits, -6)
    assert.equal(await c.billing.countOwnerLedgerEntries('user', 'user-1'), 0)
    assert.deepEqual(c.counters, { reads: 0, puts: 1 })
  } finally { service.destroy(); c.auth.close() }
})

void test('凭据迁移使用平台管理 API 的 URL、Token 和管理员 ID，旧环境变量不覆盖平台配置', async () => {
  const c = await setup(false)
  try {
    ensurePlatformIntegrationSettingsSchema(c.auth.db!)
    const platformSecrets = new Map<string, string>()
    const vault = {
      async getSecret(namespace: string, key: string) { return { value: platformSecrets.get(`${namespace}/${key}`) ?? null } },
      async putSecret(namespace: string, key: string, value: string) { platformSecrets.set(`${namespace}/${key}`, value) },
      async deleteSecret(namespace: string, key: string) { platformSecrets.delete(`${namespace}/${key}`) },
    }
    const createPlatform = () => new PlatformConfigService({
      driver: c.auth.driver, vault, instanceId: 'migration-test',
      legacy: async ids => Object.fromEntries(ids.map(id => [id, { config: { enabled: false }, secrets: {}, sources: {} }])),
    })
    const platform = createPlatform()
    await platform.initialize()
    await platform.save('sudorouter', {
      expectedVersion: null,
      config: { enabled: true, baseUrl: 'https://router-admin.platform.test', adminUserId: '76', timeoutMs: 1000,
        modelServiceUrl: '', modelsApiUrl: '' },
      secrets: { apiToken: 'test-platform-admin-token' },
    }, 'root')
    const restarted = createPlatform()
    await restarted.initialize()
    const config = serverFileConfigSchema().parse({}) as unknown as ServerConfig
    config.qms = resolveQmsConfig({}, {})
    const store = new ConfigStore(null)
    applyPlatformRuntime(restarted, config, store)
    const system = new SudoworkSystemConfigService({
      db: c.auth.driver, policies: new ClientPolicyRepository(c.auth.driver), identities: c.identities,
      defaults: { loginMethod: 'sms', skillhubBaseUrl: '' }, secrets: store,
      resolveInfrastructure: legacy => platformInfrastructure(restarted, legacy),
    })
    const runtime = resolveSudorouterRuntimeConfig({
      infrastructure: (await system.getInfrastructureConfig()).billing.sudorouter,
      environment: platformEnvironment(restarted, {
        SUDOROUTER_BASE_URL: 'https://obsolete.test', SUDOROUTER_API_TOKEN: 'obsolete-token', SUDOROUTER_ADMIN_USER_ID: '13',
      }),
      getSecret: key => store.get(key),
    })
    assert(runtime)
    let requests = 0
    const provider = new SudorouterAdapter({ ...runtime, fetch: async (url, init) => {
      requests += 1
      assert.equal(url, 'https://router-admin.platform.test/api/user/40')
      assert.equal(init?.method, 'GET')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-platform-admin-token')
      assert.equal(new Headers(init?.headers).get('New-Api-User'), '76')
      return Response.json({ success: true, data: { quota: 250000, used_quota: 12 } })
    } })
    const before = await c.auth.driver.all('SELECT * FROM platform_integration_settings ORDER BY setting_key')
    const beforeSecrets = new Map(platformSecrets)
    assert.deepEqual(await migrateLegacySudorouterCredentials(c.auth.driver, provider, c.secrets), { imported: 1 })
    assert.deepEqual(await migrateLegacySudorouterCredentials(c.auth.driver, provider, c.secrets), { imported: 0 })
    assert.equal(requests, 1)
    assert.equal(c.values.get('moss:sudorouter-users/user-1'), 'sk-original-key')
    assert.deepEqual(await c.auth.driver.all('SELECT * FROM platform_integration_settings ORDER BY setting_key'), before)
    assert.deepEqual(platformSecrets, beforeSecrets)
  } finally { c.auth.close() }
})
