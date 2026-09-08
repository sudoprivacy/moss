import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { createSudoworkCompatibilityApp, type SudoworkIdentityPort } from './app.js'
import type { SudoworkBillingPort } from './billingService.js'
import { BillingDomainError } from '../../../billing/types.js'

const identity: SudoworkIdentityPort = {
  async loginByPassword() { throw new Error('unused') },
  async loginAdminByPassword() { throw new Error('unused') },
  async changePassword() {},
  getActor(token) {
    if (token === 'user-token') return { userId: 'user-1', orgId: 'org-1', role: 'user' }
    if (token === 'admin-token') return { userId: 'admin-1', orgId: 'org-1', role: 'admin' }
    if (token === 'root-token') return { userId: 'root-1', orgId: 'org-1', role: 'super_admin' }
    return null
  },
  updateProfile() { throw new Error('unused') },
  async loginByVerifiedPhone() { throw new Error('unused') },
  async registerByVerifiedPhone() { throw new Error('unused') },
  async registerByPassword() { throw new Error('unused') },
  async refresh() { throw new Error('unused') },
  getProfile() { return null },
  async logout() {},
}

function createBilling(overrides: Partial<SudoworkBillingPort> = {}): SudoworkBillingPort {
  const defaults = new Proxy({ ...overrides } as Record<PropertyKey, unknown>, {
    get: (target, property) => property in target ? target[property] : () => {
      throw new Error(`未实现测试方法: ${String(property)}`)
    },
  }) as SudoworkBillingPort
  return defaults
}

function routeKeys(): string[] {
  return billingContract().routes.map(route => `${route.method} ${route.path}`).sort()
}

function billingContract(): { routes: Array<{
  method: string
  path: string
  authentication: string
  success_envelope: string[]
}> } {
  return JSON.parse(readFileSync(
    new URL('../../../../../contracts/sudowork/billing-api.json', import.meta.url),
    'utf8',
  ))
}

describe('Sudowork Billing 兼容路由', () => {
  test('完整注册冻结契约中的 28 条路由', () => {
    const app = createSudoworkCompatibilityApp({ identity, billing: createBilling() })
    const actual = app.routes.map(route => `${route.method} ${route.path}`)
    for (const route of routeKeys()) assert(actual.includes(route), `缺少路由 ${route}`)
    assert.equal(routeKeys().length, 28)
  })

  test('套餐公开访问，用户和管理员接口保持各自鉴权', async () => {
    const app = createSudoworkCompatibilityApp({
      identity,
      billing: createBilling({ listPackages: () => [{ id: 'pkg-5', amount: 5 }] }),
    })
    const packages = await app.request('/api/v1/recharge/packages')
    assert.deepEqual(await packages.json(), {
      success: true, data: [{ id: 'pkg-5', amount: 5 }],
    })

    const user = await app.request('/api/v1/recharge/list')
    assert.equal(user.status, 401)
    assert.deepEqual(await user.json(), { success: false, msg: '未授权' })

    const admin = await app.request('/api/v1/admin/recharge/stats', {
      headers: { authorization: 'Bearer user-token' },
    })
    assert.equal(admin.status, 401)
    assert.deepEqual(await admin.json(), { success: false, msg: '未授权' })
  })

  test('富友回调无需用户 JWT，并保持 success/fail 纯文本协议', async () => {
    let received: Record<string, unknown> | undefined
    const app = createSudoworkCompatibilityApp({
      identity,
      billing: createBilling({
        async handlePaymentCallback(payload) { received = payload },
      }),
    })
    const response = await app.request('/api/v1/recharge/callback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mchnt_cd: 'merchant', message: 'cipher', resp_code: '0000' }),
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'success')
    assert.deepEqual(received, { mchnt_cd: 'merchant', message: 'cipher', resp_code: '0000' })
  })

  test('逐条请求 28 条路由并保持冻结的成功响应外层', async () => {
    const marker = { marker: true }
    const billing = new Proxy({} as SudoworkBillingPort, {
      get: (_target, property) => {
        if (property === 'listPackages') return () => [marker]
        if (property === 'handlePaymentCallback') return async () => undefined
        if (property === 'cancelOrder' || property === 'retryOrder' || property === 'rejectCreditApplication') {
          return () => undefined
        }
        return () => marker
      },
    })
    const app = createSudoworkCompatibilityApp({ identity, billing })
    for (const route of billingContract().routes) {
      const path = route.path.replace(':orderNo', 'ORDER-1').replace(':id', '17')
      const bodyByPath: Record<string, Record<string, unknown>> = {
        '/api/v1/recharge/create': { amount: 5, payment_method: 'ALIPAY' },
        '/api/v1/recharge/pay': { order_no: 'ORDER-1' },
        '/api/v1/admin/users/:id/points': { amount: 10, operation: 'add' },
        '/api/v1/admin/users/:id/recharge': { points: 10 },
        '/api/v1/credit-applications/': { requested_points: 10, reason: '测试' },
        '/api/v1/admin/credit-applications/:id/reject': { admin_comment: '拒绝' },
        '/api/v1/admin/recharge/orders/:orderNo/refund': { reason: '退款' },
        '/api/v1/recharge/callback': { mchnt_cd: 'merchant', message: 'cipher', resp_code: '0000' },
      }
      const token = route.path === '/api/v1/admin/users/:id/recharge'
        ? 'root-token'
        : route.authentication === 'admin' ? 'admin-token' : 'user-token'
      const response = await app.request(path, {
        method: route.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(route.method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(route.method === 'POST' ? { body: JSON.stringify(bodyByPath[route.path] ?? {}) } : {}),
      })
      assert.equal(response.status, 200, `${route.method} ${route.path}`)
      if (route.path === '/api/v1/recharge/callback') {
        assert.equal(await response.text(), 'success')
      } else {
        const payload = await response.json() as Record<string, unknown>
        assert.deepEqual(Object.keys(payload).sort(), [...route.success_envelope].sort(), `${route.method} ${route.path}`)
      }
    }
  })

  test('统一 Billing 领域错误映射为旧接口状态码和错误外层', async () => {
    const app = createSudoworkCompatibilityApp({
      identity,
      billing: createBilling({
        createOrder() { throw new BillingDomainError('INVALID_RECHARGE_AMOUNT', '充值金额无效（1-10000美元）') },
      }),
    })
    const response = await app.request('/api/v1/recharge/create', {
      method: 'POST',
      headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 0.5, payment_method: 'ALIPAY' }),
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { success: false, msg: '充值金额无效（1-10000美元）' })
  })
})
