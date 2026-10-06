import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeAssistantOverrideAgentsMd } from './sharedAgentMemory.js'
import { createCatalogTestRepository } from './testing/compatibilityRepositories.js'
import { SqliteDriver } from './db/driver.js'
import {
  withOrganizationResources,
  type OrganizationResourceScope,
} from './catalog/organizationResources.js'
import { getAssistantRuntimeConfig } from './backends/backendUtils.js'
import {
  defaultAgentName,
  isDefaultAgentName,
  isUserCreatedAgentName,
  isUserOwnedAgentName,
  sessionAgentName,
  userCreatedAgentName,
} from './agentIdentity.js'
import {
  InvalidAgentNameError,
  createUserAgent,
  getUserAgent,
  listUserAgents,
  resetUserAgentStoreForTests,
} from './userAgentStore.js'

void test('a user agent is named from the id, not from anything renameable', () => {
  const uid = '0ffa2afc-41a6-4a94-b1b6-ef6eb6e7ed1e'
  // Two values, two jobs. The stored reference carries a marker so a catalog
  // assistant cannot be mistaken for it; the agent's name has to survive being
  // a path segment, so the marker is not part of it.
  assert.equal(defaultAgentName(uid), `moss-agent:user:${uid}`)
  assert.equal(sessionAgentName(uid, defaultAgentName(uid)), `user-${uid}`)
  assert.match(sessionAgentName(uid, undefined), /^[A-Za-z0-9._-]+$/)
  // Derived from the user id, so renaming the person cannot orphan the agent.
  assert.equal(defaultAgentName(uid), defaultAgentName(uid))
})

void test('a user agent is told apart from a catalog assistant', () => {
  assert.equal(isDefaultAgentName(defaultAgentName('u1')), true)
  // Catalog assistants are uuids or slugs; neither is prefixed.
  assert.equal(isDefaultAgentName('recruitment_expert'), false)
  assert.equal(isDefaultAgentName('合规审计师'), false)
  assert.equal(isDefaultAgentName(undefined), false)
  assert.equal(isDefaultAgentName(null), false)
  assert.equal(isDefaultAgentName(''), false)
})

void test('a session on the user agent gets memory; one on nobody never did', async () => {
  const db = new DatabaseSync(':memory:')
  createCatalogTestRepository(db)
  const scope: OrganizationResourceScope = {
    orgId: 'org-1',
    userId: 'user-1',
    driver: new SqliteDriver(db),
  }
  try {
    await withOrganizationResources(scope, async () => {
      // This is the whole point of giving unattributed sessions an owner: the
      // shared-memory block in RuntimeService is gated on `memory_mode === 'user'`,
      // so until now that cohort — the majority — had no memory of its last
      // conversation at all.
      const mine = await getAssistantRuntimeConfig(defaultAgentName('user-1'))
      assert.equal(mine.memoryMode, 'user')

      // Unchanged for the case that still has no agent at all, so nothing
      // silently acquires memory it did not have.
      const nobody = await getAssistantRuntimeConfig(undefined)
      assert.equal(nobody.memoryMode, 'session')

      // A user agent has no catalog entry; asking for one must not 404 the
      // session, and its skills are not narrowed by anybody.
      assert.deepEqual(mine.enabledSkills, nobody.enabledSkills)
    })
  } finally {
    db.close()
  }
})

