import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test, type TestContext } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { DirectConnectStore } from '../db.js'
import { RuntimeService } from '../runtimeService.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { AccountMemberships } from '../identity/accountMemberships.js'
import { McpStore } from '../mcp/db.js'
import { mcpServerDigest } from '../mcp/reviewedAccess.js'
import { ToolGatewayStore } from '../agentFederation/toolGatewayStore.js'
import { ToolProtocol } from '../agentFederation/toolProtocol.js'
import { NexusClient } from '../nexus/nexusClient.js'
import { orgScopedNamespace, secretSubject } from '../secrets/secretSubject.js'
import { registerModelContextTool } from './contextWorker.js'
import { createSessionRunnerHost } from './runnerHost.js'
import { createModelSession, getSessionProject, listSessionProjects, parseOntologyProjectId, withSessionProjectAccess } from './sessionProjects.js'

async function fixture(t: TestContext) {
  const store = new DirectConnectStore(':memory:')
  const auth = new AuthCenterDb(store)
  await auth.createOrganization('org', 'Fixture organization', Date.now())
  await auth.createUser({ id: 'alice', orgId: 'org', email: 'alice@example.invalid', name: 'alice', displayName: null,
    departmentId: null, role: 'admin', status: 'active', localAuth: false, tokenLimit: null,
    passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, createdAt: Date.now(), extUserId: null })
  await new AccountMemberships(store.driver).ensureExisting({ id: 'alice', orgId: 'org', phone: null, createdAt: Date.now() })
  await store.createSession({ sessionId: 'session', transcriptSessionId: 'native-history', transcriptPath: '/unused/transcript',
    userId: 'alice', orgId: 'org', role: 'admin', scopes: ['*'], cwd: '/unused', runtime: { type: 'cohost', engine: 'scode' },
    status: 'active', desiredState: 'active' })
  const state = { text: 'Current policy A', calls: 0, token: null as string | null, beforeReply: undefined as (() => Promise<void>) | undefined }
  const http = createServer((req, res) => {
    void (async () => {
      if (state.token && req.headers.authorization !== `Bearer ${state.token}`) { res.writeHead(401); res.end(); return }
      const sdk = new McpServer({ name: 'registered-worker', version: '1.0.0' })
      registerModelContextTool(sdk, { authorityRef: 'authority', modelRef: 'model', sourceRefs: ['source'] }, async () => {
        state.calls++
        await state.beforeReply?.()
        return { format: 'sudograph-agent-context/v1', revision: 'a'.repeat(64), context_digest: 'b'.repeat(64), text: state.text }
      })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.once('close', () => { void sdk.close() })
      await sdk.connect(transport)
      await transport.handleRequest(req, res)
    })().catch(() => res.destroy())
  })
  t.after(async () => {
    http.closeAllConnections()
    if (http.listening) await new Promise<void>(r => http.close(() => r()))
    await store.close()
  })
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r))
  const address = http.address()
  assert(address && typeof address !== 'string')
  const mcp = new McpStore(store.driver), reviews = new ToolGatewayStore(store.driver)
  const server = await mcp.createMcpServer('org', { name: 'Registered model', scope: 'org', owner_type: 'system', owner_id: 'org',
    mcp_type: 'http', url: `http://127.0.0.1:${address.port}/mcp`, auth_type: 'none', allow_read: true,
    allow_write: false, allow_read_sensitive_fields: true }, 'manager')
  await mcp.setMcpServerStatus('org', server.id, 'enabled', 'manager')
  await mcp.upsertMcpPolicy('org', { allow_http_sse_mcp: true, allow_external_network: true, domain_whitelist_json: ['127.0.0.1'] }, 'manager')
  const protocol = new ToolProtocol({ endpoint: server.url!, headers: {}, timeoutMs: 5000 }, AbortSignal.timeout(10000))
  let descriptor
  try { await protocol.connect(); descriptor = (await protocol.descriptors())[0] } finally { await protocol.close() }
  assert(descriptor)
  await reviews.saveReview({ ...descriptor, orgId: 'org', resource: `mcp:${server.id}/sudograph_context`, serverId: server.id,
    serverDigest: mcpServerDigest(server), action: 'read', sensitive: true,
    outbound: false, enabled: true, revision: 'review', reviewedBy: 'manager', reviewedAt: Date.now() }, null)
  const host = await createSessionRunnerHost(store, 'session')
  assert.deepEqual(host, {}, 'ordinary sessions do not initialize a model host')
  const project = await store.ontologyProjects.register({ orgId: 'org', authorityRef: 'authority', workerRef: server.id,
    modelRef: 'model', sourceRefs: ['source'] })
  // The trusted registrar's binding policy is exercised through the same production host below.
  await store.ontologyProjects.bind({ sessionId: 'session', projectId: project.projectId, orgId: 'org', userId: 'alice' }, { authorize: async () => {} })
  const production = await createSessionRunnerHost(store, 'session')
  const reader = await store.ontologyProjects.runnerContext({ sessionId: 'session', orgId: 'org', userId: 'alice' }, production.ontologyContext)
  assert(reader)
  t.after(() => production.close?.())
  return { store, mcp, server, project, production, state, read: () => reader({ sessionId: 'session', nativeSessionId: 'native-history' }) }
}

