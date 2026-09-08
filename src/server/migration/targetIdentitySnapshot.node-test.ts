import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { readTargetIdentitySnapshot } from './targetIdentitySnapshot.js'

describe('readTargetIdentitySnapshot', () => {
  test('从 Moss 统一身份表读取组织、用户、验证状态、Provider 与数字别名', () => {
    const db = new DatabaseSync(':memory:')
    const auth = new AuthCenterDb(db)
    const identities = new IdentityRepository(db)
    auth.createOrganization('org-a', '企业 A', 1)
    identities.putOrganizationProfile({
      orgId: 'org-a', code: 'ENT-A', codeVerified: true,
      loginMethod: 'password', localEnabled: true, cloudEnabled: true,
    })
    identities.assignNumericAlias({ namespace: 'enterprise', legacyId: 7, resourceId: 'org-a', orgId: 'org-a' })
    auth.createUser({
      id: 'user-a', orgId: 'org-a', email: 'a@example.test', name: '13800000000',
      displayName: 'A', departmentId: null, role: 'user', status: 'active', localAuth: true,
      tokenLimit: null, createdAt: 1, passwordHash: 'hash', passwordUpdatedAt: 1,
      lastLoginAt: null, extUserId: null,
    })
    identities.createAuthIdentity({
      id: 'phone-a', orgId: 'org-a', userId: 'user-a', provider: 'phone', issuer: 'sudowork',
      normalizedSubject: '13800000000', metadata: { verified: true },
    })
    identities.createAuthIdentity({
      id: 'cas-a', orgId: 'org-a', userId: 'user-a', provider: 'cas', issuer: 'cas-main',
      normalizedSubject: 'external-a', metadata: {},
    })
    identities.assignNumericAlias({ namespace: 'user', legacyId: 17, resourceId: 'user-a', orgId: 'org-a' })

    assert.deepEqual(readTargetIdentitySnapshot(auth, identities), {
      organizations: [{ id: 'org-a', name: '企业 A', code: 'ENT-A', codeVerified: true, legacyAlias: 7 }],
      users: [{
        id: 'user-a', orgId: 'org-a', email: 'a@example.test', emailVerified: false,
        phone: '13800000000', phoneVerified: true, username: '13800000000', displayName: 'A',
        legacyAlias: 17,
        providerIdentities: [
          { provider: 'cas', issuer: 'cas-main', subject: 'external-a' },
          { provider: 'phone', issuer: 'sudowork', subject: '13800000000' },
        ],
      }],
    })
    db.close()
  })
})
