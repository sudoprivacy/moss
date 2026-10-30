import { test, type TestContext } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { McpServer as SdkServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { SqliteDriver } from '../db/driver.js'
import { McpStore } from '../mcp/db.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import type { ExecutionGrant, CheckExecutionGrant } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { AgentToolGateway } from './toolGateway.js'
import { ToolGatewayStore } from './toolGatewayStore.js'
import { ToolProtocol, validateToolArguments, validateReviewedToolArguments } from './toolProtocol.js'

async function fixture(t: TestContext, hasRecordTool = false) {
  const state = { calls: 0, recordCalls: 0, recordProfile: 'bounded-record-v1' as string | undefined, checks: 0, description: 'Synthetic arithmetic tool', fail: false, deny: false, suspendOnCheck: 0, member: true, headers: [] as string[], hold: undefined as (() => Promise<void>) | undefined }
  const http = createServer((req, res) => {
    void (async () => {
      state.headers.push(String(req.headers.authorization ?? ''))
      const sdk = new SdkServer({ name: 'synthetic-tool', version: '1.0.0' })
      sdk.registerTool('sum', { description: state.description, inputSchema: z.object({ a: z.number(), b: z.number() }).strict(), annotations: { readOnlyHint: true } }, async ({ a, b }) => {
        state.calls++
        await state.hold?.()
        if (state.fail) { res.destroy(); return { content: [] } }
        return { content: [{ type: 'text', text: String(a + b) }] }
      })
      if (hasRecordTool) sdk.registerTool('read_selection', {
        inputSchema: z.object({ id: z.string().min(1), selection: z.record(z.string(), z.unknown()).optional() }).strict(),
        _meta: state.recordProfile ? { 'moss/input-profile': state.recordProfile } : {}, annotations: { readOnlyHint: true },
      }, async input => { state.recordCalls++; return { content: [{ type: 'text', text: JSON.stringify(input) }] } })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => { void sdk.close() })
      await sdk.connect(transport)
      await transport.handleRequest(req, res)
    })().catch(() => { res.destroy() })
  })
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r))
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())) })
  const port = (http.address() as { port: number }).port, endpoint = `http://127.0.0.1:${port}/mcp`
  const sqlite = new DatabaseSync(':memory:'); McpStore.ensureTables(sqlite)
  const db = new SqliteDriver(sqlite), mcp = new McpStore(db), store = new ToolGatewayStore(db)
  t.after(() => db.close())
  const server = await mcp.createMcpServer('org-a', { name: 'Arithmetic', scope: 'org', owner_type: 'system', owner_id: 'org-a', mcp_type: 'http', url: endpoint,
    auth_type: 'bearer', auth_config_json: JSON.stringify({ header_name: 'Authorization', prefix: 'Bearer', token: 'synthetic-tool-credential' }),
    allow_read: true, allow_write: true, require_confirmation_for_write: true }, 'manager')
  await mcp.setMcpServerStatus('org-a', server.id, 'enabled', 'manager')
  await mcp.upsertMcpPolicy('org-a', { allow_http_sse_mcp: true, allow_external_network: true, domain_whitelist_json: ['127.0.0.1'] }, 'manager')
  const digest = `sha256:${'a'.repeat(64)}`
  const grant: ExecutionGrant = { id: 'grant-a', zone: 'zone-a', issuer: 'user:manager', worker_id: 'worker-a', key_id: 'key-a', owner_user_id: 'owner-a', department_id: 'department-a',
    status: 'active', cleanup_pending: false, created_at: Date.now(), expires_at: Date.now() + 120000,
    request: { request_id: 'request-a', asset_id: 'asset-a', metadata_digest: digest, spec_digest: digest, task_id: 'task-a', initiated_by: 'user-a', mode: 'evaluation', dataset_digest: digest,
      permissions: [{ operation: 'tool.invoke', resource: `mcp:${server.id}/sum` }], ttl_seconds: 120, max_model_calls: 1 } }
  const deps = { registry: { scope: () => ({ zoneId: 'zone-a', trustDomain: 'agents.example' }), catalogId: () => 'catalog-a', inventoryGet: async () => { throw new Error('not expected') },
    executionAuthorize: async (org: string, check: CheckExecutionGrant) => {
      state.checks++
      if (state.suspendOnCheck === state.checks) await db.run("INSERT INTO agent_asset_gates(org_id, asset_id, operation_id) VALUES ('org-a', 'asset-a', 'suspend-a') ON CONFLICT(org_id, asset_id) DO UPDATE SET operation_id = 'suspend-a'")
      if (org !== 'org-a' || check.token !== 'synthetic-iam-credential' || check.task_id !== grant.request.task_id || check.grant_id !== grant.id || check.spec_digest !== digest || state.deny || grant.status !== 'active') throw new ExternalProviderError(401, 'EXECUTION_INACTIVE')
      return { grant, cacheable: false as const, authorized_at: Date.now() }
    } }, mcp, member: async () => state.member ? { isAdmin: false, userId: 'user-a', departmentId: 'department-a', role: 'user', visibleDepartmentIds: new Set(['department-a']) } : null,
    addresses: () => ['127.0.0.1'] }
  const gateway = new AgentToolGateway(store, deps)
  const discovered = await gateway.discover('org-a', server.id)
  const review = await gateway.approve('org-a', server.id, 'manager', { tool: 'sum', digest: discovered[0].digest, action: 'read', sensitive: false, outbound: false, enabled: true, expected_revision: null })
  const input = { call_id: 'call-a', grant_id: grant.id, task_id: 'task-a', spec_digest: digest, resource: review.resource, arguments: { a: 3, b: 4 } }
  const invoke = (body: unknown = input, token = 'synthetic-iam-credential') => gateway.invoke('org-a', body, token)
  return { state, http, db, store, mcp, server, grant, gateway, deps, input, invoke, review, endpoint }
}