void test('project discovery returns only current authorized canonical references without reading business context', async t => {
  const f = await fixture(t)
  await f.store.ontologyProjects.register({ orgId: 'org', authorityRef: 'hidden', workerRef: 'unreviewed-worker', modelRef: 'hidden', sourceRefs: ['hidden-source'] })
  await f.store.ontologyProjects.register({ orgId: 'other', authorityRef: 'foreign', workerRef: f.server.id, modelRef: 'foreign', sourceRefs: ['foreign-source'] })
  assert.deepEqual(await listSessionProjects(f.store, { orgId: 'org', userId: 'alice' }), { projects: [{
    project_id: f.project.projectId, authority_ref: 'authority', model_ref: 'model', source_refs: ['source'],
  }] })
  assert.equal(f.state.calls, 0)
  await f.mcp.updateMcpServer('org', f.server.id, { visible_to: { user_ids: [] } }, 'manager')
  assert.deepEqual(await listSessionProjects(f.store, { orgId: 'org', userId: 'alice' }), { projects: [] })
})

void test('project filtering narrows existing session ownership and excludes unbound, stale and deleted sessions', async t => {
  const f = await fixture(t)
  const other = await f.store.ontologyProjects.register({ orgId: 'org', authorityRef: 'other',
    workerRef: f.server.id, modelRef: 'other', sourceRefs: ['source'] })
  const create = async (sessionId: string, userId: string, projectId?: string) => {
    await f.store.createSession({ sessionId, transcriptSessionId: sessionId, transcriptPath: '/unused/transcript',
      orgId: 'org', userId, role: 'member', scopes: [], cwd: '/unused',
      runtime: { type: 'cohost', engine: 'scode' }, status: 'active', desiredState: 'active' })
    if (projectId) await f.store.ontologyProjects.bind({ sessionId, orgId: 'org', userId, projectId }, { authorize: async () => {} })
  }
  await create('ordinary', 'alice')
  await create('different-project', 'alice', other.projectId)
  await create('another-owner', 'bob', f.project.projectId)
  await create('deleted', 'alice', f.project.projectId)
  await create('changed-owner', 'alice', f.project.projectId)
  await f.store.driver.run("UPDATE sessions SET deleted_at = 1 WHERE session_id = 'deleted'")
  await f.store.driver.run("UPDATE sessions SET user_id = 'bob' WHERE session_id = 'changed-owner'")
  const owner = { orgId: 'org', userId: 'alice' }
  // Exercise the runtime's forwarding method against real SQL without starting agent backends.
  const runtime = Object.assign(Object.create(RuntimeService.prototype) as RuntimeService, { store: f.store })
  const read = () => runtime.listSessions({ ...owner, ontologyProjectId: f.project.projectId })
  const result = await withSessionProjectAccess(f.store, owner, f.project.projectId, read)
  assert.deepEqual(result.map(item => item.sessionId), ['session'])
  assert.equal((await f.store.listSessions(owner)).length, 3, 'ordinary discovery retains its existing scope')
  assert.deepEqual((await f.store.listSessions({ ...owner, ontologyProjectId: other.projectId })).map(item => item.sessionId), ['different-project'])
  assert.equal((await f.store.listSessions({ ...owner, orgId: 'foreign', ontologyProjectId: f.project.projectId })).length, 0)
  await f.store.ontologyProjects.setEnabled('org', f.project.projectId, false)
  assert.equal((await read()).length, 0)
  assert.equal(f.state.calls, 0, 'discovery never loads business context or records')
})

