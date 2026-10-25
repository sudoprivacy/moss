import { createHash } from 'node:crypto'
import { z } from 'zod'
import { AGENT_CONTROL_PROTOCOL, agentControlCatalog, agentControlActionSchema,
  type AgentControlAction } from './contract.js'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
export const nativeControlConfigSchema = z.object({
  protocol: z.literal(AGENT_CONTROL_PROTOCOL), origin: z.string(), accessToken: z.string().min(1).max(8192).regex(/^[A-Za-z0-9_.-]+$/),
  delegationId: id, deploymentId: id, expiresAt: z.number().int().positive(),
  actions: z.array(agentControlActionSchema).min(1).max(4),
}).strict()
export type NativeControlConfig = z.infer<typeof nativeControlConfigSchema>
type ControlFetch = (url: string, init: RequestInit) => Promise<Response>

/** This bearer is a bounded delegation to the configured managed actor. A tool
 * call ID correlates commands; it is never proof of the caller's Nexus identity.
 */
export class NativeControlClient {
  private readonly origin: string
  constructor(readonly config: NativeControlConfig, private readonly transport: ControlFetch = fetch,
    private readonly timeoutMs = 15_000) {
    nativeControlConfigSchema.parse(config)
    const url = new URL(config.origin)
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))))
      throw new Error('Control origin must be HTTPS or local loopback HTTP, without credentials or a path')
    this.origin = url.origin
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    if (this.config.expiresAt <= Date.now()) throw new Error('Control delegation expired; reconnect through the human setup entry')
    try {
      const response = await this.transport(`${this.origin}/api/v1/agent-control${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Authorization: `Bearer ${this.config.accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) throw new Error('Control request was refused or unavailable')
      // Never forward an unbounded server body or a credential echoed by a proxy.
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Missing control response')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 1024 * 1024) throw new Error('Control response exceeded limit')
          chunks.push(chunk.value)
        }
      } finally { await reader.cancel().catch(() => {}) }
      const text = Buffer.concat(chunks).toString('utf8')
      const value = JSON.parse(text) as unknown
      if (JSON.stringify(value).includes(this.config.accessToken)) throw new Error('Credential echo refused')
      return value
    } catch {
      // Do not echo fetch/URL/server details, retry, fall back, or classify an
      // HTTP status as evidence that a previous append/effect did not happen.
      throw new Error('Control result is unknown; query the original operation ID without invoking it again')
    }
  }

  async capabilities() {
    const value = await this.request('/capabilities') as any
    if (value?.protocol !== AGENT_CONTROL_PROTOCOL || value.delegation?.id !== this.config.delegationId ||
      value.delegation?.target?.deploymentId !== this.config.deploymentId || value.delegation?.status !== 'active' ||
      value.delegation?.expiresAt !== this.config.expiresAt || !Array.isArray(value.tools))
      throw new Error('Control capability binding does not match private configuration')
    // Commands, permission labels and schemas come only from the local canonical
    // catalog, never executable strings in a remote discovery response.
    const advertised = new Set(value.tools.map((tool: any) => tool.action))
    return this.config.actions.filter(action => advertised.has(action))
  }

  async invoke(action: AgentControlAction, args: unknown, callId: string) {
    if (!this.config.actions.includes(action)) throw new Error('Control action was not delegated')
    if (!callId || callId.length > 4096 || /[\u0000-\u001f]/.test(callId)) throw new Error('A real host invocation ID is required')
    const parsed = agentControlCatalog[action].arguments.parse(args)
    const operationId = this.operationId(callId)
    try {
      return await this.receipt(`/invoke`, operationId, {
        protocol: AGENT_CONTROL_PROTOCOL, operationId, action, arguments: parsed,
      })
    } catch {
      return { protocol: AGENT_CONTROL_PROTOCOL, operationId, status: 'unknown', outcome: 'unknown',
        errorCode: 'CONTROL_RESULT_UNCONFIRMED', next: 'Query this operation ID; do not submit a new command' }
    }
  }

  operationId(callId: string) {
    return `tool_${createHash('sha256').update(JSON.stringify(['moss-agent-control/v1', this.config.delegationId, callId])).digest('hex')}`
  }

  async operation(operationId: string) {
    id.parse(operationId)
    return this.receipt(`/operations/${operationId}`, operationId)
  }

  private async receipt(path: string, operationId: string, body?: unknown) {
    const value = await this.request(path, body) as any
    if (value?.protocol !== AGENT_CONTROL_PROTOCOL || value.operationId !== operationId ||
      value.audit?.delegationId !== this.config.delegationId || value.audit?.target?.deploymentId !== this.config.deploymentId ||
      !['prepared', 'executing', 'completed', 'rejected', 'unknown'].includes(value.status) ||
      value.outcome !== (value.status === 'completed' ? 'completed' : value.status === 'rejected' ? 'not_submitted' : 'unknown'))
      throw new Error('Control receipt binding is invalid')
    return value
  }
}
