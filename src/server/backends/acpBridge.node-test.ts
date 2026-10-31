import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createAcpBridgeHandle } from './acpBridge.js'
import { readSharedAgentMemory } from '../sharedAgentMemory.js'
import { defaultAgentName } from '../agentIdentity.js'
import { readAcpExecutionWorkspace } from './executionWorkspace.js'
import { parseSessionTranscriptMessages } from '../transcriptMessages.js'
import { ArtifactTracker } from '../artifacts.js'

void test('context projection retains durable terminal facts and excludes live observations', () => {
  const failure = { type: 'result', uuid: 'failure', timestamp: '2026-10-19T00:00:02Z',
    subtype: 'error_interrupted', is_error: true, errors: ['Execution outcome is unknown'] }
  const success = { type: 'result', uuid: 'success', timestamp: '2026-10-19T00:00:03Z',
    subtype: 'success', is_error: false, usage: { output_tokens: 7 } }
  const records = [success, { ...failure, uuid: 'sidechain', isSidechain: true },
    { type: 'progress', uuid: 'progress' }, { type: 'hello', uuid: 'hello' }, failure,
    { type: 'user', uuid: 'user', timestamp: '2026-10-19T00:00:01Z', message: { content: 'Run' } }]
  const messages = parseSessionTranscriptMessages(records.map(record => JSON.stringify(record)).join('\n') + '\nmalformed\n')
  assert.deepEqual(messages.map(message => message.uuid), ['user', 'failure', 'success'])
  assert.deepEqual(messages.slice(1), [failure, success])
  assert.equal(messages[0]?.content, 'Run')
})

void test('runtime workspace metadata is additive but malformed roots fail explicitly', () => {
  assert.equal(readAcpExecutionWorkspace({ sessionId: 'old-runtime' }), undefined)
  assert.deepEqual(readAcpExecutionWorkspace({ _meta: { sudocode: { workspace: {
    fileRoot: '/proc/hosted/workspace', shellRoot: '/data/agent/shell',
  } } } }, '/agents/helper/workspaces/session'), {
    repository: '/agents/helper/workspaces/session', workingRoot: '/proc/hosted/workspace', shellRoot: '/data/agent/shell',
  }, 'a virtual project retains its canonical repository identity')
  for (const workspace of [{ fileRoot: '../outside', shellRoot: '/project' }, { fileRoot: '/project' }, null]) {
    assert.throws(() => readAcpExecutionWorkspace({ _meta: { sudocode: { workspace } } }), /Invalid ACP execution workspace/)
  }
})

for (const isResume of [false, true]) {
  void test(`native ${isResume ? 'resume' : 'creation'} uses runtime workspace and installed skills in its first prompt`, async t => {
    const cwd = await mkdtemp(join(tmpdir(), 'moss-remote-workspace-'))
    const sent: any[] = []
    const waiters = new Map<string, (message: any) => void>()
    let events!: import('./acpTransport.js').AcpTransportEvents
    const transport: import('./acpTransport.js').AcpMessageTransport = {
      connected: true, start(value) { events = value },
      async send(message) { sent.push(message); waiters.get(message.method!)?.(message) }, async close() {},
    }
    const waitForSend = (method: string): Promise<any> => {
      const existing = sent.find(message => message.method === method)
      return existing ? Promise.resolve(existing) : new Promise(resolve => waiters.set(method, resolve))
    }
    const handle = createAcpBridgeHandle({ transport, cwd, sessionId: 'remote-workspace', model: 'fixture',
      runtime: { type: 'cohost', engine: 'scode' }, resumeSessionId: isResume ? 'native-session' : undefined,
      executionWorkspace: { repository: '/agents/helper/workspaces/session', workingRoot: '/proc/old/workspace' },
      workspaceSkills: [{ name: 'authorized-skill', description: 'An installed skill' }],
      instructions: 'NATIVE_APPLICATION_ROLE_CONTEXT',
    })
    t.after(async () => { await handle.destroy(true); await rm(cwd, { recursive: true, force: true }) })
    await waitForSend('initialize')
    events.onMessage({ jsonrpc: '2.0', id: 'm-init', result: {} })
    const method = isResume ? 'session/load' : 'session/new'
    const request = await waitForSend(method)
    assert.equal(request.params._meta.sudocode.appendSystemPrompt, 'NATIVE_APPLICATION_ROLE_CONTEXT')
    events.onMessage({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'native-session',
      _meta: { sudocode: { workspace: { fileRoot: '/data/files/project', shellRoot: '/data/files/project' } } },
    } })
    handle.writeStdin(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Use my skill' } }))
    const prompt = await waitForSend('session/prompt')
    const text = prompt.params.prompt.map((part: any) => part.text ?? '').join('\n')
    assert.match(text, /Workspace: \/data\/files\/project/)
    assert.match(text, /Bash starts in \/data\/files\/project/)
    assert.match(text, /\/data\/files\/project\/\.nexus\/sudocode\/skills\/authorized-skill\/SKILL\.md/)
    assert(!text.includes(cwd), 'a controller-side directory is not a runtime path')
    assert(!text.includes('/proc/old/workspace'))
    assert(!text.includes('workspace/report.txt'), 'the native root must not inherit the old procfs alias instructions')
  })
}