void test('real SDK tools/list and tools/call; trusted trace, one dispatch and no IAM credential forwarding', async t => {
  const f = await fixture(t)
  const result = await f.invoke()
  assert.equal(result.status, 'completed'); assert.deepEqual(result.result?.content, [{ type: 'text', text: '7' }])
  assert.equal(result.workerId, 'worker-a'); assert.equal(result.initiatedBy, 'user-a'); assert.equal(result.assetId, 'asset-a')
  assert.equal((await f.invoke()).id, result.id); assert.equal(f.state.calls, 1)
  assert.ok(f.state.headers.every(h => h === 'Bearer synthetic-tool-credential'))
  await assert.rejects(f.invoke({ ...f.input, arguments: { a: 8, b: 5 } }), { code: 'TOOL_CALL_CONFLICT' })
  assert.ok(!JSON.stringify(await f.store.calls('org-a')).includes('synthetic-iam-credential'))
})
void test('forged task/org/token/scope and departed user never invoke tools', async t => {
  const f = await fixture(t)
  await assert.rejects(f.invoke({ ...f.input, task_id: 'foreign' }), { code: 'EXECUTION_INACTIVE' })
  await assert.rejects(f.gateway.invoke('org-b', f.input, 'synthetic-iam-credential'), { code: 'EXECUTION_INACTIVE' })
  await assert.rejects(f.invoke(f.input, 'wrong'), { code: 'EXECUTION_INACTIVE' })
  f.grant.request.permissions = []
  await assert.rejects(f.invoke(), { code: 'TOOL_AUTHORIZATION_INVALID' })
  f.grant.request.permissions = [{ operation: 'tool.invoke', resource: f.review.resource }]
  f.state.member = false
  assert.equal((await f.invoke()).errorCode, 'TOOL_USER_DENIED'); assert.equal(f.state.calls, 0)
})
void test('explicit write classification cannot be overridden by remote readOnlyHint', async t => {
  const f = await fixture(t)
  await f.store.saveReview({ ...f.review, action: 'write', revision: 'revision-write' }, f.review.revision)
  assert.equal((await f.invoke()).errorCode, 'TOOL_CONFIRMATION_REQUIRED'); assert.equal(f.state.calls, 0)
})
void test('disabled tool review, changed descriptor and invalid arguments are rejected before tool side effect', async t => {
  const f = await fixture(t)
  f.state.description = 'Changed tool meaning'
  assert.equal((await f.invoke()).errorCode, 'TOOL_DESCRIPTOR_CHANGED')
  const invalid = await f.invoke({ ...f.input, call_id: 'invalid', arguments: { a: 'bad', b: 2 } })
  assert.equal(invalid.errorCode, 'INVALID_TOOL_ARGUMENTS')
  await f.store.saveReview({ ...f.review, enabled: false, revision: 'revision-disabled' }, f.review.revision)
  assert.equal((await f.invoke({ ...f.input, call_id: 'disabled' })).errorCode, 'TOOL_REVIEW_REQUIRED')
  assert.equal(f.state.calls, 0)
})
void test('loss of tool response remains unknown on repeat and a new controller never redispatches', async t => {
  const f = await fixture(t); f.state.fail = true
  const first = await f.invoke(); assert.equal(first.status, 'unknown'); assert.equal(f.state.calls, 1)
  const other = new AgentToolGateway(new ToolGatewayStore(f.db), f.deps)
  const repeat = await other.invoke('org-a', f.input, 'synthetic-iam-credential')
  assert.equal(repeat.id, first.id); assert.equal(repeat.status, 'unknown'); assert.equal(f.state.calls, 1)
})
void test('asset suspension and late IAM revocation stop prepared tool dispatch', async t => {
  const f = await fixture(t); f.state.suspendOnCheck = 2
  assert.equal((await f.invoke()).errorCode, 'AGENT_SUSPENSION_ACTIVE'); assert.equal(f.state.calls, 0)
  f.grant.status = 'revoked'
  await assert.rejects(f.invoke(), { code: 'EXECUTION_INACTIVE' })
})
void test('review revision fencing and duplicate concurrent submission', async t => {
  const f = await fixture(t)
  const outputs = await Promise.all([f.invoke(), f.invoke()])
  assert.equal(outputs[0].id, outputs[1].id); assert.equal(f.state.calls, 1)
  await assert.rejects(f.store.saveReview({ ...f.review, revision: 'stale' }, 'wrong'), { code: 'TOOL_REVIEW_CONFLICT' })
  const call = await f.store.reserve('org-a', 'prepared-call', 'digest', f.grant, f.review)
  await f.store.saveReview({ ...f.review, revision: 'changed' }, f.review.revision)
  await assert.rejects(f.store.dispatch(call.call), { code: 'TOOL_REVIEW_CHANGED' })
})
void test('schema profile rejects references, nested/unbounded fields and undeclared inputs', () => {
  for (const schema of [ { type: 'object', $ref: 'http://bad/schema', additionalProperties: false }, { type: 'object', properties: { nested: { type: 'object' } }, additionalProperties: false }, { type: 'object', properties: {}, additionalProperties: true } ]) {
    assert.throws(() => validateToolArguments(schema as Parameters<typeof validateToolArguments>[0]), { code: 'TOOL_SCHEMA_UNSUPPORTED' })
  }
})
void test('a reviewed record profile can dispatch bounded nested selections without changing the scalar default', async t => {
  const f = await fixture(t, true)
  const descriptor = (await f.gateway.discover('org-a', f.server.id)).find(item => item.tool.name === 'read_selection')!
  assert.equal(descriptor.tool._meta?.['moss/input-profile'], 'bounded-record-v1')
  assert.throws(() => validateToolArguments(descriptor.tool.inputSchema), { code: 'TOOL_SCHEMA_UNSUPPORTED' })
  const review = await f.gateway.approve('org-a', f.server.id, 'manager', { tool: 'read_selection', digest: descriptor.digest,
    action: 'read', sensitive: false, outbound: false, enabled: true, expected_revision: null })
  f.grant.request.permissions.push({ operation: 'tool.invoke', resource: review.resource })
  const input = { ...f.input, call_id: 'read-record', resource: review.resource,
    arguments: { id: 'catalog', selection: { kind: 'connected', roots: ['stable-object'], max_nodes: 20 } } }
  const result = await f.invoke(input)
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.result?.content, [{ type: 'text', text: JSON.stringify(input.arguments) }])
  assert.equal((await f.invoke(input)).id, result.id)
  assert.equal(f.state.recordCalls, 1)
  for (const [index, selection] of ['invalid', { key: 'x'.repeat(8193) }, { items: Array.from({ length: 101 }, () => 1) },
    { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }, JSON.parse('{"__proto__":{"polluted":true}}')].entries()) {
    const rejected = await f.invoke({ ...input, call_id: 'invalid-record-' + index, arguments: { id: 'catalog', selection } })
    assert.equal(rejected.errorCode, 'INVALID_TOOL_ARGUMENTS')
  }
  assert.equal(f.state.recordCalls, 1, 'invalid records never reach the remote tool')
  f.state.recordProfile = undefined
  assert.equal((await f.invoke({ ...input, call_id: 'profile-changed' })).errorCode, 'TOOL_DESCRIPTOR_CHANGED')
  assert.equal(f.state.recordCalls, 1, 'a remote profile change needs a new reviewed descriptor')
})
void test('record profiles retain JSON bounds and refuse unsupported schemas or undeclared versions', () => {
  const tool = { name: 'record', _meta: { 'moss/input-profile': 'bounded-record-v1' }, inputSchema: {
    type: 'object' as const, properties: { options: { type: 'object', additionalProperties: {} } }, required: ['options'], additionalProperties: false,
  } }
  validateReviewedToolArguments(tool, { options: { values: [null, true, 3, 'text'] } })
  const cycle: Record<string, unknown> = {}; cycle.self = cycle
  for (const options of [Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['key' + i, i])),
    { a: Array(100).fill(1), b: Array(100).fill(1), c: Array(100).fill(1) },
    { a: 'a'.repeat(8192), b: 'b'.repeat(8192), c: 'c'.repeat(8192), d: 'd'.repeat(8192) },
    { value: undefined }, { value: Number.POSITIVE_INFINITY }, { value: new Date() }, cycle]) {
    assert.throws(() => validateReviewedToolArguments(tool, { options }), { code: 'INVALID_TOOL_ARGUMENTS' })
  }
  for (const field of [{ type: 'object', additionalProperties: true }, { type: 'object', properties: {}, additionalProperties: false },
    { type: 'array', items: {} }, { $ref: 'https://foreign.invalid/schema' }]) {
    assert.throws(() => validateReviewedToolArguments({ ...tool, inputSchema: { ...tool.inputSchema, properties: { options: field } } }), { code: 'TOOL_SCHEMA_UNSUPPORTED' })
  }
  assert.throws(() => validateReviewedToolArguments({ ...tool, _meta: { 'moss/input-profile': 'unknown-version' } }), { code: 'TOOL_INPUT_PROFILE_UNSUPPORTED' })
})
void test('JSON transport denies redirects and SSE without following them', async t => {
  const server = createServer((_req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/leak' }); res.end() })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close())
  const client = new ToolProtocol({ endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, headers: {}, timeoutMs: 2000 }, AbortSignal.timeout(3000))
  await assert.rejects(client.connect()); await client.close()
})

void test('disable is an audited local operation even when the remote service is unavailable', async t => {
  const f = await fixture(t)
  await f.mcp.setMcpServerStatus('org-a', f.server.id, 'error', null)
  const disabled = await f.gateway.disable('org-a', f.server.id, 'manager', { resource: f.review.resource, expected_revision: f.review.revision })
  assert.equal(disabled.enabled, false); assert.notEqual(disabled.revision, f.review.revision)
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM agent_tool_review_audit'))?.n, 2)
  assert.equal(f.state.calls, 0)
})
void test('a prepared call cannot cross a suspend/reapprove generation and missing arguments are rejected', async t => {
  const f = await fixture(t)
  const call = await f.store.reserve('org-a', 'prepared-before-suspend', 'digest', f.grant, f.review)
  await f.db.run("UPDATE agent_asset_gates SET generation = generation + 1 WHERE org_id = 'org-a' AND asset_id = 'asset-a'")
  await assert.rejects(f.store.dispatch(call.call), { code: 'TOOL_ASSET_GENERATION_CHANGED' })
  const { arguments: _args, ...missing } = f.input
  assert.equal((await f.invoke(missing)).errorCode, 'INVALID_TOOL_ARGUMENTS'); assert.equal(f.state.calls, 0)
})
void test('management GETs are read-only, hide tool output, require live admin and reject identity overrides', async t => {
  const { dispatchToolManagement } = await import('./toolGatewayRoutes.js')
  const f = await fixture(t); await f.invoke()
  const actor = { userId: 'manager', orgId: 'org-a' } as import('../auth/token.js').AuthContext
  const service = { gateway: f.gateway, authorize: async (auth: typeof actor) => { if (auth.userId !== 'manager') throw new ExternalProviderError(403, 'ADMIN_REQUIRED') } }
  const path = `/api/v1/admin/mcp-servers/${f.server.id}/agent-tools`
  await assert.rejects(dispatchToolManagement(service, { ...actor, userId: 'member' }, 'GET', path, {}), { code: 'ADMIN_REQUIRED' })
  const before = await f.db.get('SELECT total_changes() AS n')
  const calls = await dispatchToolManagement(service, actor, 'GET', `${path}/calls`, {})
  assert.ok(!JSON.stringify(calls).includes('"result":')); assert.ok(JSON.stringify(calls).includes('task-a'))
  await dispatchToolManagement(service, actor, 'GET', path, {})
  assert.deepEqual(await f.db.get('SELECT total_changes() AS n'), before)
  assert.deepEqual(await dispatchToolManagement(service, { ...actor, orgId: 'org-b' }, 'GET', `${path}/calls`, {}), [])
  await assert.rejects(dispatchToolManagement(service, actor, 'POST', `${path}/disable`, { resource: f.review.resource, expected_revision: f.review.revision, initiated_by: 'someone' }), { code: 'INVALID_TOOL_REQUEST' })
})
void test('an in-flight remote call remains in-flight after authorization is disabled, and new calls are denied', async t => {
  const f = await fixture(t)
  let started!: () => void, release!: () => void
  const reached = new Promise<void>(resolve => { started = resolve })
  f.state.hold = () => new Promise(resolve => { release = resolve; started() })
  const pending = f.invoke(); await reached
  await f.gateway.disable('org-a', f.server.id, 'manager', { resource: f.review.resource, expected_revision: f.review.revision })
  assert.equal((await f.store.calls('org-a'))[0].status, 'dispatching')
  assert.equal((await f.invoke({ ...f.input, call_id: 'after-disable' })).errorCode, 'TOOL_REVIEW_REQUIRED')
  release(); assert.equal((await pending).status, 'completed'); assert.equal(f.state.calls, 1)
})

void test('PostgreSQL independent tool controllers reserve once, fence reapproval and keep crash replay read-only', { skip: !process.env.MOSS_PG_TEST_URL }, async t => {
  const f = await fixture(t), pg = await import('pg'), { PgDriver } = await import('../db/driver.js'), { randomUUID } = await import('node:crypto')
  const schema = `agent_tools_${randomUUID().replaceAll('-', '')}`, connectionString = process.env.MOSS_PG_TEST_URL!
  const admin = new pg.default.Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`)
  const dbs = [0, 1].map(() => new PgDriver(new pg.default.Pool({ connectionString, options: `-c search_path=${schema}` }) as never))
  try {
    const stores = dbs.map(db => new ToolGatewayStore(db)); await Promise.all(stores.map(s => s.ready))
    await stores[0].saveReview(f.review, null)
    const [a, b] = await Promise.all(stores.map(s => s.reserve('org-a', 'shared', 'digest', f.grant, f.review)))
    assert.equal(a.call.id, b.call.id); assert.equal(Number(a.created) + Number(b.created), 1)
    await stores[0].dispatch(a.call)
    assert.equal((await stores[1].calls('org-a'))[0].status, 'dispatching')
    assert.equal((await stores[1].reserve('org-a', 'shared', 'digest', f.grant, f.review)).created, false)
    const pending = await stores[0].reserve('org-a', 'before-review', 'digest', f.grant, f.review)
    await stores[1].saveReview({ ...f.review, revision: 'revoked', enabled: false }, f.review.revision)
    await assert.rejects(stores[0].dispatch(pending.call), { code: 'TOOL_REVIEW_CHANGED' })
    await dbs[1].run("UPDATE agent_asset_gates SET operation_id = 'suspend' WHERE org_id = 'org-a' AND asset_id = 'asset-a'")
    await assert.rejects(stores[0].reserve('org-a', 'after-stop', 'digest', f.grant, f.review), { code: 'AGENT_SUSPENSION_ACTIVE' })
    assert.deepEqual(await stores[1].calls('org-b'), [])
  } finally { await Promise.all(dbs.map(d => d.close())); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() }
})

void test('tool review requires both live organization administration and MCP management scope', async () => {
  const { assertAgentToolManager } = await import('./toolGatewayRoutes.js')
  const auth = { role: 'admin', scopes: ['admin:users', 'admin:mcp'] } as import('../auth/token.js').AuthContext
  assert.doesNotThrow(() => assertAgentToolManager(auth, { status: 'active', role: 'admin' }))
  for (const current of [null, { status: 'locked', role: 'admin' }, { status: 'active', role: 'user' }]) assert.throws(() => assertAgentToolManager(auth, current), { code: 'ADMIN_REQUIRED' })
  for (const scopes of [[], ['admin:users'], ['admin:mcp']]) assert.throws(() => assertAgentToolManager({ ...auth, scopes }, { status: 'active', role: 'admin' }), { code: 'ADMIN_REQUIRED' })
  assert.throws(() => assertAgentToolManager({ ...auth, role: 'user', scopes: ['*'] }, { status: 'active', role: 'admin' }), { code: 'ADMIN_REQUIRED' })
})
