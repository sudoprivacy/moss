import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listMyAgents } from './myAgents.js'
import { defaultAgentName, userCreatedAgentName } from './agentIdentity.js'
import { createUserAgent, resetUserAgentStoreForTests } from './userAgentStore.js'

const noSessions = async () => []
const nameIs = (name: string) => async () => name

void test('a person always has at least their own agent', async () => {
  resetUserAgentStoreForTests()
  const agents = await listMyAgents({
    orgId: 'o1',
    userId: 'u1',
    defaultDisplayName: '宋一民',
    listSessionAssistants: noSessions,
    resolveTemplateName: nameIs('unused'),
  })
  assert.deepEqual(agents, [
    { ref: defaultAgentName('u1'), displayName: '宋一民', kind: 'default' },
  ])
})

void test('a template the user never opened is not one of their agents', async () => {
  resetUserAgentStoreForTests()
  const agents = await listMyAgents({
    orgId: 'o1',
    userId: 'u1',
    defaultDisplayName: '宋一民',
    // The catalog holds dozens; none of them is this person's agent until they
    // start a conversation with one. Listing the catalog here would put every
    // template in the sidebar and undo the distinction the sidebar is for.
    listSessionAssistants: noSessions,
    resolveTemplateName: nameIs('招聘专家'),
  })
  assert.equal(agents.filter(a => a.kind === 'template').length, 0)
})

void test('the three kinds appear in a stable order, each named by its own source', async () => {
  resetUserAgentStoreForTests()
  const own = await createUserAgent({ orgId: 'o1', userId: 'u1', displayName: '项目 A' })
  const agents = await listMyAgents({
    orgId: 'o1',
    userId: 'u1',
    defaultDisplayName: '宋一民',
    listSessionAssistants: async () => [
      { assistantName: 'tpl-recruit' },
      { assistantName: defaultAgentName('u1') },
      { assistantName: userCreatedAgentName(own.id) },
      // The same template twice is still one agent.
      { assistantName: 'tpl-recruit' },
      { assistantName: null },
    ],
    resolveTemplateName: nameIs('招聘专家'),
  })

  assert.deepEqual(
    agents.map(a => [a.kind, a.displayName]),
    [
      ['default', '宋一民'],
      ['own', '项目 A'],
      ['template', '招聘专家'],
    ],
  )
  // The references a session already stores come back unchanged, so the client
  // can match a conversation to its agent without knowing the three shapes.
  assert.equal(agents[2]?.ref, 'tpl-recruit')
})

void test('a template whose catalog entry is gone keeps its conversations visible', async () => {
  resetUserAgentStoreForTests()
  const agents = await listMyAgents({
    orgId: 'o1',
    userId: 'u1',
    defaultDisplayName: '宋一民',
    listSessionAssistants: async () => [{ assistantName: 'uninstalled-one' }],
    // Uninstalled, or renamed out from under an old session.
    resolveTemplateName: async () => {
      throw new Error('not found')
    },
  })
  // Falling back to the reference keeps the group in the sidebar. Dropping it
  // would leave conversations the user can open belonging to nothing.
  assert.deepEqual(agents.map(a => a.displayName), ['宋一民', 'uninstalled-one'])
})

void test('agents are listed per person, not per organization', async () => {
  resetUserAgentStoreForTests()
  await createUserAgent({ orgId: 'o1', userId: 'alice', displayName: '项目 A' })
  const bobs = await listMyAgents({
    orgId: 'o1',
    userId: 'bob',
    defaultDisplayName: 'bob',
    listSessionAssistants: noSessions,
    resolveTemplateName: nameIs('unused'),
  })
  assert.deepEqual(bobs.map(a => a.kind), ['default'])
})
