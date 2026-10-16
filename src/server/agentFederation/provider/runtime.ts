import { DURABLE_HTTP_CAPABILITIES, DURABLE_AGENT_HTTP_API, type SubmitAgentRun } from '../../../../contracts/agent-http/v1alpha2/contract.js'
import { AgentProtocolError, contentDigest, parseSubmitAgentRun } from './protocol.js'
import { AgentRunStore, type ClaimedRun, type ModelMessage } from './store.js'

export interface AgentDefinition {
  external_agent_id: string
  name: string
  system_prompt: string
  router_endpoint: string
  model: string
  max_output_tokens: number
}
export interface ImmutableAgent { definition: Readonly<AgentDefinition>; revision: string; artifactDigest: string }

export function immutableAgent(value: unknown, artifactDigest: string, allowedRouterEndpoints: readonly string[]): ImmutableAgent {
  const d = value as AgentDefinition
  if (!d || typeof d !== 'object' || Array.isArray(d)
    || Object.keys(d).sort().join(',') !== 'external_agent_id,max_output_tokens,model,name,router_endpoint,system_prompt'
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(d.external_agent_id)
    || typeof d.name !== 'string' || !d.name.trim() || d.name.length > 200
    || typeof d.system_prompt !== 'string' || !d.system_prompt.trim() || d.system_prompt.length > 8000
    || typeof d.model !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,200}$/.test(d.model)
    || !Number.isSafeInteger(d.max_output_tokens) || d.max_output_tokens < 1 || d.max_output_tokens > 4096
    || !/^sha256:[a-f0-9]{64}$/.test(artifactDigest)
    || !allowedRouterEndpoints.includes(d.router_endpoint)) throw new AgentProtocolError(400, 'INVALID_AGENT_DEFINITION')
  const endpoint = new URL(d.router_endpoint)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search || d.router_endpoint.endsWith('/')) throw new AgentProtocolError(400, 'INVALID_ROUTER_ENDPOINT')
  // Definition contains no secrets and is copied/frozen; an operator changing it creates a new revision.
  const definition = Object.freeze({ ...d })
  const revision = contentDigest({ protocol: DURABLE_AGENT_HTTP_API, artifact_digest: artifactDigest, definition })
  return Object.freeze({ definition, revision, artifactDigest })
}

export function agentManifest(agent: ImmutableAgent) {
  return {
    api_version: 'agent-federation.sudo.dev/v1alpha1', kind: 'CustomAgentManifest', provider_kind: 'custom_http',
    external_agent_id: agent.definition.external_agent_id, name: agent.definition.name,
    source_revision: agent.revision, execution_revision: agent.revision,
    execution_mode: 'external_hosted', protocol: DURABLE_AGENT_HTTP_API,
    input_profile: 'query_only_v1', output_profile: 'text_v1', capabilities: DURABLE_HTTP_CAPABILITIES,
  }
}

export type ModelExecutor = (agent: ImmutableAgent, history: ModelMessage[], query: string, signal: AbortSignal) => Promise<string>

export async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new AgentProtocolError(502, 'INVALID_JSON_RESPONSE') }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new AgentProtocolError(502, 'RESPONSE_TOO_LARGE')
      chunks.push(value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch (error) {
    if (error instanceof AgentProtocolError) throw error
    throw new AgentProtocolError(502, 'INVALID_JSON_RESPONSE')
  } finally { await reader.cancel().catch(() => {}) }
}

/** All model traffic uses a deployment-authorized SudoRouter endpoint. No tools or arbitrary URLs. */
export function routerExecutor(key: string, request: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = fetch): ModelExecutor {
  if (!key || key.length > 4096 || /[\r\n]/.test(key)) throw new AgentProtocolError(400, 'INVALID_ROUTER_CREDENTIAL')
  return async (agent, history, query, signal) => {
    const d = agent.definition
    const response = await request(`${d.router_endpoint}/chat/completions`, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model: d.model, stream: false, max_tokens: d.max_output_tokens,
        messages: [{ role: 'system', content: d.system_prompt }, ...history, { role: 'user', content: query }] }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new AgentProtocolError(response.status, [400, 401, 403, 404, 422, 429].includes(response.status) ? 'MODEL_REQUEST_REJECTED' : 'MODEL_EXECUTION_UNCONFIRMED')
    }
    const result = await boundedJson(response, 2 * 1024 * 1024) as { choices?: { message?: { role?: string; content?: unknown; tool_calls?: unknown; function_call?: unknown }; finish_reason?: string }[] }
    const choice = result.choices?.[0], message = choice?.message
    if (!message || typeof message.content !== 'string' || message.content.length > 128_000 || message.tool_calls || message.function_call || choice?.finish_reason !== 'stop') throw new AgentProtocolError(502, 'MODEL_OUTPUT_INVALID')
    return message.content
  }
}