void test('project session discovery refuses revoked access before and after listing and ordinary discovery stays independent', async t => {
  const f = await fixture(t)
  const owner = { orgId: 'org', userId: 'alice' }
  let reads = 0
  const read = async () => { reads++; return ['private-session'] }
  await f.mcp.updateMcpServer('org', f.server.id, { visible_to: { user_ids: [] } }, 'manager')
  await assert.rejects(withSessionProjectAccess(f.store, owner, f.project.projectId, read), error =>
    error instanceof Error && 'statusCode' in error && error.statusCode === 403)
  await assert.rejects(withSessionProjectAccess(f.store, { ...owner, orgId: 'foreign' }, f.project.projectId, read), /unavailable/)
  assert.equal(reads, 0)
  assert.deepEqual(await withSessionProjectAccess(f.store, owner, undefined, read), ['private-session'])
  assert.equal(reads, 1)
  await f.mcp.updateMcpServer('org', f.server.id, { visible_to: { user_ids: ['alice'] } }, 'manager')
  await assert.rejects(withSessionProjectAccess(f.store, owner, f.project.projectId, async () => {
    await f.mcp.updateMcpServer('org', f.server.id, { visible_to: { user_ids: [] } }, 'manager')
    return ['must-not-be-returned']
  }), error => error instanceof Error && 'statusCode' in error && error.statusCode === 403)
  assert.equal(f.state.calls, 0)
})

void test('project lifecycle changes fence an in-flight session listing', async t => {
  const f = await fixture(t)
  const owner = { orgId: 'org', userId: 'alice' }
  await assert.rejects(withSessionProjectAccess(f.store, owner, f.project.projectId, async () => {
    await f.store.ontologyProjects.setEnabled('org', f.project.projectId, false)
    await f.store.ontologyProjects.setEnabled('org', f.project.projectId, true)
    return ['must-not-be-returned']
  }), /unavailable/)
  assert.equal(f.state.calls, 0)
})

void test('a new canonical session is atomically bound before returning and can recover its owning project', async t => {
  const f = await fixture(t)
  const owner = { orgId: 'org', userId: 'alice' }
  assert.equal(parseOntologyProjectId(f.project.projectId), f.project.projectId)
  const input = { ...owner, sessionId: 'new-session', projectId: f.project.projectId }
  const created = await createModelSession(f.store, input, () => f.store.createSession({
    ...owner, sessionId: input.sessionId, transcriptSessionId: 'new-history', transcriptPath: '/unused/new-transcript',
    role: 'admin', scopes: ['*'], cwd: '/unused', runtime: { type: 'cohost', engine: 'scode' }, status: 'creating', desiredState: 'active',
  }))
  assert.equal(created.currentAttemptId, null)
  const bound = await f.store.ontologyProjects.resolveSession(created.sessionId)
  assert.equal(bound?.projectId, f.project.projectId)
  assert.equal(bound?.userId, owner.userId)
  assert.deepEqual(await getSessionProject(f.store, created.sessionId, owner), { project: {
    project_id: f.project.projectId, authority_ref: 'authority', model_ref: 'model', source_refs: ['source'],
  } })
  await assert.rejects(getSessionProject(f.store, created.sessionId, { ...owner, userId: 'bob' }), /unavailable/)
  await f.store.driver.run("UPDATE users SET status = 'disabled' WHERE id = 'alice'")
  await assert.rejects(getSessionProject(f.store, created.sessionId, owner), error =>
    error instanceof Error && 'statusCode' in error && error.statusCode === 403)
  assert.equal(f.state.calls, 0, 'entry does not load records or business context into client state')
})

void test('denied and interrupted canonical creation leave no ordinary session, creation event or binding', async t => {
  const f = await fixture(t)
  const owner = { orgId: 'org', userId: 'alice' }
  const input = { ...owner, sessionId: 'failed-session', projectId: f.project.projectId }
  const persist = () => f.store.createSession({ ...owner, sessionId: input.sessionId, transcriptSessionId: 'failed-history',
    transcriptPath: '/unused/failed', role: 'admin', scopes: ['*'], cwd: '/unused', runtime: { type: 'cohost', engine: 'scode' },
    status: 'creating', desiredState: 'active' })
  await assert.rejects(createModelSession(f.store, input, async () => { await persist(); throw new Error('Interrupt after session insert') }), /Interrupt after session insert/)
  assert.equal(await f.store.getSession(input.sessionId), null)
  assert.equal(await f.store.latestEvent(input.sessionId, 'session_created'), null)
  assert.equal(await f.store.ontologyProjects.resolveSession(input.sessionId), undefined)
  await f.mcp.updateMcpServer('org', f.server.id, { visible_to: { user_ids: [] } }, 'manager')
  let writes = 0
  await assert.rejects(createModelSession(f.store, input, async () => { writes++; return persist() }), error =>
    error instanceof Error && 'statusCode' in error && error.statusCode === 403)
  await assert.rejects(createModelSession(f.store, { ...input, orgId: 'other' }, async () => { writes++; return persist() }), /unavailable/)
  assert.equal(writes, 0)
  assert.equal(await f.store.getSession(input.sessionId), null)
  assert.equal(await f.store.ontologyProjects.resolveSession(input.sessionId), undefined)
  for (const value of [null, '', {}, '/srv/source.db', 'https://worker.invalid', { projectId: f.project.projectId }]) {
    assert.throws(() => parseOntologyProjectId(value), /Invalid ontology_project_id/)
  }
  assert.equal(parseOntologyProjectId(undefined), undefined)
})

