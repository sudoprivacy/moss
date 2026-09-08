import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../../../authCenter/db.js'
import { ClientPolicyRepository } from '../../../configuration/clientPolicyRepository.js'
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
    identities,
    defaults: {
      loginMethod: 'password',
      skillhubBaseUrl: 'https://moss.example.test',
      sudorouterBaseUrl: 'https://router.example.test',
      productImprovementEncryptionRequired: true,
      productImprovementApiKey: 'qms-api-key',
      productImprovementPublicKey: 'qms-public-key',
    },
    smsConfigured: true,
    secrets: {
      get(key) { return secrets.get(key) },
      async put(key, value) {
        if (secretFailure) throw new Error('nexus unavailable')
        secrets.set(key, value)
      },
      async remove(key) { secrets.delete(key) },
    },
  })
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
})
