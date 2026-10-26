import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AGENT_CONTROL_AUDIENCE } from '../agentControl/contract.js'
import { issueAccessToken, verifyAccessToken } from './token.js'

const secret = 'fixture-purpose-isolation-secret'
const claims = { iss: 'fixture-moss', sub: 'owner', org_id: 'org', role: 'admin', scopes: ['*'], key_id: 'fixture-key' }

void test('an administrator control capability cannot authenticate as a browser or refresh credential', () => {
  const { token } = issueAccessToken({ ...claims, aud: AGENT_CONTROL_AUDIENCE }, secret)
  assert.equal(verifyAccessToken(token, secret, claims.iss), null)
  assert.equal(verifyAccessToken(token, secret, claims.iss, 'refresh'), null)
  assert.equal(verifyAccessToken(token, secret, claims.iss, 'access', AGENT_CONTROL_AUDIENCE)?.userId, 'owner')
  assert.equal(verifyAccessToken(token, secret, claims.iss, 'access', 'other-consumer'), null)
})

void test('ordinary login credentials retain their behavior and cannot stand in for an Agent delegation', () => {
  const { token } = issueAccessToken(claims, secret)
  assert.equal(verifyAccessToken(token, secret, claims.iss)?.role, 'admin')
  assert.equal(verifyAccessToken(token, secret, claims.iss, 'access', AGENT_CONTROL_AUDIENCE), null)
  assert.equal(verifyAccessToken(token, 'other-key', claims.iss), null)
  assert.equal(verifyAccessToken(token, secret, 'other-issuer'), null)
})

void test('audience binding does not bypass expiry or token type checks', () => {
  const expired = issueAccessToken({ ...claims, aud: AGENT_CONTROL_AUDIENCE }, secret, -1).token
  assert.equal(verifyAccessToken(expired, secret, claims.iss, 'access', AGENT_CONTROL_AUDIENCE), null)
  const refresh = issueAccessToken({ ...claims, aud: AGENT_CONTROL_AUDIENCE }, secret, 60, 'refresh').token
  assert.equal(verifyAccessToken(refresh, secret, claims.iss, 'access', AGENT_CONTROL_AUDIENCE), null)
})
