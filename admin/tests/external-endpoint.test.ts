import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isEndpointAllowed, normalizeEndpoint } from '../lib/external-endpoint'

test('address selection normalizes trailing slashes and whitespace without approving a different origin or path', () => {
  const allowed = ['http://127.0.0.1:80/v1']
  assert.equal(normalizeEndpoint(' http://127.0.0.1/v1/// '), 'http://127.0.0.1/v1')
  assert.ok(isEndpointAllowed(' http://127.0.0.1/v1/ ', allowed))
  for (const value of ['http://127.0.0.2/v1', 'http://127.0.0.1:81/v1', 'http://127.0.0.1/v1?key=secret', 'http://user@127.0.0.1/v1', 'http://127.0.0.1/console', '']) assert.equal(isEndpointAllowed(value, allowed), false)
  assert.equal(isEndpointAllowed('http://127.0.0.1/v1', []), false, 'a revoked address must need approval again')
})
