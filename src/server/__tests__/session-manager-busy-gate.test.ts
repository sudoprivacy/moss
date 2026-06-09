import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'

import {
  SessionManager,
  type BackendHandle,
  type SessionBackend,
} from '../sessionManager.js'

/**
 * SessionManager is used by ChannelManager (chat-driven channel sessions),
 * NOT by the direct-connect WS path. But it shared the "destroy on socket
 * close after idleTimeoutMs" pattern, which can kill a busy session if the
 * client detaches mid-turn. This test verifies the busy gate added in
 * sessionManager.ts:#armIdleTimeout.
 */

class FakeBackend implements SessionBackend {
  spawnCount = 0
  lastHandle: FakeHandle | null = null

  async spawn(): Promise<BackendHandle> {
    this.spawnCount += 1
    const handle = new FakeHandle()
    this.lastHandle = handle
    return handle
  }
}

class FakeHandle implements BackendHandle {
  workDir = '/tmp'
  runtime = { type: 'host' as const, engine: 'scode' as const }
  #busy = false
  destroyed = false
  destroyForce = false
  #busyListeners = new Set<(b: boolean) => void>()

  setBusy(value: boolean): void {
    if (value === this.#busy) return
    this.#busy = value
    for (const l of this.#busyListeners) l(value)
  }

  isBusy(): boolean { return this.#busy }

  onBusyChange(listener: (b: boolean) => void): () => void {
    this.#busyListeners.add(listener)
    return () => { this.#busyListeners.delete(listener) }
  }

  writeStdin(): void {}
  onStdoutLine(): () => void { return () => {} }
  onStderrLine(): () => void { return () => {} }
  onExit(): () => void { return () => {} }

  destroy(force = false): void {
    this.destroyed = true
    this.destroyForce = force
  }
}

class FakeSocket extends EventEmitter {
  readyState = 1
  OPEN = 1
  send(): void {}
  close(): void {}
}

async function waitMs(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms))
}

describe('SessionManager.armIdleTimeout busy gate', () => {
  it('does NOT destroy a busy session when sockets drop to 0', async () => {
    const backend = new FakeBackend()
    const manager = new SessionManager(backend, { idleTimeoutMs: 30 })
    const { sessionId } = await manager.createSession({ orgId: 'o', userId: 'u' })

    const socket = new FakeSocket() as unknown as WebSocket
    manager.attachSocket(sessionId, socket)

    backend.lastHandle!.setBusy(true)
    socket.emit('close')

    await waitMs(80) // > idleTimeoutMs

    expect(backend.lastHandle!.destroyed).toBe(false)
  })

  it('re-arms idleTimeoutMs once busy clears', async () => {
    const backend = new FakeBackend()
    const manager = new SessionManager(backend, { idleTimeoutMs: 30 })
    const { sessionId } = await manager.createSession({ orgId: 'o', userId: 'u' })
    const socket = new FakeSocket() as unknown as WebSocket
    manager.attachSocket(sessionId, socket)

    backend.lastHandle!.setBusy(true)
    socket.emit('close')

    await waitMs(80)
    expect(backend.lastHandle!.destroyed).toBe(false)

    // Now flip busy false — idle timer should arm fresh.
    backend.lastHandle!.setBusy(false)

    await waitMs(15)
    expect(backend.lastHandle!.destroyed).toBe(false) // not yet — full timeout
    await waitMs(40)
    expect(backend.lastHandle!.destroyed).toBe(true)
  })

  it('destroys an idle (not-busy) session after idleTimeoutMs as before', async () => {
    const backend = new FakeBackend()
    const manager = new SessionManager(backend, { idleTimeoutMs: 30 })
    const { sessionId } = await manager.createSession({ orgId: 'o', userId: 'u' })
    const socket = new FakeSocket() as unknown as WebSocket
    manager.attachSocket(sessionId, socket)

    // Never goes busy.
    socket.emit('close')
    await waitMs(70)
    expect(backend.lastHandle!.destroyed).toBe(true)
  })
})
