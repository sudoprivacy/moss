import { createHash, randomUUID } from 'node:crypto'
import type { CustomAgentManifest, ExternalRunBinding, ProtocolUsage, StandardHttpProtocol } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import { AGENT_FEDERATION_API, STANDARD_HTTP_PROTOCOLS } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import { canonicalEndpoint, ExternalProviderError } from '../externalProviders/policy.js'
import { createObserver, invocationContext, type ProviderAdapter, type ProviderInvocation, type ReviewedHttpManifest } from './adapter.js'
import { customManifestDigest, HTTP_CAPABILITIES, parseCustomManifest, parseExternalRunBinding } from './manifest.js'
import type { ProviderRequest } from './customHttpAdapter.js'

type Json = Record<string, unknown>
export type StandardManifest = CustomAgentManifest & { protocol: StandardHttpProtocol; target: string; discovery_digest: string; conversation_mode: 'single_turn' }
const failure = (code = 'INVALID_PROVIDER_RESULT'): never => { throw new ExternalProviderError(502, code) }
const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : failure()
const id = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value) ? value : failure()
const text = (value: unknown): string => typeof value === 'string' && value.length <= 128_000 ? value : failure('PROVIDER_RESPONSE_LIMIT')
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Json)[key])}`).join(',')}}` : JSON.stringify(value)
export const descriptorDigest = (value: unknown) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
export const isStandardProtocol = (manifest?: CustomAgentManifest): manifest is StandardManifest => Boolean(manifest && (STANDARD_HTTP_PROTOCOLS as readonly string[]).includes(manifest.protocol))

/** Fixed, administrator-approved HTTP destinations only; never follow discovered links. */
class Wire {
  readonly endpoint: string
  session?: string
  initialized = false
  constructor(endpoint: string, readonly key: string, readonly signal: AbortSignal, readonly request: ProviderRequest, readonly traceparent?: string) {
    this.endpoint = canonicalEndpoint(endpoint)
    if (!key || key.length > 1024 || /[\r\n]/.test(key)) throw new ExternalProviderError(400, 'INVALID_CREDENTIAL')
  }
  async send(url: string, body?: unknown, mcp = false, notification = false): Promise<unknown> {
    this.signal.throwIfAborted()
    const response = await this.request(url, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: this.signal,
      headers: { Authorization: `Bearer ${this.key}`, Accept: mcp ? 'application/json, text/event-stream' : 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(this.traceparent ? { traceparent: this.traceparent } : {}),
        ...(mcp && this.initialized ? { 'MCP-Protocol-Version': '2025-06-18' } : {}),
        ...(mcp && this.session ? { 'Mcp-Session-Id': this.session } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) { await response.body?.cancel(); return failure('PROVIDER_HTTP_ERROR') }
    const session = response.headers.get('mcp-session-id')
    if (mcp && session) {
      if (!/^[\x21-\x7e]{1,256}$/.test(session) || (this.session && this.session !== session)) { await response.body?.cancel(); return failure() }
      this.session = session
    }
    if (notification) {
      await response.body?.cancel()
      if (response.status !== 202 && response.status !== 204) return failure()
      return null
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) { await response.body?.cancel(); return failure('PROVIDER_JSON_PROFILE_REQUIRED') }
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
    let raw = '', size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) return JSON.parse(raw + decoder.decode()) as unknown
        size += chunk.value.byteLength
        if (size > 2 * 1024 * 1024) return failure('PROVIDER_RESPONSE_LIMIT')
        raw += decoder.decode(chunk.value, { stream: true })
      }
    } finally { await reader.cancel().catch(() => {}) }
  }
  async rpc(method: string, params: unknown, mcp = false): Promise<unknown> {
    const requestId = randomUUID()
    const value = record(await this.send(this.endpoint, { jsonrpc: '2.0', id: requestId, method, params }, mcp))
    if (value.jsonrpc !== '2.0' || value.id !== requestId || ('result' in value) === ('error' in value)) return failure('PROVIDER_RPC_MISMATCH')
    // A protocol error is not proof that a side effect never started.
    if ('error' in value) return failure('PROVIDER_RPC_ERROR')
    return value.result
  }
  async close(): Promise<void> {
    if (!this.session) return
    // Session cleanup does not cancel a tool invocation or change its outcome.
    try {
      const response = await this.request(this.endpoint, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(1000), headers: {
        Authorization: `Bearer ${this.key}`, 'Mcp-Session-Id': this.session, 'MCP-Protocol-Version': '2025-06-18',
      } })
      await response.body?.cancel()
    } catch { /* The remote session may already have expired. Never retry execution. */ }
  }
}

