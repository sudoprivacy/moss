import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MOSS_SHARED_SUDOWORK_ROUTES } from './sharedOperationalRoutes.js'

test('Moss Host 共享所有管理端需要且不与原生 API 冲突的旧路由', () => {
  const keys = new Set(MOSS_SHARED_SUDOWORK_ROUTES.map(route => `${route.method} ${route.path}`))
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
