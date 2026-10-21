import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { STANDARD_HTTP_PROTOCOLS } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import type { ProviderInvocation } from './adapter.js'
import { discoverStandardManifest, StandardHttpAdapter } from './standardHttpAdapter.js'
import { customManifestDigest, parseCustomManifest, parseExternalRunBinding } from './manifest.js'
import { startProtocolReference } from '../testing/standardProtocolReference.js'
import { SqliteDriver } from '../db/driver.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { createCatalogTestRepository, createIdentityTestRepository } from '../testing/compatibilityRepositories.js'
import { ExternalTaskStore } from '../externalProviders/store.js'
import { ExternalProviderService } from '../externalProviders/service.js'
import { syntheticTaskSubmission } from '../testing/externalProviderDefinitionFixture.js'

const key = 'synthetic-reference-test-key'
const protocols = { openai: STANDARD_HTTP_PROTOCOLS[0], mcp: STANDARD_HTTP_PROTOCOLS[1], a2a: STANDARD_HTTP_PROTOCOLS[2] }
async function fixture(kind: keyof typeof protocols) {
  const server = await startProtocolReference(kind, key)
  try {
    const manifest = await discoverStandardManifest({ endpoint: server.endpoint, key, protocol: protocols[kind], target: server.target, agentId: server.target, name: 'Reference Agent' }, AbortSignal.timeout(5000))
    const adapter = new StandardHttpAdapter({ manifest, digest: customManifestDigest(manifest) })
    let authorizations = 0
    const input: ProviderInvocation = { task_id: randomUUID(), attempt_id: randomUUID(), session_id: randomUUID(), binding_id: 'binding',
      external_agent_id: server.target, source_digest: customManifestDigest(manifest), endpoint: server.endpoint, org_id: 'org',
      policy: { orgIds: ['org'], endpoints: [server.endpoint], timeoutMs: 5000 }, key, query: '6 * 7', end_user: 'opaque-user',
      provider_session_id: null, signal: AbortSignal.timeout(5000), authorize_dispatch: async () => { authorizations++ },
    }
    return { server, adapter, input, manifest, authorizations: () => authorizations }
  } catch (error) { await server.close(); throw error }
}

for (const kind of ['openai', 'mcp', 'a2a'] as const) {
  void test(`${kind}: real reference server metadata -> authorized invocation -> honest protocol evidence`, async t => {
    const f = await fixture(kind); t.after(f.server.close)
    assert.equal(f.server.control.invocations, 0)
    const events: unknown[] = [], result = await f.adapter.invoke(f.input, async event => { events.push(event) })
    assert.equal(result.text, '42'); assert.equal(result.status, 'succeeded'); assert.equal(f.authorizations(), 1)
    assert.equal(f.server.control.invocations, 1); assert.equal(result.binding.provider_protocol, protocols[kind])
    assert.match(result.binding.trace_id!, /^[a-f0-9]{32}$/)
    assert.match(f.server.control.traces[0], new RegExp(`^00-${result.binding.trace_id}-[a-f0-9]{16}-01$`))
    assert.equal(result.binding.version_evidence, 'source_snapshot_only'); assert.equal(result.binding.provider_session_id, undefined)
    assert.deepEqual(parseExternalRunBinding(result.binding), result.binding)
    if (kind === 'a2a') { assert(result.binding.provider_run_id); assert.equal(f.server.control.polls, 1) }
    else assert.equal(result.binding.provider_run_id, undefined)
    if (kind === 'openai') { assert(result.binding.provider_response_id); assert.deepEqual(result.binding.usage, { source: 'provider_reported', input_tokens: 3, output_tokens: 1 }) }
    else assert.equal(result.binding.usage, undefined)
    assert(events.length > 0)
  })
  void test(`${kind}: bad credentials, revoked dispatch, descriptor change and unapproved endpoint never invoke`, async t => {
    const f = await fixture(kind); t.after(f.server.close)
    await assert.rejects(f.adapter.inspect(f.server.endpoint, 'wrong-key', AbortSignal.timeout(2000)))
    await assert.rejects(f.adapter.invoke({ ...f.input, policy: { ...f.input.policy, endpoints: [] } }, async () => {}), { code: 'ENDPOINT_NOT_APPROVED' })
    await assert.rejects(f.adapter.invoke({ ...f.input, authorize_dispatch: async () => { throw new Error('revoked') } }, async () => {}), /revoked/)
    f.server.control.revision++
    await assert.rejects(f.adapter.invoke(f.input, async () => {}), { code: 'PROVIDER_SOURCE_CHANGED' })
    assert.equal(f.server.control.invocations, 0); assert.equal(f.authorizations(), 0)
  })
  void test(`${kind}: manifest cannot enable unsupported capabilities or embed authority`, async t => {
    const f = await fixture(kind); t.after(f.server.close)
    for (const patch of [{ capabilities: { ...f.manifest.capabilities, supports_cancel: true } }, { target: undefined }, { discovery_digest: undefined },
      { endpoint: 'http://127.0.0.1:1/v1' }, { api_key: 'do-not-import' }, { execution_revision: `sha256:${'a'.repeat(64)}` }, { conversation_mode: 'history' }]) {
      assert.throws(() => parseCustomManifest(JSON.stringify({ ...f.manifest, ...patch })))
    }
    await assert.rejects(f.adapter.invoke({ ...f.input, recovery: true }, async () => {}), { code: 'PROVIDER_CONTEXT_UNSUPPORTED' })
    await assert.rejects(f.adapter.invoke({ ...f.input, provider_session_id: 'unreviewed-session' }, async () => {}), { code: 'PROVIDER_CONTEXT_UNSUPPORTED' })
    assert.equal(f.server.control.invocations, 0)
  })
}

