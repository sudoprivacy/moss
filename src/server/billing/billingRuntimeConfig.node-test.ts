import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { resolveBillingRuntimeConfig, resolveSudorouterRuntimeConfig } from './billingRuntimeConfig.js'

const infrastructure = {
  enabled: true,
  fuiou: {
    testMode: false,
    merchantCode: 'POLICY-MERCHANT',
    timeoutMs: 10_000,
    prodApiUrl: 'https://pay.policy',
    prodRefundUrl: 'https://refund.policy',
  },
  sudorouter: {
    baseUrl: 'https://router.policy',
    adminUserId: '13',
    timeoutMs: 11_000,
    initialQuota: 50_000_000,
    modelServiceUrl: 'https://router.policy/v1',
    modelsApiUrl: 'https://router.policy/api/specific_pricing',
  },
}

describe('Sudowork Billing 运行配置', () => {
  test('在线计费关闭时仍可独立装配 Sudorouter 用户生命周期', () => {
    assert.deepEqual(resolveSudorouterRuntimeConfig({
      infrastructure: infrastructure.sudorouter,
      environment: {},
      getSecret: key => key === 'server.sudorouter-api-token' ? 'nexus-router-token' : undefined,
    }), {
      baseUrl: 'https://router.policy', apiToken: 'nexus-router-token',
      adminUserId: '13', timeoutMs: 11_000, initialQuota: 50_000_000,
      modelServiceUrl: 'https://router.policy/v1',
      modelsApiUrl: 'https://router.policy/api/specific_pricing',
    })
  })

  test('非敏感参数来自统一策略且敏感值来自 Nexus', () => {
    const secrets = new Map([
      ['server.fuiou-merchant-private-key', 'nexus-private'],
      ['server.fuiou-public-key', 'nexus-public'],
      ['server.sudorouter-api-token', 'nexus-router-token'],
    ])
    assert.deepEqual(resolveBillingRuntimeConfig({
      infrastructure,
      environment: {},
      getSecret: key => secrets.get(key),
      readFile: () => { throw new Error('unexpected file read') },
    }), {
      enabled: true,
      testMode: false,
      merchantCode: 'POLICY-MERCHANT',
      merchantPrivateKey: 'nexus-private',
      fuiouPublicKey: 'nexus-public',
      baseUrl: 'https://pay.policy',
      refundUrl: 'https://refund.policy',
      timeoutMs: 10_000,
      sudorouterBaseUrl: 'https://router.policy',
      sudorouterApiToken: 'nexus-router-token',
      sudorouterAdminUserId: '13',
      sudorouterTimeoutMs: 11_000,
    })
  })

  test('旧环境变量和密钥文件保持最高优先级', () => {
    const resolved = resolveBillingRuntimeConfig({
      infrastructure,
      environment: {
        SUDOWORK_BILLING_ENABLED: 'true', FUIOU_TEST_MODE: 'true',
        FUIOU_MERCHANT_CODE: 'ENV-MERCHANT', FUIOU_MERCHANT_PRIVATE_KEY_FILE: '/private.pem',
        FUIOU_PUBLIC_KEY_BASE64: Buffer.from('env-public').toString('base64'),
        FUIOU_TEST_API_URL: 'https://pay.env', FUIOU_TEST_REFUND_URL: 'https://refund.env',
        FUIOU_TIMEOUT_MS: '12000', SUDOROUTER_BASE_URL: 'https://router.env',
        SUDOROUTER_API_TOKEN: 'env-token', SUDOROUTER_ADMIN_USER_ID: '99',
        SUDOROUTER_TIMEOUT_MS: '13000',
      },
      getSecret: () => 'nexus-value',
      readFile: path => path === '/private.pem' ? 'env-private-file' : '',
    })
    assert.equal(resolved?.merchantCode, 'ENV-MERCHANT')
    assert.equal(resolved?.merchantPrivateKey, 'env-private-file')
    assert.equal(resolved?.fuiouPublicKey, 'env-public')
    assert.equal(resolved?.baseUrl, 'https://pay.env')
    assert.equal(resolved?.sudorouterApiToken, 'env-token')
  })

  test('启用时缺少必要配置会阻止启动，关闭时不要求凭据', () => {
    assert.equal(resolveBillingRuntimeConfig({
      infrastructure: { ...infrastructure, enabled: false },
      environment: {}, getSecret: () => undefined, readFile: () => '',
    }), null)
    assert.throws(() => resolveBillingRuntimeConfig({
      infrastructure,
      environment: {}, getSecret: () => undefined, readFile: () => '',
    }), /FUIOU_MERCHANT_PRIVATE_KEY/)
  })
})
