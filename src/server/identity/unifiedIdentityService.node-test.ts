import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { migrationCommandContext, onlineCommandContext, replayCommandContext } from '../application/commandContext.js'
import { IdentityRepository } from './identityRepository.js'
import { UnifiedIdentityService } from './unifiedIdentityService.js'

function setup(): {
  db: DatabaseSync
  authDb: AuthCenterDb
  repository: IdentityRepository
  service: UnifiedIdentityService
} {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  const repository = new IdentityRepository(db)
  authDb.createOrganization('org-a', 'Organization A', 1)
  repository.putOrganizationProfile({
    orgId: 'org-a', code: 'acme', loginMethod: 'password', localEnabled: true, cloudEnabled: true,
  })
  const service = new UnifiedIdentityService(db, authDb, repository)
  return { db, authDb, repository, service }
}

describe('trusted command context', () => {
  test('forces migration and replay to suppress external effects', () => {
    assert.equal(onlineCommandContext('online-1').externalEffects, 'enqueue')
    assert.equal(migrationCommandContext('run-1', 'migration-1').externalEffects, 'suppress_external')
    assert.equal(replayCommandContext('event-1', 'replay-1').externalEffects, 'suppress_external')
  })
})

describe('UnifiedIdentityService.createUser', () => {
  test('后台创建用户可在同一事务初始化明确积分', () => {
    const { db, authDb, repository, service } = setup()
    const created = service.createUser({
      orgId: 'org-a', username: 'new-admin-user', password: 'StrongPass123',
      role: 'user', initialCreditUnits: 100_000,
    }, onlineCommandContext('create-with-initial-credit'))

    assert.equal(authDb.getUserById(created.userId)?.status, 'active')
    assert.equal(repository.getWallet('user', created.userId)?.balanceUnits, 100_000)
    db.close()
  })

  test('atomically creates user, identity, numeric alias, wallet, invitation use and pending outbox', () => {
    const { db, authDb, repository, service } = setup()
    repository.createInvitation({ id: 'invite-1', orgId: 'org-a', code: 'JOINME', initialCreditUnits: 500 })

    const result = service.createUser({
      orgId: 'org-a',
      username: 'alice',
      displayName: 'Alice',
      password: 'StrongPass123',
      phone: '+8613800000000',
      invitationCode: 'JOINME',
      role: 'user',
    }, onlineCommandContext('create-user-alice'))

    assert.equal(authDb.getUserById(result.userId)?.name, 'alice')
    assert.equal(authDb.getUserById(result.userId)?.localAuth, true)
    assert.equal(repository.findAuthIdentity('password', 'moss', 'alice')?.userId, result.userId)
    assert.equal(repository.findAuthIdentity('phone', 'sudowork', '+8613800000000')?.userId, result.userId)
    assert.equal(repository.resolveNumericAlias('user', result.legacyUserId, 'org-a'), result.userId)
    assert.deepEqual(repository.getWallet('user', result.userId), { balanceUnits: 500, version: 0 })
    assert.equal(repository.getInvitationByCode('JOINME')?.status, 'used')
    assert.equal(repository.getOutboxEvent('welcome:create-user-alice')?.status, 'pending')

    const repeated = service.createUser({
      orgId: 'org-a', username: 'alice', displayName: 'Alice', password: 'StrongPass123',
      phone: '+8613800000000', invitationCode: 'JOINME', role: 'user',
    }, onlineCommandContext('create-user-alice'))
    assert.deepEqual(repeated, result)
    assert.equal(authDb.listUsersByOrg('org-a').length, 1)
    db.close()
  })

  test('preserves imported numeric ids and suppresses external migration/replay effects', () => {
    const { db, repository, service } = setup()
    const migrated = service.createUser({
      orgId: 'org-a', username: 'legacy', passwordHash: 'legacy-hash', phone: '13800000001',
      role: 'user', status: 'locked', legacyUserId: 73,
    }, migrationCommandContext('run-7', 'import-user-73'))
    assert.equal(migrated.legacyUserId, 73)
    assert.equal(repository.getOutboxEvent('welcome:import-user-73')?.status, 'suppressed')
    assert.match(repository.getOutboxEvent('welcome:import-user-73')?.suppressReason ?? '', /migration/)

    const replayed = service.createUser({
      orgId: 'org-a', username: 'replayed', passwordHash: 'legacy-hash', phone: '13800000002',
      role: 'user', status: 'active',
    }, replayCommandContext('legacy-event-9', 'replay-user-9'))
    assert.equal(repository.getOutboxEvent('welcome:replay-user-9')?.status, 'suppressed')
    assert(replayed.legacyUserId > 73)
    db.close()
  })

  test('rolls back every write when a fixed legacy alias conflicts', () => {
    const { db, authDb, repository, service } = setup()
    service.createUser({
      orgId: 'org-a', username: 'first', password: 'StrongPass123', phone: '13800000003',
      role: 'user', legacyUserId: 9,
    }, onlineCommandContext('first'))

    assert.throws(() => service.createUser({
      orgId: 'org-a', username: 'second', password: 'StrongPass123', phone: '13800000004',
      role: 'user', legacyUserId: 9,
    }, onlineCommandContext('second')), /UNIQUE constraint failed/)
    assert.equal(authDb.listUsersByName('second').length, 0)
    assert.equal(repository.findAuthIdentity('phone', 'sudowork', '13800000004'), null)
    assert.equal(repository.getOutboxEvent('welcome:second'), null)
    db.close()
  })

  test('creates passwordless provider users with the same aliases and wallet', () => {
    const { db, authDb, repository, service } = setup()
    const result = service.createUser({
      orgId: 'org-a',
      username: 'oauth-user',
      displayName: 'OAuth User',
      role: 'user',
      extUserId: 'external-42',
      authIdentity: {
        provider: 'oauth2',
        issuer: 'moss-script',
        subject: 'external-42',
        metadata: { source: 'login' },
      },
    }, onlineCommandContext('oauth-user:external-42'))

    const user = authDb.getUserById(result.userId)
    assert.equal(user?.passwordHash, null)
    assert.equal(user?.localAuth, false)
    assert.equal(repository.findAuthIdentity('oauth2', 'moss-script', 'external-42')?.userId, result.userId)
    assert.equal(repository.getNumericAlias('user', result.userId), result.legacyUserId)
    assert.deepEqual(repository.getWallet('user', result.userId), { balanceUnits: 0, version: 0 })
    db.close()
  })
})
