import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { createIdentityTestRepository } from '../testing/compatibilityRepositories.js'
import { UnifiedIdentityService } from '../identity/unifiedIdentityService.js'
import { onlineCommandContext } from '../application/commandContext.js'
import { AuthService, AuthServiceError } from './service.js'
import type { AuthContext } from './token.js'

void test('new password, phone and provider users receive local execution without changing their password identity', async () => {
  const raw = new DatabaseSync(':memory:')
  const db = new AuthCenterDb(raw)
  const repository = createIdentityTestRepository(raw, {}, db.driver)
  const identity = new UnifiedIdentityService(db, repository)
  try {
    await db.createOrganization('org-a', 'A', 1)
    const credentials = [
      { password: 'StrongPass123' },
      { phone: '13800138000' },
      { authIdentity: { provider: 'cas', issuer: 'example', subject: 'external-user' } },
    ]
    for (const [index, credential] of credentials.entries()) {
      const created = await identity.createUser({ orgId: 'org-a', username: `new-user-${index}`, role: 'user', ...credential }, onlineCommandContext(`local-default-${index}`))
      const user = await db.getUserById(created.userId)
      assert.equal(user?.localExecutionAllowed, true)
      assert.equal(user?.localAuth, index === 0)
    }
  } finally { raw.close() }
})

void test('Local authorization can be revoked and restored without changing passwords, login or organization boundaries', async () => {
  const raw = new DatabaseSync(':memory:')
  const db = new AuthCenterDb(raw)
  createIdentityTestRepository(raw, {}, db.driver)
  const service = new AuthService(db, 3600)
  try {
    await db.setConfig('issuer', 'local-execution-test')
    await db.setConfig('jwt_secret', 'local-execution-test-secret')
    await db.createOrganization('org-a', 'A', 1)
    await db.createOrganization('org-b', 'B', 1)
    const admin = await service.createUser({ orgId: 'org-a', name: 'admin', role: 'admin', password: 'StrongPass123' })
    const user = await service.createUser({ orgId: 'org-a', name: 'member', role: 'user', password: 'StrongPass123' })
    const other = await service.createUser({ orgId: 'org-b', name: 'other', role: 'user', password: 'StrongPass123' })
    const root = await service.createUser({ orgId: 'org-a', name: 'root', role: 'super_admin', password: 'StrongPass123' })
    const auth = { userId: admin.user.id, orgId: 'org-a', role: 'admin', scopes: ['admin:users'] } as AuthContext
    const before = await db.getUserById(user.user.id)
    const login = await service.issueTokenFromPassword({ username: 'member', password: 'StrongPass123' })
    assert.equal(await service.isUserLocalExecutionAllowed(user.user.id), true)
    await service.setLocalAuth({ orgId: 'org-a', userId: user.user.id, localAuth: false }, auth)
    assert.equal(await service.isUserLocalExecutionAllowed(user.user.id), false)
    const stored = await db.getUserById(user.user.id)
    assert.equal(stored?.passwordHash, before?.passwordHash)
    assert.equal(stored?.localAuth, true)
    assert.equal((await service.listUsers('org-a', auth)).users.find(item => item.id === user.user.id)?.localExecutionAllowed, false)
    assert.equal((await service.issueTokenFromPassword({ username: 'member', password: 'StrongPass123' })).user.id, user.user.id)
    assert.equal((await service.refreshToken(login.refresh_token)).user.id, user.user.id)
    await assert.rejects(service.setLocalAuth({ orgId: 'org-a', userId: other.user.id, localAuth: false }, auth), (error: unknown) => error instanceof AuthServiceError && error.statusCode === 404)
    await assert.rejects(service.setLocalAuth({ orgId: 'org-b', userId: other.user.id, localAuth: false }, auth), (error: unknown) => error instanceof AuthServiceError && error.statusCode === 404)
    await assert.rejects(service.setLocalAuth({ orgId: 'org-a', userId: user.user.id, localAuth: true }, { ...auth, userId: user.user.id, role: 'user', scopes: [] }), (error: unknown) => error instanceof AuthServiceError && error.statusCode === 403)
    await assert.rejects(service.setLocalAuth({ orgId: 'org-a', userId: other.user.id, localAuth: false }, { ...auth, userId: user.user.id, role: 'super_admin' }), (error: unknown) => error instanceof AuthServiceError && error.statusCode === 403)
    const rootAuth = { ...auth, userId: root.user.id, role: 'super_admin' }
    await service.setLocalAuth({ orgId: 'org-a', userId: other.user.id, localAuth: false }, rootAuth)
    assert.equal(await service.isUserLocalExecutionAllowed(other.user.id), false)
    await service.setLocalAuth({ orgId: 'org-a', userId: other.user.id, localAuth: true }, rootAuth)
    assert.equal(await service.isUserLocalExecutionAllowed(other.user.id), true)
    await service.setLocalAuth({ orgId: 'org-a', userId: user.user.id, localAuth: true }, auth)
    assert.equal(await service.isUserLocalExecutionAllowed(user.user.id), true)
  } finally { service.destroy(); raw.close() }
})

void test('SQLite upgrades preserve old grants once and never undo later revocation', async () => {
  const raw = new DatabaseSync(':memory:')
  const db = new AuthCenterDb(raw)
  try {
    await db.createOrganization('org-a', 'A', 1)
    raw.exec(`INSERT INTO users (id, org_id, email, name, local_auth, created_at)
      VALUES ('allowed', 'org-a', 'a@example.test', 'allowed', 1, 1),
             ('denied', 'org-a', 'b@example.test', 'denied', 0, 1)`)
    raw.exec('ALTER TABLE users DROP COLUMN local_execution_allowed')
    const upgraded = new AuthCenterDb(raw)
    assert.equal((await upgraded.getUserById('allowed'))?.localExecutionAllowed, true)
    assert.equal((await upgraded.getUserById('denied'))?.localExecutionAllowed, false)
    await upgraded.setLocalExecutionAllowed('allowed', 'org-a', false)
    const reopened = new AuthCenterDb(raw)
    assert.equal((await reopened.getUserById('allowed'))?.localExecutionAllowed, false)
    raw.exec("INSERT INTO users (id, org_id, email, name, created_at) VALUES ('new', 'org-a', 'c@example.test', 'new', 1)")
    assert.equal((await reopened.getUserById('new'))?.localExecutionAllowed, true)
  } finally { raw.close() }
})
