import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { startProtocolReference } from '../testing/standardProtocolReference.js'
import { discoverStandardManifest, StandardHttpAdapter, isStandardProtocol } from './standardHttpAdapter.js'
import { CustomHttpAdapter, type ProviderRequest } from './customHttpAdapter.js'
import { parseCustomManifest, customManifestDigest } from './manifest.js'
import type { ProviderInvocation } from './adapter.js'
import type { TaskGrantProfile, TaskExecutionContext } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import { TOKEN_HEADER } from './taskExecutionContext.js'

for (const protocol of ['http', 'openai', 'mcp', 'a2a'] as const) {
  void test(`${protocol}: actual HTTP reference routes scoped task identity to tool then model; discovery/polling never carry it`, async t => {
    const calls: { path: string; body: Record<string, unknown> }[] = [], wire: { url: string; headers: Headers; body: string }[] = []
    const profile: TaskGrantProfile = { profile: 'sudo-task-grant/v1', model_resource: 'model:lab', tool_resources: ['mcp:server/add_numbers'], max_model_calls: 1 }
    const ids = { task_id: randomUUID(), attempt_id: randomUUID(), session_id: randomUUID(), org_id: 'org' }
    let rejectTool = false
    const gateway = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, 'Bearer sk-synthetic-task-credential')
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(body.task_id, ids.task_id); assert.equal(body.grant_id, 'grant-a')
      assert.equal(body.spec_digest, 'sha256:' + 'a'.repeat(64))
      calls.push({ path: req.url!, body })
      res.setHeader('content-type', 'application/json')
      if (req.url!.includes('agent-tools')) {
        if (rejectTool) { res.writeHead(403); res.end(JSON.stringify({ success: false })); return }
        assert.equal(body.resource, profile.tool_resources[0]); assert.deepEqual(body.arguments, { a: 35, b: 7 })
        res.end(JSON.stringify({ success: true, data: { status: 'completed', taskId: ids.task_id, result: { content: [{ type: 'text', text: '42' }] } } }))
      } else {
        assert.equal(body.resource, profile.model_resource)
        assert(!JSON.stringify(body).includes('sk-synthetic-task-credential'))
        assert.match(body.input.messages[0].content, /Tool data/)
        res.end(JSON.stringify({ success: true, data: { status: 'completed', task_id: ids.task_id, output: { text: '42' } } }))
      }
    })
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve))
    t.after(() => { gateway.closeAllConnections(); gateway.close() })
    const gatewayOrigin = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`
    const reference = await startProtocolReference(protocol, 'synthetic-provider-key', 0, { profile, gatewayOrigin, orgId: 'org' })
    t.after(reference.close)
    const protocols = { openai: 'openai-chat-completions/v1', mcp: 'mcp/2025-06-18', a2a: 'a2a/0.3.0' } as const
    const discovered = protocol === 'http' ? reference.legacyManifest() : await discoverStandardManifest({ endpoint: reference.endpoint, key: 'synthetic-provider-key', protocol: protocols[protocol], target: reference.target, agentId: reference.target, name: 'Managed reference' }, AbortSignal.timeout(5000))
    const manifest = parseCustomManifest(JSON.stringify({ ...discovered, execution_context: profile })), digest = customManifestDigest(manifest)
    const request: ProviderRequest = async (url, init) => { wire.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body ?? '') }); return fetch(url, init) }
    const adapter = isStandardProtocol(manifest) ? new StandardHttpAdapter({ manifest, digest }, request) : new CustomHttpAdapter({ manifest, digest }, request)
    let grants = 0, dispatches = 0
    const input: ProviderInvocation = { ...ids, binding_id: 'binding', external_agent_id: reference.target, source_digest: digest, endpoint: reference.endpoint,
      policy: { orgIds: ['org'], endpoints: [reference.endpoint], timeoutMs: 5000 }, key: 'synthetic-provider-key', query: '35 + 7', provider_session_id: null, end_user: 'synthetic-user', signal: AbortSignal.timeout(5000),
      authorize_dispatch: async () => { assert.equal(grants, 1); dispatches++ }, execution_context: async (): Promise<TaskExecutionContext> => { grants++; return { ...ids, ...profile, grant_id: 'grant-a', spec_digest: 'sha256:' + 'a'.repeat(64), expires_at: Date.now() + 60000,
        model_gateway: `${gatewayOrigin}/api/v1/agent-models/org/invoke`, tool_gateway: `${gatewayOrigin}/api/v1/agent-tools/org/invoke`, access_token: 'sk-synthetic-task-credential' } } }
    const result = await adapter.invoke(input, async () => {})
    assert.equal(result.text, '42'); assert.equal(result.status, 'succeeded'); assert.equal(dispatches, 1)
    assert.equal(calls.length, 2); assert(calls[0].path.includes('agent-tools')); assert(calls[1].path.includes('agent-models'))
    assert.equal(wire.filter(r => r.headers.has(TOKEN_HEADER)).length, 1)
    assert(wire.every(r => r.headers.get('authorization') === 'Bearer synthetic-provider-key' && !r.body.includes('sk-synthetic-task-credential')))
    assert(!JSON.stringify(result).includes('sk-synthetic-task-credential'))
    // Tool denial fails the Agent and prevents a model call. No fallback or hidden retry.
    rejectTool = true; grants = 0
    const before = calls.length
    if (protocol === 'mcp') assert.equal((await adapter.invoke(input, async () => {})).status, 'failed')
    else await assert.rejects(adapter.invoke(input, async () => {}))
    assert.equal(calls.length, before + 1)
  })
}
