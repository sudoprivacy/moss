import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createAcpBridgeHandle } from './acpBridge.js'
import { readSharedAgentMemory } from '../sharedAgentMemory.js'
import { defaultAgentName } from '../agentIdentity.js'

void test('a connection lost before runner subscriptions still reports one terminal exit', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'moss-early-acp-exit-'))
  let events!: import('./acpTransport.js').AcpTransportEvents
  let sends = 0
  const failure = new Error('Managed execution disappeared; resume the durable session')
  const transport: import('./acpTransport.js').AcpMessageTransport = {
    connected: false,
    start(value) { events = value; events.onClose(null, null, failure) },
    async send() { sends++ },
    async close() { events.onClose(null, null, failure) },
  }
  const handle = createAcpBridgeHandle({ transport, sessionId: 'early-exit', cwd, model: 'fixture',
    enabledSkillNames: [], runtime: { type: 'cohost', engine: 'scode' } })
  const exits: unknown[] = []
  const errors: string[] = []
  try {
    handle.onStderrLine(line => errors.push(line))
    handle.onExit((code, signal) => exits.push({ code, signal }))
    const unsubscribe = handle.onExit(() => assert.fail('Unsubscribed listener must not receive a replay'))
    unsubscribe()
    await new Promise(resolve => setImmediate(resolve))
    await handle.destroy()
    assert.deepEqual(exits, [{ code: null, signal: null }])
    assert.deepEqual(errors, [failure.message + '\n'])
    assert.equal(handle.isBusy?.(), false)
    assert.equal(sends, 0, 'A stopped connection must not begin a handshake')
  } finally { await handle.destroy(); await rm(cwd, { recursive: true, force: true }) }
})

void test('cohost prompts use the Nexus repository while host transcript state stays local', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'moss-cohost-workspace-'))
  const sent: any[] = []
  let events!: import('./acpTransport.js').AcpTransportEvents
  const transport: import('./acpTransport.js').AcpMessageTransport = {
    connected: true,
    start(value) { events = value },
    async send(message) { sent.push(message) },
    async close() {},
  }
  const repository = '/agents/fixture-user/workspaces/fixture-session'
  const workingRoot = '/proc/fixture-pid/workspace'
  const handle = createAcpBridgeHandle({
    transport, sessionId: 'cohost-workspace', cwd, model: 'fixture',
    executionWorkspace: { repository, workingRoot }, enabledSkillNames: [],
    runtime: { type: 'cohost', engine: 'scode' },
  })
  try {
    await delay(5)
    events.onMessage({ jsonrpc: '2.0', id: 'm-init', result: {} })
    events.onMessage({ jsonrpc: '2.0', id: 'm-session-new', result: { sessionId: 'fixture-native' } })
    handle.writeStdin(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Create report.txt' } }))
    for (let i = 0; i < 200 && !sent.some(message => message.method === 'session/prompt'); i++) await delay(10)
    const prompt = sent.find(message => message.method === 'session/prompt')
    assert(prompt, 'Timed out waiting for the actual ACP prompt')
    const text = prompt.params.prompt[0].text
    assert(text.includes(`Workspace: ${repository}`))
    assert(text.includes(`Drafts (草稿箱): ${repository}/.drafts`))
    assert(text.includes(`Relative file paths resolve from ${workingRoot}`))
    assert(text.includes(`workspace/report.txt addresses ${repository}/report.txt`))
    assert(!text.includes(`Workspace: ${cwd}`))
    assert.equal(handle.workDir, cwd)
  } finally {
    await handle.destroy()
    await rm(cwd, { recursive: true, force: true })
  }
})

