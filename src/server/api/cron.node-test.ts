import assert from 'node:assert/strict'
import { after, beforeEach, describe, mock, test, type TestContext } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { CronActor, CronService, CronServiceConfig } from '../services/cron/CronService.js'
import type { CronJob, CronJobRun } from '../services/cron/CronStore.js'

const settingsHome = mkdtempSync(join(os.tmpdir(), 'moss-cron-settings-'))
const homeMock = mock.method(os, 'homedir', () => settingsHome)
const { DirectConnectStore } = await import('../db.js')
const { createCronApi } = await import('./cron.js')
const { CronService: RealCronService } = await import('../services/cron/CronService.js')
const { CronStore } = await import('../services/cron/CronStore.js')
const { updateSystemSettings, SYSTEM_SETTINGS_PATH } = await import('../systemSettings.js')
assert.equal(SYSTEM_SETTINGS_PATH, join(settingsHome, '.moss', 'settings.json'))
beforeEach(async () => { await updateSystemSettings({ clientCronEnabled: true }) })
after(() => {
  homeMock.mock.restore()
  rmSync(settingsHome, { recursive: true, force: true })
})

async function setupService(t: TestContext, overrides: Partial<CronServiceConfig> = {}) {
  const store = new DirectConnectStore(':memory:')
  const sessionAuth: Array<{ userId: string; orgId: string; role: string; scopes: string[] }> = []
  const service = new RealCronService(store.driver, {
    runtimeDir: settingsHome,
    defaultRuntime: 'host',
    dockerContainerMode: 'session',
    async getUserAuth() { return { role: 'user', scopes: [] } },
    async getClientCronEnabled() { return true },
    runtimeService: {
      async createSession(auth: { userId: string; orgId: string; role: string; scopes: string[] }) {
        sessionAuth.push(auth)
        return { sessionId: `session-${sessionAuth.length}` }
      },
    } as unknown as CronServiceConfig['runtimeService'],
    ...overrides,
  })
  const internals = service as unknown as {
    executeJob(jobId: string): Promise<void>
    sendCronMessage(sessionId: string, message: string): Promise<void>
    completeRunInSession(job: CronJob, run: CronJobRun, sessionId: string, summary: string): Promise<void>
  }
  t.mock.method(internals, 'sendCronMessage', async () => {})
  let completion = Promise.resolve()
  const complete = internals.completeRunInSession.bind(service)
  t.mock.method(internals, 'completeRunInSession', (...args: Parameters<typeof complete>) => {
    completion = complete(...args)
    return completion
  })
  t.after(async () => {
    await completion
    await store.close()
  })
  const job = await service.getStore().insert({
    orgId: 'org-a', userId: 'owner', name: 'Report',
    schedule: { kind: 'every', value: '1h' },
    payloadMessage: 'run', conversationMode: 'new',
  })
  return { store, service, job, sessionAuth, executeScheduled: () => internals.executeJob(job.id) }
}

const scopedActor: CronActor = {
  userId: 'caller', orgId: 'org-a', role: 'user', scopes: ['admin:cron'],
}

