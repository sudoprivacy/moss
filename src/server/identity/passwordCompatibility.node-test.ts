import assert from 'node:assert/strict'
import { hashSync } from 'bcryptjs'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthService, AuthServiceError } from '../auth/service.js'
import { AuthCenterDb, type AuthCenterUser } from '../authCenter/db.js'

function setup(status: AuthCenterUser['status'] = 'active'): {
  db: DatabaseSync
  authDb: AuthCenterDb
  authService: AuthService
  legacyHash: string
} {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  authDb.createOrganization('org-a', 'Org A', 1)
  authDb.setConfig('issuer', 'moss-test')
  authDb.setConfig('jwt_secret', 'test-secret')
  const legacyHash = hashSync('StrongPass123', 4)
  authDb.createUser({
    id: 'legacy-user', orgId: 'org-a', email: 'legacy@example.test', name: 'legacy',
    displayName: null, departmentId: null, role: 'user', status, localAuth: true,
    tokenLimit: null, createdAt: 1, passwordHash: legacyHash, passwordUpdatedAt: null,
    lastLoginAt: null, extUserId: null,
  })
  return { db, authDb, authService: new AuthService(authDb, 3600), legacyHash }
}

describe('legacy bcrypt password compatibility', () => {
  test('accepts bcrypt once and upgrades the digest to scrypt during successful login', () => {
    const { db, authDb, authService, legacyHash } = setup()
    const result = authService.issueTokenFromPassword({ username: 'legacy', password: 'StrongPass123' })
    const updated = authDb.getUserById('legacy-user')
    assert.equal(result.user.id, 'legacy-user')
    assert.notEqual(updated?.passwordHash, legacyHash)
    assert.match(updated?.passwordHash ?? '', /^scrypt\$/)
    assert(updated?.lastLoginAt)
    authService.destroy()
    db.close()
  })

  test('does not upgrade on a wrong password or allow non-active states', () => {
    const wrong = setup()
    assert.throws(
      () => wrong.authService.issueTokenFromPassword({ username: 'legacy', password: 'wrong' }),
      (error: unknown) => error instanceof AuthServiceError && error.statusCode === 401,
    )
    assert.equal(wrong.authDb.getUserById('legacy-user')?.passwordHash, wrong.legacyHash)
    wrong.authService.destroy()
    wrong.db.close()

    for (const status of ['pending', 'locked', 'disabled'] as const) {
      const current = setup(status)
      assert.throws(
        () => current.authService.issueTokenFromPassword({ username: 'legacy', password: 'StrongPass123' }),
        (error: unknown) => error instanceof AuthServiceError && error.statusCode === 401,
      )
      current.authService.destroy()
      current.db.close()
    }
  })
})
