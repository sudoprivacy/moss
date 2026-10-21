/** Local synthetic reference agents. No model credentials, external network calls or customer data. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

export type ReferenceProtocol = 'openai' | 'mcp' | 'a2a' | 'http'
export interface ReferenceControls {
  revision: number
  fault: 'none' | 'disconnect' | 'wrong-id' | 'tool-output' | 'message' | 'task-swap' | 'rpc-error' | 'waiting' | 'failed' | 'redirect'
  invocations: number
  polls: number
  traces: string[]
}
export const referenceAnswer = (query: string): string => {
  const match = /^\s*(-?\d{1,6})\s*([+*])\s*(-?\d{1,6})\s*$/.exec(query)
  return match ? String(match[2] === '+' ? Number(match[1]) + Number(match[3]) : Number(match[1]) * Number(match[3])) : `Reference: ${query}`
}
export async function startProtocolReference(protocol: ReferenceProtocol, key: string, port = 0) {
  const control: ReferenceControls = { revision: 1, fault: 'none', invocations: 0, polls: 0, traces: [] }
  let endpoint = ''
  const tasks = new Map<string, { context: string; query: string; polls: number }>()
  const target = 'reference-agent'
  const legacyManifest = () => ({ api_version: 'agent-federation.sudo.dev/v1alpha1', kind: 'CustomAgentManifest', provider_kind: 'custom_http',
    external_agent_id: target, name: 'Local HTTP reference', source_revision: `reference-${control.revision}`, protocol: 'agent-http.sudo.dev/v1alpha1',
    execution_mode: 'external_hosted', input_profile: 'query_only_v1', output_profile: 'text_v1', capabilities: {
      supports_streaming: false, supports_cancel: false, supports_resume: false, supports_idempotency: false,
      supports_tool_events: false, supports_trace_export: false, supports_version_pin: false, supports_human_approval: false,
    } })
  const json = (res: ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  async function route(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.authorization !== `Bearer ${key}`) return json(res, { error: 'unauthorized' }, 401)
    if (control.fault === 'redirect') { res.writeHead(307, { location: 'http://127.0.0.1:1/private' }); res.end(); return }
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of req) { size += chunk.length; if (size > 65536) return json(res, { error: 'limit' }, 413); chunks.push(Buffer.from(chunk)) }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    if (protocol === 'mcp' && req.url === '/v1') {
      const server = new McpServer({ name: 'reference-agent-mcp-server', version: String(control.revision) })
      server.registerTool(target, { title: 'Reference arithmetic Agent', description: `Deterministic synthetic Agent revision ${control.revision}`,
        inputSchema: { query: z.string().max(8000) }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async ({ query }) => {
        control.invocations++; control.traces.push(String(req.headers.traceparent ?? ''))
        if (control.fault === 'disconnect') { res.destroy(); throw new Error('reference disconnect') }
        return control.fault === 'failed' ? { isError: true, content: [{ type: 'text', text: 'Synthetic failure' }] }
          : { content: [{ type: 'text', text: referenceAnswer(query) }] }
      })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await server.connect(transport)
      res.on('close', () => { void transport.close(); void server.close() })
      await transport.handleRequest(req, res, body)
      return
    }
    if (protocol === 'openai' && req.method === 'GET' && req.url === `/v1/models/${target}`) return json(res, { id: target, object: 'model', created: control.revision, owned_by: 'local-reference' })
    if (protocol === 'openai' && req.method === 'POST' && req.url === '/v1/chat/completions') {
      if (body.model !== target || body.stream !== false || body.n !== 1 || body.messages?.length !== 1 || body.messages[0].role !== 'user' || typeof body.messages[0].content !== 'string') return json(res, { error: 'bad request' }, 400)
      control.invocations++; control.traces.push(String(req.headers.traceparent ?? ''))
      if (control.fault === 'disconnect') { res.destroy(); return }
      return json(res, { id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', model: target, created: 1,
        choices: [{ index: 0, finish_reason: control.fault === 'tool-output' ? 'tool_calls' : 'stop', message: { role: 'assistant', content: referenceAnswer(body.messages[0].content) } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      })
    }
    if (protocol === 'http' && req.url === `/v1/agents/${target}/manifest`) return json(res, legacyManifest())
    if (protocol === 'http' && req.method === 'POST' && req.url === '/v1/invoke') {
      control.invocations++; control.traces.push(String(req.headers.traceparent ?? ''))
      return json(res, { api_version: 'agent-http.sudo.dev/v1alpha1', kind: 'AgentResult', invocation_id: body.invocation_id,
        provider_run_id: randomUUID(), status: 'succeeded', output: { text: referenceAnswer(body.query) } })
    }
    if (protocol === 'a2a' && req.method === 'GET' && req.url === '/.well-known/agent-card.json') return json(res, {
      protocolVersion: '0.3.0', name: 'Local A2A reference', description: 'Single-skill synthetic arithmetic Agent', url: endpoint,
      preferredTransport: 'JSONRPC', version: String(control.revision), capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
      skills: [{ id: target, name: 'Reference', description: 'Synthetic arithmetic', tags: ['reference'] }],
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, security: [{ bearer: [] }],
    })
    if (protocol === 'a2a' && req.method === 'POST' && req.url === '/v1' && body.jsonrpc === '2.0') {
      const reply = (result: unknown) => json(res, { jsonrpc: '2.0', id: control.fault === 'wrong-id' ? 'foreign-request' : body.id, result })
      if (body.method === 'message/send') {
        if (body.params?.message?.kind !== 'message' || body.params.message.role !== 'user' || body.params.message.parts?.[0]?.kind !== 'text' || !body.params.message.messageId) return json(res, { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'invalid params' } })
        control.invocations++; control.traces.push(String(req.headers.traceparent ?? ''))
        if (control.fault === 'disconnect') { res.destroy(); return }
        if (control.fault === 'rpc-error') return json(res, { jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'private reference error' } })
        const query = body.params.message.parts[0].text
        if (control.fault === 'message') return reply({ kind: 'message', role: 'agent', messageId: randomUUID(), parts: [{ kind: 'text', text: referenceAnswer(query) }] })
        if (tasks.size > 1000) return json(res, { error: 'limit' }, 429)
        const taskId = randomUUID(), context = randomUUID()
        tasks.set(taskId, { query, context, polls: 0 })
        return reply({ kind: 'task', id: taskId, contextId: context, status: { state: 'working' } })
      }
      if (body.method === 'tasks/get') {
        control.polls++
        const task = tasks.get(body.params.id)
        if (!task) return json(res, { jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'Task not found' } })
        task.polls++
        return reply({ kind: 'task', id: control.fault === 'task-swap' ? randomUUID() : body.params.id, contextId: task.context,
          status: { state: control.fault === 'waiting' ? 'input-required' : control.fault === 'failed' ? 'failed' : 'completed' },
          artifacts: [{ artifactId: randomUUID(), parts: [{ kind: 'text', text: referenceAnswer(task.query) }] }],
        })
      }
    }
    json(res, { error: 'unsupported' }, 404)
  }
  const server = createServer((req, res) => { void route(req, res).catch(() => { if (!res.headersSent && !res.destroyed) json(res, { error: 'reference error' }, 500) }) })
  server.requestTimeout = 10_000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing reference address')
  endpoint = `http://127.0.0.1:${address.port}/v1`
  return { endpoint, target, control, legacyManifest, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}
