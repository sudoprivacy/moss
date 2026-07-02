import { afterEach, describe, expect, it } from 'bun:test'
import net from 'net'
import { Database } from 'bun:sqlite'
import type { DatabaseSync } from 'node:sqlite'
import { CabinServices } from '../service.js'
import { CabinStore } from '../store.js'
import type { CabinConfig, CabinMessage, CabinPassengerContext } from '../types.js'
import type { SessionSnapshot } from '../../runtimeService.js'

const context: CabinPassengerContext = {
  flightId: 'F1',
  flightDate: '2026-07-02',
  seatId: '01A',
  columnNo: 'A',
  tabletId: 'T1',
}

function stdout(line: object): string {
  return JSON.stringify({ type: 'stdout', line: JSON.stringify(line) })
}

// A scode ACP tool_result envelope carrying the cabin-control.mjs emit-mode output.
function emitToolResult(payload: object): string {
  return stdout({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: JSON.stringify(payload) }] }] },
  })
}

function assistantText(text: string): string {
  return stdout({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
}

// A top-level Skill tool_use event whose input is a JSON string — the shape that used
// to reset the buffered chat reply mid-stream.
function skillToolUse(): string {
  return stdout({ type: 'tool_use', name: 'Skill', input: '{"skill":"cabin-hardware-control"}' })
}

const servers: net.Server[] = []

// Stand up a loopback TCP server that replays the given scode stdout lines to any client,
// then a result:success, mimicking the runner socket generateReplyWithMossSession reads.
async function fakeRunnerSocket(lines: string[]): Promise<net.Socket> {
  const server = net.createServer(socket => {
    for (const line of lines) socket.write(`${line}\n`)
    socket.write(`${stdout({ type: 'result', status: 'success' })}\n`)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  return net.connect(port, '127.0.0.1')
}

function makeServices(opts: {
  fetchImpl?: typeof fetch
  lines: string[]
}): CabinServices {
  const config = { controlBaseUrl: 'http://control.local', controlTimeoutMs: 200, llmModel: 'test' } as unknown as CabinConfig
  const runtime = {
    ensureSessionReady: async () => ({ attempt: {} }),
    connectToAttempt: async () => fakeRunnerSocket(opts.lines),
  } as never
  return new CabinServices({
    config,
    store: {} as never,
    runtime,
    fetchImpl: opts.fetchImpl,
  })
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

describe('generateReplyWithMossSession · intent-first', () => {
  it('executes the emitted command server-side and grounds the reply in the real dispatch', async () => {
    const dispatched: string[] = []
    const services = makeServices({
      lines: [
        // Model narrates a (fabricated) confirmation before any tool result — must be dropped.
        assistantText('好的，已为您打开小桌板。'),
        emitToolResult({ ok: true, mode: 'emit', command: 'seat.tray.open', seat_no: '01A', params: {} }),
      ],
      fetchImpl: async url => {
        dispatched.push(String(url))
        return new Response(JSON.stringify({ code: 0 }), { status: 200 })
      },
    })

    const deltas: string[] = []
    const result = await services.generateReplyWithMossSession({
      mossSessionId: 's1',
      context,
      text: '帮我打开小桌板',
      onDelta: d => deltas.push(d),
    })

    // Server executed the real hardware dispatch.
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toContain('/admin-api/tcp-client/cmd/seat/tray/open')
    expect(dispatched[0]).toContain('seatNo=01A')
    // Reply is the server's template, NOT the model's fabricated "已为您打开".
    expect(result.reply).toBe('已为您下发打开小桌板的指令，请稍候。')
    expect(result.toolCall?.name).toBe('cabin.hardware.control')
    expect(result.intent).toBe('tray_open')
    expect(result.slots?.execution_status).toBe('dispatched')
    // No model text leaked into the stream for a control turn.
    expect(deltas.join('')).not.toContain('已为您打开小桌板')
  })

  it('surfaces a dispatch failure without claiming success', async () => {
    const services = makeServices({
      lines: [emitToolResult({ ok: true, mode: 'emit', command: 'seat.light', seat_no: '01A', params: { on: true } })],
      fetchImpl: async () => new Response('err', { status: 500 }),
    })
    const result = await services.generateReplyWithMossSession({ mossSessionId: 's2', context, text: '打开阅读灯' })
    expect(result.reply).toBe('打开阅读灯的指令下发失败，请稍后再试。')
    expect(result.slots?.execution_status).toBe('failed')
  })

  it('asks to clarify when the emitted command is missing a required parameter', async () => {
    let fetched = false
    const services = makeServices({
      lines: [emitToolResult({ ok: true, mode: 'emit', command: 'seat.cushion', seat_no: '01A', params: {} })],
      fetchImpl: async () => { fetched = true; return new Response('{}', { status: 200 }) },
    })
    const result = await services.generateReplyWithMossSession({ mossSessionId: 's3', context, text: '调一下座椅' })
    expect(fetched).toBe(false)
    expect(result.toolCall).toBeUndefined()
    expect(result.reply).toContain('具体')
  })

  it('passes a free-chat reply through when no command is emitted', async () => {
    let fetched = false
    const services = makeServices({
      lines: [assistantText('北京今天多云，气温 28 度。')],
      fetchImpl: async () => { fetched = true; return new Response('{}', { status: 200 }) },
    })
    const result = await services.generateReplyWithMossSession({ mossSessionId: 's4', context, text: '北京天气怎么样' })
    expect(fetched).toBe(false)
    expect(result.toolCall).toBeUndefined()
    expect(result.reply).toContain('北京今天多云')
  })

  it('keeps the full chat reply when the model pokes the Skill without emitting a command', async () => {
    let fetched = false
    const services = makeServices({
      // Model speaks, spuriously opens the Skill (string input), then speaks again — no
      // cabin-control command is ever emitted, so both segments must survive.
      lines: [
        assistantText('不客气，刘女士！有任何需要随时告诉我。'),
        skillToolUse(),
        assistantText('祝您旅途愉快。'),
      ],
      fetchImpl: async () => { fetched = true; return new Response('{}', { status: 200 }) },
    })
    const result = await services.generateReplyWithMossSession({ mossSessionId: 's5', context, text: '谢谢你' })
    expect(fetched).toBe(false)
    expect(result.toolCall).toBeUndefined()
    expect(result.reply).toContain('不客气')
    expect(result.reply).toContain('祝您旅途愉快')
  })
})

// A loopback server that accepts the connection but never writes a `result` — the runner
// socket for a "fake-dead" session (TCP up, scode stalled). Forces a reply timeout.
async function fakeStallSocket(): Promise<net.Socket> {
  const server = net.createServer(() => {
    // hold the connection open, emit nothing
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  return net.connect(port, '127.0.0.1')
}

function snap(status: SessionSnapshot['status'], extra: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 's1',
    status,
    desiredState: 'active',
    endedAt: null,
    currentAttemptId: 'a1',
    ...extra,
  }
}

type RecoveryCalls = {
  createMossSession: number
  rebind: Array<[string, string]>
  connect: number
}

function makeRecoveryServices(opts: {
  snapshots: Record<string, SessionSnapshot | null>
  sockets: Array<() => Promise<net.Socket>>
  ensureThrowsFor?: Set<string>
  newSessionId?: string
  messages?: CabinMessage[]
  replyTimeoutMs?: number
}): { services: CabinServices; calls: RecoveryCalls } {
  const calls: RecoveryCalls = { createMossSession: 0, rebind: [], connect: 0 }
  let socketIdx = 0
  const config = {
    controlBaseUrl: 'http://control.local',
    controlTimeoutMs: 200,
    llmModel: 'test',
    replyTimeoutMs: opts.replyTimeoutMs ?? 150,
    sessionRecoveryEnabled: true,
    sessionRecoveryMaxAttempts: 1,
    contextReplayTurns: 20,
  } as unknown as CabinConfig
  const runtime = {
    getSessionSnapshot: (id: string) => opts.snapshots[id] ?? null,
    ensureSessionReady: async (id: string) => {
      if (opts.ensureThrowsFor?.has(id)) throw new Error('ensure failed')
      return { attempt: {} }
    },
    connectToAttempt: async () => {
      const factory = opts.sockets[socketIdx++]
      if (!factory) throw new Error('no more sockets in fixture')
      calls.connect++
      return factory()
    },
  } as never
  const store = {
    rebindMossSession: (conversationId: string, newSessionId: string) => {
      calls.rebind.push([conversationId, newSessionId])
    },
    listMessages: () => opts.messages ?? [],
  } as never
  const services = new CabinServices({
    config,
    store,
    runtime,
    createMossSession: async () => {
      calls.createMossSession += 1
      return opts.newSessionId ?? 's2'
    },
  })
  return { services, calls }
}

function goodSocket(text = '好的，刘女士。'): () => Promise<net.Socket> {
  return () => fakeRunnerSocket([assistantText(text)])
}

describe('generateReplyWithMossSession · session recovery', () => {
  const base = { context, text: '你好', conversationId: 'c1' }

  it('replaces a lost session up-front and answers on the fresh session', async () => {
    const { services, calls } = makeRecoveryServices({
      snapshots: { s1: snap('lost') },
      sockets: [goodSocket()],
    })
    const result = await services.generateReplyWithMossSession({ ...base, mossSessionId: 's1' })
    expect(calls.createMossSession).toBe(1)
    expect(calls.rebind).toEqual([['c1', 's2']])
    expect(calls.connect).toBe(1)
    expect(result.reply).toContain('好的')
  })

  it('replaces a failed session', async () => {
    const { calls, services } = makeRecoveryServices({ snapshots: { s1: snap('failed') }, sockets: [goodSocket()] })
    await services.generateReplyWithMossSession({ ...base, mossSessionId: 's1' })
    expect(calls.createMossSession).toBe(1)
  })

  it('replaces a terminated session', async () => {
    const { calls, services } = makeRecoveryServices({ snapshots: { s1: snap('terminated') }, sockets: [goodSocket()] })
    await services.generateReplyWithMossSession({ ...base, mossSessionId: 's1' })
    expect(calls.createMossSession).toBe(1)
  })

  it('recovers an idle-recycled ended session in place (desired=active) without minting a new one', async () => {
    const { calls, services } = makeRecoveryServices({
      snapshots: { s1: snap('ended', { desiredState: 'active' }) },
      sockets: [goodSocket()],
    })
    await services.generateReplyWithMossSession({ ...base, mossSessionId: 's1' })
    expect(calls.createMossSession).toBe(0)
    expect(calls.rebind).toEqual([])
  })

  it('replaces a naturally-retired ended session (desired=ended)', async () => {
    const { calls, services } = makeRecoveryServices({
      snapshots: { s1: snap('ended', { desiredState: 'ended' }) },
      sockets: [goodSocket()],
    })
    await services.generateReplyWithMossSession({ ...base, mossSessionId: 's1' })
    expect(calls.createMossSession).toBe(1)
  })

  it('reuses a detached session whose attach is still alive', async () => {
    const { calls, services } = makeRecoveryServices({
      snapshots: {
        s1: snap('detached', {
          attempt: { runtimeState: 'detached', runnerPid: 1, attachPath: '/x', lastHeartbeatAt: 1, stopReason: null, errorText: null },
        }),
      },
      sockets: [goodSocket()],
    })
    await services.generateReplyWithMossSession({ ...base, mossSessionId: 's1' })
    expect(calls.createMossSession).toBe(0)
  })

  it('replaces when a detached session cannot be respawned', async () => {
    const { calls, services } = makeRecoveryServices({
      snapshots: {
        s1: snap('detached', {
          attempt: { runtimeState: 'detached', runnerPid: null, attachPath: null, lastHeartbeatAt: null, stopReason: null, errorText: null },
        }),
      },
      sockets: [goodSocket()],
      ensureThrowsFor: new Set(['s1']),
    })
    await services.generateReplyWithMossSession({ ...base, mossSessionId: 's1' })
    expect(calls.createMossSession).toBe(1)
    expect(calls.rebind).toEqual([['c1', 's2']])
  })

  it('recovers from a fake-dead (stalled) session via reply timeout, then answers', async () => {
    const { calls, services } = makeRecoveryServices({
      snapshots: { s1: snap('active', { attempt: { runtimeState: 'running', runnerPid: 1, attachPath: '/x', lastHeartbeatAt: 1, stopReason: null, errorText: null } }) },
      sockets: [() => fakeStallSocket(), goodSocket('已经帮您处理好了。')],
      replyTimeoutMs: 120,
    })
    const result = await services.generateReplyWithMossSession({ ...base, mossSessionId: 's1' })
    expect(calls.createMossSession).toBe(1)
    expect(calls.connect).toBe(2)
    expect(result.reply).toContain('处理好了')
  })

  it('recovers at most once — a second stall surfaces the error instead of churning', async () => {
    const { calls, services } = makeRecoveryServices({
      snapshots: { s1: snap('active', { attempt: { runtimeState: 'running', runnerPid: 1, attachPath: '/x', lastHeartbeatAt: 1, stopReason: null, errorText: null } }) },
      sockets: [() => fakeStallSocket(), () => fakeStallSocket()],
      replyTimeoutMs: 120,
    })
    await expect(
      services.generateReplyWithMossSession({ ...base, mossSessionId: 's1' }),
    ).rejects.toThrow(/timed out/)
    expect(calls.createMossSession).toBe(1)
    expect(calls.connect).toBe(2)
  })

  it('builds a context-replay block that excludes the current turn and hardware templates', () => {
    const messages: CabinMessage[] = [
      { id: 'm1', conversationId: 'c1', role: 'user', source: 'text', content: '你好', intent: null, slots: null, toolCalls: null, createdAt: 1 },
      { id: 'm2', conversationId: 'c1', role: 'assistant', source: 'agent', content: '刘女士您好', intent: null, slots: null, toolCalls: null, createdAt: 2 },
      { id: 'm3', conversationId: 'c1', role: 'assistant', source: 'agent', content: '已为您下发打开小桌板的指令，请稍候。', intent: 'tray_open', slots: null, toolCalls: null, createdAt: 3 },
      { id: 'cur', conversationId: 'c1', role: 'user', source: 'text', content: '当前这一条消息', intent: null, slots: null, toolCalls: null, createdAt: 4 },
    ]
    const { services } = makeRecoveryServices({ snapshots: {}, sockets: [], messages })
    const block = (services as unknown as { buildContextReplayBlock(id: string, cur?: string): string })
      .buildContextReplayBlock('c1', 'cur')
    expect(block).toContain('你好')
    expect(block).toContain('刘女士您好')
    expect(block).not.toContain('已为您下发')
    expect(block).not.toContain('当前这一条消息')
  })
})

describe('rebindMossSession · history fidelity', () => {
  it('swaps moss_session_id in place with no reset divider and no message loss', () => {
    const db = new Database(':memory:') as unknown as DatabaseSync
    const store = new CabinStore(db)
    const conv = store.createConversation({ flightId: 'F1', flightDate: '2026-07-02', tabletId: 'T1', mossSessionId: 'old-session' })
    store.appendMessage({ conversationId: conv.id, role: 'user', source: 'text', content: '你好' })
    store.appendMessage({ conversationId: conv.id, role: 'assistant', source: 'agent', content: '刘女士您好' })
    store.appendMessage({ conversationId: conv.id, role: 'user', source: 'text', content: '查一下航班' })
    const before = store.listMessages(conv.id, 100)

    store.rebindMossSession(conv.id, 'new-session')

    const after = store.listMessages(conv.id, 100)
    expect(after.map(m => m.content)).toEqual(before.map(m => m.content))
    expect(after.some(m => m.role === 'system')).toBe(false)
    expect(after).toHaveLength(3)
    expect(store.getConversationById(conv.id)?.mossSessionId).toBe('new-session')
    expect(store.getConversationById(conv.id)?.status).toBe('active')
  })
})
