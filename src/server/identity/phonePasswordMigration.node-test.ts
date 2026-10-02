import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { AuthCenterDb, hashPassword, verifyPassword } from '../authCenter/db.js'
import { ensureIdentitySchema, IdentityRepository } from './identityRepository.js'
import { migratePhonePasswords } from './phonePasswordMigration.js'

void test('preview is read-only; apply preserves existing passwords, roles, status and organizations and is idempotent', async t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const auth = new AuthCenterDb(db)
  ensureIdentitySchema(db)
  const identities = new IdentityRepository(auth.driver)
  await auth.createOrganization('org', 'Org', 1)
  const existingHash = hashPassword('AlreadySet123')
  for (const [i, id] of ['eligible', 'existing', 'disabled', 'admin', 'conflict', 'no-phone'].entries()) {
    const phone = `1380000000${i}`
    await auth.createUser({ id, name: phone, phone: id === 'conflict' ? '13900000000' : phone, orgId: 'org', email: `${id}@example.test`,
      role: id === 'admin' ? 'admin' : 'user', status: id === 'disabled' ? 'disabled' : 'active', localAuth: false,
      passwordHash: id === 'existing' ? existingHash : null, displayName: null, departmentId: null, tokenLimit: null,
      createdAt: 1, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null })
    if (id !== 'no-phone') await identities.createAuthIdentity({ id: `identity-${id}`, userId: id, orgId: 'org', provider: 'phone', issuer: 'sudowork', normalizedSubject: phone, metadata: {} })
  }
  const before = db.prepare('SELECT id, role, status, org_id FROM users ORDER BY id').all()
  const preview = await migratePhonePasswords(auth, { actorId: 'root' })
  assert.equal(preview.eligible, 1)
  assert.equal((await auth.getUserById('eligible'))!.passwordHash, null)
  assert.equal(JSON.stringify(preview).includes('13800000000'), false)
  const applied = await migratePhonePasswords(auth, { actorId: 'root', apply: true, fingerprint: preview.fingerprint })
  assert.equal(applied.updated, 1)
  assert(verifyPassword('13800000000', (await auth.getUserById('eligible'))!.passwordHash))
  assert.equal((await auth.getUserById('existing'))!.passwordHash, existingHash)
  assert((await identities.findAuthIdentityByUser('eligible', 'password', 'moss')))
  assert.equal((await auth.getUserById('eligible'))!.localAuth, true)
  assert.equal((await migratePhonePasswords(auth, { actorId: 'root' })).eligible, 0)
  for (const id of ['disabled', 'admin', 'conflict', 'no-phone']) assert.equal((await auth.getUserById(id))!.passwordHash, null)
  assert.deepEqual(db.prepare('SELECT id, role, status, org_id FROM users ORDER BY id').all(), before)
  await assert.rejects(migratePhonePasswords(auth, { actorId: 'root', apply: true, fingerprint: preview.fingerprint }), /重新预览/)
})
