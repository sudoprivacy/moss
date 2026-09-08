import { describe, expect, it } from 'bun:test'
import {
  extractBillingContract,
  isBillingRoute,
  type BillingRouteSource,
} from './extract-sudowork-billing-api.js'

const routes: BillingRouteSource[] = [
  { method: 'GET', path: '/api/v1/recharge/packages', source_file: 'src/routes/recharge.ts', source_line: 14 },
  { method: 'POST', path: '/api/v1/recharge/callback', source_file: 'src/routes/recharge.ts', source_line: 98 },
  { method: 'POST', path: '/api/v1/admin/users/:id/sync-quota', source_file: 'src/routes/admin/points.ts', source_line: 291 },
  { method: 'GET', path: '/api/v1/users', source_file: 'src/routes/users.ts', source_line: 10 },
]

describe('Sudowork Billing 契约提取', () => {
  it('识别充值、授信、管理员积分与额度同步路由', () => {
    expect(routes.filter(isBillingRoute).map(route => route.path)).toEqual([
      '/api/v1/recharge/packages',
      '/api/v1/recharge/callback',
      '/api/v1/admin/users/:id/sync-quota',
    ])
  })

  it('为每条路由冻结认证、请求字段、响应外层和副作用', () => {
    const contract = extractBillingContract(routes)
    const byPath = Object.fromEntries(contract.routes.map(route => [route.path, route]))

    expect(byPath['/api/v1/recharge/packages']).toEqual(
      expect.objectContaining({
        method: 'GET', path: '/api/v1/recharge/packages', authentication: 'public',
        query_parameters: [], body_fields: [], success_envelope: ['success', 'data'], side_effects: [],
      }),
    )
    expect(byPath['/api/v1/recharge/callback']).toEqual(
      expect.objectContaining({
        method: 'POST', path: '/api/v1/recharge/callback', authentication: 'fuiou_callback',
        body_fields: ['mchnt_cd', 'message', 'resp_code', 'resp_desc'],
        success_envelope: [], success_content_type: 'text/plain', success_body: 'success',
        side_effects: ['fuiou_verify', 'wallet_credit', 'sudorouter_quota'],
      }),
    )
    expect(byPath['/api/v1/admin/users/:id/sync-quota']).toEqual(
      expect.objectContaining({
        method: 'POST', path: '/api/v1/admin/users/:id/sync-quota', authentication: 'admin',
        success_envelope: ['success', 'msg', 'data'], side_effects: ['sudorouter_query', 'quota_snapshot'],
      }),
    )
  })

  it('拒绝出现没有显式契约定义的新 Billing 路由', () => {
    expect(() => extractBillingContract([
      ...routes,
      { method: 'POST', path: '/api/v1/recharge/new-action', source_file: 'src/routes/recharge.ts', source_line: 999 },
    ])).toThrow('Missing billing contract definition: POST /api/v1/recharge/new-action')
  })
})
