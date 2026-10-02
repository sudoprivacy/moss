import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { openStoreAsync } from '../db.js'
import type { ServerConfig } from '../types.js'
import { MossQmsStore } from './mossQmsStore.js'
import { PgDriver, type PgPoolLike } from '../db/driver.js'

const postgresUrl = process.env.QMS_TEST_DATABASE_URL

void describe('QMS client cutover with real storage', () => {
  void it('restores shared PostgreSQL session settings after repeated QMS schema initialization', { skip: !postgresUrl, timeout: 30000 }, async () => {
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString: postgresUrl, max: 1 })
    const driver = new PgDriver(pool as unknown as PgPoolLike)
    try {
      await driver.exec("SET lock_timeout = '20s'; SET statement_timeout = '30s'")
      const snapshot = () => driver.get("SELECT pg_backend_pid() AS connection_id, current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout, current_setting('search_path') AS search_path")
      const before = await snapshot()
      await new MossQmsStore(driver).start()
      await new MossQmsStore(driver).start()
      assert.deepEqual(await snapshot(), before)
      assert.equal((await driver.get('SELECT 1 AS alive'))?.alive, 1)
    } finally { await driver.close() }
  })

  void it('ingests desktop payloads on the Moss host and serves every quality screen with tenant isolation', { skip: !postgresUrl, timeout: 60000 }, async () => {
    const { createServer } = await import('node:http')
    const { setTimeout: delay } = await import('node:timers/promises')
    const { startQmsRuntime } = await import('./qmsRuntime.js')
    const { resolveQmsConfig } = await import('./config.js')
    const { createSudoworkQmsRoutes } = await import('../api/compat/sudowork/qmsRoutes.js')
    const { createHostDispatch } = await import('../api/compat/sudowork/hostDispatch.js')
    const tenant = `qms-e2e-${randomUUID()}`
    const moss = await openStoreAsync({ dbBackend: 'postgres', databaseUrl: postgresUrl } as ServerConfig)
    const store = new MossQmsStore(moss.driver)
    await store.start()
    const runtime = await startQmsRuntime({
      config: resolveQmsConfig({ enabled: true, queueFlushIntervalMs: 100 }, {
        QMS_API_KEY: 'cutover-test-key',
      }),
      ownerId: tenant,
      driver: moss.driver,
      organizations: { getCode: async () => tenant, hasCode: async code => code === tenant || code === `${tenant}-other` },
      secrets: { get: () => undefined, put: async () => {} },
    })
    assert(runtime)
    const app = createSudoworkQmsRoutes({ ...runtime, getActor: token => token === 'admin'
      ? { userId: 'test-admin', orgId: 'test-org', role: 'super_admin', organizationScoped: true }
      : token === 'viewer' ? { userId: 'test-viewer', orgId: 'test-org', role: 'admin' } : null })
    const server = createServer(createHostDispatch({ mossOperationsFetch: app.fetch, mossHandler: (_req, res) => { res.writeHead(404); res.end() } }))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    async function call(path: string, body?: unknown, token = 'admin', method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'X-API-Key': 'cutover-test-key', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      const result = await response.json() as any
      assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(result)}`)
      assert.notEqual(result.success, false, `${method} ${path}: ${JSON.stringify(result)}`)
      return result
    }
    const ops = '/api/moss/v1/operations/qms'
    const now = Date.now()
    const common = { timestamp: now, version: '0.2.19', platform: 'darwin', arch: 'arm64', tenant_id: tenant, user_id: 'desktop-user', user_nickname: 'Desktop test', login_mode: 'personal', org_id: 'test-org' }
    const events = [
      { id: `${tenant}-perf`, type: 'perf', ...common, data: { metric: 'startup', value_ms: 100 } },
      { id: `${tenant}-conversation`, type: 'conversation', ...common, data: { session_id: tenant, model_id: 'test-model', status: 'success', duration_ms: 100, tokens_used: 25 } },
      { id: `${tenant}-turn`, type: 'turn', ...common, data: { session_id: tenant, turn_id: tenant, model_id: 'test-model', status: 'success', duration_ms: 100, total_tokens: 25 } },
      { id: `${tenant}-step`, type: 'step', ...common, data: { session_id: tenant, turn_id: tenant, step_id: tenant, step_type: 'tool', status: 'success', duration_ms: 50 } },
      { id: `${tenant}-install`, type: 'install', ...common, data: { install_id: tenant, install_type: 'fresh', status: 'success', duration_ms: 500 } },
    ]
    try {
      await moss.driver.exec('CREATE TABLE IF NOT EXISTS public.system_config (key TEXT PRIMARY KEY, value TEXT)')
      await moss.driver.run('INSERT INTO public.system_config (key,value) VALUES (?,?)', [tenant, 'main-module-value'])
      const beforePath = await moss.driver.get('SHOW search_path')
      assert.equal((await fetch(`${base}/api/v1/telemetry/batch`, { method: 'POST', body: '{}' })).status, 401)
      await call('/api/v1/telemetry/batch', { events })
      await call('/api/v1/telemetry/batch', { events }) // Retried desktop batch must not double count.
      await call('/api/v1/telemetry/batch', { events: events.map(event => ({ ...event, id: `${event.id}-yesterday`, timestamp: now - 86400000, data: { ...event.data, ...(event.type === 'install' ? { install_id: `${tenant}-yesterday` } : {}) } })) })
      await call('/api/v1/telemetry/batch', { events: [{ ...events[1], id: `${tenant}-other`, tenant_id: `${tenant}-other` }] })
      for (let attempt = 0; attempt < 60; attempt++) {
        const count = await store.execute('SELECT COUNT(*) AS count FROM telemetry_conversations WHERE tenant_id = $1', [tenant])
        if (Number(count[0]?.count) === 2) break
        await delay(100)
      }
      const persisted = await store.execute('SELECT COUNT(*) AS count FROM telemetry_conversations WHERE tenant_id = $1', [tenant])
      assert.equal(Number(persisted[0]?.count), 2, 'queue must flush and deduplicate')
      const crash = { ...common, type: 'js_exception', process_type: 'renderer', error_name: 'CutoverError', error_message: tenant, stack_trace: `CutoverError: ${tenant}\n at main.js:1:1`, context: { event_id: `${tenant}-crash` } }
      await call('/api/v1/crash/events/batch', { events: [crash] })
      await call('/api/v1/crash/events/batch', { events: [crash] })
      for (let attempt = 0; attempt < 50; attempt++) {
        const tasks = await call(`${ops}/system/tasks`)
        if (tasks.data.every((task: any) => task.last_run && !task.running)) break
        await delay(100)
      }
      await call(`${ops}/system/aggregation/run`, {})
      await call(`${ops}/system/aggregation/run`, {})
      const dailyTurns = await store.execute('SELECT COUNT(*) AS count FROM telemetry_turns_daily WHERE tenant_id = $1', [tenant])
      assert.equal(Number(dailyTurns[0]?.count), 1, 'nullable model provider must not create duplicate daily rows on PG 14')
      const range = `start_time=${now - 2 * 86400000}&end_time=${now + 10000}`
      const overview = await call(`${ops}/dashboard/overview?${range}&tenant_id=${tenant}-other`, undefined, 'viewer')
      assert.equal(overview.data.conversations.total, 2)
      assert.equal(overview.data.crashes.total, 1)
      for (const route of [
        'dashboard/perf/trend', 'dashboard/perf/dimensions', 'dashboard/conversations/trend',
        'dashboard/conversations/dimensions', 'dashboard/conversations/errors/trend',
        'dashboard/installs/trend', 'dashboard/installs/dimensions',
        'user-stats/conversations', 'user-stats/turns', 'user-stats/steps',
        'user-stats/realtime', 'user-stats/users/desktop-user',
        'user-stats/leaderboard/conversations', 'user-stats/leaderboard/turns', 'user-stats/leaderboard/steps', 'user-stats/leaderboard/tokens',
        'crash/stats/summary', 'crash/stats/trend', 'crash/stats/distribution', 'crash/events',
        'system/health', 'system/stats', 'system/config', 'system/notifications', 'system/tasks',
        'system/raw-stats', 'system/aggregation-info', 'system/error-codes', 'alerts/history',
      ]) await call(`${ops}/${route}?${range}`)
      const tables = await moss.driver.all<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'moss_qms' OR table_name LIKE 'moss_qms_%'")
      assert.equal(tables.some(row => /inbox|ingest_batches|migration_checkpoints/.test(row.table_name)), false)
      const configRows = await call(`${ops}/system/config`)
      assert.equal(configRows.data.some((row: any) => row.key === tenant), false)
      assert.equal((await moss.driver.get('SELECT value FROM public.system_config WHERE key = ?', [tenant]))?.value, 'main-module-value')
      assert.deepEqual(await moss.driver.get('SHOW search_path'), beforePath)
      const users = await call(`${ops}/user-stats/conversations?${range}`)
      assert.equal(users.data[0]?.conversation_count, 2)
      const perf = await call(`${ops}/dashboard/perf/trend?${range}`)
      assert.equal(perf.data.reduce((sum: number, row: any) => sum + row.count, 0), 2)
      const installs = await call(`${ops}/dashboard/installs/trend?${range}`)
      assert.equal(installs.data.reduce((sum: number, row: any) => sum + row.total_count, 0), 2)
      const issues = await call(`${ops}/crash/issues`)
      const issueId = issues.data[0].id
      const issue = await call(`${ops}/crash/issues/${issueId}`)
      assert.equal(issue.events.length, 1)
      await call(`${ops}/crash/events/${issue.events[0].id}`)
      await call(`${ops}/crash/issues/${issueId}/resolve`, {})
      await call(`${ops}/crash/issues/${issueId}`, { status: 'unresolved', assigned_to: 'test-admin' }, 'admin', 'PUT')
      const config = await call(`${ops}/alerts/configs`, { name: tenant, type: 'conversation', metric: 'error_rate', comparison: 'gt', threshold: 10, level: 'warning', channels: [], enabled: false })
      await call(`${ops}/alerts/configs/${config.data.id}`, { threshold: 20, id: 'must-not-change', tenant_id: 'must-not-change' }, 'admin', 'PUT')
      const updated = await call(`${ops}/alerts/configs/${config.data.id}`)
      assert.equal(updated.data.id, config.data.id)
      assert.equal(updated.data.tenant_id, tenant)
      await call(`${ops}/alerts/configs/${config.data.id}`, undefined, 'admin', 'DELETE')
      assert.equal((await fetch(`${base}${ops}/system/config`, { headers: { Authorization: 'Bearer viewer' } })).status, 403)
      assert.equal((await fetch(`${base}/api/v1/auth/login`, { method: 'POST' })).status, 404)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await runtime.stop()
      assert.equal((await moss.driver.get('SELECT 1 AS alive'))?.alive, 1)
      await moss.driver.run('DELETE FROM public.system_config WHERE key = ?', [tenant])
      for (const table of ['telemetry_perf_raw', 'telemetry_conversations', 'telemetry_turns', 'telemetry_steps', 'telemetry_install', 'crash_events', 'crash_issues', 'qms_ingest_receipts', 'telemetry_perf_daily', 'telemetry_conversations_daily', 'telemetry_conversation_errors_daily', 'telemetry_install_daily', 'telemetry_turns_daily', 'telemetry_steps_daily', 'crash_daily_stats', 'telemetry_user_conversations_daily', 'telemetry_user_turns_daily', 'telemetry_user_steps_daily', 'alert_config', 'audit_logs']) {
        await store.execute(`DELETE FROM ${table} WHERE tenant_id IN ($1, $2)`, [tenant, `${tenant}-other`])
      }
      await moss.close()
    }
  })
})
