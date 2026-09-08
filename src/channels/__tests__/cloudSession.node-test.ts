import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { afterEach, describe, it } from 'node:test'

import { DirectConnectStore } from '../../server/db.js'
import { SessionManager } from '../core/SessionManager.js'
import { MossActionExecutor } from '../gateway/MossActionExecutor.js'

const databases: DirectConnectStore[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('Channel 到 Moss 云端 Session', () => {
  it('使用连接 owner 的统一 User、Organization 和可见 Agent 创建会话', async () => {
    const database = new DirectConnectStore(':memory:')
    databases.push(database)
    database.upsertChannelPlugin({
      id: 'telegram_default',
      type: 'telegram',
      name: 'enterprise telegram',
      enabled: 1,
      status: 'running',
      user_id: 'owner-a',
      org_id: 'org-a',
    })
    const createdSessions: Array<Record<string, unknown>> = []
    const socket = new EventEmitter() as EventEmitter & {
      destroyed: boolean
      write(data: string): boolean
      destroy(): void
    }
    socket.destroyed = false
    socket.write = () => true
    socket.destroy = () => { socket.destroyed = true }
    const runtime = {
      getSessionSnapshot() { return null },
      async createSession(input: Record<string, unknown>) {
        createdSessions.push(input)
        return { sessionId: 'runtime-session-1' }
      },
      async ensureSessionReady() { return { attempt: { id: 'attempt-1' } } },
      async connectToAttempt() { return socket },
    }
    const pluginManager = {
      getInstanceKey() { return 'telegram_default:owner-a' },
    }
    const agentResolver = {
      async resolveActiveAgent() {
        return { name: 'sales-agent', displayName: '销售助手' }
      },
    }
    const executor = new MossActionExecutor(
      pluginManager as never,
      new SessionManager(database),
      { isUserAuthorized: () => true } as never,
      runtime as never,
      database,
      agentResolver as never,
    )

    await (executor as unknown as {
      createRuntimeSession(
        key: string,
        user: { id: string; platformUserId: string; platformType: 'telegram'; authorizedAt: number },
        platform: string,
        pluginId: string,
        chatId: string,
        ownerUserId: string,
      ): Promise<unknown>
    }).createRuntimeSession(
      'telegram:platform-user:chat-1',
      {
        id: 'channel-user-a',
        platformUserId: 'platform-user',
        platformType: 'telegram',
        authorizedAt: Date.now(),
      },
      'telegram',
      'telegram_default',
      'chat-1',
      'owner-a',
    )

    assert.equal(createdSessions.length, 1)
    assert.equal(createdSessions[0]?.userId, 'owner-a')
    assert.equal(createdSessions[0]?.orgId, 'org-a')
    assert.equal(createdSessions[0]?.assistantName, 'sales-agent')
    assert.equal(createdSessions[0]?.assistantDisplayName, '销售助手')
  })
})
