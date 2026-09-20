import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../../../authCenter/db.js'
import { ClientPolicyRepository } from '../../../configuration/clientPolicyRepository.js'
import { PlatformIntegrationSettingsRepository } from '../../../configuration/platformIntegrationSettingsRepository.js'
import { IdentityRepository } from '../../../identity/identityRepository.js'
import { UnifiedIdentityService } from '../../../identity/unifiedIdentityService.js'
import { migrationCommandContext } from '../../../application/commandContext.js'
import { getSystemSettings, updateSystemSettings } from '../../../systemSettings.js'
import { SudoworkSystemConfigError, SudoworkSystemConfigService } from './systemConfigService.js'

async function setup(secretFailure = false) {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  const identities = new IdentityRepository(db)
  const unified = new UnifiedIdentityService(db, authDb, identities)
  const org = await unified.createOrganization({ name: '企业 A', code: 'ENT-A' }, migrationCommandContext('test', 'org-a'))
  const secrets = new Map<string, string>()
  const service = new SudoworkSystemConfigService({
    db,
    policies: new ClientPolicyRepository(db),
    infrastructureSettings: new PlatformIntegrationSettingsRepository(db),
    identities,
    defaults: {
      loginMethod: 'password',
      skillhubBaseUrl: 'https://moss.example.test',
      sudorouterBaseUrl: 'https://router.example.test',
      productImprovementEncryptionRequired: true,
      productImprovementApiKey: 'qms-api-key',
      productImprovementPublicKey: 'qms-public-key',
      sms: {
        provider: 'disabled', sdkAppId: '', signName: '', templateId: '', signId: '',
        region: 'ap-beijing', codeLength: 6, expireMinutes: 5,
        sendIntervalSeconds: 60, maxPerDay: 10,
      },
      billing: {
        enabled: false,
        fuiou: { testMode: false, merchantCode: '', timeoutMs: 10_000 },
        sudorouter: { baseUrl: '', adminUserId: '13', timeoutMs: 10_000 },
      },
    },
    smsRuntimeAvailable: true,
    secrets: {
      get(key: string) { return secrets.get(key) },
      async put(key: string, value: string) {
        if (secretFailure) throw new Error('nexus unavailable')
        secrets.set(key, value)
      },
      async remove(key: string) { secrets.delete(key) },
    },
  } as never)
  return { db, identities, org, secrets, service }
}

