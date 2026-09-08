import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { QMS_LEGACY_ROUTES } from '../api/compat/sudowork/qmsRoutes.js'
import { QmsLegacyOperations } from './qmsLegacyOperations.js'

function setup() {
  const calls: string[] = []
  const operations = new QmsLegacyOperations({
    telemetry: {
      ingestBatch: async () => ({ received: { perf: 1, conversations: 0, turns: 0, steps: 0, installs: 0 }, timestamp: 10, queued: true as const }),
      ingestSingle: async (kind: string) => { calls.push(kind); return { timestamp: 11, queued: true as const } },
    },
    queue: { depths: async () => ({ pending: 2, processing: 1 }) },
    crash: {
      ingest: async () => ({ issueId: 7, duplicate: false }), ingestBatch: async (events: unknown[]) => ({ received: events.length }),
      listIssues: async () => ({ items: [{ id: 1 }], total: 1, limit: 50, offset: 0 }),
      getIssue: async () => ({ id: 1, tenant_id: 'tenant-a' }), updateIssue: async () => ({ id: 1 }),
      listEvents: async () => ({ items: [], total: 0, limit: 100, offset: 0 }), getEvent: async () => null,
      summary: async () => ({ total_events: 1 }), trend: async () => [], distribution: async () => [],
    },
    dashboard: {
      overview: async (query: { tenantId?: string | null }) => { calls.push(`overview:${query.tenantId}`); return { period: {} } },
      perfTrend: async () => [], conversationErrorTrend: async () => [], conversationTrend: async () => [],
      installTrend: async () => [], dimensions: async () => ({}),
    },
    userStats: {
      conversations: async () => [], turns: async () => [], steps: async () => [], leaderboard: async () => [],
      userDetail: async () => ({}), realtime: async () => ({}),
    },
    alerts: {
      listConfigs: async () => [], getConfig: async () => null, createConfig: async () => ({}),
      updateConfig: async () => null, deleteConfig: async () => false, history: async () => ({ data: [], total: 0, limit: 50, offset: 0 }),
      acknowledge: async () => ({ status: 'not_found' }), testNotification: async () => ({ success: true }),
      testConfig: async () => null,
    },
    system: {
      health: async () => ({ status: 200, body: { status: 'healthy' } }), aggregationInfo: async () => ({}),
      initializeSchema: async () => ({}), switchToContinuousAggregates: async () => undefined,
      stats: async () => ({}), listConfig: async () => [], getConfig: async () => null,
      updateConfig: async () => null, environment: () => ({}), notificationConfig: () => ({}),
      updateNotifications: async () => undefined, testNotification: async () => ({ success: true }),
      tasks: () => [], runAggregation: async () => ({ results: [], timestamp: 1 }), rawStats: async () => [],
      backfill: async () => undefined, errorCodes: () => [],
    },
    crashTasks: { runTask: async (name: string) => { calls.push(name); return true } },
  } as never)
  return { operations, calls }
}

describe('QmsLegacyOperations', () => {
  it('declares an implementation for all 72 frozen route keys', () => {
    const { operations } = setup()
    const unsupported = QMS_LEGACY_ROUTES
      .map(([method, path]) => `${method} ${path}`)
      .filter(key => !operations.supports(key))
    assert.deepEqual(unsupported, [])
  })

  it('dispatches every frozen route without falling through to the compatibility 404', async () => {
    const { operations } = setup()
    const admin = { userId: 'root', orgId: 'root', tenantId: null, canViewAllTenants: true, qmsRole: 'admin' as const }
    for (const [method, path] of QMS_LEGACY_ROUTES) {
      const body = path.endsWith('/events/batch')
        ? { events: [{ type: 'js_exception', timestamp: 1, version: '1', platform: 'darwin', process_type: 'renderer', tenant_id: 'tenant-a' }] }
        : { type: 'js_exception', timestamp: 1, version: '1', platform: 'darwin', process_type: 'renderer', tenant_id: 'tenant-a', days: 7 }
      const result = await operations.execute({
        key: `${method} ${path}`,
        params: { id: '1', userId: 'u1', type: 'conversations', channel: 'lark' },
        query: {}, body,
        scope: path.includes('/telemetry/') || (method === 'POST' && (path.endsWith('/events') || path.endsWith('/events/batch')))
          ? undefined : admin,
      })
      const error = result.body && typeof result.body === 'object'
        ? (result.body as { error?: { code?: string; message?: string } }).error
        : undefined
      assert.notEqual(error?.message, 'QMS route not found', `${method} ${path}`)
    }
  })

  it('keeps telemetry, dual crash prefixes, and health response envelopes', async () => {
    const { operations } = setup()
    const batch = await operations.execute({ key: 'POST /api/v1/telemetry/batch', params: {}, query: {}, body: {} })
    const crash = await operations.execute({
      key: 'POST /api/v1/qms/crash/events', params: {}, query: {},
      body: { type: 'js_exception', timestamp: 1, version: '1', platform: 'darwin', process_type: 'renderer', tenant_id: 'tenant-a' },
    })
    const health = await operations.execute({
      key: 'GET /api/v1/qms/system/health', params: {}, query: {}, body: undefined,
      scope: { userId: 'u1', orgId: 'o1', tenantId: 'tenant-a', canViewAllTenants: false, qmsRole: 'viewer' },
    })

    assert.deepEqual(batch.body, { success: true, data: { received: { perf: 1, conversations: 0, turns: 0, steps: 0, installs: 0 }, timestamp: 10, queued: true } })
    assert.deepEqual(crash.body, { success: true, received: 1, issue_id: 7 })
    assert.deepEqual(health, { status: 200, body: { status: 'healthy' } })
  })

  it('uses the authorized tenant instead of the requested dashboard tenant', async () => {
    const { operations, calls } = setup()
    await operations.execute({
      key: 'GET /api/v1/qms/dashboard/overview', params: {}, query: { tenant_id: 'tenant-b' }, body: undefined,
      scope: { userId: 'u1', orgId: 'o1', tenantId: 'tenant-a', canViewAllTenants: false, qmsRole: 'viewer' },
    })
    assert.deepEqual(calls, ['overview:tenant-a'])
  })

  it('keeps legacy crash validation and existing-continuous-aggregate errors', async () => {
    const { operations } = setup()
    const missing = await operations.execute({
      key: 'POST /api/v1/crash/events', params: {}, query: {}, body: { tenant_id: 'tenant-a' },
    })
    assert.deepEqual(missing, { status: 400, body: { success: false, error: 'Missing required fields' } })

    ;(operations as unknown as { services: { system: { switchToContinuousAggregates(): Promise<void> } } })
      .services.system.switchToContinuousAggregates = async () => { throw new Error('CONTINUOUS_AGGREGATES_EXIST: perf') }
    const existing = await operations.execute({
      key: 'POST /api/v1/qms/system/switch-to-continuous-aggregates', params: {}, query: {}, body: {},
      scope: { userId: 'root', orgId: 'root', tenantId: null, canViewAllTenants: true, qmsRole: 'admin' },
    })
    assert.equal(existing.status, 400)
    assert.deepEqual(existing.body, {
      success: false,
      error: { code: 'CONTINUOUS_AGGREGATES_EXIST', message: 'Continuous aggregates already exist: perf' },
    })
  })
})
