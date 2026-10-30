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

async function fixture(t: TestContext, isWorkerImplementation = false) {
  const state = { calls: 0, exactCalls: [] as Record<string, unknown>[], member: true, secret: 'fixture-worker-secret' as string | null,
    workerFailure: false,
    description: 'Read the current complete registered model context', headers: [] as string[],
    beforeReply: undefined as (() => Promise<void>) | undefined,
    response: { format: 'sudograph-worker-context/v1', authority_ref: 'authority', model_ref: 'model',
      source_refs: ['source'], scope: 'full-registered-model',
      context: { format: 'sudograph-agent-context/v1', revision: 'a'.repeat(64), context_digest: 'b'.repeat(64), text: 'Current policy A' } } }
  const http = createServer((req, res) => {
    void (async () => {
      state.headers.push(String(req.headers.authorization ?? ''))
      if (req.headers.authorization !== 'Bearer fixture-worker-secret') { res.writeHead(401); res.end(); return }
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
        inputSchema: z.object({ revision: z.string().min(1), id: z.string().min(1), selection: z.record(z.string(), z.unknown()).optional() }).strict(),
        _meta: { 'moss/input-profile': 'bounded-record-v1' }, annotations: { readOnlyHint: true } }, async args => {
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
  const binding = await registry.bind({ sessionId: 'session', projectId: project.projectId, orgId: 'org', userId: 'alice' }, ports)
  const reader = await registry.runnerContext({ sessionId: 'session', orgId: 'org', userId: 'alice' }, ports)
  assert(reader)
  const read = () => reader({ sessionId: 'session', nativeSessionId: 'native' })
  const reviewExact = async () => {
    const exact = descriptors.find(item => item.tool.name === 'sudograph_context_read')!
    return reviews.saveReview({ ...review, ...exact, resource: `mcp:${server.id}/sudograph_context_read`, revision: 'exact-review-1' }, null)
  }
  return { state, driver, mcp, reviews, server, review, ports, registry, binding, read, access, reviewExact }
}

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
