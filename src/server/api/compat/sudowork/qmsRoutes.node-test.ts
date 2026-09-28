import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createSudoworkQmsRoutes, type QmsLegacyOperationPort } from './qmsRoutes.js'
import { QmsAuthorizationService } from '../../../qms/qmsAuthorization.js'
import { TelemetryServiceError } from '../../../qms/telemetryService.js'
import { createDeferredQmsRoutes } from '../../../qms/qmsBootstrap.js'
import type { StartedQmsRuntime } from '../../../qms/qmsRuntime.js'

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
      organizations: { async getCode(id) { return id === 'org-a' ? 'tenant-a' : null }, async hasCode(code) { return code === 'tenant-a' } },
    }),
    getActor: header => header === 'admin'
      ? { userId: 'u1', orgId: 'org-a', role: 'admin' }
      : header === 'root'
        ? { userId: 'root', orgId: 'root', role: 'super_admin' }
        : null,
    operations,
  })
  return { app, operations }
}

void describe('Sudowork QMS compatibility routes', () => {
  void it('registers all 72 frozen QMS routes including both crash prefixes', () => {
    const { app } = setup()
    assert.equal(app.routes.length, 72)
    assert.equal(app.routes.some(route => route.path === '/api/v1/crash/events'), true)
    assert.equal(app.routes.some(route => route.path === '/api/v1/qms/crash/events'), true)
  })

  void it('keeps API key ingestion and old success envelope', async () => {
    const { app, operations } = setup()
    const response = await app.request('/api/v1/telemetry/perf', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': 'secret' },
      body: JSON.stringify({ tenant_id: 'tenant-a', metric: 'startup' }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { success: true, data: { key: 'POST /api/v1/telemetry/perf' } })
    assert.equal(operations.calls[0]?.tenantId, null)
  })

  for (const path of ['/api/v1/telemetry/batch', '/api/v1/crash/events/batch', '/api/v1/qms/crash/events/batch']) {
    void it(`accepts JSON and still enforces the API key on ${path}`, async () => {
      const { app, operations } = setup()
      const payload = { events: [{ type: 'perf', data: { metric: 'cold_start', value_ms: 100 } }] }
      for (const apiKey of [undefined, 'incorrect']) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (apiKey) headers['X-API-Key'] = apiKey
        const response = await app.request(path, { method: 'POST', headers, body: JSON.stringify(payload) })
        assert.equal(response.status, 401)
      }
      assert.equal(operations.calls.length, 0)
      const response = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'secret' }, body: JSON.stringify(payload) })
      assert.equal(response.status, 200)
      assert.deepEqual(operations.calls.at(-1)?.body, payload)
    })

    void it(`rejects retired encrypted envelopes on ${path} without attempting decryption`, async () => {
      const { app, operations } = setup()
      const response = await app.request(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'secret' },
        body: JSON.stringify({ algorithm: 'hybrid-v1', encrypted_key: 'unused', encrypted_data: 'unused', nonce: 'unused', tag: 'unused' }),
      })
      assert.equal(response.status, 400)
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'INVALID_PAYLOAD')
      assert.equal(operations.calls.length, 0)
    })
  }

  void it('requires the actual legacy JWT boundary for system health and scopes enterprise admins', async () => {
    const { app, operations } = setup()
    assert.equal((await app.request('/api/v1/qms/system/health')).status, 401)

    const response = await app.request('/api/v1/qms/dashboard/overview?tenant_id=tenant-b', {
      headers: { Authorization: 'Bearer admin' },
    })
    assert.equal(response.status, 200)
    assert.equal(operations.calls.at(-1)?.tenantId, 'tenant-a')
  })

  void it('keeps legacy telemetry validation and queue failure envelopes', async () => {
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

void it('returns retryable 503 when the bounded memory queue cannot accept a batch', async () => {
  const { app, operations } = setup()
  operations.execute = async () => { throw new TelemetryServiceError(503, 'QUEUE_FULL', 'QMS memory queue is full; retry later') }
  const response = await app.request('/api/v1/telemetry/batch', {
    method: 'POST', headers: { 'X-API-Key': 'secret', 'Content-Type': 'application/json' }, body: '{}',
  })
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Retry-After'), '3')
  assert.equal((await response.json() as any).error.code, 'QUEUE_FULL')
})

void it('serves ordinary routes immediately and activates QMS routes after background initialization', async () => {
  let runtime: StartedQmsRuntime | undefined
  const operations = new RecordingOperations()
  const app = createSudoworkQmsRoutes({
    ...createDeferredQmsRoutes(() => runtime, 'X-API-Key'),
    getActor: () => ({ userId: 'admin', orgId: 'org-a', role: 'admin' }),
  })
  app.get('/ordinary-health', context => context.json({ ok: true }))
  assert.equal((await app.request('/ordinary-health')).status, 200)
  const request = { method: 'POST', headers: { 'X-API-Key': 'secret', 'Content-Type': 'application/json' }, body: '{"events":[]}' }
  const waiting = await app.request('/api/v1/telemetry/batch', request)
  assert.equal(waiting.status, 503)
  assert.equal(waiting.headers.get('Retry-After'), '3')
  assert.equal(operations.calls.length, 0)
  runtime = {
    apiKeyHeader: 'X-API-Key', operations,
    authorization: new QmsAuthorizationService({ apiKey: 'secret', organizations: { getCode: async () => 'tenant-a', hasCode: async () => true } }),
    stop: async () => {},
  } as unknown as StartedQmsRuntime
  assert.equal((await app.request('/api/v1/telemetry/batch', request)).status, 200)
  assert.equal(operations.calls.length, 1)
  assert.equal((await app.request('/api/v1/qms/system/health')).status, 200)
  assert.equal((await app.request('/api/v1/telemetry/batch', { ...request, headers: { 'X-API-Key': 'invalid' } })).status, 401)
  assert.equal((await app.request('/ordinary-health')).status, 200)
})