void test('terminal tool updates retain live and durable results before a later model failure', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'moss-tool-results-'))
  const transcriptPath = join(cwd, 'transcript.jsonl')
  const sent: any[] = []
  const output: any[] = []
  let events!: import('./acpTransport.js').AcpTransportEvents
  const transport: import('./acpTransport.js').AcpMessageTransport = {
    connected: true, start(value) { events = value },
    async send(message) { sent.push(message) }, async close() {},
  }
  const handle = createAcpBridgeHandle({
    transport, sessionId: 'tool-results', cwd, model: 'fixture', transcriptPath,
    enabledSkillNames: [], runtime: { type: 'cohost', engine: 'scode' },
  })
  handle.onStdoutLine(line => output.push(JSON.parse(line)))
  const receive = (message: any) => events.onMessage({ jsonrpc: '2.0', ...message })
  const update = (value: any) => receive({ method: 'session/update', params: { sessionId: 'fixture-native', update: value } })
  try {
    await delay(5)
    receive({ id: 'm-init', result: {} })
    receive({ id: 'm-session-new', result: { sessionId: 'fixture-native' } })
    handle.writeStdin(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Read the file' } }))
    for (let i = 0; i < 200 && !sent.some(message => message.method === 'session/prompt'); i++) await delay(10)
    const prompt = sent.find(message => message.method === 'session/prompt')
    assert(prompt)
    for (const [id, status, text] of [['read-ok', 'completed', 'actual file bytes'], ['write-failed', 'failed', 'Nexus did not write: no writable backend']]) {
      update({ sessionUpdate: 'tool_call', toolCallId: id, title: id === 'read-ok' ? 'read_file' : 'write_file', rawInput: { path: 'workspace/proof.txt' } })
      update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text } }] })
      update({ sessionUpdate: 'tool_call_update', toolCallId: id, status })
      assert.equal(output.filter(event => event.type === 'tool_result' && event.tool_use_id === id).length, 1)
    }
    assert.equal(handle.isBusy?.(), true, 'tool completion does not finish the model turn')
    receive({ id: prompt.id, error: { message: 'upstream stream truncated' } })
    for (let i = 0; i < 200 && !output.some(event => event.type === 'result'); i++) await delay(10)
    const results = output.filter(event => event.type === 'tool_result')
    assert.deepEqual(results.map(result => [result.tool_use_id, result.content, result.is_error]), [
      ['read-ok', 'actual file bytes', false],
      ['write-failed', 'Nexus did not write: no writable backend', true],
    ])
    assert.equal(handle.isBusy?.(), false)
    for (let i = 0; i < 200; i++) {
      const transcript = await readFile(transcriptPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return ''
        throw error
      })
      const records = transcript.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      if (records.filter(record => record.type === 'tool_result').length === 2) break
      await delay(10)
    }
    const records = (await readFile(transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(records.filter(record => record.type === 'tool_result').map(result => [result.content, result.is_error]), results.map(result => [result.content, result.is_error]))
    receive({ id: 'late-duplicate', result: { stopReason: 'end_turn' } })
    assert.equal(output.filter(event => event.type === 'tool_result').length, 2)
  } finally {
    await handle.destroy()
    await rm(cwd, { recursive: true, force: true })
  }
})

void test('a cloud turn persists an explicit fact before dispatching its prompt', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'moss-cloud-memory-'))
  const sent: any[] = []
  let events!: import('./acpTransport.js').AcpTransportEvents
  const transport: import('./acpTransport.js').AcpMessageTransport = {
    connected: true,
    start(value) {
      events = value
    },
    async send(message) {
      sent.push(message)
    },
    async close() {},
  }
  const assistantName = defaultAgentName('fixture-user')
  const handle = createAcpBridgeHandle({
    transport,
    sessionId: 'cloud-memory',
    cwd,
    model: 'fixture',
    assistantName,
    enabledSkillNames: [],
    runtime: { type: 'k8s', engine: 'scode', k8sMode: 'user', configDir: cwd },
  })
  try {
    await delay(5)
    events.onMessage({ jsonrpc: '2.0', id: 'm-init', result: {} })
    events.onMessage({
      jsonrpc: '2.0',
      id: 'm-session-new',
      result: { sessionId: 'fixture-engine' },
    })
    handle.writeStdin(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '记住：My project color is olive-cloud-fixture' },
      }),
    )
    for (let i = 0; i < 200 && !sent.some((message) => message.method === 'session/prompt'); i++)
      await delay(10)
    assert(sent.some((message) => message.method === 'session/prompt'))
    assert.match((await readSharedAgentMemory(cwd, assistantName))!, /olive-cloud-fixture/)
    assert.equal(await readSharedAgentMemory(cwd, defaultAgentName('other-user')), null)
  } finally {
    await handle.destroy()
    await rm(cwd, { recursive: true, force: true })
  }
})

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
