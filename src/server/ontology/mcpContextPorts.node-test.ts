import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { SqliteDriver } from '../db/driver.js'
import { McpStore } from '../mcp/db.js'
import { ReviewedMcpAccess, mcpServerDigest } from '../mcp/reviewedAccess.js'
import { ToolGatewayStore } from '../agentFederation/toolGatewayStore.js'
import { orgScopedNamespace, secretSubject } from '../secrets/secretSubject.js'
import { ONTOLOGY_PROJECT_SCHEMA } from './projectSchema.js'
import { OntologyProjectRegistry } from './projectRegistry.js'
import { McpOntologyContextPorts } from './mcpContextPorts.js'
import { registerModelContextTool } from './contextWorker.js'
import { McpOntologyReviewPorts } from './mcpReviewPorts.js'
import { WORKER_REVIEW_PROFILE, WORKER_REVIEW_PROFILE_KEY } from './workerReviewProtocol.js'

async function fixture(t: TestContext, isWorkerImplementation = false, hasReviewProfile = true) {
  const state = { calls: 0, exactCalls: [] as Record<string, unknown>[], member: true, secret: 'fixture-worker-secret' as string | null,
    workerFailure: false, hasReviewProfile, reviewStatus: 200, reviewCalls: [] as Record<string, unknown>[],
    beforeReviewReply: undefined as (() => Promise<void>) | undefined,
    reviewResponse: { format: WORKER_REVIEW_PROFILE, authority_ref: 'authority', model_ref: 'model',
      source_refs: ['source'], scope: 'full-registered-model', result: { revision: 'a'.repeat(64) } } as Record<string, unknown>,
    description: 'Read the current complete registered model context', headers: [] as string[],
    beforeReply: undefined as (() => Promise<void>) | undefined,
    response: { format: 'sudograph-worker-context/v1', authority_ref: 'authority', model_ref: 'model',
      source_refs: ['source'], scope: 'full-registered-model',
      context: { format: 'sudograph-agent-context/v1', revision: 'a'.repeat(64), context_digest: 'b'.repeat(64), text: 'Current policy A' } } }
  const http = createServer((req, res) => {
    void (async () => {
      state.headers.push(String(req.headers.authorization ?? ''))
      if (req.headers.authorization !== 'Bearer fixture-worker-secret') { res.writeHead(401); res.end(); return }
      if (req.url === '/review') {
        let raw = ''
        for await (const chunk of req) raw += String(chunk)
        state.reviewCalls.push(JSON.parse(raw) as Record<string, unknown>)
        await state.beforeReviewReply?.()
        res.writeHead(state.reviewStatus, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(state.reviewResponse))
        return
      }
      const sdk = new McpServer({ name: 'registered-model-worker', version: '1.0.0' })
      if (isWorkerImplementation) registerModelContextTool(sdk, { authorityRef: 'authority', modelRef: 'model', sourceRefs: ['source'] }, async () => {
        state.calls++
        if (state.workerFailure) throw new Error('Provider failed: fixture-private-password at /private/source.db')
        return state.response.context as Awaited<ReturnType<McpOntologyContextPorts['readContext']>>
      })
      else sdk.registerTool('sudograph_context', { description: state.description,
        inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } }, async () => {
        state.calls++
        await state.beforeReply?.()
        return { content: [{ type: 'text', text: JSON.stringify(state.response) }] }
      })
      sdk.registerTool('sudograph_context_read', { description: 'Read an exact registered model pointer',
        inputSchema: z.object({ revision: z.string().min(1), id: z.string().min(1), context_digest: z.string().optional(),
          records: z.boolean().optional(), selection: z.record(z.string(), z.unknown()).optional() }).strict(),
        _meta: { 'moss/input-profile': 'bounded-record-v1', ...(state.hasReviewProfile ? { [WORKER_REVIEW_PROFILE_KEY]: WORKER_REVIEW_PROFILE } : {}) }, annotations: { readOnlyHint: true } }, async args => {
        state.exactCalls.push(args)
        await state.beforeReply?.()
        return { content: [{ type: 'text', text: JSON.stringify({ pointer: args.id, selection: args.selection }) }] }
      })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.once('close', () => { void sdk.close() })
      await sdk.connect(transport)
      await transport.handleRequest(req, res)
    })().catch(() => res.destroy())
  })
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r))
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())) })
  const address = http.address()
  assert(address && typeof address !== 'string')
  const sqlite = new DatabaseSync(':memory:')
  McpStore.ensureTables(sqlite)
  sqlite.exec(`CREATE TABLE sessions(session_id TEXT PRIMARY KEY, org_id TEXT, user_id TEXT, deleted_at BIGINT);
    INSERT INTO sessions VALUES ('session','org','alice',NULL); ${ONTOLOGY_PROJECT_SCHEMA}`)
  const driver = new SqliteDriver(sqlite), mcp = new McpStore(driver), reviews = new ToolGatewayStore(driver)
  t.after(() => driver.close())
  const server = await mcp.createMcpServer('org', { name: 'Model worker', scope: 'org', owner_type: 'system', owner_id: 'org',
    mcp_type: 'http', url: `http://127.0.0.1:${address.port}/mcp`, auth_type: 'secret_ref', secret_ref: 'model-worker',
    allow_read: true, allow_read_sensitive_fields: true, allow_write: false }, 'manager')
  await mcp.setMcpServerStatus('org', server.id, 'enabled', 'manager')
  await mcp.upsertMcpPolicy('org', { allow_http_sse_mcp: true, allow_external_network: true,
    domain_whitelist_json: ['127.0.0.1'] }, 'manager')
  const access = new ReviewedMcpAccess(reviews, { mcp,
    member: async (org, user) => state.member && org === 'org' && user === 'alice'
      ? { isAdmin: false, userId: 'alice', departmentId: null, visibleDepartmentIds: null } : null,
    addresses: () => ['127.0.0.1'],
    secrets: org => ({ getConfigItemByPinyin: async name => name === 'model-worker'
      ? { pinyin: name, scheme: 'bearer', bearer_prefix: 'Bearer', entries: [{ config_key: 'token' }] } : null,
    listSecrets: async (namespace, subject) => {
      assert.equal(namespace, orgScopedNamespace('system:model-worker', org))
      assert.equal(subject, secretSubject(namespace, ''))
      return [{ key: 'token', value: state.secret }]
    } }),
  })
  const protocol = access.protocol((await access.connection('org', server.id)).config, AbortSignal.timeout(10000))
  let descriptors
  try { await protocol.connect(); descriptors = await protocol.descriptors() } finally { await protocol.close() }
  const descriptor = descriptors.find(item => item.tool.name === 'sudograph_context')
  assert(descriptor)
  const review = await reviews.saveReview({ ...descriptor, orgId: 'org', serverId: server.id,
    resource: `mcp:${server.id}/sudograph_context`, serverDigest: mcpServerDigest(server), action: 'read', sensitive: true,
    outbound: false, enabled: true, revision: 'review-1', reviewedBy: 'manager', reviewedAt: Date.now() }, null)
  const ports = new McpOntologyContextPorts(access, mcp)
  const registry = new OntologyProjectRegistry(driver)
  const project = await registry.register({ orgId: 'org', authorityRef: 'authority', workerRef: server.id, modelRef: 'model', sourceRefs: ['source'] })
  state.reviewResponse.resource_ref = project.projectId
  const binding = await registry.bind({ sessionId: 'session', projectId: project.projectId, orgId: 'org', userId: 'alice' }, ports)
  const reader = await registry.runnerContext({ sessionId: 'session', orgId: 'org', userId: 'alice' }, ports)
  assert(reader)
  const read = () => reader({ sessionId: 'session', nativeSessionId: 'native' })
  const reviewExact = async () => {
    const exact = descriptors.find(item => item.tool.name === 'sudograph_context_read')!
    return reviews.saveReview({ ...review, ...exact, resource: `mcp:${server.id}/sudograph_context_read`, revision: 'exact-review-1' }, null)
  }
  const reviewPorts = new McpOntologyReviewPorts(access, mcp, async current => {
    await registry.assertCurrentBinding(current)
    await ports.authorize(current)
    await registry.assertCurrentBinding(current)
  })
  return { state, driver, mcp, reviews, server, review, ports, registry, binding, read, access, reviewExact, reviewPorts }
}