for (const ending of ['connection loss', 'prompt error', 'cancelled turn', 'forced close']) {
  void test(`an unfinished tool retains an interrupted result after ${ending}`, { timeout: 10000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'moss-interrupted-tool-'))
    const transcriptPath = join(cwd, 'transcript.jsonl')
    const sent: any[] = []
    const output: any[] = []
    const waiters = new Set<{ method: string; resolve: (message: any) => void }>()
    let events!: import('./acpTransport.js').AcpTransportEvents
    const transport: import('./acpTransport.js').AcpMessageTransport = {
      connected: true,
      start(value) { events = value },
      async send(message) {
        sent.push(message)
        for (const waiter of waiters) {
          if (message.method === waiter.method) { waiters.delete(waiter); waiter.resolve(message) }
        }
      },
      async close() {},
    }
    const waitForSend = (method: string): Promise<any> => {
      const existing = sent.find(message => message.method === method)
      return existing ? Promise.resolve(existing) : new Promise(resolve => waiters.add({ method, resolve }))
    }
    const handle = createAcpBridgeHandle({ transport, sessionId: 'interrupted-tools', cwd,
      model: 'fixture', transcriptPath, enabledSkillNames: [], runtime: { type: 'cohost', engine: 'scode' } })
    handle.onStdoutLine(line => output.push(JSON.parse(line)))
    const receive = (message: any) => events.onMessage({ jsonrpc: '2.0', ...message })
    const update = (value: any) => receive({ method: 'session/update', params: {
      sessionId: 'native-interrupted', update: value,
    } })
    try {
      await waitForSend('initialize')
      receive({ id: 'm-init', result: {} })
      receive({ id: 'm-session-new', result: { sessionId: 'native-interrupted' } })
      handle.writeStdin(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Run the task' } }))
      const prompt = await waitForSend('session/prompt')
      update({ sessionUpdate: 'tool_call', toolCallId: 'completed', title: 'read_file', rawInput: {} })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'completed', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'finished bytes' } }] })
      update({ sessionUpdate: 'tool_call', toolCallId: 'interrupted', title: 'bash', rawInput: { command: 'slow-task' } })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'interrupted', status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'partial tool output' } }] })
      if (ending === 'connection loss') events.onClose(null, null, new Error('connection disappeared'))
      if (ending === 'prompt error') receive({ id: prompt.id, error: { message: 'model request failed' } })
      if (ending === 'cancelled turn') receive({ id: prompt.id, result: { stopReason: 'cancelled' } })
      await handle.destroy(true)
      await handle.destroy(true)
      const records = (await readFile(transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      const interrupted = records.filter(record => record.type === 'tool_result' && record.tool_use_id === 'interrupted')
      assert.equal(interrupted.length, 1, 'reload must retain one terminal result for the unfinished tool')
      assert.equal(interrupted[0].is_error, true, 'missing acknowledgement cannot be presented as success')
      assert.match(interrupted[0].content, /partial tool output/)
      assert.match(interrupted[0].content, /side effects/i)
      assert.match(interrupted[0].content, /before retrying/i)
      const completed = records.filter(record => record.type === 'tool_result' && record.tool_use_id === 'completed')
      assert.equal(completed.length, 1)
      assert.equal(completed[0].is_error, false)
      assert.equal(completed[0].content, 'finished bytes')
      assert.equal(output.filter(record => record.type === 'tool_result' && record.tool_use_id === 'interrupted').length, 1)
      assert.equal(sent.filter(message => message.method === 'session/prompt').length, 1, 'recovery must not replay a side effect')
      if (ending === 'connection loss') {
        const terminal = output.filter(record => record.type === 'result')
        assert.equal(terminal.length, 1, 'a lost transport must end the visible turn before its runner exits')
        assert.equal(terminal[0].is_error, true)
        assert.equal(terminal[0].subtype, 'error_interrupted')
        assert.match(terminal[0].errors.join('\n'), /outcome.*unknown/i)
        assert.deepEqual(records.filter(record => record.type === 'result'), terminal,
          'history and the live stream must carry the same classified terminal result')
        const messages = parseSessionTranscriptMessages(await readFile(transcriptPath, 'utf8'))
        assert.deepEqual(messages.filter(record => record.type === 'result'), terminal,
          'the context API must retain the exact persisted interruption for a page reload')
        assert.equal(messages.filter(record => record.type === 'tool_result' && record.tool_use_id === 'interrupted').length, 1)
      }
    } finally { await handle.destroy(); await rm(cwd, { recursive: true, force: true }) }
  })
}

