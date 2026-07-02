import { afterEach, describe, expect, it } from 'bun:test'
import net from 'net'
import { CabinServices } from '../service.js'
import type { CabinConfig, CabinPassengerContext } from '../types.js'

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