void test('the production composition reads current DB policy and worker output without injected ports', async t => {
  const f = await fixture(t)
  assert.equal(await f.read(), 'Current policy A')
  f.state.text = 'Current policy B'
  assert.equal(await f.read(), 'Current policy B')
  await f.store.driver.run("UPDATE users SET status = 'disabled' WHERE id = 'alice'")
  await assert.rejects(f.read(), { code: 'TOOL_USER_DENIED' })
  assert.equal(f.state.calls, 2)
  assert.equal((await f.store.getSession('session'))?.transcriptSessionId, 'native-history')
})

for (const change of ['account', 'visibility', 'policy'] as const) {
  void test(`production ${change} revocation during I/O refuses output even for an admin session snapshot`, async t => {
    const f = await fixture(t)
    f.state.beforeReply = async () => {
      if (change === 'account') await f.store.driver.run("UPDATE human_accounts SET status = 'locked' WHERE id = 'alice'")
      if (change === 'visibility') await f.mcp.updateMcpServer('org', f.server.id, { visible_to: { user_ids: [] } }, 'manager')
      if (change === 'policy') await f.mcp.upsertMcpPolicy('org', { allow_external_network: false }, 'manager')
    }
    await assert.rejects(f.read())
    assert.equal(f.state.calls, 1)
    assert.equal((await f.mcp.queryAuditLog('org')).items[0]?.status, 'error')
  })
}

void test('production credentials use the configured external Nexus and current organization definitions', async t => {
  const f = await fixture(t)
  const previous = { mode: process.env.MOSS_NEXUS_MODE, endpoint: process.env.MOSS_NEXUS_ENDPOINT }
  t.after(() => {
    for (const [name, value] of [['MOSS_NEXUS_MODE', previous.mode], ['MOSS_NEXUS_ENDPOINT', previous.endpoint]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  })
  const id = await f.store.createConfigItem({ name: 'Worker credential', pinyin: 'model-worker', scope: 'system',
    scheme: 'bearer', bearer_prefix: 'Bearer', org_id: 'org' })
  await f.store.replaceConfigEntries(id, [{ config_key: 'token', name: 'Token', required: true }])
  await f.mcp.updateMcpServer('org', f.server.id, { auth_type: 'secret_ref', secret_ref: 'model-worker' }, 'manager')
  process.env.MOSS_NEXUS_MODE = 'embedded'
  await assert.rejects(f.read(), /configured external Nexus cluster/)
  assert.equal(f.state.calls, 0)
  process.env.MOSS_NEXUS_MODE = 'external'
  process.env.MOSS_NEXUS_ENDPOINT = 'http://127.0.0.1:19999'
  let secret: string | null = 'fixture-current-token'
  let secretReads = 0
  let closes = 0
  t.mock.method(NexusClient.prototype, 'listSecrets', async (namespace: string, subject: string) => {
    assert.equal(namespace, orgScopedNamespace('system:model-worker', 'org'))
    assert.equal(subject, secretSubject(namespace, ''))
    secretReads++
    return [{ namespace, key: 'token', value: secret, status: 'enabled', version: 1 }]
  })
  t.mock.method(NexusClient.prototype, 'close', () => { closes++ })
  f.state.token = secret
  assert.equal(await f.read(), 'Current policy A')
  const priorSecretReads = secretReads
  await f.store.updateConfigItem(id, { status: 0 })
  await assert.rejects(f.read(), { code: 'TOOL_CREDENTIAL_UNAVAILABLE' })
  assert.equal(secretReads, priorSecretReads, 'disabled credential definitions must not read Vault values')
  await f.store.updateConfigItem(id, { status: 1 })
  secret = null
  await assert.rejects(f.read(), { code: 'TOOL_CREDENTIAL_UNAVAILABLE' })
  assert.equal(f.state.calls, 1)
  assert.ok(secretReads >= 2)
  await f.production.close?.()
  assert.equal(closes, 1)
  await assert.rejects(f.read(), /host is closed/)
  const audit = JSON.stringify(await f.mcp.queryAuditLog('org'))
  assert.ok(!audit.includes('fixture-current-token') && !audit.includes('Current policy'))
})
