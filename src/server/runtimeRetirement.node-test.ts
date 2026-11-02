import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { ResourceAccessError } from './catalog/resourceError.js'
import { DirectConnectStore } from './db.js'
import { RuntimeService } from './runtimeService.js'
import type { ServerConfig } from './types.js'

async function fixture(t: TestContext, placement: Record<string, unknown>) {
  const store = new DirectConnectStore(':memory:')
  t.after(() => store.close())
  const runtime = new RuntimeService({ store, serverInstanceId: 'runtime-retirement-test',
    config: { defaultRuntime: 'cohost', heartbeatTimeoutMs: 30_000 } as ServerConfig,
    userPodService: { forAllocation: () => placement } as never, authService: {} as never })
  return { store, runtime }
}

void test('retiring an owner detaches their native sessions before stopping the runtime', async t => {
  const events: string[] = []
  const { store, runtime } = await fixture(t, {
    retire: async (ownerId: string) => { events.push(`retire ${ownerId}`); return true },
  })
  for (const [sessionId, type, desiredState] of [['native', 'cohost', 'active'], ['ended', 'cohost', 'terminated'], ['legacy', 'gvisor', 'active']] as const) {
    await store.createSession({ sessionId, transcriptSessionId: sessionId, transcriptPath: `/transcripts/${sessionId}.jsonl`,
      userId: 'owner', orgId: 'org', role: 'user', scopes: [], cwd: '/workspace',
      runtime: { type, engine: 'scode' } as never, status: 'active', desiredState })
  }
  const terminate = runtime.terminateSession.bind(runtime)
  runtime.terminateSession = async (sessionId, isRuntimeRestart) => {
    events.push(`detach ${sessionId} ${isRuntimeRestart}`)
    return terminate(sessionId, isRuntimeRestart)
  }
  assert.equal(await runtime.retireUserRuntime('owner', 'org'), true)
  assert.deepEqual(events, ['detach native true', 'retire owner'])
  const native = await store.getSession('native')
  assert.deepEqual([native?.status, native?.desiredState], ['detached', 'ended'], 'the durable session remains for a re-enabled owner')
  assert.equal(runtime.isUserRuntimeUpgrading('owner'), false)
})

void test('lock recovery passes the controller start and reports a refused lock as a conflict', async t => {
  const seen: Date[] = []
  const { runtime } = await fixture(t, {
    recoverUpgradeLock: async (_ownerId: string, createdBefore: Date) => {
      seen.push(createdBefore)
      if (seen.length > 1) throw new Error('Runtime upgrade lock is not older than this controller')
      return true
    },
  })
  assert.equal(await runtime.recoverUserRuntimeLock('owner'), true)
  assert.ok(seen[0]! <= new Date(Date.now() - process.uptime() * 1000 + 1000), 'only locks created before this process started qualify')
  await assert.rejects(runtime.recoverUserRuntimeLock('owner'), (error: unknown) =>
    error instanceof ResourceAccessError && error.statusCode === 409 && /not older/.test(error.message))
})
