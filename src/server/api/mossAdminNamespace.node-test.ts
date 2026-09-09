import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { normalizeMossAdminApiPath } from './mossAdminNamespace.js'

describe('Moss Admin API namespace', () => {
  test('maps the dedicated Admin namespace to existing native routes', () => {
    assert.equal(normalizeMossAdminApiPath('/api/moss/v1/auth/token'), '/api/v1/auth/token')
    assert.equal(normalizeMossAdminApiPath('/api/moss/v1/users/u-1'), '/api/v1/users/u-1')
    assert.equal(normalizeMossAdminApiPath('/api/moss/v1'), '/api/v1')
  })

  test('does not rewrite legacy, static, health, or lookalike paths', () => {
    assert.equal(normalizeMossAdminApiPath('/api/v1/auth/token'), '/api/v1/auth/token')
    assert.equal(normalizeMossAdminApiPath('/api/moss/v10/auth/token'), '/api/moss/v10/auth/token')
    assert.equal(normalizeMossAdminApiPath('/admin/'), '/admin/')
    assert.equal(normalizeMossAdminApiPath('/healthz'), '/healthz')
  })
})
