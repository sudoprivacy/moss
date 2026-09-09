import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../../../authCenter/db.js'
import { ClientPolicyRepository } from '../../../configuration/clientPolicyRepository.js'
import { PlatformIntegrationSettingsRepository } from '../../../configuration/platformIntegrationSettingsRepository.js'
import { IdentityRepository } from '../../../identity/identityRepository.js'
import { UnifiedIdentityService } from '../../../identity/unifiedIdentityService.js'
import { migrationCommandContext } from '../../../application/commandContext.js'
import { SudoworkSystemConfigError, SudoworkSystemConfigService } from './systemConfigService.js'

function setup(secretFailure = false) {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  const identities = new IdentityRepository(db)
  const unified = new UnifiedIdentityService(db, authDb, identities)
  const org = unified.createOrganization({ name: '企业 A', code: 'ENT-A' }, migrationCommandContext('test', 'org-a'))
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
      get(key) { return secrets.get(key) },
      async put(key, value) {
        if (secretFailure) throw new Error('nexus unavailable')
        secrets.set(key, value)
      },
      async remove(key) { secrets.delete(key) },
    },
  } as never)
  return { db, identities, org, secrets, service }
}

describe('Sudowork 系统配置统一服务', () => {
  test('平台策略与组织 CAS Connection 投影为旧公开和管理响应', async () => {
    const { db, identities, org, secrets, service } = setup()
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

  test('权限、短信前置条件和 Nexus 失败不会留下部分策略', async () => {
    const { db, org, service } = setup(true)
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

  test('短信和支付基础设施非敏感参数写入统一平台策略并要求重启', async () => {
    const { db, org, service } = setup()
    try {
      const legacyRoot = { userId: 'root', orgId: org.organizationId, role: 'super_admin' }
      const root = { ...legacyRoot, organizationScoped: true }
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
      assert.equal(config.restart_required, true)
      assert.equal(config.sms.provider, 'tencent')
      assert.equal(config.sms.expire_minutes, 8)
      assert.equal(config.billing.enabled, true)
      assert.equal(config.billing.fuiou.merchant_code, 'MERCHANT-1')
      assert.equal(config.billing.sudorouter.base_url, 'https://router.test')
      assert.equal(config.billing.sudorouter.initial_quota, 50_000_000)
      assert.equal(config.billing.sudorouter.model_service_url, 'https://router.test/v1')
      assert.equal(service.getPublicConfig().sudorouter_baseurl, 'https://router.test')
      assert.equal(db.prepare(`
        SELECT instr(policy_json, 'billingInfrastructure') + instr(policy_json, 'smsInfrastructure') AS leaked
        FROM client_delivery_policies WHERE scope_type = 'platform' AND scope_id = 'default'
      `).get()?.leaked, 0)
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
      const legacyConfig = service.getAdminConfig(legacyRoot) as any
      assert.equal(legacyConfig.sms, undefined)
      assert.equal(legacyConfig.billing, undefined)
      assert.equal(legacyConfig.restart_required, undefined)
    } finally {
      db.close()
    }
  })

  test('拒绝非法短信和支付基础设施参数', async () => {
    const { db, org, service } = setup()
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
