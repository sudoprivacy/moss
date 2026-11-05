// Turn watchdog of the ACP bridge: a turn whose model goes silent (a provider
// stream that only sends keep-alives) or whose prompt scode rejects must end
// with an error result instead of leaving every client waiting forever.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import type { ChildProcess } from 'node:child_process'
import { createAcpBridgeHandle } from '../backends/acpBridge.js'

type Rpc = { jsonrpc: '2.0'; id?: string; method?: string; params?: any }
type Script = {
  onPrompt?: (prompt: Rpc, fake: FakeScode) => void
  onCancel?: (fake: FakeScode) => void
}

class FakeScode extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  received: Rpc[] = []
  promptId: string | null = null

  constructor(script: Script) {
    super()
    createInterface({ input: this.stdin }).on('line', line => {
      const msg = JSON.parse(line) as Rpc
      this.received.push(msg)
      if (msg.id === 'm-init') this.send({ jsonrpc: '2.0', id: 'm-init', result: {} })
      else if (msg.id === 'm-session-new') this.send({ jsonrpc: '2.0', id: 'm-session-new', result: { sessionId: 'acp-1' } })
      else if (msg.method === 'session/prompt') {
        this.promptId = msg.id ?? null
        script.onPrompt?.(msg, this)
      } else if (msg.method === 'session/cancel') script.onCancel?.(this)
    })
  }

  send(msg: unknown): void {
    this.stdout.write(JSON.stringify(msg) + '\n')
  }

  update(update: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-1', update } })
  }

  stop(stopReason = 'end_turn'): void {
    this.send({ jsonrpc: '2.0', id: this.promptId, result: { stopReason } })
  }

  kill(): boolean {
    this.killed = true
    return true
  }
}

function startBridge(script: Script, opts: { stallMs: number; graceMs?: number }) {
  const fake = new FakeScode(script)
  const handle = createAcpBridgeHandle({
    child: fake as unknown as ChildProcess,
    sessionId: 'moss-1',
    cwd: '/tmp',
    model: 'test-model',
    runtime: { type: 'host', engine: 'scode' } as never,
    turnStallTimeoutMs: opts.stallMs,
    turnStallCancelGraceMs: opts.graceMs ?? 100,
  })
  const results: Array<{ status: string; error?: string }> = []
  handle.onStdoutLine(line => {
    try {
      const ev = JSON.parse(line)
      if (ev.type === 'result') results.push(ev)
    } catch {
      // not an event
    }
  })
  const nextResult = (timeoutMs = 3000) =>
    new Promise<{ status: string; error?: string }>((resolve, reject) => {
      const seen = results.length
      const started = Date.now()
      const tick = setInterval(() => {
        if (results.length > seen) {
          clearInterval(tick)
          resolve(results[seen]!)
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(tick)
          reject(new Error('no result event'))
        }
      }, 10)
    })
  return { fake, handle, results, nextResult }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('ACP bridge turn watchdog', () => {
  it('ends a turn whose model stays silent: cancels it and reports model_stalled', async () => {
    const { fake, handle, nextResult } = startBridge({
      // The model never answers; scode honours the cancel.
      onCancel: f => f.stop('cancelled'),
    }, { stallMs: 200 })
    const result = nextResult()
    handle.writeStdin('hello')
    const r = await result
    assert.equal(r.status, 'error')
    assert.match(r.error ?? '', /^model_stalled/)
    assert.ok(fake.received.some(m => m.method === 'session/cancel'), 'session/cancel was sent')
    assert.equal(handle.isBusy?.(), false)
    handle.destroy()
  })

  it('ends the turn itself when scode does not confirm the cancel, and drops the late answer', async () => {
    const { fake, handle, results, nextResult } = startBridge({}, { stallMs: 150, graceMs: 100 })
    const result = nextResult()
    handle.writeStdin('hello')
    const r = await result
    assert.equal(r.status, 'error')
    assert.match(r.error ?? '', /^model_stalled/)
    assert.equal(handle.isBusy?.(), false)
    // scode answers the abandoned prompt much later: no second result.
    fake.stop()
    await sleep(100)
    assert.equal(results.length, 1)
    handle.destroy()
  })

  it('reports a prompt scode rejects instead of waiting forever', async () => {
    const { handle, nextResult } = startBridge({
      onPrompt: (p, f) => f.send({ jsonrpc: '2.0', id: p.id, error: { code: -32603, message: 'provider returned 400' } }),
    }, { stallMs: 0 })
    const result = nextResult()
    handle.writeStdin('hello')
    const r = await result
    assert.equal(r.status, 'error')
    assert.equal(r.error, 'prompt_failed: provider returned 400')
    assert.equal(handle.isBusy?.(), false)
    handle.destroy()
  })

  it('does not count a running tool as silence', async () => {
    const { fake, handle, nextResult } = startBridge({
      onPrompt: async (_p, f) => {
        f.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash', status: 'in_progress', rawInput: { command: 'sleep 1' } })
        await sleep(600) // three stall periods with the tool still running
        f.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] })
        f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } })
        f.stop()
      },
    }, { stallMs: 200 })
    const result = nextResult()
    handle.writeStdin('hello')
    const r = await result
    assert.equal(r.status, 'success')
    assert.ok(!fake.received.some(m => m.method === 'session/cancel'), 'no cancel was sent')
    handle.destroy()
  })

  it('keeps a turn alive while the model streams, however long it takes', async () => {
    const { fake, handle, nextResult } = startBridge({
      onPrompt: async (_p, f) => {
        for (let i = 0; i < 6; i++) {
          f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `part ${i} ` } })
          await sleep(100)
        }
        f.stop()
      },
    }, { stallMs: 250 })
    const result = nextResult()
    handle.writeStdin('hello')
    const r = await result
    assert.equal(r.status, 'success')
    assert.ok(!fake.received.some(m => m.method === 'session/cancel'))
    handle.destroy()
  })

  it('is off with a stall timeout of 0', async () => {
    const { fake, handle, results } = startBridge({}, { stallMs: 0 })
    handle.writeStdin('hello')
    await sleep(400)
    assert.equal(results.length, 0)
    assert.ok(!fake.received.some(m => m.method === 'session/cancel'))
    handle.destroy()
  })
})
