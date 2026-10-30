import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HttpBrowserWorker, browserController, invokeSessionBrowser } from './browserGateway.js'

void test('opening a panel does not retain revoked profile authorization', async () => {
  const principal = { orgId: 'org', userId: 'owner' }
  let active = true
  const calls: unknown[] = []
  const deps = {
    getSession: async (sessionId: string) => ({ sessionId, ...principal, cwd: '/private-workspace', runtime: { type: 'cohost' } }),
    isUserActive: async () => active,
    worker: { invoke: async (...args: unknown[]) => { calls.push(args); return { ok: true } } },
  }
  await invokeSessionBrowser(deps, principal, 'conversation', { kind: 'state' })
  active = false
  await assert.rejects(invokeSessionBrowser(deps, principal, 'conversation', { kind: 'frame', viewerId: '00000000-0000-4000-8000-000000000000', controlEpoch: 1, targetEpoch: 0 }), /session_forbidden/)
  await assert.rejects(invokeSessionBrowser(deps, { ...principal, userId: 'manager' }, 'conversation', { kind: 'take', controlEpoch: 1, targetEpoch: 0 }), /session_forbidden/)
  assert.equal(calls.length, 1)
})

void test('human requests cannot impersonate AI or switch browser ownership', async () => {
  const principal = { orgId: 'org', userId: 'owner' }
  const calls: unknown[] = []
  const deps = {
    getSession: async (sessionId: string) => ({ sessionId, ...principal, cwd: '/private-workspace', runtime: { type: 'cohost' } }),
    isUserActive: async () => true,
    worker: { invoke: async (...args: unknown[]) => { calls.push(args); return { ok: true } } },
  }
  await invokeSessionBrowser(deps, principal, 'conversation', {
    kind: 'input', controlEpoch: 4, targetEpoch: 2, input: { kind: 'text', text: 'Manual login' },
    actor: 'ai', controller: 'ai', profile: 'someone-else', endpoint: 'http://attacker', binding: { userId: 'other' },
  })
  assert.deepEqual(calls, [[{ sessionId: 'conversation', ...principal }, browserController(principal), {
    kind: 'input', controlEpoch: 4, targetEpoch: 2, input: { kind: 'text', text: 'Manual login' },
  }]])
  await assert.rejects(invokeSessionBrowser(deps, principal, 'conversation', { kind: 'input', controlEpoch: true, targetEpoch: 2 }), /invalid_browser_epoch/)
})

void test('a timed out input is sent once and carries only the trusted host credential', async () => {
  let calls = 0
  const worker = new HttpBrowserWorker('http://127.0.0.1:8000/', 'fixture-host-token', async (url, options) => {
    calls++
    assert.equal(String(url), 'http://127.0.0.1:8000/invoke')
    assert.equal(options?.redirect, 'error')
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer fixture-host-token')
    throw new Error('Input may have reached Chrome')
  })
  await assert.rejects(worker.invoke({ orgId: 'org', userId: 'owner', sessionId: 'conversation' }, 'trusted-controller', { kind: 'input' }), /browser_connection_unavailable/)
  assert.equal(calls, 1)
})
