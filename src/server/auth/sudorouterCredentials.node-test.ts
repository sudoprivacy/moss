import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { AuthService, AuthServiceError } from './service.js'
import type { AuthContext } from './token.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { createIdentityTestRepository } from '../testing/compatibilityRepositories.js'

void test('lists only masked gateway keys and audits authorized copies without exposing another organization', async () => {
  const raw = new DatabaseSync(':memory:')
  const db = new AuthCenterDb(raw)
  const repository = createIdentityTestRepository(raw, {}, db.driver)
  const service = new AuthService(db, 3600)
  try {
    await db.createOrganization('org-a', 'A', 1)
    await db.createOrganization('org-b', 'B', 1)
    const admin = await service.createUser({ orgId: 'org-a', name: 'admin', role: 'admin', password: 'Test-password' })
    const user = await service.createUser({ orgId: 'org-a', name: '13800138000', displayName: 'Nickname', role: 'user', password: 'Test-password' })
    const other = await service.createUser({ orgId: 'org-b', name: '13800138001', role: 'user', password: 'Test-password' })
    const token = 'sk-private-gateway-key-never-returned-in-lists'
    let reads = 0
    service.configureSudorouterAccounts({
      initialQuotaUnits: 0,
      accountProvisioner: {
        async ensureAccount() { throw new Error('Must not provision on read') },
        async getAccount(ownerId) {
          reads++
          if (ownerId !== user.user.id) return null
          return { externalUserId: '91', token, tokenSecretRef: 'nexus://test/key', quotaUnits: 0, usedQuotaUnits: 0 }
        },
      },
    })
    const auth = { userId: admin.user.id, orgId: 'org-a', role: 'admin', scopes: ['admin:users'] } as AuthContext
    const list = await service.listUsers('org-a', auth)
    const listed = list.users.find(u => u.id === user.user.id)!
    assert.equal(listed.name, '13800138000')
    assert.equal(listed.sudorouterApiKeyMasked, 'sk-pri…ists')
    assert.equal(JSON.stringify(list).includes(token), false)
    assert.deepEqual(await service.copyUserSudorouterKey(user.user.id, auth), { key: token })
    const priorReads = reads
    await assert.rejects(service.copyUserSudorouterKey(other.user.id, auth), (e: unknown) => e instanceof AuthServiceError && e.statusCode === 404)
    await assert.rejects(service.copyUserSudorouterKey(user.user.id, { ...auth, scopes: [] }), (e: unknown) => e instanceof AuthServiceError && e.statusCode === 403)
    await assert.rejects(service.copyUserSudorouterKey(admin.user.id, { ...auth, userId: user.user.id, role: 'user' }), (e: unknown) => e instanceof AuthServiceError && e.statusCode === 403)
    assert.equal(reads, priorReads, 'Rejected requests must not read secrets')
    const audit = await repository.listOperationAudits({ orgId: 'org-a', limit: 20, offset: 0 })
    assert.equal(audit.items.filter(row => row.action === 'SUDOROUTER_KEY_COPY').length, 1)
    assert.equal(JSON.stringify(audit).includes(token), false)
  } finally { service.destroy(); raw.close() }
})
