import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requirePersonalAgent } from './personalAgentAccess.js'
import { ResourceAccessError } from './catalog/resourceError.js'
import { createUserAgent, resetUserAgentStoreForTests } from './userAgentStore.js'
import { userCreatedAgentName } from './agentIdentity.js'

void test('personal session references require the exact owner and organization', async () => {
  resetUserAgentStoreForTests()
  try {
    const agent = await createUserAgent({ orgId: 'org-a', userId: 'alice', displayName: 'Project' })
    const ref = userCreatedAgentName(agent.id)
    assert.deepEqual(await requirePersonalAgent('org-a', 'alice', ref), agent)
    assert.equal(await requirePersonalAgent('org-a', 'alice', 'moss-agent:user:alice'), null)
    for (const [org, user, reference] of [
      ['org-a', 'bob', ref],
      ['org-b', 'alice', ref],
      ['org-a', 'alice', 'moss-agent:user:bob'],
      ['org-a', 'alice', 'moss-agent:own:missing'],
    ]) {
      await assert.rejects(requirePersonalAgent(org!, user!, reference!), (error: unknown) => error instanceof ResourceAccessError && error.statusCode === 404)
    }
  } finally {
    resetUserAgentStoreForTests()
  }
})
