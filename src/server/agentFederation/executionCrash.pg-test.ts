import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { PgDriver, type PgPoolLike } from '../db/driver.js'
import { applyPgSchema } from '../db/pg_schema.js'
import { CatalogRepository } from '../catalog/catalogRepository.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { ExternalTaskStore } from '../externalProviders/store.js'
import { ExternalProviderService } from '../externalProviders/service.js'
import { AgentRunStore } from './provider/store.js'
import { HttpAgentRuntime, agentManifest, immutableAgent } from './provider/runtime.js'
import { providerServer } from './provider/server.js'
import { TASK_API } from '../../../contracts/task/v1alpha1/contract.js'
import type { ExternalTask } from '../../../contracts/external-provider/v1/contract.js'

async function until(check: () => Promise<boolean>, timeout = 10_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await delay(50) }
  assert.fail('Timed out waiting for execution recovery')
}

void test('SIGKILL of the Moss controller recovers after the real lease timeout; a lost response never repeats execution', { skip: !process.env.MOSS_PG_TEST_URL, timeout: 70_000 }, async () => {
  const connectionString = process.env.MOSS_PG_TEST_URL!, schema = `moss_crash_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`)
  const driver = new PgDriver(new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 }) as unknown as PgPoolLike)
  const providerDriver = new PgDriver(new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 }) as unknown as PgPoolLike)
  const router = 'http://127.0.0.1:30123/v1', token = 'synthetic-crash-client-token-'.repeat(2)
  const agent = immutableAgent({ external_agent_id: 'calculator', name: 'Calculator', system_prompt: 'Calculate', router_endpoint: router, model: 'fixture', max_output_tokens: 128 }, `sha256:${'c'.repeat(64)}`, [router])
  const providerStore = new AgentRunStore(providerDriver); await providerStore.ready
  let modelCalls = 0, finish!: () => void
  const barrier = new Promise<void>(resolve => { finish = resolve })
  const provider = new HttpAgentRuntime(providerStore, [agent], async () => { modelCalls++; await barrier; return '42' })
  const server = providerServer(provider, [{ id: 'integration', token, agentIds: ['calculator'] }])
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); provider.start()
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const actor = { orgId: 'org-1', userId: 'reviewer' }, services: ExternalProviderService[] = []
  let child: ReturnType<typeof fork> | undefined
  let isPartitioned = true, recoveryRequests = 0
  const makeService = () => {
    const service = new ExternalProviderService(new ExternalTaskStore(driver), { catalog: new CatalogRepository(driver), identities: new IdentityRepository(driver),
      secrets: { getSecret: async () => ({ value: token, status: 'enabled', version: 1 }), putSecret: async () => {}, deleteSecret: async () => {} },
      isActive: async () => true, policy: { orgIds: [actor.orgId], endpoints: [endpoint], timeoutMs: 90_000 },
      httpRequest: async (url, init) => {
        if (String(url).includes('/runs/')) { recoveryRequests++; if (isPartitioned) throw new Error('Simulated connection loss') }
        return fetch(url, init)
      },
    }); services.push(service); return service
  }
  try {
    await applyPgSchema(driver)
    await driver.run('INSERT INTO organizations(id, name, created_at) VALUES (?, ?, ?)', [actor.orgId, 'Synthetic failover', Date.now()])
    const setup = makeService()
    const binding = await setup.administration.onboard(actor, { request_id: randomUUID(), provider_kind: 'custom_http', name: 'Crash calculator', endpoint, api_key: token, app_id: 'calculator', workspace_id: 'provider-workspace', source_definition: JSON.stringify(agentManifest(agent)), decoder: 'text', allowed_user_ids: [actor.userId], review_days: 1, review_note: 'Synthetic crash drill' })
    await setup.review(actor, binding.id, true, binding.revision); await setup.close()
    child = fork(new URL('../testing/externalExecutionOwner.fixture.ts', import.meta.url), { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const message = once(child, 'message')
    child.send({ connectionString, schema, endpoint, token, actor, submission: { api_version: TASK_API, kind: 'SubmitTask', agent: { catalog_id: binding.id }, request_source: 'interactive', input: { instruction: '6 * 7', resource_refs: [] }, workspace_refs: [], requested_mode: 'auto', data_classification: 'synthetic', required_capabilities: ['idempotency', 'version_pin'], constraints: { idempotency_key: randomUUID(), timeout_ms: 90_000 } } })
    const [response] = await message as [{ task?: ExternalTask; ownerId: string; error?: string }]
    assert(response.task, response.error); const task = response.task
    const store = new ExternalTaskStore(driver); await store.ready
    await until(async () => modelCalls === 1 && Boolean((await store.task(actor, task.id)).provider_refs.run_id))
    const old = await driver.get('SELECT token, lease_until FROM external_attempt_leases WHERE attempt_id = ?', [task.attempt_id])
    const remoteId = (await store.task(actor, task.id)).provider_refs.run_id
    const exited = once(child, 'exit'); child.kill('SIGKILL'); const [, signal] = await exited
    assert.equal(signal, 'SIGKILL')
    const replacement = makeService()
    await until(async () => recoveryRequests > 0, 40_000)
    assert(Date.now() >= Number(old!.lease_until), 'No early takeover or artificial lease expiration')
    assert.equal((await store.task(actor, task.id)).status, 'running')
    assert.equal(await store.mutate(task.id, value => { value.answer = 'stale'; return 'answer' }, { attemptId: task.attempt_id!, ownerId: response.ownerId, token: String(old!.token) }), null)
    isPartitioned = false; finish()
    await until(async () => (await store.task(actor, task.id)).status === 'succeeded')
    const final = await store.task(actor, task.id)
    assert.equal(final.answer, '42'); assert.equal(final.attempt_id, task.attempt_id); assert.equal(final.provider_refs.run_id, remoteId); assert.equal(modelCalls, 1)
    assert.equal((await driver.get('SELECT server_instance_id FROM session_attempts WHERE attempt_id = ?', [task.attempt_id]))?.server_instance_id, replacement.ownership.ownerId)
  } finally {
    child?.kill('SIGKILL'); finish(); await Promise.all(services.map(s => s.close())); await provider.close()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await driver.close(); await providerDriver.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})
