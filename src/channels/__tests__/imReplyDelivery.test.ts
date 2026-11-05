/**
 * IM reply delivery: when a channel turn ends, and what reaches the chat.
 *
 * Covers the 2026-10-09 WeCom report: a long data turn outlived the 5-minute wait,
 * the chat got only progress text, and the answer the agent produced afterwards never
 * arrived (P1/P3); a runner that dropped mid-turn left the chat waiting the full five
 * minutes (P2); and WeCom streams opened by a fallback send were never finished (P4).
 */
import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { MossActionExecutor } from '../gateway/MossActionExecutor.js'
import { WeComPlugin } from '../plugins/wecom/WeComPlugin.js'

type Frame = Record<string, unknown>
type Sent = { kind: 'send' | 'edit'; text: string; msg: Record<string, unknown> }
type FakeSocket = EventEmitter & { destroyed: boolean; write(line: string): boolean; destroy(): void }

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** A runner whose replies the test scripts per input. */
function fakeRunner(onInput: (text: string, socket: FakeSocket) => void) {
  const inputs: string[] = []
  const sockets: FakeSocket[] = []
  const emit = (socket: FakeSocket, frame: Frame) =>
    socket.emit('data', Buffer.from(JSON.stringify({ type: 'stdout', line: JSON.stringify(frame) }) + '\n'))
  const runtime = {
    ensureSessionReady: async () => ({ attempt: { attemptId: 'a1' } }),
    connectToAttempt: async () => {
      const socket = Object.assign(new EventEmitter(), {
        destroyed: false,
        destroy() { socket.destroyed = true; socket.emit('close') },
        write(line: string) {
          const text = String(JSON.parse(line).data).replace(/\n$/, '')
          inputs.push(text)
          onInput(text, socket)
          return true
        },
      }) as FakeSocket
      sockets.push(socket)
      return socket
    },
    createSession: async () => ({ sessionId: 'session-new' }),
    getSessionSnapshot: () => null,
    getSession: () => undefined,
  }
  return { runtime, inputs, sockets, emit }
}

function harness(runtime: object, rotation: { rotate: boolean; seedText?: string } = { rotate: false }) {
  const db = {
    incrementChannelSessionTurnCount: () => 1,
    resetChannelSessionTurnCount: () => {},
    touchSessionActivity: () => {},
    getChannelPlugin: () => null,
    getUserOrgId: () => 'org-1',
    findChannelSession: () => null,
  }
  const sessionManager = { getSession: () => ({ id: 'cs-1', conversationId: 'conv' }), updateSessionConversation: () => {} }
  const executor = new MossActionExecutor({} as never, sessionManager as never, {} as never, runtime as never, db as never)
  const internals = executor as unknown as Record<string, unknown>
  internals.getChannelUser = () => ({ id: 'cu-1', platformUserId: 'u1', platformType: 'wecom', authorizedAt: 0 })
  internals.planRotation = async () => rotation
  const sent: Sent[] = []
  const sendFn = async (msg: Record<string, unknown>) => { sent.push({ kind: 'send', text: String(msg.text), msg }); return `m-${sent.length}` }
  const editFn = async (_id: string, msg: Record<string, unknown>) => { sent.push({ kind: 'edit', text: String(msg.text), msg }); return true }
  const ask = (text: string, platform = 'wecom') =>
    (internals.processMessage as (...args: unknown[]) => Promise<void>).call(
      executor, platform, platform, 'user:u1', { id: 'u1' }, text, sendFn, editFn, 'owner-1')
  return { sent, ask }
}

/** Shorten the IM wait for one test; the setting's own floor is 30 seconds. */
function withResponseTimeout(ms: number): () => void {
  const target = MossActionExecutor as unknown as { responseTimeoutMs: () => number }
  const original = target.responseTimeoutMs
  target.responseTimeoutMs = () => ms
  return () => { target.responseTimeoutMs = original }
}

