import assert from 'node:assert/strict'
import { hashSync } from 'bcryptjs'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthService, AuthServiceError } from '../auth/service.js'
import { AuthCenterDb, type AuthCenterUser } from '../authCenter/db.js'
import { createIdentityTestRepository } from '../testing/compatibilityRepositories.js'

async function setup(status: AuthCenterUser['status'] = 'active'): Promise<{
  db: DatabaseSync
  authDb: AuthCenterDb
  authService: AuthService
  legacyHash: string
}> {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  createIdentityTestRepository(db, {}, authDb.driver)
  await authDb.createOrganization('org-a', 'Org A', 1)
  await authDb.setConfig('issuer', 'moss-test')
  await authDb.setConfig('jwt_secret', 'test-secret')
  const legacyHash = hashSync('StrongPass123', 4)
  await authDb.createUser({
    id: 'legacy-user', orgId: 'org-a', email: 'legacy@example.test', name: 'legacy',
    displayName: null, departmentId: null, role: 'user', status, localAuth: true,
    tokenLimit: null, createdAt: 1, passwordHash: legacyHash, passwordUpdatedAt: null,
    lastLoginAt: null, extUserId: null,
  })
  return { db, authDb, authService: new AuthService(authDb, 3600), legacyHash }
}

void describe('legacy bcrypt password compatibility', () => {
  void test('accepts bcrypt once and upgrades the digest to scrypt during successful login', async () => {
    const { db, authDb, authService, legacyHash } = await setup()
    const result = await authService.issueTokenFromPassword({ username: 'legacy', password: 'StrongPass123' })
    const updated = await authDb.getUserById('legacy-user')
    assert.equal(result.user.id, 'legacy-user')
    assert.notEqual(updated?.passwordHash, legacyHash)
    assert.match(updated?.passwordHash ?? '', /^scrypt\$/)
    assert(updated?.lastLoginAt)
    authService.destroy()
    db.close()
  })

  void test('does not upgrade on a wrong password or allow non-active states', async () => {
    const wrong = await setup()
    await assert.rejects(
      wrong.authService.issueTokenFromPassword({ username: 'legacy', password: 'wrong' }),
      (error: unknown) => error instanceof AuthServiceError && error.statusCode === 401,
    )
    assert.equal((await wrong.authDb.getUserById('legacy-user'))?.passwordHash, wrong.legacyHash)
    wrong.authService.destroy()
    wrong.db.close()

    for (const status of ['pending', 'locked', 'disabled'] as const) {
      const current = await setup(status)
      await assert.rejects(
        current.authService.issueTokenFromPassword({ username: 'legacy', password: 'StrongPass123' }),
        (error: unknown) => error instanceof AuthServiceError && error.statusCode === 401,
      )
      current.authService.destroy()
      current.db.close()
    }
  })
})
