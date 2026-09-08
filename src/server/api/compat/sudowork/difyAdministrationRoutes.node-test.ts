import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { describe, test } from 'node:test'
import { registerSudoworkDifyAdministrationRoutes } from './difyAdministrationRoutes.js'

function setup(role = 'admin') {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const administration = new Proxy({}, { get(_target, method: string) {
    if (method === 'getBinding') return (...args: unknown[]) => {
      calls.push({ method, args }); return null
    }
    if (method === 'getAgent') return (...args: unknown[]) => {
      calls.push({ method, args }); return { assistantId: 'agent-1' }
    }
    if (method === 'listAcl' || method === 'listDatasets') return (...args: unknown[]) => {
      calls.push({ method, args }); return []
    }
    if (method === 'getEnhancement') return (...args: unknown[]) => {
      calls.push({ method, args }); return { enabled: true, mode: 'agent-chat' }
    }
    return async (...args: unknown[]) => {
      calls.push({ method, args })
      return method.startsWith('delete') ? undefined : { method }
    }
  } })
  const app = new Hono()
  registerSudoworkDifyAdministrationRoutes(app, {
    administration: administration as never,
    getActor: () => ({ userId: 'admin-a', orgId: 'org-a', role }),
    resolveEnterpriseAlias: id => id === 9 ? { resourceId: 'org-a', orgId: 'org-a' } : null,
    idempotencyKey: () => 'request-key',
  })
  return { app, calls }
}

describe('Sudowork Dify administration compatibility routes', () => {
  test('registers all 18 frozen administration routes', () => {
    const { app } = setup()
    assert.deepEqual(app.routes.map(route => `${route.method} ${route.path}`), [
      'GET /api/v1/admin/dify/sso',
      'GET /api/v1/admin/dify/binding',
      'POST /api/v1/admin/dify/binding/provision',
      'GET /api/v1/admin/dify/agents',
      'POST /api/v1/admin/dify/agents',
      'GET /api/v1/admin/dify/agents/:assistantId',
      'DELETE /api/v1/admin/dify/agents/:assistantId',
      'PUT /api/v1/admin/dify/agents/:assistantId/acl',
      'GET /api/v1/admin/dify/enterprise-assistants',
      'GET /api/v1/admin/dify/shareable-tenants',
      'GET /api/v1/admin/dify/datasets',
      'POST /api/v1/admin/dify/enterprise-assistants',
      'GET /api/v1/admin/dify/enterprise-assistants/:assistantId',
      'PUT /api/v1/admin/dify/enterprise-assistants/:assistantId',
      'PUT /api/v1/admin/dify/enterprise-assistants/:assistantId/enhancement',
      'GET /api/v1/admin/dify/enterprise-assistants/:assistantId/enhancement',
      'GET /api/v1/admin/dify/agents/:assistantId/datasets',
      'PUT /api/v1/admin/dify/agents/:assistantId/datasets',
    ])
  })

  test('keeps agent create, detail, acl and dataset envelopes', async () => {
    const { app, calls } = setup()
    const created = await app.request('/api/v1/admin/dify/agents', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enterprise_id: 9, name: 'Agent', assistant_id: 'agent-1', mode: 'workflow' }),
    })
    assert.equal(created.status, 200)
    assert.deepEqual(await created.json(), { success: true, data: { method: 'createAgent' } })
    assert.equal(calls[0]?.method, 'createAgent')

    const detail = await app.request('/api/v1/admin/dify/agents/agent-1?enterprise_id=9')
    assert.deepEqual(await detail.json(), {
      success: true, data: { assistantId: 'agent-1', acl: [], datasets: [] },
    })

    const invalidAcl = await app.request('/api/v1/admin/dify/agents/agent-1/acl', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enterprise_id: 9 }),
    })
    assert.deepEqual([invalidAcl.status, await invalidAcl.json()], [400, { success: false, msg: 'entries is required' }])

    const invalidDatasets = await app.request('/api/v1/admin/dify/agents/agent-1/datasets', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enterprise_id: 9 }),
    })
    assert.deepEqual([invalidDatasets.status, await invalidDatasets.json()], [400, { success: false, msg: 'dataset_ids is required' }])
  })

  test('keeps multipart validation and immutable enhancement method', async () => {
    const { app } = setup()
    const invalidForm = new FormData()
    invalidForm.set('enterprise_id', '9')
    const invalid = await app.request('/api/v1/admin/dify/enterprise-assistants', { method: 'POST', body: invalidForm })
    assert.deepEqual([invalid.status, await invalid.json()], [400, { success: false, msg: 'name and profession are required' }])

    const enhancement = await app.request('/api/v1/admin/dify/enterprise-assistants/agent-1/enhancement', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enterprise_id: 9, enable: false }),
    })
    assert.deepEqual([enhancement.status, await enhancement.json()], [400, {
      success: false, msg: 'enhancement method cannot be changed after creation',
    }])
  })
})
