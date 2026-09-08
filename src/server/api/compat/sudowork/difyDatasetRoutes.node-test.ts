import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { describe, test } from 'node:test'
import type { IdentityActor } from '../../../identity/organizationIdentityService.js'
import { registerSudoworkDifyDatasetRoutes } from './difyDatasetRoutes.js'

function setup(actor: IdentityActor | null = { userId: 'admin-a', orgId: 'org-a', role: 'admin' }) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const dataset = new Proxy({}, {
    get(_target, method: string) {
      return async (...args: unknown[]) => {
        calls.push({ method, args })
        return method.startsWith('delete') ? null : { provider: method }
      }
    },
  })
  const app = new Hono()
  registerSudoworkDifyDatasetRoutes(app, {
    dataset: dataset as never,
    getActor: () => actor,
    resolveEnterpriseAlias(legacyId) {
      return legacyId === 9 ? { resourceId: 'org-a', orgId: 'org-a' } : null
    },
    idempotencyKey: () => 'request-key',
  })
  return { app, calls }
}

describe('Sudowork admin dataset compatibility routes', () => {
  test('registers all nine frozen routes', () => {
    const { app } = setup()
    const routes = app.routes.map(route => `${route.method} ${route.path}`)
    assert.deepEqual(routes, [
      'GET /api/v1/admin/datasets',
      'POST /api/v1/admin/datasets',
      'GET /api/v1/admin/datasets/:datasetId',
      'PATCH /api/v1/admin/datasets/:datasetId',
      'DELETE /api/v1/admin/datasets/:datasetId',
      'GET /api/v1/admin/datasets/:datasetId/documents',
      'POST /api/v1/admin/datasets/:datasetId/documents',
      'DELETE /api/v1/admin/datasets/:datasetId/documents/:documentId',
      'POST /api/v1/admin/datasets/:datasetId/retrieve',
    ])
  })

  test('distinguishes unauthenticated users from non-admin users', async () => {
    const unauthorized = setup(null).app
    const forbidden = setup({ userId: 'user-a', orgId: 'org-a', role: 'user' }).app
    const missing = await unauthorized.request('/api/v1/admin/datasets')
    const denied = await forbidden.request('/api/v1/admin/datasets')
    assert.equal(missing.status, 401)
    assert.deepEqual(await missing.json(), { success: false, msg: '未授权，请先登录' })
    assert.equal(denied.status, 403)
    assert.deepEqual(await denied.json(), { success: false, msg: '权限不足' })
  })

  test('preserves enterprise scoping and paging rules', async () => {
    const regular = setup()
    const response = await regular.app.request('/api/v1/admin/datasets?enterprise_id=9&page=0&limit=1000&keyword=文档')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { success: true, data: { provider: 'list' } })
    assert.deepEqual(regular.calls[0], {
      method: 'list', args: ['org-a', { page: 1, limit: 100, keyword: '文档' }],
    })

    const crossOrg = await regular.app.request('/api/v1/admin/datasets?enterprise_id=10')
    assert.equal(crossOrg.status, 403)
    assert.deepEqual(await crossOrg.json(), { success: false, msg: 'cannot operate on another enterprise' })

    const superAdmin = setup({ userId: 'root', orgId: 'system', role: 'super_admin' }).app
    const absent = await superAdmin.request('/api/v1/admin/datasets')
    const unknown = await superAdmin.request('/api/v1/admin/datasets?enterprise_id=10')
    assert.deepEqual([absent.status, await absent.json()], [400, { success: false, msg: 'super admin must specify enterprise_id' }])
    assert.deepEqual([unknown.status, await unknown.json()], [400, { success: false, msg: 'enterprise 10 not found' }])
  })

  test('preserves JSON writes and validation messages', async () => {
    const { app, calls } = setup()
    const missing = await app.request('/api/v1/admin/datasets', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.deepEqual([missing.status, await missing.json()], [400, { success: false, msg: 'name is required' }])

    const created = await app.request('/api/v1/admin/datasets', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-idempotency-key': 'client-key' },
      body: JSON.stringify({ enterprise_id: 9, name: 'Knowledge', indexing_technique: 'economy' }),
    })
    assert.deepEqual(await created.json(), { success: true, data: { provider: 'create' } })
    assert.equal(calls[0]?.method, 'create')
    assert.equal(calls[0]?.args[0], 'org-a')
    assert.deepEqual(calls[0]?.args[1], {
      name: 'Knowledge', description: undefined, indexingTechnique: 'economy', permission: undefined,
    })
    const command = calls[0]?.args[2] as Record<string, unknown>
    assert.deepEqual({
      source: command.source,
      externalEffects: command.externalEffects,
      idempotencyKey: command.idempotencyKey,
    }, assertCommandContext('client-key'))
  })

  test('preserves text and multipart document uploads', async () => {
    const textSetup = setup()
    const textResponse = await textSetup.app.request('/api/v1/admin/datasets/ds%2F1/documents', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enterprise_id: 9, name: 'Guide', text: 'body' }),
    })
    assert.equal(textResponse.status, 200)
    assert.equal(textSetup.calls[0]?.method, 'createDocumentByText')
    assert.equal(textSetup.calls[0]?.args[1], 'ds/1')

    const fileSetup = setup()
    const form = new FormData()
    form.set('enterprise_id', '9')
    form.set('indexing_technique', 'high_quality')
    form.set('file', new File(['bytes'], 'guide.txt', { type: 'text/plain' }))
    const fileResponse = await fileSetup.app.request('/api/v1/admin/datasets/dataset-1/documents', {
      method: 'POST', body: form,
    })
    assert.equal(fileResponse.status, 200)
    assert.equal(fileSetup.calls[0]?.method, 'createDocumentByFile')
    const input = fileSetup.calls[0]?.args[2] as Record<string, unknown>
    assert.deepEqual({ fileName: input.fileName, contentType: input.contentType, indexingTechnique: input.indexingTechnique }, {
      fileName: 'guide.txt', contentType: 'text/plain', indexingTechnique: 'high_quality',
    })
  })
})

function assertCommandContext(idempotencyKey: string): unknown {
  return {
    source: 'online', externalEffects: 'enqueue', idempotencyKey,
  }
}
