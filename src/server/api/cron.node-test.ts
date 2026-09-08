import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DirectConnectStore } from '../db.js'
import { createCronApi } from './cron.js'

function createApi(policy: Readonly<Record<string, boolean>>) {
  const store = new DirectConnectStore(':memory:')
  const cronService = {
    addJob() {},
    updateJob() {},
    removeJob() {},
    async triggerJob(jobId: string, actor: { userId: string; orgId: string }) {
      return {
        id: 'run-1',
        jobId,
        orgId: actor.orgId,
        userId: actor.userId,
        sessionId: null,
        status: 'running',
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
        summary: null,
        createdAt: Date.now(),
      }
    },
  }
  return {
    store,
    api: createCronApi(store.db, {
      cronService: cronService as never,
      isOrgUser: () => true,
      isClientCronEnabled: orgId => policy[orgId] ?? true,
    }),
  }
}

const input = {
  name: 'daily report',
  schedule: { kind: 'every' as const, value: '1h' },
  payloadMessage: 'report',
  conversationMode: 'new' as const,
}

describe('Cron API Organization 策略', () => {
  it('普通用户只受所在 Organization 的 Cron 策略影响', async () => {
    const { api } = createApi({ 'org-a': false, 'org-b': true })

    const blocked = await api.createJob({ orgId: 'org-a', userId: 'user-a', role: 'user' }, input)
    const allowed = await api.createJob({ orgId: 'org-b', userId: 'user-b', role: 'user' }, input)

    assert.deepEqual(blocked, { success: false, message: 'cron_disabled_by_org' })
    assert.equal(allowed.success, true)
  })

  it('管理员仍可在禁用本地 Cron 的 Organization 创建企业任务', async () => {
    const { api } = createApi({ 'org-a': false })

    const result = await api.createJob({ orgId: 'org-a', userId: 'admin-a', role: 'admin' }, input)

    assert.equal(result.success, true)
  })

  it('相同用户标识也不能跨 Organization 读取任务', async () => {
    const { api } = createApi({})
    const created = await api.createJob({ orgId: 'org-a', userId: 'shared-user', role: 'user' }, input)
    assert.equal(created.success, true)

    const jobId = (created as { data?: { id?: string } }).data?.id
    assert.ok(jobId)
    const result = await api.getJob({ orgId: 'org-b', userId: 'shared-user' }, jobId)

    assert.deepEqual(result, { success: false, message: 'Access denied' })
  })

  it('跨 Organization 的更新、删除、手动执行与历史查询全部拒绝', async () => {
    const { api } = createApi({})
    const created = await api.createJob({ orgId: 'org-a', userId: 'owner-a', role: 'user' }, input)
    const jobId = (created as { data?: { id?: string } }).data?.id
    assert.ok(jobId)
    const foreign = { orgId: 'org-b', userId: 'owner-a', scopes: ['*'] }

    assert.deepEqual(await api.updateJob(foreign, jobId, { name: 'hijacked' }), {
      success: false,
      message: 'Access denied',
    })
    assert.deepEqual(await api.triggerJob(foreign, jobId), {
      success: false,
      message: 'Access denied',
    })
    assert.deepEqual(await api.listRuns(foreign, jobId), {
      success: false,
      message: 'Access denied',
    })
    assert.deepEqual(await api.deleteJob(foreign, jobId), {
      success: false,
      message: 'Access denied',
    })
    assert.equal((await api.getJob({ orgId: 'org-a', userId: 'owner-a' }, jobId)).success, true)
  })

  it('同 Organization 的 co-owner 与管理员保留管理权限', async () => {
    const { api } = createApi({})
    const created = await api.createJob(
      { orgId: 'org-a', userId: 'owner-a', role: 'user' },
      { ...input, coOwnerIds: ['co-owner-a'] },
    )
    const jobId = (created as { data?: { id?: string } }).data?.id
    assert.ok(jobId)

    const updated = await api.updateJob(
      { orgId: 'org-a', userId: 'co-owner-a' },
      jobId,
      { name: 'updated by co-owner' },
    )
    assert.equal(updated.success, true)

    const triggered = await api.triggerJob(
      { orgId: 'org-a', userId: 'admin-a', scopes: ['admin:cron'] },
      jobId,
    )
    assert.equal(triggered.success, true)
    assert.equal((triggered as { data?: { userId?: string } }).data?.userId, 'admin-a')

    const deleted = await api.deleteJob(
      { orgId: 'org-a', userId: 'admin-a', scopes: ['admin:cron'] },
      jobId,
    )
    assert.equal(deleted.success, true)
  })
})