for (const fault of ['wrong-id', 'task-swap', 'rpc-error', 'waiting'] as const) {
  void test(`A2A ${fault}: no success and no repeated message/send`, async t => {
    const f = await fixture('a2a'); t.after(f.server.close); f.server.control.fault = fault
    await assert.rejects(f.adapter.invoke(f.input, async () => {}))
    assert.equal(f.server.control.invocations, 1)
  })
}
void test('A2A Message response has a response handle, not a fabricated task', async t => {
  const f = await fixture('a2a'); t.after(f.server.close); f.server.control.fault = 'message'
  const result = await f.adapter.invoke(f.input, async () => {})
  assert.equal(result.text, '42'); assert(result.binding.provider_response_id); assert.equal(result.binding.provider_run_id, undefined); assert.equal(f.server.control.polls, 0)
})
for (const kind of ['mcp', 'a2a'] as const) {
  void test(`${kind}: explicit tool/task failure is failed with no private diagnostic text`, async t => {
    const f = await fixture(kind); t.after(f.server.close); f.server.control.fault = 'failed'
    const result = await f.adapter.invoke(f.input, async () => {})
    assert.equal(result.status, 'failed'); assert.equal(result.text, ''); assert.equal(f.server.control.invocations, 1)
  })
}
void test('OpenAI tool calls cannot masquerade as completed text', async t => {
  const f = await fixture('openai'); t.after(f.server.close); f.server.control.fault = 'tool-output'
  await assert.rejects(f.adapter.invoke(f.input, async () => {}), { code: 'PROVIDER_OUTPUT_UNSUPPORTED' }); assert.equal(f.server.control.invocations, 1)
})
void test('redirects remain refused on metadata discovery', async t => {
  const f = await fixture('openai'); t.after(f.server.close); f.server.control.fault = 'redirect'
  await assert.rejects(f.adapter.invoke(f.input, async () => {})); assert.equal(f.server.control.invocations, 0)
})
void test('protocol run evidence rejects missing legacy handles and invented MCP run IDs', async t => {
  const f = await fixture('mcp'); t.after(f.server.close)
  const result = await f.adapter.invoke(f.input, async () => {})
  assert.throws(() => parseExternalRunBinding({ ...result.binding, provider_run_id: 'invented' }))
  assert.throws(() => parseExternalRunBinding({ ...result.binding, provider_protocol: undefined }))
  assert.throws(() => parseExternalRunBinding({ ...result.binding, trace_id: '0' }))
})

