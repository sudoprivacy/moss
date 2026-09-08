import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { afterEach, describe, it } from 'node:test'

import { DirectConnectStore } from '../../db.js'
import { CronService } from './CronService.js'

class SuccessfulRunnerSocket extends EventEmitter {
  write(_data: string, callback?: (error?: Error | null) => void): boolean {
    callback?.(null)
    queueMicrotask(() => {
      this.emit('data', Buffer.from([
        JSON.stringify({ type: 'stdin_ack' }),
        JSON.stringify({ type: 'stdout', line: JSON.stringify({ type: 'result', status: 'success' }) }),
        '',
      ].join('\n')))
    })
    return true
  }

  end(): this {
    return this
  }

  destroy(): this {
    return this
  }
}

class ControlledRunnerSocket extends EventEmitter {
  destroyed = false

  write(_data: string, callback?: (error?: Error | null) => void): boolean {
    callback?.(null)
    return true
  }

  succeed(): void {
    this.emit('data', Buffer.from(`${JSON.stringify({
      type: 'stdout',
      line: JSON.stringify({ type: 'result', status: 'success' }),
    })}\n`))
  }

  end(): this { return this }
  destroy(): this { this.destroyed = true; return this }
}

const stores: DirectConnectStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('CronService 企业云端会话执行', () => {
  it('手动触发使用触发者身份，并将任务 Organization 固定到 Moss 云端会话', async () => {
    const store = new DirectConnectStore(':memory:')
    stores.push(store)
    const createdSessions: Array<Record<string, unknown>> = []
    const runtimeService = {
      async createSession(input: Record<string, unknown>) {
        createdSessions.push(input)
        return { sessionId: 'cron-session-1' }
      },
      async ensureSessionReady() {
        return { attempt: { id: 'attempt-1' } }
      },
      async connectToAttempt() {
        return new SuccessfulRunnerSocket()
      },
      getSession() {
        return null
      },
      async terminateSession() {},
    }
    const service = new CronService(store.db, {
      runtimeService: runtimeService as never,
      runtimeDir: '/tmp/moss-runtime',
      defaultRuntime: 'host',
      dockerContainerMode: 'session',
      getUserAuth: async (userId, orgId) => {
        assert.equal(userId, 'operator-b')
        assert.equal(orgId, 'org-a')
        return { role: 'dept_admin', scopes: ['cron:trigger'] }
      },
    })
    const job = service.getStore().insert({
      orgId: 'org-a',
      userId: 'owner-a',
      name: 'enterprise report',
      schedule: { kind: 'every', value: '1h' },
      payloadMessage: 'generate report',
      conversationMode: 'new',
    })

    const run = await service.triggerJob(job.id, { userId: 'operator-b', orgId: 'org-a' })

    assert.equal(run.userId, 'operator-b')
    assert.deepEqual(createdSessions, [{
      cwd: `/tmp/moss-runtime/cron/${job.id}/workspace`,
      dangerouslySkipPermissions: false,
      userId: 'operator-b',
      orgId: 'org-a',
      role: 'dept_admin',
      scopes: ['cron:trigger'],
      assistantName: undefined,
      source: JSON.stringify({
        source: 'cron',
        cronJobId: job.id,
        cronJobName: 'enterprise report',
        cronRunId: run.id,
        agentMode: 'remote',
      }),
    }])

    await new Promise(resolve => setImmediate(resolve))
    assert.equal(service.getStore().getRunById(run.id)?.status, 'ok')
  })

  it('Organization 禁用本地用户 Cron 后，既有普通用户任务在实际调度时跳过', async () => {
    const store = new DirectConnectStore(':memory:')
    stores.push(store)
    let createSessionCalls = 0
    const runtimeService = {
      async createSession() {
        createSessionCalls += 1
        return { sessionId: 'must-not-be-created' }
      },
      getSession() {
        return null
      },
      async terminateSession() {},
    }
    const service = new CronService(store.db, {
      runtimeService: runtimeService as never,
      runtimeDir: '/tmp/moss-runtime',
      defaultRuntime: 'host',
      dockerContainerMode: 'session',
      getUserAuth: async () => ({ role: 'user', scopes: [] }),
      isClientCronEnabled: orgId => orgId !== 'org-disabled',
    })
    const job = service.getStore().insert({
      orgId: 'org-disabled',
      userId: 'owner-a',
      name: 'paused local task',
      schedule: { kind: 'every', value: '1h' },
      payloadMessage: 'must not run',
      conversationMode: 'new',
    })

    await (service as unknown as { executeJob(jobId: string): Promise<void> }).executeJob(job.id)

    const [run] = service.getStore().listRunsByJob(job.id)
    assert.equal(run.status, 'skipped')
    assert.equal(createSessionCalls, 0)
    assert.equal(service.getStore().getById(job.id)?.lastStatus, 'skipped')
  })

  it('停止会等待手工触发后仍在执行的云端会话', async () => {
    const store = new DirectConnectStore(':memory:')
    stores.push(store)
    const socket = new ControlledRunnerSocket()
    const service = new CronService(store.db, {
      runtimeService: {
        async createSession() { return { sessionId: 'cron-session-pending' } },
        getSession() { return null },
        async ensureSessionReady() { return { attempt: { id: 'attempt-1' } } },
        async connectToAttempt() { return socket },
        async terminateSession() {},
      } as never,
      runtimeDir: '/tmp/moss-runtime',
      defaultRuntime: 'host',
      dockerContainerMode: 'session',
      getUserAuth: async () => ({ role: 'user', scopes: [] }),
    })
    const job = service.getStore().insert({
      orgId: 'org-a',
      userId: 'owner-a',
      name: 'pending manual run',
      schedule: { kind: 'every', value: '1h' },
      payloadMessage: 'run',
      conversationMode: 'new',
    })
    await service.start()
    const run = await service.triggerJob(job.id, { userId: 'owner-a', orgId: 'org-a' })

    let stopped = false
    const stopPromise = Promise.resolve(service.stop()).then(() => { stopped = true })
    await new Promise(resolve => setImmediate(resolve))
    const stoppedBeforeRunCompleted = stopped

    socket.succeed()
    await stopPromise
    assert.equal(stoppedBeforeRunCompleted, false)
    assert.equal(service.getStore().getRunById(run.id)?.status, 'ok')
  })

  it('执行用户已失效时记录错误且不创建云端会话', async () => {
    const store = new DirectConnectStore(':memory:')
    stores.push(store)
    let createCalls = 0
    const service = new CronService(store.db, {
      runtimeService: {
        async createSession() { createCalls += 1; return { sessionId: 'unexpected' } },
        getSession() { return null },
        async terminateSession() {},
      } as never,
      runtimeDir: '/tmp/moss-runtime',
      defaultRuntime: 'host',
      dockerContainerMode: 'session',
      getUserAuth: async () => null,
    })
    const job = service.getStore().insert({
      orgId: 'org-a',
      userId: 'deleted-user',
      name: 'invalid owner',
      schedule: { kind: 'every', value: '1h' },
      payloadMessage: 'run',
      conversationMode: 'new',
    })

    await assert.rejects(service.triggerJob(job.id), /User auth not found/)

    assert.equal(createCalls, 0)
    assert.equal(service.getStore().listRunsByJob(job.id)[0]?.status, 'error')
  })

  it('已有 queued 或 running 记录时拒绝创建重叠运行', async () => {
    const store = new DirectConnectStore(':memory:')
    stores.push(store)
    const service = new CronService(store.db, {
      runtimeService: {
        async createSession() { return { sessionId: 'unexpected' } },
        getSession() { return null },
        async terminateSession() {},
      } as never,
      runtimeDir: '/tmp/moss-runtime',
      defaultRuntime: 'host',
      dockerContainerMode: 'session',
      getUserAuth: async () => ({ role: 'user', scopes: [] }),
    })
    const job = service.getStore().insert({
      orgId: 'org-a',
      userId: 'user-a',
      name: 'single flight',
      schedule: { kind: 'every', value: '1h' },
      payloadMessage: 'run',
      conversationMode: 'new',
    })
    service.getStore().createRun(job.id, job.orgId, job.userId)

    await assert.rejects(service.triggerJob(job.id), /already in progress/)
    assert.equal(service.getStore().listRunsByJob(job.id).length, 1)
  })

  it('进程重启时将超时遗留运行标错并允许后续运行', async () => {
    const store = new DirectConnectStore(':memory:')
    stores.push(store)
    const service = new CronService(store.db, {
      runtimeService: {
        async createSession() { return { sessionId: 'unused' } },
        getSession() { return null },
        async terminateSession() {},
      } as never,
      runtimeDir: '/tmp/moss-runtime',
      defaultRuntime: 'host',
      dockerContainerMode: 'session',
      getUserAuth: async () => ({ role: 'user', scopes: [] }),
    })
    const job = service.getStore().insert({
      orgId: 'org-a',
      userId: 'user-a',
      name: 'restart recovery',
      schedule: { kind: 'every', value: '1h' },
      payloadMessage: 'run',
      conversationMode: 'new',
    })
    const stale = service.getStore().createRun(job.id, job.orgId, job.userId)
    service.getStore().startRun(stale.id)
    store.db.prepare(`UPDATE cron_job_runs SET created_at = 1, started_at = 1 WHERE id = ?`).run(stale.id)

    await service.start()

    assert.equal(service.getStore().getRunById(stale.id)?.status, 'error')
    assert.equal(service.getStore().hasActiveRun(job.id), false)
    await service.stop()
  })

  it('复用模式使用绑定的活动会话且不创建或回收该会话', async () => {
    const store = new DirectConnectStore(':memory:')
    stores.push(store)
    let createCalls = 0
    const terminated: string[] = []
    const service = new CronService(store.db, {
      runtimeService: {
        async createSession() { createCalls += 1; return { sessionId: 'unexpected' } },
        getSession(sessionId: string) {
          return sessionId === 'bound-session' ? { sessionId, status: 'active' } : null
        },
        async ensureSessionReady() { return { attempt: { id: 'attempt-1' } } },
        async connectToAttempt() { return new SuccessfulRunnerSocket() },
        async terminateSession(sessionId: string) { terminated.push(sessionId) },
      } as never,
      runtimeDir: '/tmp/moss-runtime',
      defaultRuntime: 'host',
      dockerContainerMode: 'session',
      getUserAuth: async () => ({ role: 'user', scopes: [] }),
    })
    const job = service.getStore().insert({
      orgId: 'org-a',
      userId: 'user-a',
      name: 'reuse bound session',
      schedule: { kind: 'every', value: '1h' },
      payloadMessage: 'continue',
      conversationMode: 'reuse',
      boundSessionId: 'bound-session',
    })

    const run = await service.triggerJob(job.id)
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(service.getStore().getRunById(run.id)?.sessionId, 'bound-session')
    assert.equal(service.getStore().getRunById(run.id)?.status, 'ok')
    assert.equal(createCalls, 0)
    assert.deepEqual(terminated, [])
  })
})