void test('closing a live turn retains the rendered answer once without a prompt response', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'moss-close-turn-history-'))
  const transcriptPath = join(cwd, 'transcript.jsonl')
  const sent: any[] = []
  const output: any[] = []
  let events!: import('./acpTransport.js').AcpTransportEvents
  const transport: import('./acpTransport.js').AcpMessageTransport = {
    connected: true, start(value) { events = value },
    async send(message) { sent.push(message) }, async close() {},
  }
  const handle = createAcpBridgeHandle({ transport, sessionId: 'closed-history', cwd,
    model: 'fixture', transcriptPath, enabledSkillNames: [], runtime: { type: 'cohost', engine: 'scode' } })
  handle.onStdoutLine(line => output.push(JSON.parse(line)))
  try {
    for (let i = 0; i < 200 && !sent.some(message => message.id === 'm-init'); i++) await delay(10)
    events.onMessage({ jsonrpc: '2.0', id: 'm-init', result: {} })
    events.onMessage({ jsonrpc: '2.0', id: 'm-session-new', result: { sessionId: 'native-closed-history' } })
    handle.writeStdin(JSON.stringify({ type: 'user', message: { role: 'user', content: 'A slow reply' } }))
    for (let i = 0; i < 200 && !sent.some(message => message.method === 'session/prompt'); i++) await delay(10)
    assert(sent.some(message => message.method === 'session/prompt'))
    events.onMessage({ jsonrpc: '2.0', method: 'session/update', params: {
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Visible partial answer' } },
    } })
    await handle.destroy(true)
    await handle.destroy(true)
    const records = (await readFile(transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const assistants = records.filter(record => record.type === 'assistant')
    assert.equal(assistants.length, 1)
    assert.equal(assistants[0].message.content[0].text, 'Visible partial answer')
    assert.equal(assistants[0].message.partial, true)
    assert.equal(assistants[0].uuid, output.find(event => event.type === 'assistant').uuid)
    assert.equal(assistants[0].parentUuid, records.find(record => record.type === 'user').uuid)
  } finally { await handle.destroy(); await rm(cwd, { recursive: true, force: true }) }
})