void test('a user agent gets its memory but does not claim a role', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'moss-user-agent-'))
  try {
    await writeAssistantOverrideAgentsMd({
      workspace,
      assistantName: defaultAgentName('user-1'),
      sharedMemory: "The current logged-in user's name is 宋一民.",
    })
    const written = await readFile(join(workspace, 'AGENTS.md'), 'utf8')
    // The memory has to reach the agent — this file is how.
    assert.match(written, /Shared User Memory/)
    assert.match(written, /宋一民/)
    // But a name derived from a user id is not a persona: naming it here would
    // make the agent answer "I am user-user-1".
    assert.doesNotMatch(written, /Application role/)
    assert.doesNotMatch(written, /as your assistant name/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

void test('a catalog assistant is named even with no display name', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'moss-catalog-agent-'))
  try {
    // The distinction is the agent's kind, not whether a display name happens
    // to be supplied — keying on the display name silently dropped the role
    // section for every assistant that has none.
    await writeAssistantOverrideAgentsMd({ workspace, assistantName: 'quote' })
    const written = await readFile(join(workspace, 'AGENTS.md'), 'utf8')
    assert.match(written, /use quote as your assistant name/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

void test('nothing to say writes nothing at all', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'moss-empty-agent-'))
  try {
    await writeAssistantOverrideAgentsMd({ workspace, assistantName: defaultAgentName('user-2') })
    // No role, no memory, no rules. A header-only file would announce itself as
    // an override and override nothing, in a directory that may be the user's.
    await assert.rejects(() => readFile(join(workspace, 'AGENTS.md'), 'utf8'))
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

void test('two users who pick the same template are not the same agent', () => {
  const alice = '0ffa2afc-41a6-4a94-b1b6-ef6eb6e7ed1e'
  const bob = '7c3e1a02-9b11-4d55-8f20-aa1b2c3d4e5f'
  const template = '0427fe1b-9fbb-4afa-a857-28f8313a4db9'
  // `/agents/{name}` is zone-wide and a zone is a tenant, so naming the runtime
  // after the template put every user in an organization into one agent home.
  assert.notEqual(sessionAgentName(alice, template), sessionAgentName(bob, template))
  // Stable: the same pair always names the same agent, or its home moves and
  // its conversations are orphaned.
  assert.equal(sessionAgentName(alice, template), sessionAgentName(alice, template))
})

void test('a session with no template is the user own agent, not a pair', () => {
  const uid = 'u1'
  const own = `user-${uid}`
  assert.equal(sessionAgentName(uid, undefined), own)
  assert.equal(sessionAgentName(uid, null), own)
  // Already resolved to the default agent upstream — do not pair it with itself.
  assert.equal(sessionAgentName(uid, defaultAgentName(uid)), own)
})

void test('every real assistant_name in production survives being a path segment', () => {
  // Taken from `SELECT DISTINCT assistant_name FROM sessions` on the deployment.
  // Each of these has been going into `/agents/{name}` verbatim.
  const seen = [
    'AI 学习辅导',
    '企业知识中枢Agent',
    '政策',
    'Remote Agent',
    'scode-standard',
    'o9cq80x9bRuaQBmup91yI7geEAMM@im.wechat',
    '0427fe1b-9fbb-4afa-a857-28f8313a4db9',
  ]
  const names = seen.map(ref => sessionAgentName('u1', ref))
  for (const name of names) {
    assert.match(name, /^[A-Za-z0-9._-]+$/, `${name} is not safe as a path segment`)
    assert.ok(!name.includes('/'))
  }
  // Distinct inputs stay distinct, including the two that slugify to nothing
  // readable and are carried entirely by the digest.
  assert.equal(new Set(names).size, seen.length)
})

void test('a user can have a second agent of their own, distinct from any template', () => {
  const uid = 'u1'
  const mine = userCreatedAgentName('5f1c2a9e-0b44-4c77-9a3e-11d2e3f4a5b6')
  assert.equal(isUserCreatedAgentName(mine), true)
  // Both kinds are the user's own: neither is in the organization catalog, so
  // every caller that would look one up there has to skip both.
  assert.equal(isUserOwnedAgentName(mine), true)
  assert.equal(isUserOwnedAgentName(defaultAgentName(uid)), true)
  assert.equal(isUserOwnedAgentName('recruitment_expert'), false)
  // It is a different principal from the user's implicit default — that is the
  // whole point: a second context with its own memory.
  assert.notEqual(sessionAgentName(uid, mine), sessionAgentName(uid, undefined))
})

void test('an agent id that leaks cannot be used to address another user agent', () => {
  const mine = userCreatedAgentName('5f1c2a9e-0b44-4c77-9a3e-11d2e3f4a5b6')
  assert.notEqual(sessionAgentName('alice', mine), sessionAgentName('bob', mine))
})

void test('agents a user made are theirs alone, and are named not numbered', async () => {
  resetUserAgentStoreForTests()
  const a = await createUserAgent({ orgId: 'o1', userId: 'alice', displayName: ' 项目 A ' })
  const b = await createUserAgent({ orgId: 'o1', userId: 'alice', displayName: '项目 B' })
  assert.equal(a.displayName, '项目 A', 'the name is trimmed, not stored as typed')
  assert.notEqual(a.id, b.id)

  // Ownership is part of the lookup, not a check afterwards: an agent id is the
  // key to someone's memory and conversations.
  assert.deepEqual((await listUserAgents('o1', 'bob')), [])
  assert.equal(await getUserAgent('o1', 'bob', a.id), null)
  assert.equal((await getUserAgent('o1', 'alice', a.id))?.displayName, '项目 A')

  // Same user id under another organization is another person.
  assert.deepEqual(await listUserAgents('o2', 'alice'), [])

  // Oldest first, so the list does not reshuffle under the user.
  assert.deepEqual((await listUserAgents('o1', 'alice')).map(x => x.displayName), ['项目 A', '项目 B'])
})

void test('an agent has to be called something', async () => {
  resetUserAgentStoreForTests()
  await assert.rejects(
    () => createUserAgent({ orgId: 'o1', userId: 'alice', displayName: '   ' }),
    InvalidAgentNameError,
  )
  await assert.rejects(
    () => createUserAgent({ orgId: 'o1', userId: 'alice', displayName: 'x'.repeat(61) }),
    InvalidAgentNameError,
  )
})

void test('an assistant whose name looks like a marker is still an assistant', () => {
  // An assistant's name is whatever somebody typed. A short prefix is a name,
  // not a reservation: claiming `agent-` made `agent-one` — which a test
  // installs, and nothing stops a customer from creating — read as one of the
  // user's own agents, so the catalog lookup was skipped and a request that
  // should answer 404 for another organization's assistant proceeded instead.
  for (const name of ['agent-one', 'user-guide', 'agent-smith', 'users', 'moss-agentry']) {
    assert.equal(isUserOwnedAgentName(name), false, `${name} must stay a catalog reference`)
    assert.equal(isDefaultAgentName(name), false, name)
    assert.equal(isUserCreatedAgentName(name), false, name)
  }
})

void test('the stored marker never reaches the path', () => {
  const ref = userCreatedAgentName('5f1c2a9e-0b44-4c77-9a3e-11d2e3f4a5b6')
  const name = sessionAgentName('u1', ref)
  // The marker is in-band for storage; `/agents/{name}` has to stay a legal
  // path segment, and `:` is not one of its characters.
  assert.match(name, /^[A-Za-z0-9._-]+$/)
  assert.ok(name.includes('5f1c2a9e-0b44-4c77-9a3e-11d2e3f4a5b6'))
})
