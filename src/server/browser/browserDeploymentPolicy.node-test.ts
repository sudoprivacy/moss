import assert from 'node:assert/strict'
import test from 'node:test'
import { browserAllowedOwners, browserOwnerAllowed } from './browserDeploymentPolicy.js'
import { BrowserWorkerRegistry } from './browserWorkerRegistry.js'

void test('restricted rollout requires both organization and user; revocation blocks every entry', async () => {
  const saved = process.env.MOSS_BROWSER_ALLOWED_OWNERS
  const binding = { orgId: 'org-a', userId: 'user-a', sessionId: 'session-a' }
  try {
    delete process.env.MOSS_BROWSER_ALLOWED_OWNERS
    assert.equal(browserOwnerAllowed(binding), true)
    process.env.MOSS_BROWSER_ALLOWED_OWNERS = JSON.stringify([binding].map(({ orgId, userId }) => ({ orgId, userId })))
    assert.equal(browserOwnerAllowed(binding), true)
    assert.equal(browserOwnerAllowed({ ...binding, orgId: 'org-b' }), false)
    assert.equal(browserOwnerAllowed({ ...binding, userId: 'user-b' }), false)
    const registry = new BrowserWorkerRegistry(async () => null)
    assert.ok(await registry.mcp(binding, { id: 1, method: 'tools/list' }))
    process.env.MOSS_BROWSER_ALLOWED_OWNERS = '[]'
    await assert.rejects(registry.invoke(binding, 'user-test', { kind: 'state' }), /browser_not_enabled_for_owner/)
    for (const method of ['initialize', 'tools/list', 'tools/call']) {
      await assert.rejects(registry.mcp(binding, { id: 2, method }), /browser_not_enabled_for_owner/)
    }
  } finally {
    if (saved === undefined) delete process.env.MOSS_BROWSER_ALLOWED_OWNERS
    else process.env.MOSS_BROWSER_ALLOWED_OWNERS = saved
  }
})

void test('malformed rollout settings refuse startup without exposing their contents', () => {
  const saved = process.env.MOSS_BROWSER_ALLOWED_OWNERS
  try {
    for (const value of ['broken-json', '{}', '[null]', '[{"orgId":"org"}]', '[{"orgId":"org","userId":"user","unexpected":true}]']) {
      process.env.MOSS_BROWSER_ALLOWED_OWNERS = value
      assert.throws(() => new BrowserWorkerRegistry(async () => null), { message: 'Invalid MOSS_BROWSER_ALLOWED_OWNERS' })
    }
    process.env.MOSS_BROWSER_ALLOWED_OWNERS = '[]'
    assert.deepEqual(browserAllowedOwners(), [])
  } finally {
    if (saved === undefined) delete process.env.MOSS_BROWSER_ALLOWED_OWNERS
    else process.env.MOSS_BROWSER_ALLOWED_OWNERS = saved
  }
})