for (const chunks of [[], ['api returned 403 Forbidden: ', 'enterprise balance is insufficient']]) {
  void test(`failed prompt diagnostics survive context reload with ${chunks.length} streamed chunks`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'moss-failed-turn-history-'))
    const transcriptPath = join(cwd, 'transcript.jsonl')
    const sent: any[] = []
    const output: any[] = []
    let events!: import('./acpTransport.js').AcpTransportEvents
    const transport: import('./acpTransport.js').AcpMessageTransport = {
      connected: true, start(value) { events = value },
      async send(message) { sent.push(message) }, async close() {},
    }
    const handle = createAcpBridgeHandle({ transport, sessionId: 'failed-history', cwd,
      model: 'fixture', transcriptPath, enabledSkillNames: [], runtime: { type: 'cohost', engine: 'scode' } })
    handle.onStdoutLine(line => output.push(JSON.parse(line)))
    const receive = (message: any) => events.onMessage({ jsonrpc: '2.0', ...message })
    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 200 && !predicate(); i++) await delay(10)
      assert(predicate(), 'Timed out waiting for the ACP turn')
    }
    try {
      await waitFor(() => sent.some(message => message.id === 'm-init'))
      receive({ id: 'm-init', result: {} })
      receive({ id: 'm-session-new', result: { sessionId: 'native-failed-history' } })
      handle.writeStdin(JSON.stringify({ type: 'user', message: { role: 'user', content: 'First request' } }))
      await waitFor(() => sent.some(message => message.method === 'session/prompt'))
      for (const text of chunks) receive({ method: 'session/update', params: {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      } })
      const first = sent.find(message => message.method === 'session/prompt')
      receive({ id: first.id, error: { code: -32603, message: 'Internal error' } })
      receive({ id: first.id, error: { code: -32603, message: 'Duplicate error response' } })
      await waitFor(() => output.some(event => event.type === 'result'))
      assert.equal(handle.isBusy?.(), false)
      handle.writeStdin(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Retry request' } }))
      await waitFor(() => sent.filter(message => message.method === 'session/prompt').length === 2)
      receive({ method: 'session/update', params: {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Retry succeeded' } },
      } })
      const second = sent.filter(message => message.method === 'session/prompt')[1]
      receive({ id: second.id, result: { stopReason: 'end_turn' } })
      await waitFor(() => output.filter(event => event.type === 'result').length === 2)
      await handle.destroy()
      const records = (await readFile(transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      const assistants = records.filter(record => record.type === 'assistant')
      assert.equal(assistants.length, 2, 'Each turn must retain one stable assistant record')
      assert.equal(assistants[0].message.content[0].text, chunks.join('') || 'Internal error')
      assert.equal(assistants[0].message.is_error, true)
      assert.equal(assistants[1].message.content[0].text, 'Retry succeeded')
      const liveAssistant = output.find(event => event.type === 'assistant')
      assert.equal(assistants[0].uuid, liveAssistant.uuid, 'Live and durable records must share one identity')
      const retry = records.find(record => record.type === 'user' && record.message.content === 'Retry request')
      assert.equal(retry.parentUuid, assistants[0].uuid)
    } finally { await handle.destroy(); await rm(cwd, { recursive: true, force: true }) }
  })
}

void test('a subscribed runner receives the original transport error once', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'moss-live-acp-exit-'))
  let events!: import('./acpTransport.js').AcpTransportEvents
  const failure = new Error('Managed transport cleanup failed')
  const transport: import('./acpTransport.js').AcpMessageTransport = {
    connected: true, start(value) { events = value }, async send() {},
    async close() { events.onClose(null, null, failure) },
  }
  const handle = createAcpBridgeHandle({ transport, sessionId: 'live-exit', cwd, model: 'fixture',
    enabledSkillNames: [], runtime: { type: 'cohost', engine: 'scode' } })
  const exits: unknown[] = []
  try {
    handle.onExit((code, signal, error) => exits.push({ code, signal, error }))
    await handle.destroy()
    await handle.destroy()
    assert.deepEqual(exits, [{ code: null, signal: null, error: failure }])
  } finally {
    await handle.destroy()
    assert.ok(cwd.startsWith(join(tmpdir(), 'moss-live-acp-exit-')))
    await rm(cwd, { recursive: true, force: true })
  }
})

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
    handle.onExit((code, signal, error) => exits.push({ code, signal, error }))
    const unsubscribe = handle.onExit(() => assert.fail('Unsubscribed listener must not receive a replay'))
    unsubscribe()
    await new Promise(resolve => setImmediate(resolve))
    await handle.destroy()
    assert.deepEqual(exits, [{ code: null, signal: null, error: failure }])
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

