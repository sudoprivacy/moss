import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { migrationCommandContext, onlineCommandContext, replayCommandContext } from '../application/commandContext.js'
import { createIdentityTestRepository } from '../testing/compatibilityRepositories.js'
import { IdentityRepository } from './identityRepository.js'
import { UnifiedIdentityService } from './unifiedIdentityService.js'

async function setup(): Promise<{
  db: DatabaseSync
  authDb: AuthCenterDb
  repository: IdentityRepository
  service: UnifiedIdentityService
}> {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  const repository = createIdentityTestRepository(db, {}, authDb.driver)
  await authDb.createOrganization('org-a', 'Organization A', 1)
  await repository.putOrganizationProfile({
    orgId: 'org-a', code: 'acme', loginMethod: 'password', localEnabled: true, cloudEnabled: true,
  })
  const service = new UnifiedIdentityService(authDb, repository)
  return { db, authDb, repository, service }
}

void describe('trusted command context', () => {
  void test('forces migration and replay to suppress external effects', async () => {
    assert.equal(onlineCommandContext('online-1').externalEffects, 'enqueue')
    assert.equal(migrationCommandContext('run-1', 'migration-1').externalEffects, 'suppress_external')
    assert.equal(replayCommandContext('event-1', 'replay-1').externalEffects, 'suppress_external')
  })
})

void describe('UnifiedIdentityService.createUser', () => {
  void test('后台创建用户可在同一事务初始化明确积分', async () => {
    const { db, authDb, repository, service } = await setup()
    const created = await service.createUser({
      orgId: 'org-a', username: 'new-admin-user', password: 'StrongPass123',
      role: 'user', initialCreditUnits: 100_000,
    }, onlineCommandContext('create-with-initial-credit'))

    assert.equal((await authDb.getUserById(created.userId))?.status, 'active')
    assert.equal((await repository.getWallet('user', created.userId))?.balanceUnits, 100_000)
    db.close()
  })

  void test('atomically creates user, identity, numeric alias, wallet, invitation use and pending outbox', async () => {
    const { db, authDb, repository, service } = await setup()
    await repository.createInvitation({ id: 'invite-1', orgId: 'org-a', code: 'JOINME', initialCreditUnits: 500 })

    const result = await service.createUser({
      orgId: 'org-a',
      username: 'alice',
      displayName: 'Alice',
      password: 'StrongPass123',
      phone: '+8613800000000',
      invitationCode: 'JOINME',
      role: 'user',
    }, onlineCommandContext('create-user-alice'))

    assert.equal((await authDb.getUserById(result.userId))?.name, 'alice')
    assert.equal((await authDb.getUserById(result.userId))?.localAuth, true)
    assert.equal((await repository.findAuthIdentity('password', 'moss', 'alice'))?.userId, result.userId)
    assert.equal((await repository.findAuthIdentity('phone', 'sudowork', '+8613800000000'))?.userId, result.userId)
    assert.equal(await repository.resolveNumericAlias('user', result.legacyUserId, 'org-a'), result.userId)
    assert.deepEqual(await repository.getWallet('user', result.userId), { balanceUnits: 500, version: 0 })
    assert.equal((await repository.getInvitationByCode('JOINME'))?.status, 'used')
    assert.equal((await repository.getOutboxEvent('welcome:create-user-alice'))?.status, 'pending')

    const repeated = await service.createUser({
      orgId: 'org-a', username: 'alice', displayName: 'Alice', password: 'StrongPass123',
      phone: '+8613800000000', invitationCode: 'JOINME', role: 'user',
    }, onlineCommandContext('create-user-alice'))
    assert.deepEqual(repeated, result)
    assert.equal((await authDb.listUsersByOrg('org-a')).length, 1)
    db.close()
  })

  void test('preserves imported numeric ids and suppresses external migration/replay effects', async () => {
    const { db, repository, service } = await setup()
    const migrated = await service.createUser({
      orgId: 'org-a', username: 'legacy', passwordHash: 'legacy-hash', phone: '13800000001',
      role: 'user', status: 'locked', legacyUserId: 73,
    }, migrationCommandContext('run-7', 'import-user-73'))
    assert.equal(migrated.legacyUserId, 73)
    assert.equal((await repository.getOutboxEvent('welcome:import-user-73'))?.status, 'suppressed')
    assert.match((await repository.getOutboxEvent('welcome:import-user-73'))?.suppressReason ?? '', /migration/)

    const replayed = await service.createUser({
      orgId: 'org-a', username: 'replayed', passwordHash: 'legacy-hash', phone: '13800000002',
      role: 'user', status: 'active',
    }, replayCommandContext('legacy-event-9', 'replay-user-9'))
    assert.equal((await repository.getOutboxEvent('welcome:replay-user-9'))?.status, 'suppressed')
    assert(replayed.legacyUserId > 73)
    db.close()
  })

  void test('rolls back every write when a fixed legacy alias conflicts', async () => {
    const { db, authDb, repository, service } = await setup()
    await service.createUser({
      orgId: 'org-a', username: 'first', password: 'StrongPass123', phone: '13800000003',
      role: 'user', legacyUserId: 9,
    }, onlineCommandContext('first'))

    await assert.rejects(service.createUser({
      orgId: 'org-a', username: 'second', password: 'StrongPass123', phone: '13800000004',
      role: 'user', legacyUserId: 9,
    }, onlineCommandContext('second')), /UNIQUE constraint failed/)
    assert.equal((await authDb.listUsersByName('second')).length, 0)
    assert.equal(await repository.findAuthIdentity('phone', 'sudowork', '13800000004'), null)
    assert.equal(await repository.getOutboxEvent('welcome:second'), null)
    db.close()
  })

  void test('creates passwordless provider users with the same aliases and wallet', async () => {
    const { db, authDb, repository, service } = await setup()
    const result = await service.createUser({
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

    const user = await authDb.getUserById(result.userId)
    assert.equal(user?.passwordHash, null)
    assert.equal(user?.localAuth, false)
    assert.equal((await repository.findAuthIdentity('oauth2', 'moss-script', 'external-42'))?.userId, result.userId)
    assert.equal(await repository.getNumericAlias('user', result.userId), result.legacyUserId)
    assert.deepEqual(await repository.getWallet('user', result.userId), { balanceUnits: 0, version: 0 })
    db.close()
  })
})