async function discover(wire: Wire, protocol: StandardHttpProtocol, target: string): Promise<unknown> {
  if (protocol === 'openai-chat-completions/v1') {
    const model = record(await wire.send(`${wire.endpoint}/models/${encodeURIComponent(target)}`))
    if (model.id !== target || model.object !== 'model') return failure('PROVIDER_TARGET_MISMATCH')
    return model
  }
  if (protocol === 'mcp/2025-06-18') {
    const init = record(await wire.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'moss-agent-gateway', version: '1.0.0' } }, true))
    if (init.protocolVersion !== '2025-06-18' || !record(init.capabilities).tools) return failure('PROVIDER_PROTOCOL_UNSUPPORTED')
    wire.initialized = true
    await wire.send(wire.endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' }, true, true)
    let cursor: string | undefined, selected: Json | undefined
    const cursors = new Set<string>()
    for (let page = 0; page < 10; page++) {
      const result = record(await wire.rpc('tools/list', cursor ? { cursor } : {}, true))
      if (!Array.isArray(result.tools) || result.tools.length > 200) return failure('PROVIDER_DISCOVERY_LIMIT')
      for (const candidate of result.tools) {
        const tool = record(candidate)
        if (tool.name === target) { if (selected) return failure('PROVIDER_TARGET_AMBIGUOUS'); selected = tool }
      }
      if (result.nextCursor === undefined) {
        if (!selected) return failure('PROVIDER_TARGET_MISMATCH')
        const schema = record(selected.inputSchema), properties = record(schema.properties)
        if (schema.type !== 'object' || Object.keys(properties).join() !== 'query' || record(properties.query).type !== 'string'
          || JSON.stringify(schema.required) !== '["query"]'
          || Object.keys(schema).some(key => !['$schema', 'type', 'properties', 'required', 'additionalProperties'].includes(key))
          || (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')
          || Object.keys(record(properties.query)).some(key => !['type', 'description', 'title', 'minLength', 'maxLength'].includes(key))
          || [record(properties.query).minLength, record(properties.query).maxLength].some(value => value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0))) return failure('PROVIDER_INPUT_UNSUPPORTED')
        return selected
      }
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 1000 || cursors.has(result.nextCursor)) return failure('PROVIDER_DISCOVERY_LIMIT')
      cursor = result.nextCursor; cursors.add(cursor)
    }
    return failure('PROVIDER_DISCOVERY_LIMIT')
  }
  const card = record(await wire.send(`${new URL(wire.endpoint).origin}/.well-known/agent-card.json`))
  if (card.protocolVersion !== '0.3.0' || card.url !== wire.endpoint || (card.preferredTransport !== undefined && card.preferredTransport !== 'JSONRPC')) return failure('PROVIDER_PROTOCOL_UNSUPPORTED')
  if (!Array.isArray(card.skills) || card.skills.length !== 1 || record(card.skills[0]).id !== target) return failure('PROVIDER_TARGET_MISMATCH')
  if (!Array.isArray(card.defaultInputModes) || !card.defaultInputModes.includes('text/plain') || !Array.isArray(card.defaultOutputModes) || !card.defaultOutputModes.includes('text/plain')) return failure('PROVIDER_INPUT_UNSUPPORTED')
  return card
}