void describe('Sudowork 系统配置统一服务', () => {
  void test('平台策略与组织 CAS Connection 投影为旧公开和管理响应', async () => {
    const { db, identities, org, secrets, service } = await setup()
    try {
      const root = { userId: 'root', orgId: org.organizationId, role: 'super_admin' }
      await service.update(root, {
        login_method: 2,
        third_party_auth: {
          enabled: 1,
          default_provider: 'cas-main',
          providers: [{
            id: 'cas-main', name: '统一认证', type: 'cas', enabled: 1,
            cas_url: 'https://cas.example.test/', login_path: '/cas/login',
            validate_path: '/cas/p3/serviceValidate', logout_path: '/cas/logout',
            logout_service_url: 'https://moss.example.test/api/v1/auth/third-party/cas/logout/callback/cas-main',
            service_param: 'service', service_encode_mode: 'component',
            callback_mode: 'server_callback',
            server_callback_url: 'https://moss.example.test/api/v1/auth/third-party/cas/callback/cas-main',
            app_callback_url: 'sudowork://cas-callback/cas-main/callback',
            enterprise_code: 'ENT-A', auto_provision: 1,
          }],
        },
        log_report: { enabled: 1, protocol: 'https', domain: 'logs.example.test', key: 'log-secret' },
        version_update: { enabled: 1, cos_domain: 'https://releases.example.test' },
        product_improvement: { enabled: 1 },
        scode_auto_model: 'auto-model',
        recharge_mode: 'approve',
        credit_application: { min_points: 200, max_points: 2000, allow_duplicate_pending: false },
      })

      assert.equal(identities.getIntegrationConnection('cas-main')?.orgId, org.organizationId)
      assert.equal(secrets.get('client.log-report-key'), 'log-secret')
      assert.equal(db.prepare(`SELECT instr(policy_json, 'log-secret') AS found FROM client_delivery_policies`).get()?.found, 0)

      const publicConfig = service.getPublicConfig()
      assert.equal(publicConfig.login_method, 2)
      assert.deepEqual(publicConfig.log_report, { enabled: 1, baseurl: 'https://logs.example.test' })
      assert.equal((publicConfig.third_party_auth as any).providers[0].enterprise_code, '')
      assert.equal((publicConfig.third_party_auth as any).providers[0].auto_provision, 0)
      assert.equal(publicConfig.skillhub_baseurl, 'https://moss.example.test')

      const adminConfig = service.getAdminConfig(root)
      assert.equal((adminConfig.third_party_auth as any).providers[0].enterprise_code, 'ENT-A')
      assert.deepEqual(adminConfig.log_report, {
        enabled: 1, protocol: 'https', domain: 'logs.example.test', key: '', key_set: true,
      })
      assert.deepEqual(service.getCredentialData(), {
        log_report: { key: 'log-secret' },
        product_improvement: { api_key: 'qms-api-key', public_key: 'qms-public-key' },
      })
    } finally {
      db.close()
    }
  })

  void test('权限、短信前置条件和 Nexus 失败不会留下部分策略', async () => {
    const { db, org, service } = await setup(true)
    try {
      await assert.rejects(
        service.update({ userId: 'admin', orgId: org.organizationId, role: 'admin' }, { login_method: 1 }),
        (error: unknown) => error instanceof SudoworkSystemConfigError && error.statusCode === 403,
      )
      await assert.rejects(
        service.update({ userId: 'root', orgId: org.organizationId, role: 'super_admin' }, {
          log_report: { enabled: 1, protocol: 'https', domain: 'logs.example.test', key: 'new-secret' },
        }),
        /nexus unavailable/,
      )
      assert.deepEqual(new ClientPolicyRepository(db).getPlatform(), {})
    } finally {
      db.close()
    }
  })

  void test('平台超级管理员可更新短信和支付基础设施并要求重启', async () => {
    const { db, org, service } = await setup()
    try {
      const root = { userId: 'root', orgId: org.organizationId, role: 'super_admin' }
      const scopedRoot = { ...root, organizationScoped: true }
      await service.update(root, {
        sms: {
          provider: 'tencent', sdk_app_id: '1400000000', sign_name: '企业签名',
          template_id: '123456', sign_id: '654321', region: 'ap-guangzhou',
          code_length: 6, expire_minutes: 8, send_interval_seconds: 90, max_per_day: 20,
        },
        billing: {
          enabled: true,
          fuiou: {
            test_mode: true, merchant_code: 'MERCHANT-1', timeout_ms: 12_000,
            test_api_url: 'https://pay.test', test_refund_url: 'https://refund.test',
          },
          sudorouter: {
            base_url: 'https://router.test', admin_user_id: '91', timeout_ms: 15_000,
            initial_quota: 50_000_000,
            model_service_url: 'https://router.test/v1',
            models_api_url: 'https://router.test/api/specific_pricing',
          },
        },
      })

      const config = service.getAdminConfig(root) as any
      assert.equal(config.scope_type, 'platform')
      assert.equal(config.restart_required, true)
      assert.equal(config.sms.provider, 'tencent')
      assert.equal(config.sms.expire_minutes, 8)
      assert.equal(config.billing.enabled, true)
      assert.equal(config.billing.fuiou.merchant_code, 'MERCHANT-1')
      assert.equal(config.billing.sudorouter.base_url, 'https://router.test')
      assert.equal(config.billing.sudorouter.initial_quota, 50_000_000)
      assert.equal(config.billing.sudorouter.model_service_url, 'https://router.test/v1')
      assert.equal(service.getPublicConfig().sudorouter_baseurl, 'https://router.test')
      assert.equal((db.prepare(`
        SELECT instr(policy_json, 'billingInfrastructure') + instr(policy_json, 'smsInfrastructure') AS leaked
        FROM client_delivery_policies WHERE scope_type = 'platform' AND scope_id = 'default'
      `).get() as { leaked: number } | undefined)?.leaked ?? 0, 0)
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM platform_integration_settings
        WHERE setting_key IN ('sudowork.sms', 'sudowork.billing')
      `).get()?.count, 2)
      assert.deepEqual((service as any).getInfrastructureConfig(), {
        sms: {
          provider: 'tencent', sdkAppId: '1400000000', signName: '企业签名',
          templateId: '123456', signId: '654321', region: 'ap-guangzhou',
          codeLength: 6, expireMinutes: 8, sendIntervalSeconds: 90, maxPerDay: 20,
        },
        billing: {
          enabled: true,
          fuiou: {
            testMode: true, merchantCode: 'MERCHANT-1', timeoutMs: 12_000,
            testApiUrl: 'https://pay.test', testRefundUrl: 'https://refund.test',
          },
          sudorouter: {
            baseUrl: 'https://router.test', adminUserId: '91', timeoutMs: 15_000,
            initialQuota: 50_000_000, modelServiceUrl: 'https://router.test/v1',
            modelsApiUrl: 'https://router.test/api/specific_pricing',
          },
        },
      })
      const scopedConfig = service.getAdminConfig(scopedRoot) as any
      assert.equal(scopedConfig.scope_type, 'organization')
      assert.equal(scopedConfig.sms, undefined)
      assert.equal(scopedConfig.billing, undefined)
      assert.equal(scopedConfig.restart_required, undefined)
    } finally {
      db.close()
    }
  })

  void test('组织作用域系统配置写入本组织策略且不改平台默认', async () => {
    const { db, identities, org, secrets, service } = await setup()
    try {
      secrets.set('client.log-report-key', 'platform-log-key')
      const orgB = await new UnifiedIdentityService(db, new AuthCenterDb(db), identities)
        .createOrganization({ name: '企业 B', code: 'ENT-B' }, migrationCommandContext('test', 'org-b'))
      const policies = new ClientPolicyRepository(db)
      policies.putPlatform({
        loginMethod: 1,
        scodeAutoModel: 'platform-model',
        rechargeMode: 'pay',
        creditApplication: { min_points: 100, max_points: 1000, allow_duplicate_pending: false },
      }, 'root')

      const scopedRoot = {
        userId: 'root-b', orgId: orgB.organizationId, role: 'super_admin', organizationScoped: true,
      }
      await service.update(scopedRoot, {
        login_method: 1,
        log_report: { enabled: 1, protocol: 'https', domain: 'logs-b.example.test', key: '' },
        version_update: { enabled: 1, cos_domain: 'https://releases-b.example.test' },
        product_improvement: { enabled: 1 },
        scode_auto_model: 'org-b-model',
        recharge_mode: 'approve',
        credit_application: { min_points: 200, max_points: 2000, allow_duplicate_pending: true },
      })

      const platformPolicy = policies.getPlatform()
      assert.equal(platformPolicy.scodeAutoModel, 'platform-model')
      assert.equal(platformPolicy.rechargeMode, 'pay')
      assert.equal(platformPolicy.logReport, undefined)

      const orgPolicy = policies.getOrganization(orgB.organizationId)
      assert.equal(orgPolicy.scodeAutoModel, 'org-b-model')
      assert.deepEqual(orgPolicy.logReport, {
        enabled: 1, protocol: 'https', domain: 'logs-b.example.test', keySet: true,
      })

      const orgConfig = service.getAdminConfig(scopedRoot) as any
      assert.equal(orgConfig.scope_type, 'organization')
      assert.equal(orgConfig.scode_auto_model, 'org-b-model')
      assert.equal(orgConfig.log_report.domain, 'logs-b.example.test')

      const defaultConfig = service.getPublicConfig(org.organizationId)
      assert.equal(defaultConfig.scode_auto_model, 'platform-model')
      assert.equal(defaultConfig.recharge_mode, 'pay')
      assert.equal(service.getCreditApplicationPolicy(orgB.organizationId).rechargeMode, 'approve')
      assert.equal(service.getCreditApplicationPolicy(orgB.organizationId).minPoints, 200)
      assert.equal(service.getCreditApplicationPolicy(org.organizationId).rechargeMode, 'payment')
      assert.deepEqual(service.getCredentialData(orgB.organizationId), {
        log_report: { key: 'platform-log-key' },
        product_improvement: { api_key: 'qms-api-key', public_key: 'qms-public-key' },
      })

      await service.update(scopedRoot, {
        client_cron_enabled: false,
        client_show_tool_calls: true,
        workspace_upload_limit_bytes: 8192,
      })
      assert.equal(identities.getOrganizationProfile(orgB.organizationId)?.clientCronEnabled, false)
      assert.equal(policies.getOrganization(orgB.organizationId).clientShowToolCalls, true)
      assert.equal(policies.getOrganization(orgB.organizationId).workspaceUploadLimitBytes, 8192)
    } finally {
      db.close()
    }
  })

  void test('组织 cron 开关和全局 kill switch 组合生效', async () => {
    const original = getSystemSettings()
    const { db, identities, org, service } = await setup()
    try {
      await updateSystemSettings({ clientCronEnabled: false })
      identities.setOrganizationClientCronEnabled(org.organizationId, true)
      assert.equal(service.getPublicConfig(org.organizationId).client_cron_enabled, false)

      await updateSystemSettings({ clientCronEnabled: true })
      assert.equal(service.getPublicConfig(org.organizationId).client_cron_enabled, true)

      identities.setOrganizationClientCronEnabled(org.organizationId, false)
      assert.equal(service.getPublicConfig(org.organizationId).client_cron_enabled, false)

      await service.update({
        userId: 'root', orgId: org.organizationId, role: 'super_admin', organizationScoped: true,
      }, { client_cron_enabled: true })
      assert.equal(identities.getOrganizationProfile(org.organizationId)?.clientCronEnabled, true)
    } finally {
      await updateSystemSettings({ clientCronEnabled: original.clientCronEnabled })
      db.close()
    }
  })

  void test('组织作用域保存单字段不会复制继承的平台策略', async () => {
    const { db, identities, org, service } = await setup()
    try {
      const orgB = await new UnifiedIdentityService(db, new AuthCenterDb(db), identities)
        .createOrganization({ name: '企业 B', code: 'ENT-B' }, migrationCommandContext('test', 'org-b'))
      const policies = new ClientPolicyRepository(db)
      policies.putPlatform({
        loginMethod: 1,
        logReport: { enabled: 0, protocol: '', domain: '', keySet: false },
        versionUpdate: { enabled: 0, cosDomain: '' },
        productImprovement: { enabled: 0 },
        thirdPartyAuth: { enabled: 0, defaultProvider: '' },
        scodeAutoModel: 'platform-model',
        rechargeMode: 'pay',
        creditApplication: { min_points: 100, max_points: 1000, allow_duplicate_pending: false },
        clientShowToolCalls: false,
        workspaceUploadLimitBytes: 4096,
      }, 'root')
      const scopedRoot = {
        userId: 'root-b', orgId: orgB.organizationId, role: 'super_admin', organizationScoped: true,
      }
      const roundTripped = service.getAdminConfig(scopedRoot) as Record<string, unknown>
      await service.update(scopedRoot, { ...roundTripped, scode_auto_model: 'org-b-model' })

      assert.deepEqual(policies.getOrganization(orgB.organizationId), { scodeAutoModel: 'org-b-model' })
    } finally {
      db.close()
    }
  })

  void test('组织作用域把已有 override 改回平台值时会清除 override', async () => {
    const { db, identities, org, service } = await setup()
    try {
      const orgB = await new UnifiedIdentityService(db, new AuthCenterDb(db), identities)
        .createOrganization({ name: '企业 B', code: 'ENT-B' }, migrationCommandContext('test', 'org-b'))
      const policies = new ClientPolicyRepository(db)
      policies.putPlatform({ scodeAutoModel: 'platform-model', clientShowToolCalls: false }, 'root')
      policies.putOrganization(orgB.organizationId, {
        scodeAutoModel: 'org-b-model',
        clientShowToolCalls: true,
      }, 'admin-b')
      const scopedRoot = {
        userId: 'root-b', orgId: orgB.organizationId, role: 'super_admin', organizationScoped: true,
      }

      await service.update(scopedRoot, {
        scode_auto_model: 'platform-model',
        client_show_tool_calls: false,
      })

      assert.deepEqual(policies.getOrganization(orgB.organizationId), {})
      const config = service.getAdminConfig(scopedRoot) as any
      assert.equal(config.scode_auto_model, 'platform-model')
      assert.equal(config.client_show_tool_calls, false)
    } finally {
      db.close()
    }
  })

  void test('组织作用域拒绝字符串布尔值避免 Boolean 字符串误判', async () => {
    const { db, org, service } = await setup()
    const scopedRoot = {
      userId: 'root', orgId: org.organizationId, role: 'super_admin', organizationScoped: true,
    }
    try {
      await assert.rejects(
        service.update(scopedRoot, { client_cron_enabled: 'false' }),
        (error: unknown) => error instanceof SudoworkSystemConfigError
          && error.statusCode === 400
          && /client_cron_enabled/.test(error.message),
      )
      await assert.rejects(
        service.update(scopedRoot, { client_show_tool_calls: 'false' }),
        (error: unknown) => error instanceof SudoworkSystemConfigError
          && error.statusCode === 400
          && /client_show_tool_calls/.test(error.message),
      )
    } finally {
      db.close()
    }
  })

  void test('组织作用域不能修改部署级基础设施和全局日志密钥', async () => {
    const { db, org, service } = await setup()
    const scopedRoot = {
      userId: 'root', orgId: org.organizationId, role: 'super_admin', organizationScoped: true,
    }
    try {
      await assert.rejects(service.update(scopedRoot, {
        sms: { provider: 'tencent' },
      }), (error: unknown) => error instanceof SudoworkSystemConfigError && error.statusCode === 403)
      await assert.rejects(service.update(scopedRoot, {
        billing: { enabled: true },
      }), (error: unknown) => error instanceof SudoworkSystemConfigError && error.statusCode === 403)
      await assert.rejects(service.update(scopedRoot, {
        log_report: { enabled: 1, protocol: 'https', domain: 'logs.example.test', key: 'org-secret' },
      }), (error: unknown) => error instanceof SudoworkSystemConfigError && error.statusCode === 403)
      assert.deepEqual(new ClientPolicyRepository(db).getOrganization(org.organizationId), {})
    } finally {
      db.close()
    }
  })

  void test('组织作用域 CAS 更新只替换本组织 Provider', async () => {
    const { db, identities, org, service } = await setup()
    try {
      const orgB = await new UnifiedIdentityService(db, new AuthCenterDb(db), identities)
        .createOrganization({ name: '企业 B', code: 'ENT-B' }, migrationCommandContext('test', 'org-b'))
      identities.putIntegrationConnection({
        id: 'cas-a-old',
        orgId: org.organizationId,
        providerType: 'cas',
        name: '企业 A 旧 CAS',
        enabled: true,
        secretRef: null,
        config: {},
      })
      identities.putIntegrationConnection({
        id: 'cas-b-old',
        orgId: orgB.organizationId,
        providerType: 'cas',
        name: '企业 B 旧 CAS',
        enabled: true,
        secretRef: null,
        config: {},
      })
      const scopedRoot = {
        userId: 'root', orgId: org.organizationId, role: 'super_admin', organizationScoped: true,
      }
      await service.update(scopedRoot, {
        third_party_auth: {
          enabled: 1,
          default_provider: 'cas-a-new',
          providers: [{
            id: 'cas-a-new', name: '企业 A 新 CAS', type: 'cas', enabled: 1,
            cas_url: 'https://cas-a.example.test/', login_path: '/cas/login',
            validate_path: '/cas/p3/serviceValidate', logout_path: '/cas/logout',
            logout_service_url: 'https://moss.example.test/api/v1/auth/third-party/cas/logout/callback/cas-a-new',
            service_param: 'service', service_encode_mode: 'component',
            callback_mode: 'server_callback',
            server_callback_url: 'https://moss.example.test/api/v1/auth/third-party/cas/callback/cas-a-new',
            app_callback_url: 'sudowork://cas-callback/cas-a-new/callback',
            enterprise_code: 'ENT-A', auto_provision: 1,
          }],
        },
      })

      assert.equal(identities.getIntegrationConnection('cas-a-old')?.enabled, false)
      assert.equal(identities.getIntegrationConnection('cas-a-new')?.orgId, org.organizationId)
      assert.equal(identities.getIntegrationConnection('cas-b-old')?.enabled, true)
      assert.equal((service.getAdminConfig(scopedRoot).third_party_auth as any).providers.length, 2)
      assert.equal((service.getPublicConfig(orgB.organizationId).third_party_auth as any).providers[0].id, 'cas-b-old')

      await assert.rejects(service.update(scopedRoot, {
        third_party_auth: {
          enabled: 1,
          default_provider: 'cas-b-new',
          providers: [{
            id: 'cas-b-new', name: '企业 B CAS', type: 'cas', enabled: 1,
            cas_url: 'https://cas-b.example.test/', login_path: '/cas/login',
            validate_path: '/cas/p3/serviceValidate', logout_path: '/cas/logout',
            service_param: 'service',
            callback_mode: 'server_callback',
            server_callback_url: 'https://moss.example.test/callback',
            app_callback_url: 'sudowork://cas-callback/cas-b-new/callback',
            enterprise_code: 'ENT-B',
          }],
        },
      }), (error: unknown) => error instanceof SudoworkSystemConfigError && error.statusCode === 403)
      await assert.rejects(service.update(scopedRoot, {
        third_party_auth: {
          enabled: 1,
          default_provider: 'cas-b-old',
          providers: [{
            id: 'cas-b-old', name: '复用企业 B Provider ID', type: 'cas', enabled: 1,
            cas_url: 'https://cas-a.example.test/', login_path: '/cas/login',
            validate_path: '/cas/p3/serviceValidate', logout_path: '/cas/logout',
            service_param: 'service',
            callback_mode: 'server_callback',
            server_callback_url: 'https://moss.example.test/callback',
            app_callback_url: 'sudowork://cas-callback/cas-b-old/callback',
            enterprise_code: 'ENT-A',
          }],
        },
      }), (error: unknown) => error instanceof SudoworkSystemConfigError && error.statusCode === 403)
    } finally {
      db.close()
    }
  })

  void test('组织继承平台 CAS 但没有启用 Provider 时可 GET 后原样 PUT', async () => {
    const { db, identities, org, service } = await setup()
    try {
      const orgB = await new UnifiedIdentityService(db, new AuthCenterDb(db), identities)
        .createOrganization({ name: '企业 B', code: 'ENT-B' }, migrationCommandContext('test', 'org-b'))
      const policies = new ClientPolicyRepository(db)
      policies.putPlatform({
        thirdPartyAuth: { enabled: 1, defaultProvider: 'cas-a' },
      }, 'root')
      identities.putIntegrationConnection({
        id: 'cas-a',
        orgId: org.organizationId,
        providerType: 'cas',
        name: '企业 A CAS',
        enabled: true,
        secretRef: null,
        config: {},
      })
      identities.putIntegrationConnection({
        id: 'cas-b-disabled',
        orgId: orgB.organizationId,
        providerType: 'cas',
        name: '企业 B 禁用 CAS',
        enabled: false,
        secretRef: null,
        config: {},
      })
      const scopedRoot = {
        userId: 'root-b', orgId: orgB.organizationId, role: 'super_admin', organizationScoped: true,
      }
      const config = service.getAdminConfig(scopedRoot) as any
      assert.equal(config.third_party_auth.enabled, 0)
      assert.equal(config.third_party_auth.default_provider, '')
      assert.equal(config.third_party_auth.providers.length, 1)

      await service.update(scopedRoot, { ...config, scode_auto_model: 'org-b-model' })
      assert.equal(policies.getOrganization(orgB.organizationId).scodeAutoModel, 'org-b-model')
    } finally {
      db.close()
    }
  })

  void test('组织没有启用 CAS Provider 时不能保存 CAS-only 登录方式', async () => {
    const { db, identities, org, service } = await setup()
    try {
      const orgB = await new UnifiedIdentityService(db, new AuthCenterDb(db), identities)
        .createOrganization({ name: '企业 B', code: 'ENT-B' }, migrationCommandContext('test', 'org-b'))
      const policies = new ClientPolicyRepository(db)
      policies.putPlatform({
        thirdPartyAuth: { enabled: 1, defaultProvider: 'cas-a' },
      }, 'root')
      identities.putIntegrationConnection({
        id: 'cas-a',
        orgId: org.organizationId,
        providerType: 'cas',
        name: '企业 A CAS',
        enabled: true,
        secretRef: null,
        config: {},
      })
      identities.putIntegrationConnection({
        id: 'cas-b-disabled',
        orgId: orgB.organizationId,
        providerType: 'cas',
        name: '企业 B 禁用 CAS',
        enabled: false,
        secretRef: null,
        config: {},
      })
      const scopedRoot = {
        userId: 'root-b', orgId: orgB.organizationId, role: 'super_admin', organizationScoped: true,
      }

      await assert.rejects(
        service.update(scopedRoot, { login_method: 2 }),
        (error: unknown) => error instanceof SudoworkSystemConfigError
          && error.statusCode === 400
          && /三方认证配置未启用/.test(error.message),
      )
    } finally {
      db.close()
    }
  })

  void test('公开配置可按组织合并客户端策略并过滤三方认证 Provider', async () => {
    const { db, identities, org, service } = await setup()
    try {
      const orgB = await new UnifiedIdentityService(db, new AuthCenterDb(db), identities)
        .createOrganization({ name: '企业 B', code: 'ENT-B' }, migrationCommandContext('test', 'org-b'))
      const policies = new ClientPolicyRepository(db)
      policies.putPlatform({
        loginMethod: 1,
        skillhubBaseUrl: 'https://moss.example.test',
        clientShowToolCalls: true,
        workspaceUploadLimitBytes: 8192,
        thirdPartyAuth: { enabled: 1, defaultProvider: 'cas-a' },
      }, 'root')
      policies.putOrganization(orgB.organizationId, {
        loginMethod: 2,
        scodeAutoModel: 'org-b-model',
        clientShowToolCalls: false,
        workspaceUploadLimitBytes: 4096,
      }, 'admin-b')
      identities.putIntegrationConnection({
        id: 'cas-a',
        orgId: org.organizationId,
        providerType: 'cas',
        name: '企业 A CAS',
        enabled: true,
        secretRef: null,
        config: {},
      })
      identities.putIntegrationConnection({
        id: 'cas-b',
        orgId: orgB.organizationId,
        providerType: 'cas',
        name: '企业 B CAS',
        enabled: true,
        secretRef: null,
        config: {},
      })

      const config = service.getPublicConfig(orgB.organizationId)
      assert.equal(config.login_method, 2)
      assert.equal(config.scode_auto_model, 'org-b-model')
      assert.equal(config.client_show_tool_calls, false)
      assert.equal(config.workspace_upload_limit_bytes, 4096)
      assert.equal((config.third_party_auth as any).default_provider, 'cas-b')
      assert.equal((config.third_party_auth as any).providers.length, 1)
      assert.equal((config.third_party_auth as any).providers[0].id, 'cas-b')
    } finally {
      db.close()
    }
  })

  void test('拒绝非法短信和支付基础设施参数', async () => {
    const { db, org, service } = await setup()
    const root = { userId: 'root', orgId: org.organizationId, role: 'super_admin' }
    try {
      await assert.rejects(service.update(root, {
        sms: { provider: 'tencent', code_length: 2 },
      }), /短信验证码长度/)
      await assert.rejects(service.update(root, {
        billing: { enabled: true, fuiou: { timeout_ms: 0 } },
      }), /富友超时时间/)
    } finally {
      db.close()
    }
  })
})
