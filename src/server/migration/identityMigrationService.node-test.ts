import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { migrationCommandContext } from '../application/commandContext.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { UnifiedIdentityService } from '../identity/unifiedIdentityService.js'
import { IdentityMergePlanner, type LegacyIdentitySnapshot } from './identityMergePlanner.js'
import {
  IdentityMigrationBlockedError,
  IdentityMigrationService,
} from './identityMigrationService.js'
import { MigrationRunStore } from './migrationRunStore.js'

const source: LegacyIdentitySnapshot = {
  organizations: [{ legacyId: 7, name: '新企业', code: 'NEWCO', codeVerified: true }],
  users: [{
    legacyId: 17,
    enterpriseId: 7,
    username: 'legacy-user',
    displayName: '历史用户',
    phone: '13800000000',
    phoneVerified: true,
    email: 'legacy@example.test',
    emailVerified: true,
    passwordHash: '$2b$10$legacy-hash',
    role: 'ENTERPRISE_ADMIN',
    status: 'ACTIVE',
    providerIdentity: null,
    providerIdentities: [
      { provider: 'cas', issuer: 'cas-main', subject: 'subject-a' },
      { provider: 'cas', issuer: 'cas-other', subject: 'subject-b' },
    ],
  }],
}

function setup(snapshot: LegacyIdentitySnapshot = source) {
  const db = new DatabaseSync(':memory:')
  const auth = new AuthCenterDb(db)
  const identities = new IdentityRepository(db)
  const unified = new UnifiedIdentityService(db, auth, identities)
  const runs = new MigrationRunStore(db, { idFactory: () => 'run-identity' })
  runs.createRun({ sourceFingerprint: 'sha256:source', sourceMetadata: {} })
  const planner = new IdentityMergePlanner({ organizations: [], users: [] })
  const service = new IdentityMigrationService({ db, auth, identities, unified, runs, source: { readSnapshot: () => snapshot }, planner })
  return { db, auth, identities, runs, service }
}

