import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createAcpBridgeHandle } from './acpBridge.js'

void test('a failed ACP prompt emits an error result, releases busy, and allows the next turn', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'moss-acp-error-'))
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    killed: false,
    kill() { this.killed = true; return true },
  })
  const requests: Array<{ id: string; method: string }> = []
  child.stdin.on('data', chunk => requests.push(JSON.parse(String(chunk))))
  const output: Array<Record<string, any>> = []
  const handle = createAcpBridgeHandle({
    child, sessionId: 'session-test', cwd, model: 'gpt-4o', enabledSkillNames: [],
    runtime: { type: 'host', engine: 'scode' },
  })
  handle.onStdoutLine(line => output.push(JSON.parse(line)))
  const respond = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n')
  const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; i < 200 && !predicate(); i++) await delay(10)
    assert(predicate(), 'Timed out waiting for bridge state')
  }
  try {
    await waitFor(() => requests.some(r => r.id === 'm-init'))
    respond({ id: 'm-init', result: {} })
    respond({ id: 'm-session-new', result: { sessionId: 'engine-session' } })
    handle.writeStdin(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Reply OK' } }))
    await waitFor(() => requests.some(r => r.method === 'session/prompt'))
    assert.equal(handle.isBusy?.(), true)
    respond({ id: 'unrelated', error: { message: 'Ignore unrelated response' } })
    assert.equal(output.some(e => e.type === 'result'), false)
    assert.equal(handle.isBusy?.(), true)
    const first = requests.find(r => r.method === 'session/prompt')!
    respond({ id: first.id, error: { code: -32603, message: 'context_window_exceeded' } })
    assert.deepEqual(output.find(e => e.type === 'result'), {
      type: 'result', session_id: 'session-test', status: 'error',
      is_error: true, errors: ['context_window_exceeded'],
    })
    assert.equal(handle.isBusy?.(), false)
    handle.writeStdin(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Try again' } }))
    await waitFor(() => requests.filter(r => r.method === 'session/prompt').length === 2)
    assert.equal(handle.isBusy?.(), true)
    const second = requests.filter(r => r.method === 'session/prompt')[1]!
    respond({ id: second.id, result: { stopReason: 'end_turn' } })
    assert.equal(handle.isBusy?.(), false)
    await waitFor(() => output.filter(e => e.type === 'result').length === 2)
    assert.equal(output.filter(e => e.type === 'result').length, 2)
    assert.notEqual(output.filter(e => e.type === 'result')[1]!.is_error, true)
  } finally {
    await handle.destroy()
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
    await rm(cwd, { recursive: true, force: true })
  }
})
