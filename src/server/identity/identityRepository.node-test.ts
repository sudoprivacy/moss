import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb, type AuthCenterUser } from '../authCenter/db.js'
import { IdentityRepository } from './identityRepository.js'

function createStore(): { db: DatabaseSync; authDb: AuthCenterDb; repository: IdentityRepository } {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  const repository = new IdentityRepository(db)
  authDb.createOrganization('org-a', 'Organization A', 1)
  authDb.createOrganization('org-b', 'Organization B', 1)
  return { db, authDb, repository }
}

function user(id: string, orgId: string, status: AuthCenterUser['status']): AuthCenterUser {
  return {
    id,
    orgId,
    email: `${id}@example.test`,
    name: id,
    displayName: null,
    departmentId: null,
    role: 'user',
    status,
    localAuth: true,
    tokenLimit: null,
    createdAt: 1,
    passwordHash: null,
    passwordUpdatedAt: null,
    lastLoginAt: null,
    extUserId: null,
  }
}

describe('unified identity schema and repository', () => {
  test('upgrades the old two-state users table without losing rows or foreign keys', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        password_hash TEXT,
        password_updated_at INTEGER,
        last_login_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      INSERT INTO organizations VALUES ('org-old', 'Old Org', 1);
      INSERT INTO users (id, org_id, email, name, status, created_at)
        VALUES ('user-old', 'org-old', 'old@example.test', 'old', 'active', 1);
      INSERT INTO api_keys VALUES ('key-old', 'org-old', 'user-old', 'key', 'prefix', 'hash', '[]', 'active', 1, NULL);
    `)

    const authDb = new AuthCenterDb(db)
    assert.equal(authDb.getUserById('user-old')?.status, 'active')
    authDb.updateUser('user-old', { status: 'locked' })
    assert.equal(authDb.getUserById('user-old')?.status, 'locked')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(authDb.getApiKeyById('key-old')?.userId, 'user-old')
    db.close()
  })

  test('persists all unified account states', () => {
    const { db, authDb } = createStore()
    for (const status of ['pending', 'active', 'locked', 'disabled'] as const) {
      authDb.createUser(user(`user-${status}`, 'org-a', status))
    }
    assert.deepEqual(
      (db.prepare('SELECT status FROM users ORDER BY status').all() as Array<{ status: string }>)
        .map((row) => row.status),
      ['active', 'disabled', 'locked', 'pending'],
    )
    db.close()
  })

  test('stores one organization profile and resolves its stable code', () => {
    const { db, repository } = createStore()
    repository.putOrganizationProfile({
      orgId: 'org-a',
      code: 'acme',
      loginMethod: 'password',
      localEnabled: true,
      cloudEnabled: true,
    })
    assert.equal(repository.getOrganizationProfileByCode('acme')?.orgId, 'org-a')
    assert.throws(() => repository.putOrganizationProfile({
      orgId: 'org-b',
      code: 'acme',
      loginMethod: 'password',
      localEnabled: true,
      cloudEnabled: false,
    }), /UNIQUE constraint failed/)
    db.close()
  })

  test('resolves provider identities without crossing organization boundaries', () => {
    const { db, authDb, repository } = createStore()
    authDb.createUser(user('user-a', 'org-a', 'active'))
    authDb.createUser(user('user-b', 'org-b', 'active'))
    repository.createAuthIdentity({
      id: 'identity-a',
      orgId: 'org-a',
      userId: 'user-a',
      provider: 'phone',
      issuer: 'sudowork',
      normalizedSubject: '+8613800000000',
      metadata: { source: 'migration' },
    })
    assert.equal(
      repository.findAuthIdentity('phone', 'sudowork', '+8613800000000')?.userId,
      'user-a',
    )
    assert.throws(() => repository.createAuthIdentity({
      id: 'identity-b',
      orgId: 'org-b',
      userId: 'user-b',
      provider: 'phone',
      issuer: 'sudowork',
      normalizedSubject: '+8613800000000',
      metadata: {},
    }), /UNIQUE constraint failed/)
    db.close()
  })

  test('keeps legacy numeric aliases unique per namespace and org-scoped on lookup', () => {
    const { db, repository } = createStore()
    repository.assignNumericAlias({ namespace: 'user', legacyId: 42, resourceId: 'user-a', orgId: 'org-a' })
    repository.assignNumericAlias({ namespace: 'enterprise', legacyId: 42, resourceId: 'org-b', orgId: 'org-b' })
    assert.equal(repository.resolveNumericAlias('user', 42, 'org-a'), 'user-a')
    assert.equal(repository.resolveNumericAlias('user', 42, 'org-b'), null)
    assert.throws(() => repository.assignNumericAlias({
      namespace: 'user', legacyId: 42, resourceId: 'user-b', orgId: 'org-b',
    }), /UNIQUE constraint failed/)
    db.close()
  })

  test('updates organization policy and lists profiles without a global singleton', () => {
    const { db, repository } = createStore()
    repository.putOrganizationProfile({
      orgId: 'org-a', code: 'A', loginMethod: 'sms', localEnabled: true, cloudEnabled: false,
      appName: 'A App',
    })
    repository.putOrganizationProfile({
      orgId: 'org-b', code: 'B', loginMethod: 'cas', localEnabled: false, cloudEnabled: true,
    })

    assert.deepEqual(repository.listOrganizationProfiles().map((profile) => profile.code), ['A', 'B'])
    assert.equal(repository.getOrganizationProfile('org-a')?.appName, 'A App')
    assert.equal(repository.getOrganizationProfile('org-b')?.loginMethod, 'cas')
    db.close()
  })

  test('lists, filters, revokes, and deletes invitations with stable ordering', () => {
    const { db, repository } = createStore()
    repository.createInvitation({ id: 'invite-a', orgId: 'org-a', code: 'CODE-A', initialCreditUnits: 10 })
    repository.createInvitation({ id: 'invite-b', orgId: 'org-b', code: 'CODE-B', initialCreditUnits: 20 })
    repository.createInvitation({ id: 'invite-c', orgId: 'org-a', code: 'CODE-C', initialCreditUnits: 30 })

    assert.equal(repository.listInvitations({ orgId: 'org-a', status: 'pending' }).total, 2)
    assert.deepEqual(
      repository.listInvitations({ orgId: 'org-a', status: 'pending', limit: 1, offset: 1 }).items
        .map((invitation) => invitation.code),
      ['CODE-A'],
    )
    assert.equal(repository.revokeInvitation('invite-a'), true)
    assert.equal(repository.getInvitationById('invite-a')?.status, 'revoked')
    assert.equal(repository.deletePendingInvitation('invite-a'), false)
    assert.equal(repository.deletePendingInvitation('invite-c'), true)
    assert.equal(repository.getInvitationByCode('CODE-C'), null)
    db.close()
  })

  test('moves every organization-scoped identity reference with its user', () => {
    const { db, authDb, repository } = createStore()
    authDb.createUser(user('user-a', 'org-a', 'active'))
    repository.createAuthIdentity({
      id: 'identity-a', orgId: 'org-a', userId: 'user-a', provider: 'phone',
      issuer: 'sudowork', normalizedSubject: '13800000000', metadata: {},
    })
    repository.assignNumericAlias({
      namespace: 'user', legacyId: 42, resourceId: 'user-a', orgId: 'org-a',
    })

    repository.moveUserOrganization('user-a', 'org-b')

    assert.equal(repository.findAuthIdentity('phone', 'sudowork', '13800000000')?.orgId, 'org-b')
    assert.equal(repository.resolveNumericAlias('user', 42, 'org-a'), null)
    assert.equal(repository.resolveNumericAlias('user', 42, 'org-b'), 'user-a')
    db.close()
  })

  test('stores organization integration connections without provider-specific tables', () => {
    const { db, repository } = createStore()
    repository.putIntegrationConnection({
      id: 'cas-main', orgId: 'org-a', providerType: 'cas', name: '统一认证', enabled: true,
      secretRef: null, config: { casUrl: 'https://cas.example.test', autoProvision: true },
    })
    assert.deepEqual(repository.getIntegrationConnection('cas-main'), {
      id: 'cas-main', orgId: 'org-a', providerType: 'cas', name: '统一认证', enabled: true,
      secretRef: null, config: { casUrl: 'https://cas.example.test', autoProvision: true },
    })
    assert.equal(repository.listIntegrationConnections('org-a', 'cas').length, 1)
    assert.equal(repository.listIntegrationConnections('org-b', 'cas').length, 0)
    db.close()
  })
})
