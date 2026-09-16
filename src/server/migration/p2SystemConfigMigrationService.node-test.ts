import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { migrationCommandContext } from '../application/commandContext.js'
import { SudoworkSystemConfigService } from '../api/compat/sudowork/systemConfigService.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { ClientPolicyRepository } from '../configuration/clientPolicyRepository.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { UnifiedIdentityService } from '../identity/unifiedIdentityService.js'
import {
  P2SystemConfigMigrationBlockedError,
  P2SystemConfigMigrationService,
} from './p2SystemConfigMigrationService.js'

const LEGACY_LOG_KEY = Buffer.from('L7CbnQlwVrzWlaehCWSIiKuwBxFDh9i1AFaifYv7UXE=', 'base64')

async function encryptLegacyLogReportKeyForTest(value: string) {
  const key = await crypto.subtle.importKey('raw', LEGACY_LOG_KEY, { name: 'AES-GCM' }, false, ['encrypt'])
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, key, new TextEncoder().encode(value),
  )
  return {
    nonce: Buffer.from(nonce).toString('base64'),
    ciphertext: Buffer.from(encrypted).toString('base64'),
  }
}

async function setup(
  raw: Record<string, string>,
  secretFailure = false,
  productImprovementCredentials: { apiKey?: string; publicKey?: string } = {
    apiKey: 'qms-key', publicKey: 'qms-public',
  },
) {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  const identities = new IdentityRepository(db)
  const unified = new UnifiedIdentityService(db, authDb, identities)
  const org = unified.createOrganization(
    { name: '企业 A', code: 'ENT-A', legacyEnterpriseId: 1 },
    migrationCommandContext('identity', 'org-a'),
  )
  const secrets = new Map<string, string>()
  const policies = new ClientPolicyRepository(db)
  const service = new SudoworkSystemConfigService({
    db,
    policies,
    identities,
    defaults: {
      loginMethod: 'password',
      skillhubBaseUrl: 'https://moss.example.test',
      productImprovementEncryptionRequired: true,
      productImprovementApiKey: productImprovementCredentials.apiKey,
      productImprovementPublicKey: productImprovementCredentials.publicKey,
    },
    smsConfigured: true,
    secrets: {
      get: key => secrets.get(key),
      async put(key, value) {
        if (secretFailure) throw new Error('nexus unavailable')
        secrets.set(key, value)
      },
      async remove(key) { secrets.delete(key) },
    },
  })
  const migration = new P2SystemConfigMigrationService({
    db,
    identities,
    service,
    platformOrgId: org.organizationId,
    source: { readSystemConfig: () => raw },
  })
  return { db, identities, org, policies, secrets, service, migration }
}

