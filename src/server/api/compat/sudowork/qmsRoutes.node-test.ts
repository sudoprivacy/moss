import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createSudoworkQmsRoutes, type QmsLegacyOperationPort } from './qmsRoutes.js'
import { QmsAuthorizationService } from '../../../qms/qmsAuthorization.js'
import { TelemetryServiceError } from '../../../qms/telemetryService.js'

class RecordingOperations implements QmsLegacyOperationPort {
  calls: Array<{ key: string; body: unknown; tenantId: string | null }> = []
  async execute(input: Parameters<QmsLegacyOperationPort['execute']>[0]) {
    this.calls.push({ key: input.key, body: input.body, tenantId: input.scope?.tenantId ?? null })
    return { status: 200, body: { success: true, data: { key: input.key } } }
  }
}

function setup() {
  const operations = new RecordingOperations()
  const app = createSudoworkQmsRoutes({
    apiKeyHeader: 'X-API-Key',
    authorization: new QmsAuthorizationService({
      apiKey: 'secret',
      organizations: { getCode: id => id === 'org-a' ? 'tenant-a' : null, hasCode: code => code === 'tenant-a' },
    }),
    getActor: header => header === 'admin'
      ? { userId: 'u1', orgId: 'org-a', role: 'admin' }
      : header === 'root'
        ? { userId: 'root', orgId: 'root', role: 'super_admin' }
        : null,
    encryption: { encryptionRequired: false },
    operations,
  })
  return { app, operations }
}

describe('Sudowork QMS compatibility routes', () => {
  it('registers all 72 frozen QMS routes including both crash prefixes', () => {
    const { app } = setup()
    assert.equal(app.routes.length, 72)
    assert.equal(app.routes.some(route => route.path === '/api/v1/crash/events'), true)
    assert.equal(app.routes.some(route => route.path === '/api/v1/qms/crash/events'), true)
  })

  it('keeps API key ingestion and old success envelope', async () => {
    const { app, operations } = setup()
    const response = await app.request('/api/v1/telemetry/perf', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': 'secret' },
      body: JSON.stringify({ tenant_id: 'tenant-a', metric: 'startup' }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { success: true, data: { key: 'POST /api/v1/telemetry/perf' } })
    assert.equal(operations.calls[0]?.tenantId, null)
  })

  it('requires the actual legacy JWT boundary for system health and scopes enterprise admins', async () => {
    const { app, operations } = setup()
    assert.equal((await app.request('/api/v1/qms/system/health')).status, 401)

    const response = await app.request('/api/v1/qms/dashboard/overview?tenant_id=tenant-b', {
      headers: { Authorization: 'Bearer admin' },
    })
    assert.equal(response.status, 200)
    assert.equal(operations.calls.at(-1)?.tenantId, 'tenant-a')
  })

  it('keeps legacy telemetry validation and queue failure envelopes', async () => {
    const { app, operations } = setup()
    operations.execute = async () => {
      throw new TelemetryServiceError(400, 'TENANT_ID_REQUIRED', 'tenant_id is required for QMS telemetry ingestion', ['perf'])
    }
    const validation = await app.request('/api/v1/telemetry/perf', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': 'secret' }, body: '{}',
    })
    assert.equal(validation.status, 400)
    assert.deepEqual(await validation.json(), {
      success: false,
      error: { code: 'TENANT_ID_REQUIRED', message: 'tenant_id is required for QMS telemetry ingestion', items: ['perf'] },
    })

    operations.execute = async () => { throw new Error('redis password must never escape') }
    const queue = await app.request('/api/v1/telemetry/install', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': 'secret' }, body: '{}',
    })
    assert.equal(queue.status, 500)
    assert.deepEqual(await queue.json(), {
      success: false,
      error: { code: 'QUEUE_ERROR', message: 'Failed to queue install event' },
    })
  })
})
