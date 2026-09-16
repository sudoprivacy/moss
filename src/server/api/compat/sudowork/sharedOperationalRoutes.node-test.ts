import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MOSS_OPERATIONS_LEGACY_ROUTES,
  mapMossOperationsPath,
} from './sharedOperationalRoutes.js'

test('Moss 运营命名空间覆盖全部内部旧协议投影', () => {
  const keys = new Set(MOSS_OPERATIONS_LEGACY_ROUTES.map(route => `${route.method} ${route.path}`))
  for (const key of [
    'POST /api/v1/admin/approve',
    'POST /api/v1/admin/reject',
    'POST /api/v1/admin/delete',
    'GET /api/v1/admin/users',
    'GET /api/v1/admin/users/:id/ledger',
    'POST /api/v1/admin/users/:id/points',
    'POST /api/v1/admin/users/:id/recharge',
    'POST /api/v1/admin/users/:id/sync-quota',
    'GET /api/v1/admin/system-config',
    'PUT /api/v1/admin/system-config',
    'GET /api/v1/admin/datasets',
    'POST /api/v1/admin/datasets',
    'GET /api/v1/admin/datasets/:datasetId/documents',
    'POST /api/v1/admin/datasets/:datasetId/retrieve',
  ]) assert(keys.has(key), `missing shared route: ${key}`)

  assert.equal(keys.has('GET /api/v1/users'), false)
  assert.equal(keys.has('POST /api/v1/users'), false)
})

test('Moss 原生运营命名空间映射到内部旧协议投影且不接受近似路径', () => {
  assert.equal(
    mapMossOperationsPath('/api/moss/v1/operations/stats'),
    '/api/v1/admin/stats',
  )
  assert.equal(
    mapMossOperationsPath('/api/moss/v1/operations/users/17/ledger'),
    '/api/v1/admin/users/17/ledger',
  )
  assert.equal(
    mapMossOperationsPath('/api/moss/v1/operations/qms/system/health'),
    '/api/v1/qms/system/health',
  )
  assert.equal(mapMossOperationsPath('/api/moss/v10/operations/stats'), null)
  assert.equal(mapMossOperationsPath('/api/v1/admin/stats'), null)
})
