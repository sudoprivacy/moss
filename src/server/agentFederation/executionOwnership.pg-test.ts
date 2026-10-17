import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { PgDriver, type PgPoolLike } from '../db/driver.js'
import { applyPgSchema } from '../db/pg_schema.js'
import { forPostgresDirectConnectStore } from '../db.js'
import { CatalogRepository } from '../catalog/catalogRepository.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { ExternalTaskStore } from '../externalProviders/store.js'
import { ExternalProviderService } from '../externalProviders/service.js'
import { AgentRunStore } from './provider/store.js'
import { HttpAgentRuntime, agentManifest, immutableAgent } from './provider/runtime.js'
import { providerServer } from './provider/server.js'
import { TASK_API } from '../../../contracts/task/v1alpha1/contract.js'
import type { ExecutionFence } from './executionOwnership.js'

async function until(check: () => Promise<boolean>, timeout = 10_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await delay(20) }
  assert.fail('Timed out waiting for durable execution state')
}

void test('PostgreSQL Moss takeover preserves the original invocation and Attempt, fences the old owner and does not repeat the model', { skip: !process.env.MOSS_PG_TEST_URL }, async () => {
  const connectionString = process.env.MOSS_PG_TEST_URL!, schema = `moss_takeover_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`)
  const drivers = [0, 1, 2].map(() => new PgDriver(new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 }) as unknown as PgPoolLike))
  const services: ExternalProviderService[] = []
  const router = 'http://127.0.0.1:30123/v1'
  const agent = immutableAgent({ external_agent_id: 'calculator', name: 'Calculator', system_prompt: 'Calculate', router_endpoint: router, model: 'fixture-model', max_output_tokens: 128 }, `sha256:${'a'.repeat(64)}`, [router])
  const providerStore = new AgentRunStore(drivers[2]); await providerStore.ready
  let complete!: () => void, modelCalls = 0
  const barrier = new Promise<void>(resolve => { complete = resolve })
  const provider = new HttpAgentRuntime(providerStore, [agent], async () => { modelCalls++; await barrier; return '42' })
  const token = 'synthetic-integration-token-'.repeat(2)
  const server = providerServer(provider, [{ id: 'integration', token, agentIds: ['calculator'] }])
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); provider.start()
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  try {
    await applyPgSchema(drivers[0])
    const actor = { orgId: 'org-1', userId: 'reviewer' }
    await drivers[0].run('INSERT INTO organizations(id, name, created_at) VALUES (?, ?, ?)', [actor.orgId, 'Synthetic takeover org', Date.now()])
    const keys = new Map<string, string>()
    const secrets = {
      getSecret: async (namespace: string, key: string) => ({ value: keys.get(`${namespace}/${key}`) ?? null, status: 'enabled', version: 1 }),
      putSecret: async (namespace: string, key: string, value: string) => { keys.set(`${namespace}/${key}`, value) },
      deleteSecret: async (namespace: string, key: string) => { keys.delete(`${namespace}/${key}`) },
    }
    for (const driver of drivers.slice(0, 2)) {
      const store = new ExternalTaskStore(driver); await store.ready
      const controller = forPostgresDirectConnectStore(driver)
      const instance = await controller.registerServerInstance('integration-controller')
      const service = new ExternalProviderService(store, { catalog: new CatalogRepository(driver), identities: new IdentityRepository(driver), secrets, isActive: async () => true, policy: { orgIds: [actor.orgId], endpoints: [endpoint], timeoutMs: 60_000 } }, instance.instanceId)
      await service.ownership.ready; await service.releases.ready; services.push(service)
      assert.equal(service.ownership.ownerId, instance.instanceId)
    }
    const first = services[0], second = services[1]
    assert.equal(Number((await drivers[0].get("SELECT COUNT(*) AS total FROM server_instances WHERE status = 'running'"))?.total), 2)
    const binding = await first.administration.onboard(actor, { request_id: randomUUID(), provider_kind: 'custom_http', name: 'HA calculator', endpoint, api_key: token, app_id: 'calculator', workspace_id: 'provider-workspace', source_definition: JSON.stringify(agentManifest(agent)), decoder: 'text', allowed_user_ids: [actor.userId], review_days: 1, review_note: 'Synthetic durable provider verification' })
    await first.review(actor, binding.id, true, binding.revision)
    const task = await first.create(actor, { api_version: TASK_API, kind: 'SubmitTask', agent: { catalog_id: binding.id }, request_source: 'interactive', input: { instruction: '6 * 7', resource_refs: [] }, workspace_refs: [], requested_mode: 'auto', data_classification: 'synthetic', required_capabilities: ['version_pin', 'idempotency'], constraints: { idempotency_key: randomUUID() } })
    await until(async () => modelCalls === 1 && Boolean((await first.store.task(actor, task.id)).provider_refs.run_id))
    const before = await first.store.task(actor, task.id)
    const oldLease = await drivers[0].get('SELECT token, invocation_context FROM external_attempt_leases WHERE attempt_id = ?', [task.attempt_id])
    assert.equal(JSON.parse(String(oldLease?.invocation_context)).provider_session_id, null)
    assert((await first.store.session(actor, task.session_id)).conversation_id, 'A live session now has a remote ID; recovery must still submit the original null input')
    const oldFence: ExecutionFence = { attemptId: task.attempt_id!, ownerId: first.ownership.ownerId, token: String(oldLease?.token) }
    await first.close()
    assert.equal((await drivers[0].get('SELECT status FROM server_instances WHERE instance_id = ?', [first.ownership.ownerId]))?.status, 'running', 'Closing external tasks must not stop the controller')
    await second.maintain()
    await until(async () => (await drivers[1].get('SELECT server_instance_id FROM session_attempts WHERE attempt_id = ?', [task.attempt_id]))?.server_instance_id === second.ownership.ownerId)
    assert.equal(await first.store.mutate(task.id, value => { value.status = 'failed'; return 'status' }, oldFence), null)
    complete()
    await until(async () => (await second.store.task(actor, task.id)).status === 'succeeded')
    const final = await second.store.task(actor, task.id)
    assert.equal(final.answer, '42'); assert.equal(final.attempt_id, before.attempt_id)
    assert.equal(final.provider_refs.run_id, before.provider_refs.run_id); assert.equal(modelCalls, 1)
    assert.equal((await second.store.runBinding(actor, task.id))?.version_evidence, 'provider_revision_fenced')
    assert.equal((await drivers[1].get('SELECT runtime_type FROM sessions WHERE session_id = ?', [task.session_id]))?.runtime_type, 'external')
    assert.equal(Number((await drivers[1].get('SELECT COUNT(*) AS total FROM external_pilot_tasks'))?.total), 0)
    assert.equal(Number((await drivers[1].get('SELECT COUNT(*) AS total FROM session_attempts WHERE session_id = ?', [task.session_id]))?.total), 1)
  } finally {
    complete(); await Promise.all(services.map(s => s.close())); await provider.close()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await Promise.all(drivers.map(d => d.close())); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})