/** Read-only metadata helper for administrators/reference-service authors. Never invokes an Agent. */
export async function discoverStandardManifest(input: { endpoint: string; key: string; protocol: StandardHttpProtocol; target: string; agentId: string; name: string }, signal: AbortSignal, request: ProviderRequest = fetch): Promise<StandardManifest> {
  if (!(STANDARD_HTTP_PROTOCOLS as readonly string[]).includes(input.protocol) || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(input.target)) throw new ExternalProviderError(400, 'PROVIDER_PROTOCOL_UNSUPPORTED')
  const wire = new Wire(input.endpoint, input.key, signal, request)
  try {
    const descriptor = await discover(wire, input.protocol, input.target)
    return parseCustomManifest(JSON.stringify({ api_version: AGENT_FEDERATION_API, kind: 'CustomAgentManifest', provider_kind: 'custom_http',
      external_agent_id: input.agentId, name: input.name, source_revision: 'metadata-snapshot-v1', execution_mode: 'external_hosted',
      protocol: input.protocol, target: input.target, discovery_digest: descriptorDigest(descriptor), conversation_mode: 'single_turn',
      input_profile: 'query_only_v1', output_profile: 'text_v1', capabilities: { ...HTTP_CAPABILITIES },
    })) as StandardManifest
  } finally { await wire.close() }
}

function parts(value: unknown): string {
  if (!Array.isArray(value) || value.length > 128) return failure('PROVIDER_OUTPUT_UNSUPPORTED')
  return text(value.map(part => { const item = record(part); if (item.kind !== 'text') return failure('PROVIDER_OUTPUT_UNSUPPORTED'); return text(item.text) }).join(''))
}

