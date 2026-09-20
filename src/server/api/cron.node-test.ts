import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DirectConnectStore } from '../db.js'
import { createCronApi } from './cron.js'
import type { CronService } from '../services/cron/CronService.js'
import { CronService as RealCronService } from '../services/cron/CronService.js'
import { CronStore } from '../services/cron/CronStore.js'
import type { CronJob } from '../services/cron/CronStore.js'

void describe('Cron API organization policy', () => {
  void test('client cron creation is gated per organization', async () => {
    const store = new DirectConnectStore(':memory:')
    const addedJobs: CronJob[] = []
    const cronService = {
      addJob(job: CronJob) {
        addedJobs.push(job)
      },
    } as unknown as CronService
    const api = createCronApi(store.driver, {
      cronService,
      getClientCronEnabled: orgId => orgId !== 'org-a',
    })
    const input = {
      name: 'Daily report',
      schedule: { kind: 'every' as const, value: '1h' },
      payloadMessage: 'run',
      conversationMode: 'new' as const,
    }

    const orgAUser = await api.createJob({ orgId: 'org-a', userId: 'user-a', role: 'user' }, input)
    const orgBUser = await api.createJob({ orgId: 'org-b', userId: 'user-b', role: 'user' }, input)
    const orgAAdmin = await api.createJob({
      orgId: 'org-a',
      userId: 'admin-a',
      role: 'admin',
      scopes: ['admin:cron'],
    }, input)

    assert.deepEqual(orgAUser, { success: false, message: 'cron_disabled_by_org' })
    assert.equal(orgBUser.success, true)
    assert.equal(orgAAdmin.success, true)
    assert.equal(addedJobs.map(job => job.orgId).sort().join(','), 'org-a,org-b')

    await store.close()
  })

  void test('client cron update and manual trigger are gated after organization cron is disabled', async () => {
    const store = new DirectConnectStore(':memory:')
    let clientCronEnabled = true
    let updateCalls = 0
    let triggerCalls = 0
    const cronService = {
      addJob() {},
      async updateJob() { updateCalls += 1 },
      async triggerJob() {
        triggerCalls += 1
        return {
          id: 'run-1',
          jobId: 'job-1',
          orgId: 'org-a',
          userId: 'user-a',
          status: 'running',
          sessionId: null,
          error: null,
          startedAt: 1,
          completedAt: null,
          createdAt: 1,
        }
      },
    } as unknown as CronService
    const api = createCronApi(store.driver, {
      cronService,
      getClientCronEnabled: () => clientCronEnabled,
    })
    const created = await api.createJob({ orgId: 'org-a', userId: 'user-a', role: 'user' }, {
      name: 'Daily report',
      schedule: { kind: 'every' as const, value: '1h' },
      payloadMessage: 'run',
      conversationMode: 'new' as const,
    })
    assert.equal(created.success, true)
    const jobId = (created as any).data.id as string
    clientCronEnabled = false

    const blockedUpdate = await api.updateJob(
      { orgId: 'org-a', userId: 'user-a', role: 'user' },
      jobId,
      { enabled: false },
    )
    const blockedTrigger = await api.triggerJob(
      { orgId: 'org-a', userId: 'user-a', role: 'user' },
      jobId,
    )
    const adminUpdate = await api.updateJob(
      { orgId: 'org-a', userId: 'admin-a', role: 'admin', scopes: ['admin:cron'] },
      jobId,
      { enabled: false },
    )

    assert.deepEqual(blockedUpdate, { success: false, message: 'cron_disabled_by_org' })
    assert.deepEqual(blockedTrigger, { success: false, message: 'cron_disabled_by_org' })
    assert.equal(adminUpdate.success, true)
    assert.equal(updateCalls, 1)
    assert.equal(triggerCalls, 0)

    await store.close()
  })

  void test('CronService awaits async policy resolver before manual user trigger', async () => {
    const store = new DirectConnectStore(':memory:')
    const cronStore = new CronStore(store.driver)
    const job = await cronStore.insert({
      orgId: 'org-a',
      userId: 'user-a',
      name: 'Daily report',
      schedule: { kind: 'every', value: '1h' },
      payloadMessage: 'run',
      conversationMode: 'new',
    })
    const service = new RealCronService(store.driver, {
      runtimeService: {} as never,
      runtimeDir: '/tmp/moss-cron-test',
      defaultRuntime: 'host',
      dockerContainerMode: 'session',
      async getClientCronEnabled() { return false },
      async getUserAuth() { return { role: 'user', scopes: [] } },
    })

    await assert.rejects(
      service.triggerJob(job.id, { userId: 'user-a', orgId: 'org-a' }),
      /cron_disabled_by_org/,
    )

    await store.close()
  })
})