for (const isPreparationRejected of [false, true]) {
  void test(`native input remains busy through artifact preparation and ${isPreparationRejected ? 'rejection' : 'engine handoff'}`, async t => {
    const cwd = await mkdtemp(join(tmpdir(), 'moss-input-preparation-'))
    const sent: any[] = []
    const output: any[] = []
    let events!: import('./acpTransport.js').AcpTransportEvents
    let release!: () => void
    let onPreparing!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const preparing = new Promise<void>(resolve => { onPreparing = resolve })
    t.mock.method(ArtifactTracker.prototype, 'begin', async () => {
      onPreparing()
      await held
      if (isPreparationRejected) throw new Error('Artifact preparation refused')
    })
    const transport: import('./acpTransport.js').AcpMessageTransport = {
      connected: true, start(value) { events = value },
      async send(message) { sent.push(message) }, async close() { events.onClose(null, null) },
    }
    const handle = createAcpBridgeHandle({ transport, cwd, sessionId: 'preparing-input', model: 'fixture',
      enabledSkillNames: [], runtime: { type: 'host', engine: 'scode' } })
    t.after(async () => {
      release()
      await handle.destroy(true)
      await rm(cwd, { recursive: true, force: true })
    })
    handle.onStdoutLine(line => output.push(JSON.parse(line)))
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5000
      while (!predicate()) { assert.ok(Date.now() < deadline, 'protocol event deadline'); await delay(5) }
    }
    const receive = (value: any) => events.onMessage({ jsonrpc: '2.0', ...value })
    await waitFor(() => sent.some(item => item.method === 'initialize'))
    receive({ id: 'm-init', result: { _meta: { sudocode: { inputDelivery: { version: 1 } } } } })
    receive({ id: 'm-session-new', result: { sessionId: 'native-preparation' } })
    assert.equal(handle.isBusy?.(), false)
    handle.writeStdin(JSON.stringify({ type: 'control_request', request_id: 'original', request: { subtype: 'input',
      action: { action: 'submit', clientId: 'original', delivery: 'queue', content: [{ type: 'text', text: 'Accepted input' }] } } }))
    await preparing
    assert.equal(sent.some(item => item.params?.action === 'submit'), false)
    assert.equal(handle.isBusy?.(), true, 'maintenance must not observe idle while accepted input can still reach the engine')
    release()
    if (isPreparationRejected) {
      await waitFor(() => output.some(item => item.requestId === 'original'))
      assert.match(output.find(item => item.requestId === 'original').error, /Artifact preparation refused/)
      assert.equal(sent.some(item => item.params?.action === 'submit'), false)
    } else {
      await waitFor(() => sent.some(item => item.params?.action === 'submit'))
      const submit = sent.find(item => item.params?.action === 'submit')
      assert.equal(handle.isBusy?.(), true, 'native acknowledgement is still pending')
      receive({ method: '_sudocode/session/input_update', params: { sessionId: 'native-preparation',
        update: { kind: 'state', state: { revision: 1, activeTurnId: 1, running: true, paused: false, pending: [] } } } })
      receive({ id: submit.id, result: { id: 1 } })
      await waitFor(() => output.some(item => item.requestId === 'original'))
      assert.equal(handle.isBusy?.(), true, 'the engine is still running after handoff')
      receive({ method: '_sudocode/session/input_update', params: { sessionId: 'native-preparation',
        update: { kind: 'state', state: { revision: 2, activeTurnId: null, running: false, paused: false, pending: [] } } } })
      assert.equal(sent.filter(item => item.params?.action === 'submit').length, 1, 'maintenance observation must not replay input')
    }
    assert.equal(handle.isBusy?.(), false)
  })
}

