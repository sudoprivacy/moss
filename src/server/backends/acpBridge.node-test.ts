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
    child: child as unknown as import('node:child_process').ChildProcess, sessionId: 'session-test', cwd, model: 'gpt-4o', enabledSkillNames: [],
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
    await waitFor(() => output.some(e => e.type === 'result'))
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


void test('message transport carries permission ID zero, rejection, cancellation, and stale replies', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'moss-acp-mailbox-'))
  const sent: any[] = []
  let events: import('./acpTransport.js').AcpTransportEvents
  const transport: import('./acpTransport.js').AcpMessageTransport = {
    connected: true,
    start(value) { events = value },
    async send(message) { sent.push(message) },
    async close() { events.onClose(null, null) },
  }
  const output: any[] = []
  const handle = createAcpBridgeHandle({ transport, sessionId: 'moss-session', cwd, model: 'scripted',
    runtime: { type: 'k8s', engine: 'scode' } })
  handle.onStdoutLine(line => output.push(JSON.parse(line)))
  const receive = (message: any) => events.onMessage({ jsonrpc: '2.0', ...message })
  const reply = (requestId: string, behavior: string) => handle.writeStdin(JSON.stringify({
    type: 'control_response', response: {subtype: 'success', request_id: requestId, response: {behavior}},
  }))
  try {
    await delay(5)
    receive({id: 'm-init', result: {}})
    receive({id: 'm-session-new', result: {sessionId: 'durable'}})
    const permission = (id: number) => receive({id, method: 'session/request_permission', params: {
      sessionId: 'durable', toolCall: {title: 'write_file', rawInput: {path: 'a.txt'}},
      options: [{optionId: 'yes', kind: 'allow_once', name: 'Allow'}, {optionId: 'no', kind: 'reject_once', name: 'Reject'}],
    }})
    permission(0)
    const approval = output.find(event => event.type === 'control_request')
    assert.deepEqual(approval.request.rawInput, {path: 'a.txt'})
    assert.equal(sent.some(message => message.id === 0), false, 'no automatic approval')
    reply(approval.request_id, 'no')
    await delay(0)
    assert.deepEqual(sent.at(-1), {jsonrpc: '2.0', id: 0, result: {outcome: {outcome: 'selected', optionId: 'no'}}})
    permission(1)
    const second = output.filter(event => event.type === 'control_request').at(-1)
    reply(second.request_id, 'unadvertised-option')
    assert.deepEqual(sent.at(-1).result, {outcome: {outcome: 'cancelled'}})
    permission(2)
    const third = output.filter(event => event.type === 'control_request').at(-1)
    handle.writeStdin(JSON.stringify({type: 'control_request', request: {subtype: 'interrupt'}}))
    assert.equal(sent.at(-1).method, 'session/cancel')
    const count = sent.length
    reply(third.request_id, 'yes')
    reply(approval.request_id, 'yes')
    assert.equal(sent.length, count, 'stale answers neither approve a tool nor start a prompt')
  } finally { await handle.destroy(); await rm(cwd, {recursive: true, force: true}) }
})
