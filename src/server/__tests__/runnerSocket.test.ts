/**
 * runnerSocket 单元测试：
 *  - 'connect' → resolve socket
 *  - 'error'   → reject 原错误
 *  - 连接挂起（无 connect/error 事件）→ 超时 destroy 并 reject
 *
 * 第 3 项是 E2E host WebSocket 会话挂起回归的守护测试：连接若不设上限，
 * promise 永久 pending，桥接 WebSocket 的消息处理器永不注册，客户端消息
 * 被静默丢弃直至超时（GitHub Actions run 33772949363 的根因）。
 *
 * 隔离方式：mock 'net' 的 createConnection 返回可控 fake socket
 * （runnerSocket 仅依赖 net，mock 无其他副作用）。
 */
import { describe, expect, it, mock } from 'bun:test'
import { EventEmitter } from 'events'
import * as realNet from 'net'

type FakeSocket = EventEmitter & { destroyed: boolean; destroy: () => void }

let fakeSocket: FakeSocket | null = null

mock.module('net', () => {
  const patched = {
    ...realNet,
    createConnection: () => {
      if (!fakeSocket) throw new Error('test bug: fake socket not set')
      return fakeSocket
    },
  }
  return { ...patched, default: patched }
})

const { connectToAttachSocket } = await import('../runnerSocket.js')

function makeFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket
  socket.destroyed = false
  socket.destroy = () => {
    socket.destroyed = true
  }
  return socket
}

describe('connectToAttachSocket', () => {
  it("resolves the socket on 'connect'", async () => {
    fakeSocket = makeFakeSocket()
    const promise = connectToAttachSocket('/tmp/attach', 5_000)
    fakeSocket.emit('connect')
    await expect(promise).resolves.toBe(fakeSocket)
    fakeSocket = null
  })

  it("rejects with the original error on 'error'", async () => {
    fakeSocket = makeFakeSocket()
    const failure = new Error('connect ECONNREFUSED')
    const promise = connectToAttachSocket('/tmp/attach', 5_000)
    fakeSocket.emit('error', failure)
    await expect(promise).rejects.toBe(failure)
    fakeSocket = null
  })

  it('destroys the socket and rejects when the connect stalls past the timeout', async () => {
    fakeSocket = makeFakeSocket()
    const startedAt = Date.now()
    const promise = connectToAttachSocket('/tmp/stalled-attach', 120)
    await expect(promise).rejects.toThrow('Timed out after 120ms')
    expect(fakeSocket.destroyed).toBe(true)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
    fakeSocket = null
  })
})
