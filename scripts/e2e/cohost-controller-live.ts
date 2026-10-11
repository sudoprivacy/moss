/** Real Moss session transport, approved file work and a dependent next turn. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { SessionRpcMessage, NexusSessionEndpoint } from '@nexus-ai-fs/vfs-client'
import type { ManagedAgentClient } from '../../src/server/nexus/managedAgentClient.js'

/** One controller implementation for live turns and durable recovery acceptance. */
export function connectController(s: {
  agent: ManagedAgentClient
  sessionEndpoint: NexusSessionEndpoint
  sessionId?: string
}, allowed: ReadonlySet<string>, allowExplore = false) {
  const pending = new Map<string, { resolve(value: any): void, reject(error: Error): void }>()
  let nextId = 0
  let approvals = 0
  let exploreDelegations = 0
  const children = new Map<string, string[]>()
  let unexpected: string | undefined
  const updates: any[] = []
  let onClosed!: (error: Error | undefined) => void
  const closed = new Promise<Error | undefined>(resolve => { onClosed = resolve })
  const transport = s.agent.openSession(s.sessionEndpoint, {
    onClose(error) {
      onClosed(error)
      for (const request of pending.values()) request.reject(error ?? new Error('session closed'))
      pending.clear()
    },
    onMessage(message: SessionRpcMessage) {
      const m = message as any
      if (m.method === 'session/request_permission') {
        const call = m.params.toolCall
        const raw = typeof call.rawInput === 'string' ? JSON.parse(call.rawInput) : call.rawInput
        // ACP permission updates omit title; the preceding tool-call update
        // carries it. Match its exact input before using that name.
        const title = call.title ?? [...updates].reverse().find(update =>
          update.sessionUpdate === 'tool_call' && isDeepStrictEqual(update.rawInput, raw),
        )?.title
        const path = raw?.path ?? raw?.file_path
        const explore = allowExplore && (raw?.agent ?? raw?.subagent_type) === 'Explore'
        const childStatus = allowExplore && (
          title === 'pid_output' && children.has(raw?.pid)
          || title === 'pid_status' && (children.has(raw?.pid) || !raw?.pid && children.size > 0)
        )
        const childFile = allowExplore && title === 'read_file' && [...children.values()].some(paths => paths.includes(path))
        const childDiscovery = allowExplore && title === 'ToolSearch' && typeof raw?.query === 'string'
        const ok = allowed.has(path) || explore || childStatus || childFile || childDiscovery
        if (!ok) unexpected = `unexpected approval ${String(title)} path ${String(path)}`
        const option = m.params.options.find((o: any) => o.kind === (ok ? 'allow_once' : 'reject_once'))
        if (!option) throw new Error('permission request has no matching one-call option')
        if (ok) approvals += 1
        if (explore) exploreDelegations += 1
        void transport.send({ jsonrpc: '2.0', id: m.id,
          result: { outcome: { outcome: 'selected', optionId: option.optionId } } })
      } else if (m.method === 'session/update') {
        updates.push(m.params.update)
        const output = m.params.update?.rawOutput
        if (allowExplore && output?.subagentType === 'Explore' && typeof output.agentId === 'string' && typeof output.outputFile === 'string') {
          children.set(output.agentId, [output.outputFile, output.manifestFile].filter((path): path is string => typeof path === 'string'))
        }
      } else if (m.method) {
        unexpected = `unexpected controller request ${m.method}`
        if (m.id !== undefined) void transport.send({ jsonrpc: '2.0', id: m.id,
          error: { code: -32601, message: unexpected } })
      } else {
        const request = pending.get(String(m.id))
        if (!request) return
        pending.delete(String(m.id))
        if (m.error) request.reject(new Error(JSON.stringify(m.error)))
        else request.resolve(m.result ?? {})
      }
    },
  }, s.sessionId)
  transport.start()
  async function rpc(method: string, params: unknown, budget = 120_000): Promise<any> {
    const id = `moss-live-${++nextId}`
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), budget)
        void transport.send({ jsonrpc: '2.0', id, method, params }).catch(reject)
      })
    } finally {
      clearTimeout(timer)
      pending.delete(id)
    }
  }
  return {
    rpc,
    updates,
    closed,
    get approvals() { return approvals },
    get exploreDelegations() { return exploreDelegations },
    assertHealthy() {
      if (unexpected) throw new Error(unexpected)
      if (updates.some(u => u.sessionUpdate === 'tool_call_update' && u.status === 'failed')) {
        throw new Error('workflow recovered from a failed tool')
      }
    },
    close: () => transport.close(),
  }
}

export async function reviewSession(s: {
  agent: ManagedAgentClient
  sessionEndpoint: NexusSessionEndpoint
  durableSessionId?: string
  owner: string
}, files: {
  write(path: string, content: Buffer, token: string): Promise<void>
  read(path: string, token: string): Promise<Buffer>
}) {
  const code = `MOSS_${randomUUID()}`
  const units = 9 + Math.floor(Math.random() * 17)
  const subtotal = units * 29 + 47
  const root = `/agents/agent-${s.owner}/review-${randomUUID()}`
  const input = `${root}/order.json`
  const result = `${root}/result.json`
  const final = `${root}/final.json`
  await files.write(input, Buffer.from(JSON.stringify({ code, units, unit_price: 29, delivery: 47 })), '')
  const controller = connectController(s, new Set([input, result, final]))
  const { rpc } = controller
  try {
    await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const opened = await rpc('session/new', { cwd: '/', mcpServers: [] })
    const sessionId = opened.sessionId
    if (sessionId !== s.durableSessionId) throw new Error('Moss opened a different durable session')
    await rpc('session/setPermissionMode', { sessionId, permissionMode: 'prompt' })
    const first = await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text:
      `Read ${input}. Calculate units times unit_price plus delivery. Save ${result} as JSON with code and numeric subtotal. Reply with the code and subtotal after saving.` }] })
    if (first.stopReason !== 'end_turn') throw new Error(`first turn stopped: ${first.stopReason}`)
    const saved = JSON.parse((await files.read(result, '')).toString())
    if (saved.code !== code || saved.subtotal !== subtotal) throw new Error('first persisted result differs from the actual order')
    const second = await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text:
      `Add a handling fee of 13 to that subtotal. Use the code and subtotal from this conversation. Save ${final} as JSON with code and numeric total, then report them.` }] })
    if (second.stopReason !== 'end_turn') throw new Error(`next turn stopped: ${second.stopReason}`)
    const savedFinal = JSON.parse((await files.read(final, '')).toString())
    if (savedFinal.code !== code || savedFinal.total !== subtotal + 13) throw new Error('next turn lost the actual order')
    controller.assertHealthy()
    if (controller.approvals < 3) throw new Error('actual file requests did not reach the Moss controller')
    return { code, subtotal, total: subtotal + 13, approvals: controller.approvals, sessionId }
  } finally {
    await controller.close()
  }
}
