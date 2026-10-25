import assert from 'node:assert/strict'
import test from 'node:test'
import { browserAllowedOwners, browserOwnerAllowed, browserOwnerImages } from './browserDeploymentPolicy.js'
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

void test('owner image pins require an immutable default and reject ambiguous or malformed configuration', () => {
  const names = ['MOSS_BROWSER_IMAGE', 'MOSS_BROWSER_SECRET', 'MOSS_BROWSER_OWNER_IMAGES'] as const
  const saved = names.map(name => process.env[name])
  const image = `sha256:${'a'.repeat(64)}`
  const owner = { orgId: 'org-a', userId: 'user-a', image }
  try {
    process.env.MOSS_BROWSER_IMAGE = `sha256:${'b'.repeat(64)}`
    process.env.MOSS_BROWSER_SECRET = 'test-secret-for-image-policy-'.repeat(2)
    for (const source of [
      'not-json', '{}', '[null]', JSON.stringify([{ ...owner, image: 'browser:latest' }]),
      JSON.stringify([{ ...owner, userId: ' ' }]), JSON.stringify([{ ...owner, orgId: 'a'.repeat(256) }]),
      JSON.stringify([{ ...owner, unexpected: 'private-configuration-value' }]), JSON.stringify([owner, owner]),
      JSON.stringify(Array.from({ length: 201 }, (_, index) => ({ ...owner, userId: String(index) }))),
      ' '.repeat(65_537),
    ]) {
      process.env.MOSS_BROWSER_OWNER_IMAGES = source
      assert.throws(() => new BrowserWorkerRegistry(async () => null), { message: 'Invalid MOSS_BROWSER_OWNER_IMAGES' })
    }
    process.env.MOSS_BROWSER_OWNER_IMAGES = JSON.stringify([owner])
    delete process.env.MOSS_BROWSER_IMAGE
    assert.throws(() => new BrowserWorkerRegistry(async () => null), { message: 'Invalid MOSS_BROWSER_OWNER_IMAGES' })
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name]
      else process.env[name] = saved[index]
    })
  }
})

void test('pins retain exact organization/user identity and remain separate from access grants', () => {
  const names = ['MOSS_BROWSER_IMAGE', 'MOSS_BROWSER_OWNER_IMAGES', 'MOSS_BROWSER_ALLOWED_OWNERS'] as const
  const saved = names.map(name => process.env[name])
  const image = `registry.example/browser@sha256:${'c'.repeat(64)}`
  const owners = [{ orgId: 'org:one', userId: 'user', image }, { orgId: 'org', userId: 'one:user', image }]
  try {
    process.env.MOSS_BROWSER_IMAGE = image
    delete process.env.MOSS_BROWSER_OWNER_IMAGES
    assert.deepEqual(browserOwnerImages(), [])
    process.env.MOSS_BROWSER_OWNER_IMAGES = JSON.stringify(owners)
    assert.deepEqual(browserOwnerImages(), owners)
    process.env.MOSS_BROWSER_ALLOWED_OWNERS = '[]'
    for (const owner of owners) assert.equal(browserOwnerAllowed(owner), false)
    process.env.MOSS_BROWSER_OWNER_IMAGES = '[]'
    assert.deepEqual(browserOwnerImages(), [])
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name]
      else process.env[name] = saved[index]
    })
  }
})