for (const kind of ['http', 'openai', 'mcp', 'a2a'] as const) {
  void test(`${kind}: Moss admin onboard/review, member task, evidence, idempotency and revoke over real HTTP`, async t => {
    const server = await startProtocolReference(kind, key), actor = { orgId: 'org', userId: 'member' }
    t.after(server.close)
    const manifest = kind === 'http' ? server.legacyManifest() : await discoverStandardManifest({ endpoint: server.endpoint, key,
      protocol: protocols[kind], target: server.target, agentId: server.target, name: 'Reference Agent' }, AbortSignal.timeout(5000))
    const db = new DatabaseSync(':memory:'), driver = new SqliteDriver(db)
    await new AuthCenterDb(db).createOrganization(actor.orgId, 'Protocol test', Date.now())
    const catalog = createCatalogTestRepository(db, driver), identities = createIdentityTestRepository(db, {}, driver), secrets = new Map<string, string>()
    const options = { catalog, identities, policy: { orgIds: [actor.orgId], endpoints: [server.endpoint], timeoutMs: 5000 },
      isActorActive: async (candidate: typeof actor) => candidate.orgId === actor.orgId, isMemberActive: async () => true,
      members: async () => [{ id: actor.userId, name: 'Member' }],
      secrets: { getSecret: async (namespace: string, name: string) => ({ value: secrets.get(`${namespace}/${name}`) ?? null, status: 'enabled', version: 1 }),
        putSecret: async (namespace: string, name: string, value: string) => { secrets.set(`${namespace}/${name}`, value) },
        deleteSecret: async (namespace: string, name: string) => { secrets.delete(`${namespace}/${name}`) } },
    }
    const store = new ExternalTaskStore(driver)
    let service = new ExternalProviderService(store, options)
    t.after(async () => { await service.close(); await driver.close() })
    const agent = await service.onboard(actor, { request_id: randomUUID(), provider_kind: 'custom_http', endpoint: server.endpoint, api_key: key,
      app_id: server.target, workspace_id: 'reference', name: 'Protocol reference', source_definition: JSON.stringify(manifest), decoder: 'text',
      allowed_user_ids: [actor.userId], review_days: 1, review_note: 'Synthetic local conformance' })
    await service.review(actor, agent.id, true, agent.revision)
    assert.equal(server.control.invocations, 0)
    assert.equal((await service.list({ ...actor, userId: 'not-granted' })).length, 0)
    const submission = syntheticTaskSubmission({ agent_id: agent.id, query: '6 * 7', idempotency_key: randomUUID() })
    const task = await service.create(actor, submission); await service.waitForTask(task.id)
    assert.equal((await store.task(actor, task.id)).status, 'succeeded'); assert.equal((await store.task(actor, task.id)).answer, '42')
    const evidence = await service.evidence(actor, task.id)
    if (kind !== 'http') assert.equal(evidence.execution?.protocol, protocols[kind])
    await assert.rejects(service.evidence({ ...actor, userId: 'not-granted' }, task.id))
    assert.equal((await service.create(actor, submission)).id, task.id); assert.equal(server.control.invocations, 1)
    if (kind !== 'http') {
      server.control.fault = 'disconnect'
      const uncertain = syntheticTaskSubmission({ agent_id: agent.id, query: '6 * 7', idempotency_key: randomUUID() })
      const unknown = await service.create(actor, uncertain); await service.waitForTask(unknown.id)
      assert.equal((await store.task(actor, unknown.id)).status, 'unknown')
      assert.equal(server.control.invocations, 2)
      await service.close(); service = new ExternalProviderService(store, options)
      assert.equal((await service.create(actor, uncertain)).id, unknown.id)
      assert.equal(server.control.invocations, 2)
    }
    const before = server.control.invocations, binding = await store.binding(actor, agent.id)
    await service.review(actor, agent.id, false, binding.revision!)
    const rejected = await service.create(actor, syntheticTaskSubmission({ agent_id: agent.id, query: 'again', idempotency_key: randomUUID() }))
    assert.equal(rejected.status, 'rejected'); assert.equal(server.control.invocations, before)
  })
}