describe('P2 系统配置迁移', () => {
  test('把旧平台策略与 CAS 投影到统一模型，日志密钥只进入 Nexus 且可重复执行', async () => {
    const encrypted = await encryptLegacyLogReportKeyForTest('legacy-log-secret')
    const raw = {
      login_method: '2',
      third_party_auth: JSON.stringify({
        enabled: 1,
        default_provider: 'cas-main',
        providers: [{
          id: 'cas-main', name: '统一认证', type: 'cas', enabled: 1,
          cas_url: 'https://cas.example.test', login_path: '/cas/login',
          validate_path: '/cas/p3/serviceValidate', logout_path: '/cas/logout',
          logout_service_url: 'https://moss.example.test/logout', service_param: 'service',
          service_encode_mode: 'component', callback_mode: 'server_callback',
          server_callback_url: 'https://moss.example.test/cas/callback',
          app_callback_url: 'sudowork://cas-callback/cas-main/callback',
          enterprise_code: 'ENT-A', auto_provision: 1,
        }],
      }),
      log_report: JSON.stringify({
        enabled: 1, protocol: 'https', domain: 'logs.example.test',
        key_cipher: encrypted.ciphertext, key_nonce: encrypted.nonce,
      }),
      version_update: JSON.stringify({ enabled: 1, cos_domain: 'https://releases.example.test' }),
      product_improvement: JSON.stringify({ enabled: 1 }),
      scode_auto_model: 'auto-model',
      recharge_mode: 'approve',
    }
    const fixture = await setup(raw)
    try {
      const plan = await fixture.migration.plan()
      assert.equal(plan.status, 'ready')
      assert.deepEqual(plan.deferredKeys, ['recharge_mode'])
      assert.deepEqual(fixture.policies.getPlatform(), {})
      assert.equal(fixture.secrets.size, 0)

      assert.deepEqual(await fixture.migration.execute('p2-system'), {
        migrationRunId: 'p2-system', imported: true, reused: false,
      })
      assert.deepEqual(await fixture.migration.execute('p2-system-resume'), {
        migrationRunId: 'p2-system-resume', imported: false, reused: true,
      })
      assert.equal(fixture.service.getPublicConfig().login_method, 2)
      assert.equal(fixture.identities.getIntegrationConnection('cas-main')?.orgId, fixture.org.organizationId)
      assert.equal(fixture.secrets.get('client.log-report-key'), 'legacy-log-secret')
      const stored = String(fixture.db.prepare('SELECT policy_json FROM client_delivery_policies').get()?.policy_json)
      assert.equal(stored.includes('legacy-log-secret'), false)
      assert.equal(stored.includes(encrypted.ciphertext), false)
      assert.equal(stored.includes(encrypted.nonce), false)
    } finally {
      fixture.db.close()
    }
  })

  test('无效 JSON、未知 CAS 企业或 Nexus 失败均不会留下平台策略', async () => {
    const malformed = await setup({ log_report: '{broken' })
    try {
      const plan = await malformed.migration.plan()
      assert.equal(plan.status, 'blocked')
      await assert.rejects(
        malformed.migration.execute('bad-json'),
        (error: unknown) => error instanceof P2SystemConfigMigrationBlockedError,
      )
      assert.deepEqual(malformed.policies.getPlatform(), {})
    } finally {
      malformed.db.close()
    }

    const unknownOrg = await setup({
      third_party_auth: JSON.stringify({
        enabled: 1, default_provider: 'cas-x',
        providers: [{ id: 'cas-x', name: 'CAS', type: 'cas', enabled: 1, cas_url: 'https://cas.example.test', enterprise_code: 'UNKNOWN' }],
      }),
    })
    try {
      assert.equal((await unknownOrg.migration.plan()).status, 'blocked')
    } finally {
      unknownOrg.db.close()
    }

    const encrypted = await encryptLegacyLogReportKeyForTest('secret')
    const nexusFailure = await setup({
      log_report: JSON.stringify({
        enabled: 1, protocol: 'https', domain: 'logs.example.test',
        key_cipher: encrypted.ciphertext, key_nonce: encrypted.nonce,
      }),
    }, true)
    try {
      await assert.rejects(nexusFailure.migration.execute('nexus-failure'), /nexus unavailable/)
      assert.deepEqual(nexusFailure.policies.getPlatform(), {})
      assert.equal(nexusFailure.identities.getCommandResult('configuration.import_system', 'system-config'), null)
    } finally {
      nexusFailure.db.close()
    }
  })

  test('预检复用在线命令校验并在缺少 QMS 凭据时阻断且零写入', async () => {
    const fixture = await setup({
      product_improvement: JSON.stringify({ enabled: 1 }),
    }, false, {})
    try {
      const plan = await fixture.migration.plan()
      assert.equal(plan.status, 'blocked')
      assert.match(plan.conflicts.join('\n'), /QMS_DEFAULT_API_KEY/)
      assert.deepEqual(fixture.policies.getPlatform(), {})
      assert.equal(fixture.secrets.size, 0)
    } finally {
      fixture.db.close()
    }
  })
})