void test('human review requires its own explicit reviewed profile and follows the actual private HTTP endpoint', async t => {
  const f = await fixture(t)
  await assert.rejects(f.reviewPorts.read(f.binding, { operation: 'head' }), { code: 'HOST_READ_REVIEW_REQUIRED' })
  assert.equal(f.state.reviewCalls.length, 0)
  assert.equal(await f.read(), 'Current policy A')
  await f.reviewExact()
  assert.deepEqual(await f.reviewPorts.read(f.binding, { operation: 'head' }), { revision: 'a'.repeat(64) })
  assert.deepEqual(f.state.reviewCalls, [{ operation: 'head', resource: f.binding.projectId }])
  const audit = await f.mcp.queryAuditLog('org')
  assert.ok(audit.items.some(item => item.action === 'ontology.review.read' && item.status === 'success'))
  assert.ok(!JSON.stringify(audit).includes('fixture-worker-secret'))
})

void test('legacy review profiles and changed descriptors refuse before private HTTP dispatch', async t => {
  const legacy = await fixture(t, false, false)
  await legacy.reviewExact()
  await assert.rejects(legacy.reviewPorts.read(legacy.binding, { operation: 'head' }), /requires review of its human-read profile/)
  assert.equal(legacy.state.reviewCalls.length, 0)
  const changed = await fixture(t)
  await changed.reviewExact()
  changed.state.hasReviewProfile = false
  await assert.rejects(changed.reviewPorts.read(changed.binding, { operation: 'head' }), { code: 'TOOL_DESCRIPTOR_CHANGED' })
  assert.equal(changed.state.reviewCalls.length, 0)
})

