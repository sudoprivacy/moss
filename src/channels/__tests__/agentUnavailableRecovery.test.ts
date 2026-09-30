import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { MossActionExecutor } from '../gateway/MossActionExecutor.js'

/**
 * An IM chat whose existing session is bound to an agent that can no longer be
 * used (disabled, or its creator withdrew access) must not dead-end: the chat
 * moves to a fresh session on its current agent, the old session is retired,
 * and the chat is told why. Any other revive failure keeps the old, silent
 * fallback.
 */

class AgentNotUsableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentNotUsableError'
  }
}

function fakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { write: (s: string) => boolean; destroy: () => void; destroyed: boolean }
  socket.write = () => true
  socket.destroy = () => { socket.destroyed = true }
  socket.destroyed = false
  return socket
}

function harness(reviveError: Error) {
  const calls = { terminated: [] as string[], created: [] as Array<Record<string, unknown>> }
  const runtime = {
    getSessionSnapshot: (id: string) => (id === 'old' ? { status: 'ended', desiredState: 'active' } : null),
    ensureSessionReady: async (id: string) => {
      if (id === 'old') throw reviveError
      return { attempt: { id: 'attempt-new' } }
    },
    connectToAttempt: async () => fakeSocket(),
    createSession: async (options: Record<string, unknown>) => {
      calls.created.push(options)
      return { sessionId: 'new' }
    },
    terminateSession: async (id: string) => { calls.terminated.push(id) },
    getSession: () => undefined,
  }
  const db = {
    getChannelPlugin: () => null,
    getUserOrgId: () => 'org-1',
    findChannelSession: () => ({ sessionId: 'old', status: 'ended' }),
    touchSessionActivity: () => {},
  }
  const sessionManager = { getSession: () => ({ id: 'cs-1' }), updateSessionConversation: () => {} }
  const resolver = { resolveActiveAgent: async () => ({ name: 'default-agent', displayName: '默认助手' }) }
  const executor = new MossActionExecutor(
    {} as never, sessionManager as never, {} as never, runtime as never, db as never, resolver as never,
  )
  const create = () =>
    (executor as unknown as {
      createRuntimeSession: (...args: unknown[]) => Promise<{ sessionId: string; notice?: string }>
    }).createRuntimeSession('k', { id: 'u', displayName: 'U' }, 'wecom', 'wecom_default', 'chat-1', 'owner-1')
  return { calls, create }
}

describe('IM recovery when the session agent is no longer usable', () => {
  it('moves to a fresh session on the current agent, retires the old one, and explains', async () => {
    const { calls, create } = harness(new AgentNotUsableError('该智能体已停用'))
    const state = await create()
    expect(state.sessionId).toBe('new')
    expect(calls.created[0]?.assistantName).toBe('default-agent')
    expect(calls.terminated).toEqual(['old'])
    expect(state.notice).toContain('原智能体已不可用（该智能体已停用）')
    expect(state.notice).toContain('默认助手')
  })

  it('keeps the silent fallback for other revive failures', async () => {
    const { calls, create } = harness(new Error('runner crashed'))
    const state = await create()
    expect(state.sessionId).toBe('new')
    expect(calls.terminated).toEqual([])
    expect(state.notice).toBeUndefined()
  })
})
