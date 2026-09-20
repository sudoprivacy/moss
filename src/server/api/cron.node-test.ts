import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DirectConnectStore } from '../db.js'
import { createCronApi } from './cron.js'
import type { CronService } from '../services/cron/CronService.js'
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
})
