/** Loopback-only fixture for desktop reporter and quality UI integration tests. Use disposable databases. */
import { createServer } from 'node:http'
import { Hono } from 'hono'
import { startQmsRuntime } from '../src/server/qms/qmsRuntime.ts'
import { openStoreAsync } from '../src/server/db.ts'
import type { ServerConfig } from '../src/server/types.ts'
import { resolveQmsConfig } from '../src/server/qms/config.ts'
import { createSudoworkQmsRoutes } from '../src/server/api/compat/sudowork/qmsRoutes.ts'
import { createHostDispatch } from '../src/server/api/compat/sudowork/hostDispatch.ts'
import { sealCredentials } from '../src/server/credentialsEnvelope.ts'
const postgresUrl = process.env.QMS_TEST_DATABASE_URL
if (!postgresUrl) throw new Error('QMS_TEST_DATABASE_URL must point to a disposable Moss PostgreSQL database')
const store = await openStoreAsync({ dbBackend: 'postgres', databaseUrl: postgresUrl } as ServerConfig)
const runtime = await startQmsRuntime({
  config: resolveQmsConfig({ enabled: true, queueFlushIntervalMs: 100 }, { QMS_API_KEY: 'fixture-quality-key' }),
  driver: store.driver,
  ownerId: 'browser-quality-test', organizations: { getCode: async () => 'QUALITY-TEST', hasCode: async code => code === 'QUALITY-TEST' }, secrets: { get: () => undefined, put: async () => {} },
})
if (!runtime) throw new Error('No runtime')
const app = new Hono()
app.route('/', createSudoworkQmsRoutes({ ...runtime, getActor: token => token === 'fixture-token' ? { userId: 'admin', orgId: 'quality-org', role: 'super_admin', organizationScoped: true } : null }))
const common = { timestamp: Date.now(), version: '0.2.19', platform: 'darwin', arch: 'arm64', tenant_id: 'QUALITY-TEST', user_id: 'client-user', user_nickname: '测试用户', login_mode: 'personal' }
await app.request('/api/v1/telemetry/batch', { method: 'POST', headers: { 'X-API-Key': 'fixture-quality-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [
  { ...common, id: 'browser-perf', type: 'perf', data: { metric: 'startup', value_ms: 680 } },
  { ...common, id: 'browser-conv', type: 'conversation', data: { session_id: 'browser-session', model_id: 'test-model', status: 'success', duration_ms: 2400, tokens_used: 1280 } },
  { ...common, id: 'browser-turn', type: 'turn', data: { session_id: 'browser-session', turn_id: 'turn-1', model_id: 'test-model', status: 'success', duration_ms: 2400, total_tokens: 1280 } },
  { ...common, id: 'browser-step', type: 'step', data: { session_id: 'browser-session', turn_id: 'turn-1', step_id: 'step-1', step_type: 'tool', status: 'success', duration_ms: 200 } },
  { ...common, id: 'browser-install', type: 'install', data: { install_id: 'browser-install', install_type: 'fresh', status: 'success', duration_ms: 2100 } },
] }) })
const moss = new Hono()
moss.post('/api/v1/auth/token', c => c.json({ access_token: 'fixture-token', refresh_token: 'fixture-refresh', expires_in: 3600 }))
moss.get('/api/v1/auth/me', c => c.json({ user: { id: 'admin', name: 'admin', displayName: '验证管理员', role: 'super_admin', orgId: 'quality-org' }, organization: { id: 'quality-org', name: '质量管理验证', type: 'enterprise' }, scopes: ['*'] }))
moss.get('/api/v1/organizations', c => c.json({ organizations: [{ id: 'quality-org', name: '质量管理验证', type: 'enterprise' }] }))
moss.get('/api/v1/system-config', c => c.json({ success: true, data: { product_improvement: { enabled: 1, encryption_required: false, baseurl: 'http://127.0.0.1:43139', tenant_id: 'QUALITY-TEST' } } }))
moss.get('/api/v1/system-config/credentials', c => c.json({ success: true, ...sealCredentials({ product_improvement: { api_key: 'fixture-quality-key' } }) }))
const { getRequestListener } = await import('@hono/node-server')
const server = createServer(createHostDispatch({ mossOperationsFetch: app.fetch, mossHandler: getRequestListener(moss.fetch) }))
server.listen(43139, '127.0.0.1', () => console.log('QMS fixture ready on 43139'))
process.on('SIGTERM', async () => { server.closeAllConnections(); server.close(); await runtime.stop(); await store.close(); process.exit(0) })
