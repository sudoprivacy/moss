import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { PgDriver, type PgPoolLike } from '../../db/driver.js'
import { DURABLE_AGENT_HTTP_API } from '../../../../contracts/agent-http/v1alpha2/contract.js'
import { AgentRunStore } from './store.js'
import { HttpAgentRuntime, immutableAgent } from './runtime.js'

void test('PostgreSQL: independent provider instances serialize requests, fence stale results and recover queued work', { skip: !process.env.MOSS_PG_TEST_URL }, async () => {
  const connectionString = process.env.MOSS_PG_TEST_URL!, schema = `http_provider_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const drivers = [0, 1].map(() => new PgDriver(new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 }) as unknown as PgPoolLike))
  const stores: AgentRunStore[] = [], runtimes: HttpAgentRuntime[] = []
  try {
    const definition = { external_agent_id: 'calculator', name: 'Calculator', system_prompt: 'Calculate', router_endpoint: 'http://127.0.0.1:30123/v1', model: 'test-model', max_output_tokens: 128 }
    const agent = immutableAgent(definition, `sha256:${'a'.repeat(64)}`, [definition.router_endpoint])
    let modelCalls = 0
    for (const driver of drivers) {
      const store = new AgentRunStore(driver); await store.ready; stores.push(store)
      runtimes.push(new HttpAgentRuntime(store, [agent], async () => { modelCalls++; return '42' }))
    }
    const input = { api_version: DURABLE_AGENT_HTTP_API, kind: 'SubmitAgentRun' as const, invocation_id: randomUUID(), external_agent_id: 'calculator', execution_revision: agent.revision, query: '6 * 7', provider_session_id: null, end_user: 'synthetic-user', deadline_at: Date.now() + 60_000 }
    const accepted = await Promise.all(Array.from({ length: 24 }, (_, i) => runtimes[i % 2].submit('client', input)))
    assert.equal(new Set(accepted.map(x => x.provider_run_id)).size, 1)
    await Promise.all(runtimes.map(r => r.tick())); await Promise.all(runtimes.map(r => r.idle()))
    assert.equal(modelCalls, 1); assert.equal((await stores[1].get('client', input.invocation_id)).status, 'succeeded')
    await assert.rejects(runtimes[1].submit('client', { ...input, query: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' })
    const second = { ...input, invocation_id: randomUUID() }
    await runtimes[0].submit('client', second)
    const claim = await stores[0].claim('client', second.invocation_id); assert(claim)
    assert.equal(await stores[1].claim('client', second.invocation_id), null)
    await drivers[1].run('UPDATE http_agent_runs SET lease_until = 0 WHERE invocation_id = ?', [second.invocation_id])
    await drivers[1].run('UPDATE http_agent_maintenance SET next_run_at = 0')
    assert.equal(await stores[0].finish(claim, 'stale output', 'succeeded'), false)
    await runtimes[1].tick(); await runtimes[1].idle()
    assert.equal((await stores[0].get('client', second.invocation_id)).status, 'unknown'); assert.equal(modelCalls, 1)
    assert.equal((await runtimes[1].submit('client', second)).status, 'unknown')
    await assert.rejects(stores[1].get('foreign-client', second.invocation_id), { code: 'RUN_NOT_FOUND' })
  } finally {
    await Promise.all(runtimes.map(r => r.close())); await Promise.all(drivers.map(d => d.close()))
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})