for (const change of ['membership', 'credential', 'review', 'generation', 'session-owner'] as const) {
  void test(`human review discards an in-flight result after ${change} changes`, async t => {
    const f = await fixture(t)
    const review = await f.reviewExact()
    f.state.beforeReviewReply = async () => {
      if (change === 'membership') f.state.member = false
      if (change === 'credential') f.state.secret = null
      if (change === 'review') await f.reviews.saveReview({ ...review, revision: 'revoked', enabled: false }, review.revision)
      if (change === 'generation') {
        await f.registry.setEnabled('org', f.binding.projectId, false)
        await f.registry.setEnabled('org', f.binding.projectId, true)
      }
      if (change === 'session-owner') await f.driver.run("UPDATE sessions SET user_id='foreign' WHERE session_id='session'")
    }
    await assert.rejects(f.reviewPorts.read(f.binding, { operation: 'head' }))
    assert.equal(f.state.reviewCalls.length, 1)
    assert.equal((await f.mcp.queryAuditLog('org')).items[0]?.status, 'error')
  })
}

for (const field of ['format', 'authority_ref', 'model_ref', 'resource_ref', 'source_refs', 'scope', 'unknown'] as const) {
  void test(`human review rejects incompatible worker ${field}`, async t => {
    const f = await fixture(t)
    await f.reviewExact()
    f.state.reviewResponse[field] = field === 'source_refs' ? ['foreign-source'] : 'foreign-value'
    await assert.rejects(f.reviewPorts.read(f.binding, { operation: 'head' }), /incompatible identity or scope/)
  })
}

void test('human page arguments remain revision-bound and immutable before asynchronous checks', async t => {
  const f = await fixture(t)
  await f.reviewExact()
  for (const input of [{ operation: 'apply' }, { operation: 'html', endpoint: 'https://foreign.invalid/steal' },
    { operation: 'head', model_ref: 'foreign' }, { operation: 'head', resource: 'foreign' }, { operation: 'page', params: { id: 'object' } }]) {
    await assert.rejects(f.reviewPorts.read(f.binding, input))
  }
  assert.equal(f.state.reviewCalls.length, 0)
  const input = { operation: 'page', params: { revision: 'a'.repeat(64), id: 'object:orders' } }
  const pending = f.reviewPorts.read(f.binding, input)
  input.params.id = 'foreign-object'
  await pending
  assert.equal((f.state.reviewCalls[0].params as Record<string, unknown>).id, 'object:orders')
})

void test('human HTML uses its bounded host profile while agent MCP output retains its existing limit', async t => {
  const f = await fixture(t)
  await f.reviewExact()
  f.state.reviewResponse.result = { html: 'x'.repeat(2 * 1024 * 1024 + 1) }
  const result = await f.reviewPorts.read(f.binding, { operation: 'document', endpoint: `/review/${'a'.repeat(32)}/v1` }) as { html: string }
  assert.equal(result.html.length, 2 * 1024 * 1024 + 1)
  f.state.response.context.text = 'x'.repeat(128000)
  await assert.rejects(f.read(), { code: 'TOOL_OUTPUT_UNSUPPORTED' })
})

