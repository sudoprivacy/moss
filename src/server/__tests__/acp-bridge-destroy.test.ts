import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChildProcess } from 'child_process'

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
  return { child: ee, killCalls, stdinEnded }
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
})