export class HttpAgentRuntime {
  private readonly versions = new Map<string, ImmutableAgent>()
  private readonly current = new Map<string, ImmutableAgent>()
  private readonly running = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private timer?: ReturnType<typeof setInterval>
  private maintenance?: Promise<void>
  private closing = false
  constructor(readonly store: AgentRunStore, agents: ImmutableAgent[], private readonly executeModel: ModelExecutor, private readonly concurrency = 4) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new AgentProtocolError(400, 'INVALID_CONCURRENCY')
    for (const agent of agents) {
      const key = `${agent.definition.external_agent_id}/${agent.revision}`
      if (this.versions.has(key)) throw new AgentProtocolError(400, 'DUPLICATE_AGENT_VERSION')
      this.versions.set(key, agent); this.current.set(agent.definition.external_agent_id, agent)
    }
    if (!agents.length) throw new AgentProtocolError(400, 'AGENT_DEFINITION_REQUIRED')
  }
  agent(id: string, revision?: string): ImmutableAgent {
    const agent = revision ? this.versions.get(`${id}/${revision}`) : this.current.get(id)
    if (!agent) throw new AgentProtocolError(409, 'EXECUTION_REVISION_UNAVAILABLE')
    return agent
  }
  async submit(clientId: string, request: SubmitAgentRun) {
    request = parseSubmitAgentRun(request)
    if (this.closing) throw new AgentProtocolError(503, 'PROVIDER_STOPPING')
    // Retrieval of existing idempotent results must survive retiring the runtime version.
    try {
      const existing = await this.store.get(clientId, request.invocation_id)
      if (existing.request_digest !== contentDigest(request)) throw new AgentProtocolError(409, 'IDEMPOTENCY_CONFLICT')
      return existing
    } catch (error) { if (!(error instanceof AgentProtocolError) || error.code !== 'RUN_NOT_FOUND') throw error }
    this.agent(request.external_agent_id, request.execution_revision)
    return this.store.submit(clientId, request)
  }
  start() {
    if (this.timer || this.closing) return
    this.timer = setInterval(() => { void this.tick().catch(() => {}) }, 250)
    this.timer.unref()
  }
  async tick(): Promise<void> {
    if (this.closing) return
    if (this.maintenance) return this.maintenance
    this.maintenance = this.pump()
    try { await this.maintenance } finally { this.maintenance = undefined }
  }
  private async pump() {
    await this.store.scheduledMaintenance()
    if (this.running.size >= this.concurrency || this.closing) return
    for (const candidate of await this.store.queued([...this.versions.values()].map(a => a.revision), this.concurrency)) {
      if (this.running.size >= this.concurrency || this.closing) break
      const claim = await this.store.claim(candidate.clientId, candidate.invocationId)
      if (!claim) continue
      const controller = new AbortController()
      const key = `${claim.clientId}/${claim.request.invocation_id}`
      const promise = this.execute(claim, controller).catch(() => { /* Durable lease expiry preserves uncertainty on database failure. */ }).finally(() => { this.running.delete(key) })
      this.running.set(key, { controller, promise })
    }
  }
  private async execute(claim: ClaimedRun, controller: AbortController) {
    let heartbeat: Promise<void> | undefined
    const timer = setInterval(() => {
      if (heartbeat) return
      heartbeat = this.store.renew(claim).then(ok => { if (!ok) controller.abort() }, () => controller.abort()).finally(() => { heartbeat = undefined })
    }, 5000)
    timer.unref()
    try {
      const agent = this.agent(claim.request.external_agent_id, claim.request.execution_revision)
      const remaining = claim.request.deadline_at - await this.store.now()
      if (remaining <= 0) return
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(remaining, 120_000))])
      const answer = await this.executeModel(agent, claim.history, claim.request.query, signal)
      await this.store.finish(claim, answer, 'succeeded')
    } catch (error) {
      const code = error instanceof AgentProtocolError ? error.code : 'MODEL_EXECUTION_UNCONFIRMED'
      const confirmedFailure = ['MODEL_REQUEST_REJECTED', 'MODEL_OUTPUT_INVALID', 'EXECUTION_REVISION_UNAVAILABLE'].includes(code)
      await this.store.finish(claim, '', confirmedFailure ? 'failed' : 'unknown', confirmedFailure ? code : 'MODEL_EXECUTION_UNCONFIRMED')
    } finally { clearInterval(timer); await heartbeat }
  }
  async idle() { await Promise.all([...this.running.values()].map(item => item.promise)) }
  async close() {
    this.closing = true; clearInterval(this.timer)
    await this.maintenance
    for (const item of this.running.values()) item.controller.abort()
    await this.idle()
  }
}