export class StandardHttpAdapter implements ProviderAdapter {
  readonly kind = 'custom_http' as const
  readonly capabilities = HTTP_CAPABILITIES
  readonly version: string
  readonly manifest: StandardManifest
  constructor(readonly reviewed: ReviewedHttpManifest, readonly request: ProviderRequest = fetch) {
    const manifest = parseCustomManifest(JSON.stringify(reviewed.manifest))
    if (!isStandardProtocol(manifest) || customManifestDigest(manifest) !== reviewed.digest) throw new ExternalProviderError(409, 'MANIFEST_DIGEST_MISMATCH')
    this.manifest = manifest; this.version = `${manifest.protocol}/single-turn@0.1.0`
  }
  private async check(wire: Wire, query?: string) {
    const descriptor = await discover(wire, this.manifest.protocol, this.manifest.target)
    if (descriptorDigest(descriptor) !== this.manifest.discovery_digest) throw new ExternalProviderError(409, 'PROVIDER_SOURCE_CHANGED')
    if (query !== undefined && this.manifest.protocol === 'mcp/2025-06-18') {
      const field = record(record(record(record(descriptor).inputSchema).properties).query), length = [...query].length
      if ((field.minLength !== undefined && length < Number(field.minLength)) || (field.maxLength !== undefined && length > Number(field.maxLength))) throw new ExternalProviderError(400, 'PROVIDER_INPUT_UNSUPPORTED')
    }
  }
  async inspect(endpoint: string, key: string, signal: AbortSignal) {
    const wire = new Wire(endpoint, key, signal, this.request)
    try { await this.check(wire); return { name: this.manifest.name, parameters_digest: this.reviewed.digest, checked_at: Date.now() } }
    finally { await wire.close() }
  }
  async invoke(input: ProviderInvocation, observe: Parameters<ProviderAdapter['invoke']>[1]) {
    const { endpoint, signal } = invocationContext(input)
    if (input.external_agent_id !== this.manifest.external_agent_id || input.source_digest !== this.reviewed.digest || input.provider_session_id || input.recovery) throw new ExternalProviderError(409, 'PROVIDER_CONTEXT_UNSUPPORTED')
    const traceId = createHash('sha256').update(input.task_id).digest('hex').slice(0, 32)
    const spanId = createHash('sha256').update(input.attempt_id).digest('hex').slice(0, 16)
    const wire = new Wire(endpoint, input.key, signal, this.request, `00-${traceId}-${spanId}-01`)
    const startedAt = new Date().toISOString(), publish = createObserver(this, input, observe)
    let output = '', status: 'succeeded' | 'failed' = 'succeeded', runId: string | undefined, responseId: string | undefined, usage: ProtocolUsage | undefined
    try {
      await this.check(wire, input.query)
      await input.authorize_dispatch(); signal.throwIfAborted()
      if (this.manifest.protocol === 'openai-chat-completions/v1') {
        const result = record(await wire.send(`${endpoint}/chat/completions`, { model: this.manifest.target, messages: [{ role: 'user', content: input.query }], stream: false, n: 1, user: input.end_user }))
        if (result.object !== 'chat.completion' || !Array.isArray(result.choices) || result.choices.length !== 1) return failure()
        responseId = id(result.id)
        const choice = record(result.choices[0]), message = record(choice.message)
        if (choice.finish_reason !== 'stop' || message.role !== 'assistant' || message.tool_calls || message.function_call || message.refusal) return failure('PROVIDER_OUTPUT_UNSUPPORTED')
        output = text(message.content)
        if (result.usage !== undefined) {
          const counts = record(result.usage)
          if (![counts.prompt_tokens, counts.completion_tokens].every(n => Number.isSafeInteger(n) && Number(n) >= 0)) return failure()
          usage = { source: 'provider_reported', input_tokens: counts.prompt_tokens as number, output_tokens: counts.completion_tokens as number }
        }
      } else if (this.manifest.protocol === 'mcp/2025-06-18') {
        const result = record(await wire.rpc('tools/call', { name: this.manifest.target, arguments: { query: input.query } }, true))
        if ((result.isError !== undefined && typeof result.isError !== 'boolean') || !Array.isArray(result.content) || result.content.length > 128) return failure()
        output = text(result.content.map(part => { const item = record(part); if (item.type !== 'text') return failure('PROVIDER_OUTPUT_UNSUPPORTED'); return text(item.text) }).join('\n'))
        if (result.isError === true) { status = 'failed'; output = '' }
      } else {
        let result = record(await wire.rpc('message/send', { message: { kind: 'message', role: 'user', messageId: randomUUID(), parts: [{ kind: 'text', text: input.query }] }, configuration: { acceptedOutputModes: ['text/plain'], blocking: false, historyLength: 0 } }))
        if (result.kind === 'message') {
          if (result.role !== 'agent') return failure()
          responseId = id(result.messageId); output = parts(result.parts)
        } else {
          let contextId: string | undefined
          for (let poll = 0; ; poll++) {
            if (result.kind !== 'task') return failure()
            const currentId = id(result.id), currentContext = id(result.contextId)
            if ((runId && currentId !== runId) || (contextId && contextId !== currentContext)) return failure('PROVIDER_TASK_MISMATCH')
            runId = currentId; contextId = currentContext
            const state = record(result.status).state
            if (state === 'completed') {
              if (!Array.isArray(result.artifacts) || result.artifacts.length > 128) return failure('PROVIDER_OUTPUT_UNSUPPORTED')
              output = text(result.artifacts.map(artifact => parts(record(artifact).parts)).join('\n')); break
            }
            if (['failed', 'canceled', 'rejected'].includes(String(state))) { status = 'failed'; break }
            await publish('', { run_id: runId }, 'running')
            if (!['submitted', 'working'].includes(String(state)) || poll >= 49) return failure('PROVIDER_INTERACTION_UNCONFIRMED')
            await new Promise<void>((resolve, reject) => {
              const abort = () => { clearTimeout(timer); reject(signal.reason) }
              const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 100)
              signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
            })
            result = record(await wire.rpc('tasks/get', { id: runId, historyLength: 0 }))
          }
        }
      }
      const binding: ExternalRunBinding = parseExternalRunBinding({ api_version: AGENT_FEDERATION_API, kind: 'ExternalRunBinding',
        task_id: input.task_id, attempt_id: input.attempt_id, session_id: input.session_id, binding_id: input.binding_id,
        provider_kind: 'custom_http', external_agent_id: input.external_agent_id, source_digest: input.source_digest,
        source_identity_evidence: 'unverified', adapter_version: this.version, observability: 'partial', replay: 'unsupported', resume: 'unsupported',
        version_evidence: 'source_snapshot_only', provider_protocol: this.manifest.protocol, trace_id: traceId,
        ...(runId ? { provider_run_id: runId } : {}), ...(responseId ? { provider_response_id: responseId } : {}), ...(usage ? { usage } : {}),
        started_at: startedAt, completed_at: new Date().toISOString(),
      })
      await publish(output, { ...(runId ? { run_id: runId } : {}), ...(responseId ? { message_id: responseId } : {}) }, status)
      return { text: output, status, binding }
    } finally { await wire.close() }
  }
}
