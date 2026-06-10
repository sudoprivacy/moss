import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChildProcess } from 'child_process'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

import { createAcpBridgeHandle } from '../backends/acpBridge.js'
import type { SessionRuntimeInfo } from '../sessionManager.js'

/**
 * Fabricate a ChildProcess-shaped object for AcpBridge to attach listeners to.
 * Tracks whether .kill() was called so the user-mode destroy test can assert
 * the bridge did NOT signal the host docker exec process.
 */
function makeFakeChild(): {
  child: ChildProcess
  killCalls: NodeJS.Signals[]
  stdinEnded: { value: boolean }
  stdin: PassThrough
  stdout: PassThrough
} {
  const ee = new EventEmitter() as unknown as ChildProcess & EventEmitter
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  ;(ee as any).stdin = stdin
  ;(ee as any).stdout = stdout
  ;(ee as any).stderr = stderr
  ;(ee as any).killed = false
  ;(ee as any).exitCode = null
  const killCalls: NodeJS.Signals[] = []
  const stdinEnded = { value: false }
  const originalEnd = stdin.end.bind(stdin)
  stdin.end = ((...args: unknown[]) => {
    stdinEnded.value = true
    return originalEnd(...(args as []))
  }) as typeof stdin.end
  ;(ee as any).kill = (sig: NodeJS.Signals = 'SIGTERM') => {
    killCalls.push(sig)
    ;(ee as any).killed = true
    return true
  }
  return { child: ee, killCalls, stdinEnded, stdin, stdout }
}

const userRuntime: SessionRuntimeInfo = {
  type: 'docker',
  engine: 'scode',
  dockerMode: 'session',
  containerMode: 'user',
  containerName: 'irrelevant',
  userContainerName: 'moss-user-fake',
  configDir: '/tmp/moss-cfg',
}

const sessionRuntime: SessionRuntimeInfo = {
  type: 'docker',
  engine: 'scode',
  dockerMode: 'session',
  containerMode: 'session',
  containerName: 'moss-session-fake',
  configDir: '/tmp/moss-cfg',
}