void describe('Cron manual caller capability', () => {
  void test('API preserves trusted admin:cron scopes for the service gate and session while checking live auth', async t => {
    const authCalls: Array<[string, string]> = []
    const { store, service, job, sessionAuth } = await setupService(t, {
      async getClientCronEnabled() { return false },
      async getUserAuth(userId, orgId) {
        authCalls.push([userId, orgId])
        return { role: 'user', scopes: [] }
      },
    })
    const api = createCronApi(store.driver, { cronService: service, getClientCronEnabled: async () => false })
    assert.equal((await api.triggerJob(scopedActor, job.id)).success, true)
    assert.deepEqual(authCalls, [['caller', 'org-a']])
    assert.equal(sessionAuth.length, 1)
    const { userId, orgId, role, scopes } = sessionAuth[0]
    assert.deepEqual({ userId, orgId, role, scopes }, scopedActor)
    assert.notEqual(scopes, scopedActor.scopes)
  })

  void test('does not regain wider live user scopes than the authenticated request has', async t => {
    const { service, job, sessionAuth } = await setupService(t, {
      async getClientCronEnabled() { return false },
      async getUserAuth() { return { role: 'user', scopes: ['admin:cron'] } },
    })
    await assert.rejects(service.triggerJob(job.id, { ...scopedActor, scopes: [] }), /cron_disabled_by_org/)
    assert.equal(sessionAuth.length, 0)
    assert.deepEqual(await service.getStore().listRunsByJob(job.id), [])
  })

  for (const liveAuth of [null, { role: 'admin', scopes: ['admin:cron'], status: 'disabled' }]) {
    void test(`rejects a stale privileged actor when live auth is ${liveAuth ? 'disabled' : 'missing'}`, async t => {
      const { service, job, sessionAuth } = await setupService(t, {
        async getUserAuth() { return liveAuth },
        async getClientCronEnabled() { return false },
      })
      await assert.rejects(service.triggerJob(job.id, scopedActor), /User auth not found/)
      assert.equal(sessionAuth.length, 0)
      assert.deepEqual(await service.getStore().listRunsByJob(job.id), [])
    })
  }

  void test('rejects actor org mismatch even with admin:cron before resolving credentials', async t => {
    let authCalls = 0
    const { service, job } = await setupService(t, {
      async getUserAuth() { authCalls += 1; return { role: 'admin', scopes: ['*'] } },
    })
    await assert.rejects(service.triggerJob(job.id, { ...scopedActor, orgId: 'org-b' }), /organization mismatch/)
    assert.equal(authCalls, 0)
    assert.deepEqual(await service.getStore().listRunsByJob(job.id), [])
  })

  void test('uses current executor auth when there is no manual actor', async t => {
    const authCalls: string[] = []
    const { service, job, sessionAuth } = await setupService(t, {
      async getClientCronEnabled() { return false },
      async getUserAuth(userId) {
        authCalls.push(userId)
        return { role: 'user', scopes: ['admin:cron'] }
      },
    })
    await service.getStore().update(job.id, { coOwnerIds: ['executor'], executorUserId: 'executor' })
    const run = await service.triggerJob(job.id)
    assert.equal(run.userId, 'executor')
    assert.deepEqual(authCalls, ['executor'])
    assert.equal(sessionAuth[0].userId, 'executor')
    assert.deepEqual(sessionAuth[0].scopes, ['admin:cron'])
  })

  void test('service independently rejects an asynchronous policy denial after API admission', async t => {
    const { store, service, job, sessionAuth } = await setupService(t, {
      async getClientCronEnabled() { await Promise.resolve(); return false },
    })
    const api = createCronApi(store.driver, { cronService: service, getClientCronEnabled: async () => true })
    const result = await api.triggerJob({ ...scopedActor, userId: 'owner', scopes: [] }, job.id)
    assert.deepEqual(result, { success: false, message: 'cron_disabled_by_org' })
    assert.equal(sessionAuth.length, 0)
    assert.deepEqual(await service.getStore().listRunsByJob(job.id), [])
  })

  void test('resolver failures fail closed before creating runs', async t => {
    const { service, job, sessionAuth } = await setupService(t, {
      async getClientCronEnabled() { throw new Error('policy unavailable') },
    })
    await assert.rejects(service.triggerJob(job.id, scopedActor), /policy unavailable/)
    assert.equal(sessionAuth.length, 0)
    assert.deepEqual(await service.getStore().listRunsByJob(job.id), [])
  })

  void test('global kill switch combines with org policy at both gates while admin:cron still bypasses', async t => {
    const { store, service, job } = await setupService(t)
    await updateSystemSettings({ clientCronEnabled: false })
    const api = createCronApi(store.driver, { cronService: service, getClientCronEnabled: async () => true })
    const user = { ...scopedActor, userId: 'owner', scopes: [] }
    assert.deepEqual(await api.triggerJob(user, job.id), { success: false, message: 'cron_disabled_by_org' })
    await assert.rejects(service.triggerJob(job.id, user), /cron_disabled_by_org/)
    assert.equal((await api.triggerJob(scopedActor, job.id)).success, true)
  })
})

void describe('Cron scheduled policy and active users', () => {
  void test('awaits org policy and records a skipped run for a non-admin owner', async t => {
    const { service, job, sessionAuth, executeScheduled } = await setupService(t, {
      async getClientCronEnabled() { await Promise.resolve(); return false },
    })
    await executeScheduled()
    assert.equal((await service.getStore().listRunsByJob(job.id))[0].status, 'skipped')
    assert.equal(sessionAuth.length, 0)
  })

  void test('active owner admin:cron bypass uses the scheduled executor credentials', async t => {
    const { service, job, sessionAuth, executeScheduled } = await setupService(t, {
      async getClientCronEnabled() { return false },
      async getUserAuth(userId) {
        return { role: 'user', scopes: userId === 'owner' ? ['admin:cron'] : ['sessions:create'] }
      },
    })
    await service.getStore().update(job.id, { coOwnerIds: ['executor'], executorUserId: 'executor' })
    await executeScheduled()
    assert.equal((await service.getStore().listRunsByJob(job.id))[0].status, 'ok')
    assert.equal(sessionAuth[0].userId, 'executor')
    assert.deepEqual(sessionAuth[0].scopes, ['sessions:create'])
  })

  for (const liveAuth of [null, { role: 'admin', scopes: ['*'], status: 'disabled' }]) {
    void test(`never executes a ${liveAuth ? 'disabled' : 'missing'} executor even when client cron is enabled`, async t => {
      const { service, job, sessionAuth, executeScheduled } = await setupService(t, {
        async getUserAuth() { return liveAuth },
      })
      await executeScheduled()
      const [run] = await service.getStore().listRunsByJob(job.id)
      assert.equal(run.status, 'error')
      assert.match(run.error ?? '', /User auth not found/)
      assert.equal(sessionAuth.length, 0)
    })
  }

  void test('a disabled privileged owner cannot bypass disabled org policy through another executor', async t => {
    const { service, job, sessionAuth, executeScheduled } = await setupService(t, {
      async getClientCronEnabled() { return false },
      async getUserAuth(userId) {
        return userId === 'owner'
          ? { role: 'admin', scopes: ['*'], status: 'disabled' }
          : { role: 'user', scopes: [], status: 'active' }
      },
    })
    await service.getStore().update(job.id, { coOwnerIds: ['executor'], executorUserId: 'executor' })
    await executeScheduled()
    assert.equal((await service.getStore().listRunsByJob(job.id))[0].status, 'skipped')
    assert.equal(sessionAuth.length, 0)
  })
})

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
      service.triggerJob(job.id, { userId: 'user-a', orgId: 'org-a', role: 'user', scopes: [] }),
      /cron_disabled_by_org/,
    )

    await store.close()
  })
})