void test('human review preserves typed recovery without upstream diagnostics and honors cancellation', async t => {
  const f = await fixture(t)
  await f.reviewExact()
  f.state.reviewStatus = 409
  f.state.reviewResponse = { error: 'CONTEXT_STALE', reason: 'private-password /private/source.db', recovery: 'private-password' }
  await assert.rejects(f.reviewPorts.read(f.binding, { operation: 'head' }), error => {
    assert.equal((error as { code: string }).code, 'CONTEXT_STALE')
    assert.ok(!JSON.stringify(error).includes('private-password') && !String(error).includes('/private/'))
    return true
  })
  const before = f.state.reviewCalls.length
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.reviewPorts.read(f.binding, { operation: 'head' }, controller.signal))
  assert.equal(f.state.reviewCalls.length, before)
})

void test('host exact reads require their own review and preserve a selection snapshot across the actual MCP transport', async t => {
  const f = await fixture(t)
  const args = { revision: 'a'.repeat(64), id: 'field:order-date', selection: { offset: 0, roots: ['object:orders'] } }
  const read = () => f.access.readForHost('org', 'alice', f.server.id, 'sudograph_context_read', { arguments: args })
  await assert.rejects(read(), { code: 'HOST_READ_REVIEW_REQUIRED' })
  assert.equal(await f.read(), 'Current policy A', 'context access does not imply an exact-read grant')
  await f.reviewExact()
  const pending = read()
  args.selection.offset = 99
  args.selection.roots.push('object:foreign')
  const result = await pending
  assert.deepEqual(f.state.exactCalls, [{ ...args, selection: { offset: 0, roots: ['object:orders'] } }])
  assert.ok(JSON.stringify(result).includes('object:orders'))
  assert.ok(!JSON.stringify(result).includes('object:foreign'))
  await assert.rejects(f.access.readForHost('org', 'alice', f.server.id, 'sudograph_context_read',
    { arguments: { ...args, path: '/foreign/source.db' } }), { code: 'INVALID_TOOL_ARGUMENTS' })
  assert.equal(f.state.exactCalls.length, 1)
})

for (const change of ['membership', 'credential', 'review'] as const) {
  void test(`host exact reads discard data after in-flight ${change} revocation`, async t => {
    const f = await fixture(t)
    const review = await f.reviewExact()
    f.state.beforeReply = async () => {
      if (change === 'membership') f.state.member = false
      if (change === 'credential') f.state.secret = null
      if (change === 'review') await f.reviews.saveReview({ ...review, enabled: false, revision: 'revoked' }, review.revision)
    }
    await assert.rejects(f.access.readForHost('org', 'alice', f.server.id, 'sudograph_context_read',
      { arguments: { revision: 'a'.repeat(64), id: 'object:orders' } }))
    assert.equal(f.state.exactCalls.length, 1)
  })
}

void test('host read snapshots reject non-JSON values without normalizing them into approved records', async t => {
  const f = await fixture(t)
  await f.reviewExact()
  class Selection { roots = ['object:orders'] }
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  for (const selection of [new Selection(), cyclic, { roots: new Date() }, { roots: 'x'.repeat(32001) }]) {
    await assert.rejects(f.access.readForHost('org', 'alice', f.server.id, 'sudograph_context_read',
      { arguments: { revision: 'a'.repeat(64), id: 'object:orders', selection } }), { code: 'INVALID_TOOL_ARGUMENTS' })
  }
  assert.equal(f.state.exactCalls.length, 0)
})

void test('host exact reads preserve cancellation before dispatch', async t => {
  const f = await fixture(t)
  await f.reviewExact()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.access.readForHost('org', 'alice', f.server.id, 'sudograph_context_read',
    { arguments: { revision: 'a'.repeat(64), id: 'object:orders' }, signal: controller.signal }))
  assert.equal(f.state.exactCalls.length, 0)
})

void test('actual MCP transport reads the current canonical context and records metadata without content or credentials', async t => {
  const f = await fixture(t)
  assert.equal(await f.read(), 'Current policy A')
  f.state.response.context.text = 'Current policy B'
  f.state.response.context.revision = 'c'.repeat(64)
  assert.equal(await f.read(), 'Current policy B')
  assert.equal(f.state.calls, 2)
  assert.ok(f.state.headers.every(value => value === 'Bearer fixture-worker-secret'))
  const audit = await f.mcp.queryAuditLog('org')
  assert.equal(audit.total, 2)
  assert.ok(audit.items.every(row => row.action === 'ontology.context.read' && row.status === 'success'))
  const persisted = JSON.stringify(audit)
  assert.ok(!persisted.includes('Current policy') && !persisted.includes('fixture-worker-secret'))
  assert.equal((await f.reviews.calls('org')).length, 0, 'host reads do not forge task grants or persist a context snapshot')
})

