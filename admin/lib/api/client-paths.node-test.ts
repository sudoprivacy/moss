import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  apiErrorMessage,
  toMossAdminApiPath,
  toMossOperationsApiPath,
} from './api-paths.js'

test('Moss Admin 客户端统一使用独立原生 API 命名空间', () => {
  assert.equal(toMossAdminApiPath('/api/v1/auth/token'), '/api/moss/v1/auth/token')
  assert.equal(toMossAdminApiPath('/api/v1/users'), '/api/moss/v1/users')
  assert.equal(toMossAdminApiPath('/api/moss/v1/users'), '/api/moss/v1/users')
  assert.equal(toMossAdminApiPath('/uploads/icon.png'), '/uploads/icon.png')
})

test('运营路径隐藏旧 admin 与 qms 协议命名', () => {
  assert.equal(
    toMossOperationsApiPath('/api/v1/admin/recharge/stats'),
    '/api/moss/v1/operations/recharge/stats',
  )
  assert.equal(
    toMossOperationsApiPath('/api/v1/qms/system/health'),
    '/api/moss/v1/operations/qms/system/health',
  )
  assert.throws(() => toMossOperationsApiPath('/api/v1/auth/token'), /Unsupported operations path/)
})
test('Admin 同时显示 Moss 和旧兼容接口的错误文案', () => {
  assert.equal(apiErrorMessage({ msg: 'QMS 未配置' }, 'Request failed'), 'QMS 未配置')
  assert.equal(apiErrorMessage({ error: { message: '权限不足' } }, 'Request failed'), '权限不足')
  assert.equal(apiErrorMessage({}, 'Request failed'), 'Request failed')
})
