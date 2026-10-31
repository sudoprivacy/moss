import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { TestContext } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { DirectConnectStore } from '../db.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { AccountMemberships } from '../identity/accountMemberships.js'
import { McpStore } from '../mcp/db.js'
import { mcpServerDigest } from '../mcp/reviewedAccess.js'
import { ToolGatewayStore } from '../agentFederation/toolGatewayStore.js'
import { ToolProtocol } from '../agentFederation/toolProtocol.js'
import { registerModelContextReadTool, registerModelContextTool } from './contextWorker.js'
import { WORKER_REVIEW_PROFILE } from './workerReviewProtocol.js'
import { createSessionRunnerHost } from './runnerHost.js'

export async function createReviewHostFixture(t: TestContext, humanReview = false) {
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
  const state = { text: 'Current policy A', revision: 'a'.repeat(64), calls: 0, reviewCalls: 0,
    token: null as string | null, beforeReply: undefined as (() => Promise<void>) | undefined }
  const http = createServer((req, res) => {
    void (async () => {
      if (state.token && req.headers.authorization !== `Bearer ${state.token}`) { res.writeHead(401); res.end(); return }
      if (humanReview && req.url === '/review') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { resource: string }
        state.reviewCalls++
        await state.beforeReply?.()
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ format: WORKER_REVIEW_PROFILE, authority_ref: 'authority', model_ref: 'model',
          resource_ref: input.resource, source_refs: ['source'], scope: 'full-registered-model',
          result: { revision: state.revision, context_digest: 'b'.repeat(64) } }))
        return
      }
      const sdk = new McpServer({ name: 'registered-worker', version: '1.0.0' })
      registerModelContextTool(sdk, { authorityRef: 'authority', modelRef: 'model', sourceRefs: ['source'] }, async () => {
        state.calls++
        await state.beforeReply?.()
        return { format: 'sudograph-agent-context/v1', revision: state.revision, context_digest: 'b'.repeat(64), text: state.text }
      })
      if (humanReview) registerModelContextReadTool(sdk, async () => ({}), { hostReview: true })
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
  let descriptors
  try { await protocol.connect(); descriptors = await protocol.descriptors() } finally { await protocol.close() }
  for (const descriptor of descriptors) {
    await reviews.saveReview({ ...descriptor, orgId: 'org', resource: `mcp:${server.id}/${descriptor.tool.name}`, serverId: server.id,
      serverDigest: mcpServerDigest(server), action: 'read', sensitive: true,
      outbound: false, enabled: true, revision: descriptor.tool.name + '-review', reviewedBy: 'manager', reviewedAt: Date.now() }, null)
  }
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

