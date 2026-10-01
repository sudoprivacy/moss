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
import { defaultAgentName, isDefaultAgentName } from './agentIdentity.js'

void test('a user agent is named from the id, not from anything renameable', () => {
  const name = defaultAgentName('0ffa2afc-41a6-4a94-b1b6-ef6eb6e7ed1e')
  // `/agents/{name}` is a real path segment, so the name may not carry a
  // separator and may not change when the user renames themselves.
  assert.equal(name, 'user-0ffa2afc-41a6-4a94-b1b6-ef6eb6e7ed1e')
  assert.ok(!name.includes('/'))
  assert.equal(name, defaultAgentName('0ffa2afc-41a6-4a94-b1b6-ef6eb6e7ed1e'))
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
