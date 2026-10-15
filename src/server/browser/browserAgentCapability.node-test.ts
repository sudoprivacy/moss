import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserAgentCapabilities } from './browserAgentCapability.js'

void test('browser capabilities reject another session, superseded attempts and revoked accounts', async () => {
  const grants = new BrowserAgentCapabilities()
  const binding = { orgId: 'org', userId: 'owner', sessionId: 'conversation' }
  let session = { ...binding, currentAttemptId: 'attempt-1', desiredState: 'active' }
  let active = true
  const deps = { getSession: async () => session, isUserActive: async () => active }
  const oldToken = grants.issue(binding, 'attempt-1')
  assert.deepEqual(await grants.authorize('conversation', oldToken, deps), binding)
  await assert.rejects(grants.authorize('other-conversation', oldToken, deps), /Invalid browser capability/)
  await assert.rejects(grants.authorize('conversation', 'forged', deps), /Invalid browser capability/)
  active = false
  await assert.rejects(grants.authorize('conversation', oldToken, deps), /revoked/)
  active = true
  session = { ...session, currentAttemptId: 'attempt-2' }
  await assert.rejects(grants.authorize('conversation', oldToken, deps), /Invalid browser capability/)
  const newToken = grants.issue(binding, 'attempt-2')
  await assert.rejects(grants.authorize('conversation', oldToken, deps), /Invalid browser capability/)
  assert.deepEqual(await grants.authorize('conversation', newToken, deps), binding)
  session = { ...session, desiredState: 'terminated' }
  await assert.rejects(grants.authorize('conversation', newToken, deps), /revoked/)
})

void test('a stable deployment key preserves an active grant across restart and HA routing', async () => {
  const secret = 'owned-fixture-deployment-key-32-characters'
  const first = new BrowserAgentCapabilities(secret)
  const binding = { orgId: 'org', userId: 'owner', sessionId: 'conversation' }
  const session = { ...binding, currentAttemptId: 'attempt-1', desiredState: 'active' }
  const deps = { getSession: async () => session, isUserActive: async () => true }
  const token = first.issue(binding, 'attempt-1')
  const restarted = new BrowserAgentCapabilities(secret)
  assert.deepEqual(await restarted.authorize(binding.sessionId, token, deps), binding)
  const rotated = new BrowserAgentCapabilities('different-owned-deployment-key-32-characters')
  await assert.rejects(rotated.authorize(binding.sessionId, token, deps), /Invalid browser capability/)
})