void test('a departed member or disabled server cannot dispatch or fall back to the previously read context', async t => {
  const f = await fixture(t)
  assert.equal(await f.read(), 'Current policy A')
  f.state.member = false
  await assert.rejects(f.read(), { code: 'TOOL_USER_DENIED' })
  f.state.member = true
  await f.mcp.setMcpServerStatus('org', f.server.id, 'disabled', 'manager')
  await assert.rejects(f.read(), { code: 'TOOL_SERVER_UNAVAILABLE' })
  assert.equal(f.state.calls, 1)
})

for (const change of ['membership', 'credential', 'review'] as const) {
  void test(`in-flight ${change} revocation discards worker output`, async t => {
    const f = await fixture(t)
    f.state.beforeReply = async () => {
      if (change === 'membership') f.state.member = false
      if (change === 'credential') f.state.secret = null
      if (change === 'review') await f.reviews.saveReview({ ...f.review, enabled: false, revision: 'revoked' }, f.review.revision)
    }
    await assert.rejects(f.read())
    assert.equal(f.state.calls, 1)
    const audit = await f.mcp.queryAuditLog('org')
    assert.equal(audit.items[0]?.status, 'error')
    assert.ok(!JSON.stringify(audit).includes('Current policy A'))
  })
}

void test('a write review, changed descriptor or agent restriction cannot be treated as a host read grant', async t => {
  const f = await fixture(t)
  await f.reviews.saveReview({ ...f.review, action: 'write', revision: 'write' }, f.review.revision)
  await assert.rejects(f.read(), { code: 'HOST_READ_REVIEW_REQUIRED' })
  await f.reviews.saveReview({ ...f.review, revision: 'read-again' }, 'write')
  f.state.description = 'Changed tool semantics'
  await assert.rejects(f.read(), { code: 'TOOL_DESCRIPTOR_CHANGED' })
  f.state.description = 'Read the current complete registered model context'
  await f.mcp.updateMcpServer('org', f.server.id, { bound_assistants: ['another-agent'] }, 'manager')
  await assert.rejects(f.read(), { code: 'HOST_READ_AGENT_BINDING_UNSUPPORTED' })
  assert.equal(f.state.calls, 0)
})

for (const field of ['authority_ref', 'model_ref', 'source_refs', 'scope', 'context'] as const) {
  void test(`worker ${field} must match the registered model and supported full scope`, async t => {
    const f = await fixture(t)
    if (field === 'source_refs') f.state.response.source_refs = ['another-source']
    else if (field === 'context') f.state.response.context.revision = 'invalid'
    else f.state.response[field] = 'another-value'
    await assert.rejects(f.read())
    assert.equal((await f.mcp.queryAuditLog('org')).items[0]?.status, 'error')
  })
}

void test('existing network and output limits are preserved for host context reads', async t => {
  const f = await fixture(t)
  await f.mcp.upsertMcpPolicy('org', { domain_whitelist_json: [] }, 'manager')
  await assert.rejects(f.read(), { code: 'TOOL_DESTINATION_DENIED' })
  assert.equal(f.state.calls, 0)
  await f.mcp.upsertMcpPolicy('org', { domain_whitelist_json: ['127.0.0.1'] }, 'manager')
  f.state.response.context.text = 'x'.repeat(128000)
  await assert.rejects(f.read(), { code: 'TOOL_OUTPUT_UNSUPPORTED' })
  assert.equal(f.state.calls, 1)
})

void test('the actual worker tool refuses caller-selected models and sanitizes compiler/provider failures', async t => {
  const f = await fixture(t, true)
  const protocol = f.access.protocol((await f.access.connection('org', f.server.id)).config, AbortSignal.timeout(10000))
  try {
    await protocol.connect()
    assert.equal((await protocol.call('sudograph_context', { model_ref: 'foreign' })).isError, true)
    assert.equal(f.state.calls, 0)
    f.state.workerFailure = true
    const result = await protocol.call('sudograph_context', {})
    assert.equal(result.isError, true)
    assert.ok(!JSON.stringify(result).includes('fixture-private-password') && !JSON.stringify(result).includes('/private/source.db'))
  } finally { await protocol.close() }
  await assert.rejects(f.read(), { code: 'HOST_READ_FAILED' })
  assert.ok(!JSON.stringify(await f.mcp.queryAuditLog('org')).includes('fixture-private-password'))
})