describe('IM reply delivery', () => {
  it('delivers a turn that finishes in time exactly as before', async () => {
    const runner = fakeRunner((_text, socket) => setTimeout(() => {
      runner.emit(socket, { type: 'assistant', content: 'The answer.' })
      runner.emit(socket, { type: 'result' })
    }, 5))
    const { sent, ask } = harness(runner.runtime)
    await ask('question')
    expect(sent.map(s => [s.kind, s.text])).toEqual([['send', '⏳ Thinking...'], ['edit', 'The answer.']])
    expect(sent[1]!.msg.replyMarkup).toEqual({})
  })

  it('ends the reply at once when the runner drops mid-turn (P2)', async () => {
    const runner = fakeRunner((_text, socket) => setTimeout(() => {
      runner.emit(socket, { type: 'assistant', content: 'Partial work.' })
      socket.emit('close')
    }, 5))
    const { sent, ask } = harness(runner.runtime)
    const started = Date.now()
    await ask('question')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(sent.at(-1)!.text).toMatch(/^Partial work\.\n\n❌ 会话连接已中断/)
  })

  it('tells the user when the runner exits mid-turn with no text (P2)', async () => {
    const runner = fakeRunner((_text, socket) => setTimeout(() => {
      socket.emit('data', Buffer.from(JSON.stringify({ type: 'exit', code: 1 }) + '\n'))
    }, 5))
    const { sent, ask } = harness(runner.runtime)
    await ask('question', 'lark')
    expect(sent.at(-1)!.text).toMatch(/^❌ 会话连接已中断/)
  })

  it('sends the answer of a turn that outlives the wait when it finishes (P1/P3)', async () => {
    const restore = withResponseTimeout(100)
    try {
      const runner = fakeRunner((_text, socket) => {
        runner.emit(socket, { type: 'assistant', content: '正在查询…' })
        setTimeout(() => {
          runner.emit(socket, { type: 'assistant', content: '最终报告' })
          runner.emit(socket, { type: 'result' })
        }, 600)
      })
      const { sent, ask } = harness(runner.runtime)
      await ask('question')
      expect(sent.at(-1)!.text).toMatch(/^正在查询…\n\n⏳ 处理时间较长/)
      expect(sent.at(-1)!.text).not.toContain('Please try again')
      await sleep(900)
      const late = sent.at(-1)!
      expect(late.kind).toBe('send')
      expect(late.text).toBe('最终报告')
      expect(late.msg.proactive).toBe(true)
      expect(late.msg.noStreaming).toBe(true)
    } finally { restore() }
  })

  it('still tells the user when a timed-out turn loses its runner', async () => {
    const restore = withResponseTimeout(100)
    try {
      const runner = fakeRunner((_text, socket) => {
        runner.emit(socket, { type: 'assistant', content: 'Step 1.' })
        setTimeout(() => { runner.emit(socket, { type: 'assistant', content: ' Step 2.' }); socket.emit('close') }, 400)
      })
      const { sent, ask } = harness(runner.runtime)
      await ask('question')
      await sleep(700)
      expect(sent.at(-1)!.msg.proactive).toBe(true)
      expect(sent.at(-1)!.text).toMatch(/^Step 2\.\n\n❌ 会话连接已中断/)
    } finally { restore() }
  })

  it('drops a pending late reply once a new turn starts', async () => {
    const restore = withResponseTimeout(100)
    try {
      const runner = fakeRunner((text, socket) => {
        const reply = text === 'first' ? 'old' : 'new'
        setTimeout(() => { runner.emit(socket, { type: 'assistant', content: reply }); runner.emit(socket, { type: 'result' }) },
          text === 'first' ? 300 : 600)
      })
      const { sent, ask } = harness(runner.runtime)
      await ask('first')
      restore()
      await ask('second')
      await sleep(500)
      expect(sent.some(s => s.msg.proactive)).toBe(false)
    } finally { restore() }
  })

  it('lets a history seed turn finish first, and never sends its reply as the answer (P1)', async () => {
    let isSeedDone = false
    let isQuestionAfterSeed: boolean | undefined
    const runner = fakeRunner((text, socket) => {
      if (text.startsWith('SEED')) {
        setTimeout(() => {
          runner.emit(socket, { type: 'assistant', content: '好的，已了解之前的对话。' })
          runner.emit(socket, { type: 'result' })
          isSeedDone = true
        }, 50)
      } else {
        isQuestionAfterSeed = isSeedDone
        setTimeout(() => { runner.emit(socket, { type: 'assistant', content: 'Real answer' }); runner.emit(socket, { type: 'result' }) }, 5)
      }
    })
    const { sent, ask } = harness(runner.runtime, { rotate: true, seedText: 'SEED summary' })
    await ask('question')
    expect(runner.inputs).toEqual(['SEED summary', 'question'])
    expect(isQuestionAfterSeed).toBe(true)
    expect(sent.at(-1)!.text).toBe('Real answer')
  })

  it('reconnects when the runner drops during the seed turn', async () => {
    const runner = fakeRunner((text, socket) => {
      if (text.startsWith('SEED')) setTimeout(() => socket.emit('close'), 20)
      else setTimeout(() => { runner.emit(socket, { type: 'assistant', content: 'After reconnect' }); runner.emit(socket, { type: 'result' }) }, 5)
    })
    const { sent, ask } = harness(runner.runtime, { rotate: true, seedText: 'SEED summary' })
    const started = Date.now()
    await ask('question')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(runner.sockets.length).toBe(2)
    expect(sent.at(-1)!.text).toBe('After reconnect')
  })
})

describe('WeCom streams', () => {
  function plugin(chatId: string, reqId: string) {
    const frames: Frame[] = []
    const instance = new WeComPlugin()
    ;(instance as unknown as { send: (frame: Frame) => void }).send = frame => { frames.push(frame) }
    ;(instance as unknown as { reqIdCache: Map<string, string> }).reqIdCache.set(chatId, reqId)
    return { frames, instance }
  }
  const stream = (frame: Frame) => (frame.body as { stream: { id: string; finish: boolean } }).stream

  it('closes a final message sent outside an open stream (P4)', async () => {
    const { frames, instance } = plugin('user:u1', 'req-1')
    await instance.sendMessage('user:u1', { type: 'text', text: '⏳ Thinking...' })
    await instance.sendMessage('user:u1', { type: 'text', text: 'final', replyMarkup: {} })
    expect(frames.map(f => stream(f).finish)).toEqual([false, true])
    // editMessage on a finished stream falls back to sendMessage; the final edit must close it.
    await instance.editMessage('user:u1', 'x', { type: 'text', text: 'final again', replyMarkup: {} })
    expect(stream(frames.at(-1)!).finish).toBe(true)
  })

  it('pushes a proactive message and leaves the open reply stream alone', async () => {
    const { frames, instance } = plugin('group:g1', 'req-2')
    await instance.sendMessage('group:g1', { type: 'text', text: '⏳ Thinking...' })
    const open = stream(frames[0]!).id
    await instance.sendMessage('group:g1', { type: 'text', text: 'late answer', proactive: true })
    expect(frames[1]!.cmd).toBe('aibot_send_msg')
    expect((frames[1]!.body as Record<string, unknown>).chat_type).toBe(2)
    await instance.editMessage('group:g1', 'x', { type: 'text', text: 'still my stream' })
    expect(stream(frames[2]!).id).toBe(open)
  })
})