void test('native input forwarding preserves admission, commit, flush and cancellation boundaries', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'moss-input-delivery-'))
  const transcriptPath = join(cwd, 'transcript.jsonl')
  const sent: any[] = []
  const output: any[] = []
  let events!: import('./acpTransport.js').AcpTransportEvents
  const transport: import('./acpTransport.js').AcpMessageTransport = {
    connected: true, start(value) { events = value },
    async send(message) { sent.push(message) }, async close() {},
  }
  const handle = createAcpBridgeHandle({ transport, cwd, sessionId: 'input-host', model: 'fixture',
    transcriptPath, enabledSkillNames: [], runtime: { type: 'cohost', engine: 'scode' } })
  t.after(async () => { await handle.destroy(); await rm(cwd, { recursive: true, force: true }) })
  handle.onStdoutLine(line => output.push(JSON.parse(line)))
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000
    while (!predicate()) { assert.ok(Date.now() < deadline, 'protocol event deadline'); await delay(5) }
  }
  const receive = (value: any) => events.onMessage({ jsonrpc: '2.0', ...value })
  const state = (revision: number, pending: any[], running = true) => ({ revision, activeTurnId: running ? 1 : null, running, paused: false, pending })
  const update = (value: any) => receive({ method: '_sudocode/session/input_update', params: { sessionId: 'input-native', update: value } })
  const control = (requestId: string, action: any) => handle.writeStdin(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'input', action } }))
  await waitFor(() => sent.some(item => item.method === 'initialize'))
  control('cold-snapshot', { action: 'snapshot' })
  receive({ id: 'm-init', result: { _meta: { sudocode: { inputDelivery: { version: 1 } } } } })
  receive({ id: 'm-session-new', result: { sessionId: 'input-native' } })
  await waitFor(() => sent.some(item => item.params?.action === 'snapshot'))
  const snapshot = sent.find(item => item.params?.action === 'snapshot')
  receive({ id: snapshot.id, result: { state: state(1, [], false) } })
  await waitFor(() => output.some(item => item.requestId === 'cold-snapshot'))
  assert.equal(output.find(item => item.requestId === 'cold-snapshot').isSupported, true)

  const content = [{ type: 'text', text: 'REFERENCE_INPUT: continue the original task' }, { type: 'image', mimeType: 'image/png', data: 'test-png' }]
  control('submit', { action: 'submit', clientId: 'draft-1', delivery: 'queue', display: 'original draft', draft: { text: 'original draft', files: ['/webupload/example'] }, content })
  await waitFor(() => sent.some(item => item.params?.action === 'submit'))
  const submit = sent.find(item => item.params?.action === 'submit')
  assert.equal(submit.method, '_sudocode/session/input')
  assert.equal(submit.params.delivery, 'queue')
  assert.equal(submit.params.display, 'original draft')
  assert.equal(submit.params.content[0].data, 'test-png')
  assert.deepEqual(submit.params.draft, { text: 'original draft', files: ['/webupload/example'] })
  const pending = [{ id: 2, clientId: 'draft-1', display: 'original draft', source: 'human', delivery: 'queue' }]
  update({ kind: 'state', state: state(2, pending) })
  receive({ id: submit.id, result: { id: 2, state: state(2, pending) } })
  await waitFor(() => output.some(item => item.requestId === 'submit'))
  assert.equal((await readFile(transcriptPath, 'utf8').catch(() => '')).includes('REFERENCE_INPUT'), false, 'admission is not durable model consumption')
  control('flush', { action: 'flush_or_cancel' })
  await waitFor(() => sent.some(item => item.params?.action === 'flush_or_cancel'))
  const flush = sent.find(item => item.params?.action === 'flush_or_cancel')
  receive({ id: flush.id, result: { cancelled: false, state: state(3, pending) } })
  assert.equal(sent.some(item => item.method === 'session/cancel'), false, 'flush must not synthesize cancellation')
  update({ kind: 'committed', clientId: 'draft-1', source: 'human', display: 'original draft' })
  update({ kind: 'state', state: state(4, []) })
  await waitFor(() => output.some(item => item.update?.kind === 'committed'))
  handle.writeStdin(JSON.stringify({ type: 'control_request', request_id: 'cancel', request: { subtype: 'interrupt' } }))
  assert.equal(sent.filter(item => item.method === 'session/cancel').length, 1)
  control('held', { action: 'submit', clientId: 'held', delivery: 'queue', content: [{ type: 'text', text: 'Already admitted' }] })
  await waitFor(() => sent.some(item => item.params?.clientId === 'held'))
  const held = sent.find(item => item.params?.clientId === 'held')
  control('preparing', { action: 'submit', clientId: 'preparing', delivery: 'queue', content: [{ type: 'text', text: 'Must not arrive after cancellation' }] })
  handle.writeStdin(JSON.stringify({ type: 'control_request', request_id: 'cancel-preparing', request: { subtype: 'interrupt' } }))
  assert.equal(sent.filter(item => item.method === 'session/cancel').length, 2, 'cancellation bypasses a held admission reply')
  receive({ id: held.id, result: { id: 3, state: { ...state(5, []), paused: true } } })
  await waitFor(() => output.some(item => item.requestId === 'preparing'))
  assert.match(output.find(item => item.requestId === 'preparing').error, /cancelled before delivery/)
  assert.equal(sent.some(item => item.params?.clientId === 'preparing'), false, 'late preparation must not resume a cancelled session')
  control('closing-snapshot', { action: 'snapshot' })
  await waitFor(() => sent.filter(item => item.params?.action === 'snapshot').length === 2)
  events.onClose(1, null)
  assert.match(output.find(item => item.subtype === 'error_interrupted').errors[0], /outcome.*unknown/i)
  await waitFor(() => output.some(item => item.requestId === 'closing-snapshot'))
  assert.equal(output.find(item => item.requestId === 'closing-snapshot').isOutcomeUnknown, true, 'stream close does not prove that the engine rejected a request')
  await handle.destroy(true)
  const records = (await readFile(transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(records.filter(item => item.type === 'user' && item.uuid === 'draft-1').length, 1)
  const user = records.find(item => item.type === 'user' && item.uuid === 'draft-1')
  assert.equal(user.displayText, 'original draft', 'history preserves human text separately from expanded agent content')
  assert.match(user.message.content, /REFERENCE_INPUT: continue the original task/, 'resume retains the exact agent input')
  assert.equal(parseSessionTranscriptMessages(await readFile(transcriptPath, 'utf8')).find(item => item.uuid === 'draft-1')?.displayText,
    'original draft', 'the existing context API returns the same human display text after reload')
  assert.equal(records.filter(item => item.subtype === 'error_interrupted').length, 1, 'native turns retain the interrupted outcome even without a prompt RPC')
  assert.equal(sent.some(item => item.method === 'session/prompt'), false, 'native delivery must not fall back to a second turn scheduler')
})