describe('AcpBridge.destroy (C2 dispatch)', () => {
  it("containerMode='user': closes stdin, does NOT signal child", () => {
    const { child, killCalls, stdinEnded } = makeFakeChild()
    const handle = createAcpBridgeHandle({
      child,
      sessionId: 'sid',
      cwd: '/tmp',
      model: 'proxy/fake',
      runtime: userRuntime,
      containerMode: 'user',
    })
    handle.destroy(true)
    expect(killCalls).toEqual([])
    expect(stdinEnded.value).toBe(true)
  })

  it("containerMode='session': sends SIGKILL when force=true", () => {
    const { child, killCalls } = makeFakeChild()
    const handle = createAcpBridgeHandle({
      child,
      sessionId: 'sid',
      cwd: '/tmp',
      model: 'proxy/fake',
      runtime: sessionRuntime,
      containerMode: 'session',
    })
    handle.destroy(true)
    expect(killCalls).toEqual(['SIGKILL'])
  })

  it("containerMode='session': sends SIGTERM when force=false", () => {
    const { child, killCalls } = makeFakeChild()
    const handle = createAcpBridgeHandle({
      child,
      sessionId: 'sid',
      cwd: '/tmp',
      model: 'proxy/fake',
      runtime: sessionRuntime,
      containerMode: 'session',
    })
    handle.destroy(false)
    expect(killCalls).toEqual(['SIGTERM'])
  })

  it('isBusy/onBusyChange wire up; writeStdin -> busy=true', async () => {
    const { child } = makeFakeChild()
    const handle = createAcpBridgeHandle({
      child,
      sessionId: 'sid',
      cwd: '/tmp',
      model: 'proxy/fake',
      runtime: userRuntime,
      containerMode: 'user',
    })
    let received: boolean[] = []
    handle.onBusyChange!(b => received.push(b))
    expect(handle.isBusy!()).toBe(false)
    handle.writeStdin('{}')
    expect(handle.isBusy!()).toBe(true)
    expect(received).toEqual([true])
  })

  it('persists the scode ACP session id after session/new', async () => {
    const { child, stdin, stdout } = makeFakeChild()
    const cwd = await mkdtemp(path.join(tmpdir(), 'moss-acp-bridge-'))
    const sessionIdPath = path.join(cwd, '.moss', 'scode-session-id')
    const stdinWrites: string[] = []
    stdin.on('data', chunk => { stdinWrites.push(chunk.toString('utf8')) })
    try {
      createAcpBridgeHandle({
        child,
        sessionId: 'sid',
        cwd,
        model: 'proxy/fake',
        runtime: userRuntime,
        containerMode: 'user',
        scodeSessionIdPath: sessionIdPath,
      })

      writeJsonLine(stdout, { jsonrpc: '2.0', id: 'm-init', result: {} })
      await waitUntil(() => stdinWrites.some(line => line.includes('"method":"session/new"')))
      writeJsonLine(stdout, { jsonrpc: '2.0', id: 'm-session-new', result: { sessionId: 'acp-sid' } })
      await waitUntil(async () => {
        try {
          return (await readFile(sessionIdPath, 'utf8')).trim() === 'acp-sid'
        } catch {
          return false
        }
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('loads the persisted scode ACP session id on resume', async () => {
    const { child, stdin, stdout } = makeFakeChild()
    const cwd = await mkdtemp(path.join(tmpdir(), 'moss-acp-bridge-'))
    const stdinWrites: string[] = []
    stdin.on('data', chunk => { stdinWrites.push(chunk.toString('utf8')) })
    try {
      const handle = createAcpBridgeHandle({
        child,
        sessionId: 'sid',
        cwd,
        model: 'proxy/fake',
        runtime: userRuntime,
        containerMode: 'user',
        resumeSessionId: 'acp-existing',
        scodeSessionIdPath: path.join(cwd, '.moss', 'scode-session-id'),
      })

      writeJsonLine(stdout, { jsonrpc: '2.0', id: 'm-init', result: {} })
      await waitUntil(() => stdinWrites.some(line => line.includes('"method":"session/load"')))
      expect(stdinWrites.some(line => line.includes('"sessionId":"acp-existing"'))).toBe(true)
      expect(stdinWrites.some(line => line.includes('"method":"session/new"'))).toBe(false)

      writeJsonLine(stdout, { jsonrpc: '2.0', id: 'm-session-load', result: {} })
      await waitTick()
      handle.writeStdin(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '继续' }] },
        uuid: 'user-1',
      }) + '\n')
      await waitUntil(() => stdinWrites.some(line => line.includes('"method":"session/prompt"')))
      const promptLine = stdinWrites.find(line => line.includes('"method":"session/prompt"'))!
      expect(promptLine).toContain('"sessionId":"acp-existing"')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('maps SendUserMessage to assistant output and suppresses fallback chunks', async () => {
    const { child, stdin, stdout } = makeFakeChild()
    const cwd = await mkdtemp(path.join(tmpdir(), 'moss-acp-bridge-'))
    const lines: string[] = []
    const stdinWrites: string[] = []
    stdin.on('data', chunk => { stdinWrites.push(chunk.toString('utf8')) })
    try {
      const handle = createAcpBridgeHandle({
        child,
        sessionId: 'sid',
        cwd,
        model: 'proxy/fake',
        runtime: userRuntime,
        containerMode: 'user',
      })
      handle.onStdoutLine(line => lines.push(line.trim()))

      await waitTick()
      writeJsonLine(stdout, { jsonrpc: '2.0', id: 'm-init', result: {} })
      writeJsonLine(stdout, { jsonrpc: '2.0', id: 'm-session-new', result: { sessionId: 'acp-sid' } })
      await waitTick()

      handle.writeStdin(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '你好' }] },
        uuid: 'user-1',
      }) + '\n')
      await waitUntil(() => stdinWrites.some(line => line.includes('"method":"session/prompt"')))

      writeJsonLine(stdout, {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionUpdate: 'tool_call',
          update: {
            toolCallId: 'call-1',
            title: 'SendUserMessage',
            rawInput: { message: '正确中文回复', status: 'normal' },
          },
        },
      })
      writeJsonLine(stdout, {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionUpdate: 'agent_message_chunk',
          update: { content: { text: 'wrong fallback text' } },
        },
      })
      writeJsonLine(stdout, {
        jsonrpc: '2.0',
        id: 'm-1',
        result: {
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      })
      await waitTick()

      const events = lines
        .map(line => {
          try { return JSON.parse(line) } catch { return null }
        })
        .filter(Boolean)
      const assistantTexts = events
        .filter(event => event.type === 'assistant')
        .flatMap(event => event.message?.content ?? [])
        .map(block => block.text)
        .filter(Boolean)
      const toolNames = events
        .filter(event => event.type === 'tool_use')
        .map(event => event.name)

      expect(assistantTexts).toContain('正确中文回复')
      expect(assistantTexts).not.toContain('wrong fallback text')
      expect(toolNames).not.toContain('SendUserMessage')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

function writeJsonLine(stdout: PassThrough, value: unknown): void {
  stdout.write(`${JSON.stringify(value)}\n`)
}

async function waitTick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition was not met')
}
