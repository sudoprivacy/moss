import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { createChannelsApi } from '../../server/api/channels.js'
import { DirectConnectStore } from '../../server/db.js'
import { SessionManager } from '../core/SessionManager.js'

const databases: DirectConnectStore[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function createDatabase(): DirectConnectStore {
  const database = new DirectConnectStore(':memory:')
  databases.push(database)
  return database
}

function insertPlugin(database: DirectConnectStore, id: string, orgId: string | null, enabled = 0): void {
  database.upsertChannelPlugin({
    id,
    type: 'telegram',
    name: id,
    enabled,
    status: 'stopped',
    credentials_json: null,
    config_json: null,
    user_id: 'shared-user',
    org_id: orgId,
  })
}

describe('Channel Organization 隔离', () => {
  it('新数据库初始化不会在表创建前执行组织回填', () => {
    const errors: unknown[][] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { errors.push(args) }
    try {
      createDatabase()
    } finally {
      console.error = originalError
    }

    assert.equal(
      errors.some(args => String(args[0]).includes('department_secret_policies.org_id')),
      false,
    )
  })

  it('插件列表与详情必须同时匹配认证 Organization 和 owner', async () => {
    const database = createDatabase()
    insertPlugin(database, 'telegram_org_a', 'org-a')
    insertPlugin(database, 'telegram_org_b', 'org-b')
    const api = createChannelsApi(database)

    const listed = await api.getPlugins('org-a', 'shared-user')

    assert.ok(listed.plugins.some(plugin => plugin.id === 'telegram_org_a'))
    assert.ok(!listed.plugins.some(plugin => plugin.id === 'telegram_org_b'))
    assert.equal(await api.getPlugin('org-a', 'shared-user', 'telegram_org_b'), null)
  })

  it('授权用户列表和删除必须拒绝同 owner 下的跨 Organization 数据', async () => {
    const database = createDatabase()
    database.upsertChannelUser({
      id: 'channel-user-a',
      platform_user_id: 'platform-a',
      platform_type: 'telegram',
      plugin_scope: 'telegram_org_a',
      authorized_at: Date.now(),
      org_id: 'org-a',
      user_id: 'shared-user',
    })
    database.upsertChannelUser({
      id: 'channel-user-b',
      platform_user_id: 'platform-b',
      platform_type: 'telegram',
      plugin_scope: 'telegram_org_b',
      authorized_at: Date.now(),
      org_id: 'org-b',
      user_id: 'shared-user',
    })
    const api = createChannelsApi(database)

    const listed = await api.getUsers('org-a', 'shared-user')
    const deleted = await api.deleteUser('org-a', 'shared-user', 'channel-user-b')
    const missing = await api.deleteUser('org-a', 'shared-user', 'missing-channel-user')

    assert.deepEqual(listed.users.map(user => user.id), ['channel-user-a'])
    assert.deepEqual(deleted, missing)
    assert.ok(database.getChannelUserById('channel-user-b'))
  })

  it('旧数据仅从统一 User 回填 orgId，无法映射的连接保持无归属并被禁用', () => {
    const database = createDatabase()
    database.db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, org_id TEXT);
      CREATE TABLE IF NOT EXISTS department_secret_policies (org_id TEXT);
      INSERT INTO users (id, org_id) VALUES ('mapped-user', 'org-a');
    `)
    database.upsertChannelPlugin({
      id: 'telegram_mapped',
      type: 'telegram',
      name: 'mapped',
      enabled: 1,
      status: 'running',
      user_id: 'mapped-user',
      org_id: null,
    })
    database.upsertChannelPlugin({
      id: 'telegram_orphan',
      type: 'telegram',
      name: 'orphan',
      enabled: 1,
      status: 'running',
      user_id: 'missing-user',
      org_id: null,
    })

    database.backfillOrgScoping('default-org')

    const mapped = database.getChannelPlugin('telegram_mapped', 'mapped-user')
    const orphan = database.getChannelPlugin('telegram_orphan', 'missing-user')
    assert.equal(mapped?.org_id, 'org-a')
    assert.equal(orphan?.org_id, null)
    assert.equal(orphan?.enabled, 0)
    assert.equal(orphan?.status, 'error')
  })

  it('跨 Organization 不能移除连接或按连接批量删除授权用户', async () => {
    const database = createDatabase()
    insertPlugin(database, 'telegram_foreign', 'org-b')
    database.upsertChannelUser({
      id: 'channel-user-a',
      platform_user_id: 'platform-a',
      platform_type: 'telegram',
      plugin_scope: 'telegram_foreign',
      authorized_at: Date.now(),
      org_id: 'org-a',
      user_id: 'shared-user',
    })
    database.upsertChannelUser({
      id: 'channel-user-b',
      platform_user_id: 'platform-b',
      platform_type: 'telegram',
      plugin_scope: 'telegram_foreign',
      authorized_at: Date.now(),
      org_id: 'org-b',
      user_id: 'shared-user',
    })
    const api = createChannelsApi(database)

    const removed = await api.removePlugin('org-a', 'shared-user', 'telegram_foreign')
    const missing = await api.removePlugin('org-a', 'shared-user', 'telegram_missing')
    const cleared = await api.deleteUsersByPlatform('org-a', 'shared-user', 'telegram_foreign')

    assert.deepEqual(removed, missing)
    assert.ok(database.getChannelPlugin('telegram_foreign', 'shared-user'))
    assert.deepEqual(cleared, { ok: true, count: 1 })
    assert.equal(database.getChannelUserById('channel-user-a'), null)
    assert.ok(database.getChannelUserById('channel-user-b'))
  })

  it('配对列表和审批不能读取同一 owner 在其他 Organization 的请求', async () => {
    const database = createDatabase()
    const expiresAt = Date.now() + 60_000
    database.upsertPairingRequest({
      code: 'PAIR-A',
      platform_user_id: 'platform-a',
      platform_type: 'telegram',
      requested_at: Date.now(),
      expires_at: expiresAt,
      status: 'pending',
      user_id: 'shared-user',
      org_id: 'org-a',
    })
    database.upsertPairingRequest({
      code: 'PAIR-B',
      platform_user_id: 'platform-b',
      platform_type: 'telegram',
      requested_at: Date.now(),
      expires_at: expiresAt,
      status: 'pending',
      user_id: 'shared-user',
      org_id: 'org-b',
    })
    const api = createChannelsApi(database)

    const listed = await api.getPendingPairings('org-a', 'shared-user')
    const approved = await api.approvePairing('org-a', 'shared-user', 'PAIR-B')
    const missingApproval = await api.approvePairing('org-a', 'shared-user', 'PAIR-MISSING')
    const rejected = await api.rejectPairing('org-a', 'shared-user', 'PAIR-B')
    const missingRejection = await api.rejectPairing('org-a', 'shared-user', 'PAIR-MISSING')

    assert.deepEqual(listed.pairings.map(pairing => pairing.code), ['PAIR-A'])
    assert.deepEqual(approved, missingApproval)
    assert.deepEqual(rejected, missingRejection)
    assert.equal(database.getPairingRequest('PAIR-B')?.status, 'pending')
  })

  it('旧配对只从统一 User 回填 orgId，无法映射的待审批请求会失效', () => {
    const database = createDatabase()
    database.db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, org_id TEXT);
      INSERT INTO users (id, org_id) VALUES ('mapped-user', 'org-a');
    `)
    const expiresAt = Date.now() + 60_000
    database.upsertPairingRequest({
      code: 'PAIR-MAPPED',
      platform_user_id: 'platform-a',
      platform_type: 'telegram',
      requested_at: Date.now(),
      expires_at: expiresAt,
      status: 'pending',
      user_id: 'mapped-user',
    })
    database.upsertPairingRequest({
      code: 'PAIR-ORPHAN',
      platform_user_id: 'platform-b',
      platform_type: 'telegram',
      requested_at: Date.now(),
      expires_at: expiresAt,
      status: 'pending',
      user_id: 'missing-user',
    })

    database.backfillOrgScoping('default-org')

    assert.equal(database.getPairingRequest('PAIR-MAPPED')?.org_id, 'org-a')
    assert.equal(database.getPairingRequest('PAIR-MAPPED')?.status, 'pending')
    assert.equal(database.getPairingRequest('PAIR-ORPHAN')?.org_id, null)
    assert.equal(database.getPairingRequest('PAIR-ORPHAN')?.status, 'expired')
  })

  it('删除 Channel 云端会话只终止并删除当前 Organization 的运行时 Session', async () => {
    const database = createDatabase()
    for (const [sessionId, orgId] of [['session-a', 'org-a'], ['session-b', 'org-b']] as const) {
      database.createSession({
        sessionId,
        transcriptSessionId: `transcript-${sessionId}`,
        transcriptPath: `/tmp/${sessionId}.jsonl`,
        userId: 'shared-user',
        orgId,
        role: 'user',
        scopes: [],
        cwd: '/tmp',
        runtime: { type: 'host', hostMode: 'direct' },
        status: 'active',
        desiredState: 'active',
        source: 'telegram',
        channelChatId: `${orgId}-chat`,
      })
    }
    const terminated: string[] = []
    const api = createChannelsApi(database, {
      async terminateSession(sessionId: string) { terminated.push(sessionId) },
    })

    const foreign = await api.deleteSession('org-a', 'shared-user', 'session-b')
    const own = await api.deleteSession('org-a', 'shared-user', 'session-a')

    assert.deepEqual(foreign, { success: true })
    assert.deepEqual(own, { success: true })
    assert.deepEqual(terminated, ['session-a'])
    assert.ok(database.getSession('session-b'))
    assert.equal(database.getSession('session-a'), null)
  })

  it('同步 Channel 设置时只清理当前 Organization owner 的映射会话', () => {
    const database = createDatabase()
    database.upsertChannelUser({
      id: 'channel-user-a',
      platform_user_id: 'platform-a',
      platform_type: 'telegram',
      authorized_at: Date.now(),
      org_id: 'org-a',
      user_id: 'shared-user',
    })
    database.upsertChannelUser({
      id: 'channel-user-b',
      platform_user_id: 'platform-b',
      platform_type: 'telegram',
      authorized_at: Date.now(),
      org_id: 'org-b',
      user_id: 'shared-user',
    })
    const sessions = new SessionManager(database)
    sessions.createSessionWithConversation({
      id: 'channel-user-a',
      platformUserId: 'platform-a',
      platformType: 'telegram',
      authorizedAt: Date.now(),
    }, 'conversation-a')
    sessions.createSessionWithConversation({
      id: 'channel-user-b',
      platformUserId: 'platform-b',
      platformType: 'telegram',
      authorizedAt: Date.now(),
    }, 'conversation-b')

    const cleared = sessions.clearSessionsForOwner('org-a', 'shared-user')

    assert.equal(cleared, 1)
    assert.equal(sessions.getSession('channel-user-a'), null)
    assert.ok(sessions.getSession('channel-user-b'))
  })
})