void test('native receipts recover the original transcript after restart without resubmitting input', async t => {
  for (const stopReason of ['end_turn', 'cancelled', 'error', 'write_failure'] as const) await t.test(stopReason, async child => {
    const cwd = await mkdtemp(join(tmpdir(), 'moss-native-receipt-'))
    const transcriptPath = join(cwd, 'transcript.jsonl')
    const handles: ReturnType<typeof createAcpBridgeHandle>[] = []
    child.after(async () => { for (const handle of handles) await handle.destroy(); await rm(cwd, { recursive: true, force: true }) })
    const start = async (nativeSession: string) => {
      const sent: any[] = [], output: any[] = []
      let events!: import('./acpTransport.js').AcpTransportEvents
      const transport: import('./acpTransport.js').AcpMessageTransport = {
        connected: true, start(value) { events = value }, async send(message) { sent.push(message) }, async close() {},
      }
      const handle = createAcpBridgeHandle({ transport, cwd, sessionId: 'receipt-host', model: 'fixture', transcriptPath,
        enabledSkillNames: [], runtime: { type: 'cohost', engine: 'scode' } })
      handles.push(handle)
      handle.onStdoutLine(line => output.push(JSON.parse(line)))
      const waitFor = async (predicate: () => boolean) => {
        const deadline = Date.now() + 5000
        while (!predicate()) { assert.ok(Date.now() < deadline, 'native receipt deadline'); await delay(5) }
      }
      const receive = (value: any) => events.onMessage({ jsonrpc: '2.0', ...value })
      const update = (value: any) => receive({ method: '_sudocode/session/input_update', params: { sessionId: nativeSession, update: value } })
      const control = (requestId: string, request: any) => handle.writeStdin(JSON.stringify({ type: 'control_request', request_id: requestId, request }))
      const receipt = async (clientId: string) => {
        const id = 'receipt-' + output.length
        control(id, { subtype: 'input_receipt', clientId })
        await waitFor(() => output.some(item => item.type === 'input_delivery_receipt' && item.requestId === id))
        return output.find(item => item.type === 'input_delivery_receipt' && item.requestId === id).receipt
      }
      await waitFor(() => sent.some(item => item.method === 'initialize'))
      receive({ id: 'm-init', result: { _meta: { sudocode: { inputDelivery: { version: 1 } } } } })
      receive({ id: 'm-session-new', result: { sessionId: nativeSession } })
      await waitFor(() => output.some(item => item.type === 'hello'))
      assert.equal(output.find(item => item.type === 'hello').nativeInputReceipts?.version, 1, 'callers require the advertised receipt protocol before sending its controls')
      return { sent, output, handle, waitFor, receive, update, control, receipt }
    }
    const original = await start('native-original')
    if (stopReason === 'write_failure') await mkdir(transcriptPath)
    original.control('submit', { subtype: 'input', action: { action: 'submit', clientId: 'stable-input', delivery: 'queue',
      display: 'Human review comment', content: [{ type: 'text', text: 'Full anchored review input' }] } })
    await original.waitFor(() => original.sent.some(item => item.params?.action === 'submit'))
    const submission = original.sent.find(item => item.params?.action === 'submit')
    const state = { revision: 1, activeTurnId: 7, running: true, paused: false,
      pending: [{ clientId: 'stable-input', id: 7, source: 'human', delivery: 'queue' }] }
    original.update({ kind: 'state', state })
    original.receive({ id: submission.id, result: { id: 7, state } })
    assert.deepEqual(await original.receipt('stable-input'), { state: 'pending' }, 'admission is pending, never a completed turn')
    original.update({ kind: 'committed', clientId: 'stable-input', source: 'human' })
    original.update({ kind: 'state', state: { ...state, revision: 2, pending: [] } })
    assert.deepEqual(await original.receipt('stable-input'), { state: stopReason === 'write_failure' ? 'unknown' : 'pending' }, 'model consumption alone does not prove completion')
    original.receive({ method: 'session/update', params: { sessionId: 'native-original', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Original answer, preserved exactly.' } } } })
    if (stopReason === 'error') original.update({ kind: 'error', message: 'Provider failed after partial output' })
    else original.update({ kind: 'turn_complete', turnId: 7, stopReason: stopReason === 'write_failure' ? 'end_turn' : stopReason })
    original.update({ kind: 'state', state: { ...state, revision: 3, activeTurnId: null, pending: [], running: false } })
    await original.waitFor(() => original.output.some(item => item.type === 'input_delivery_persisted'))
    assert.equal(original.output.find(item => item.type === 'input_delivery_persisted').error, stopReason === 'write_failure' ? 'TRANSCRIPT_WRITE_FAILED' : undefined)
    const expected = { state: 'complete', text: 'Original answer, preserved exactly.',
      ...(stopReason === 'cancelled' ? { error: 'TURN_CANCELLED' } : stopReason === 'error' ? { error: 'TURN_FAILED' } : {}) }
    const recovered = stopReason === 'write_failure' ? { state: 'unknown' } : expected
    assert.deepEqual(await original.receipt('stable-input'), recovered)
    await original.handle.destroy(true)
    const replacement = await start('native-replacement')
    assert.deepEqual(await replacement.receipt('stable-input'), recovered, 'recovery survives a different native execution')
    assert.deepEqual(await replacement.receipt('never-admitted'), { state: 'unknown' })
    if (stopReason !== 'write_failure') {
      await appendFile(transcriptPath, [
        { type: 'user', uuid: 'legacy-no-receipt', message: { role: 'user', content: 'Legacy input' } },
        { type: 'assistant', uuid: 'legacy-answer', message: { role: 'assistant', content: [{ type: 'text', text: 'Unrelated adjacent answer' }] } },
      ].map(row => JSON.stringify(row) + '\n').join(''))
      assert.deepEqual(await replacement.receipt('legacy-no-receipt'), { state: 'unknown' }, 'adjacent messages cannot prove native completion')
    }
    assert.equal(replacement.sent.some(item => item.params?.action === 'submit' || item.method === 'session/prompt'), false)
  })
})