describe('IdentityMigrationService', () => {
  test('组织与用户阶段可独立执行并分别形成恢复边界', () => {
    const fixture = setup()
    try {
      const plan = fixture.service.plan([])
      const organization = fixture.service.executeOrganizations(
        plan,
        migrationCommandContext('run-identity', 'organizations-phase'),
      )
      assert.equal(organization.organizationsCreated, 1)
      assert.equal(fixture.auth.listOrganizations().length, 1)
      assert.equal(fixture.auth.listUsersByOrg(organization.organizationIds[0]!).length, 0)

      const identities = fixture.service.executeUsers(
        plan,
        migrationCommandContext('run-identity', 'identities-phase'),
      )
      assert.equal(identities.usersCreated, 1)
      assert.equal(fixture.auth.listUsersByOrg(organization.organizationIds[0]!).length, 1)
    } finally {
      fixture.db.close()
    }
  })

  test('imports organizations and users through unified commands with stable aliases and suppressed effects', () => {
    const fixture = setup()
    try {
      const plan = fixture.service.plan([])
      assert.equal(plan.status, 'ready')
      const context = migrationCommandContext('run-identity', 'identity-phase')
      const first = fixture.service.execute(plan, context)
      const replay = fixture.service.execute(plan, context)

      assert.equal(first.organizationsCreated, 1)
      assert.equal(first.usersCreated, 1)
      assert.deepEqual(replay, first)
      const org = fixture.identities.resolveNumericAliasGlobal('enterprise', 7)
      const user = fixture.identities.resolveNumericAliasGlobal('user', 17)
      assert(org)
      assert(user)
      assert.equal(user.orgId, org.resourceId)
      assert.equal(fixture.auth.getUserById(user.resourceId)?.passwordHash, '$2b$10$legacy-hash')
      assert.equal(fixture.auth.getUserById(user.resourceId)?.role, 'admin')
      assert.equal(fixture.identities.findAuthIdentity('cas', 'cas-main', 'subject-a')?.userId, user.resourceId)
      assert.equal(fixture.identities.findAuthIdentity('cas', 'cas-other', 'subject-b')?.userId, user.resourceId)
      assert.equal(fixture.identities.getOutboxEvent('welcome:migration:identity:user:17')?.status, 'suppressed')
      assert.equal(fixture.runs.listSuppressedEffects('run-identity').length, 1)
      assert.equal(first.deliverableExternalOutboxCount, 0)
      assert.equal(fixture.auth.listOrganizations().length, 1)
      assert.equal(fixture.auth.listUsersByOrg(org.resourceId).length, 1)
    } finally {
      fixture.db.close()
    }
  })

  test('reuses mapped Moss identities and only assigns permanent legacy aliases', () => {
    const db = new DatabaseSync(':memory:')
    const auth = new AuthCenterDb(db)
    const identities = new IdentityRepository(db)
    const unified = new UnifiedIdentityService(db, auth, identities)
    const existingOrg = unified.createOrganization(
      { name: 'Moss 企业', code: 'NEWCO', legacyEnterpriseId: 7 },
      migrationCommandContext('bootstrap', 'bootstrap-org'),
    )
    const existingUser = unified.createUser({
      orgId: existingOrg.organizationId,
      username: 'existing-user',
      email: 'legacy@example.test',
      passwordHash: '$2b$10$existing',
      role: 'user', legacyUserId: 17,
      authIdentity: { provider: 'cas', issuer: 'corp', subject: 'legacy-cas' },
    }, migrationCommandContext('bootstrap', 'bootstrap-user'))
    const runs = new MigrationRunStore(db, { idFactory: () => 'run-identity' })
    runs.createRun({ sourceFingerprint: 'sha256:source', sourceMetadata: {} })
    const withProvider: LegacyIdentitySnapshot = {
      organizations: source.organizations,
      users: [{ ...source.users[0], providerIdentity: { provider: 'cas', issuer: 'corp', subject: 'legacy-cas' } }],
    }
    const planner = new IdentityMergePlanner({
      organizations: [{ id: existingOrg.organizationId, code: 'NEWCO', codeVerified: true, legacyAlias: 7 }],
      users: [{
        id: existingUser.userId, orgId: existingOrg.organizationId,
        email: 'legacy@example.test', emailVerified: true, phone: null, phoneVerified: false, legacyAlias: 17,
        providerIdentities: [{ provider: 'cas', issuer: 'corp', subject: 'legacy-cas' }],
      }],
    })
    const service = new IdentityMigrationService({
      db, auth, identities, unified, runs, source: { readSnapshot: () => withProvider }, planner,
    })
    try {
      const report = service.execute(service.plan([]), migrationCommandContext('run-identity', 'identity-phase'))
      assert.equal(report.organizationsReused, 1)
      assert.equal(report.usersReused, 1)
      assert.equal(identities.resolveNumericAliasGlobal('enterprise', 7)?.resourceId, existingOrg.organizationId)
      assert.equal(identities.resolveNumericAliasGlobal('user', 17)?.resourceId, existingUser.userId)
      assert.equal(auth.listOrganizations().length, 1)
      assert.equal(auth.listUsersByOrg(existingOrg.organizationId).length, 1)
    } finally {
      db.close()
    }
  })

  test('blocks execution when merge planning contains unresolved conflicts', () => {
    const fixture = setup()
    try {
      const blocked = fixture.service.plan([{ kind: 'organization', sourceId: '7', targetId: 'missing' }])
      assert.equal(blocked.status, 'blocked')
      assert.throws(
        () => fixture.service.execute(blocked, migrationCommandContext('run-identity', 'identity-phase')),
        IdentityMigrationBlockedError,
      )
      assert.equal(fixture.auth.listOrganizations().length, 0)
    } finally {
      fixture.db.close()
    }
  })
})
