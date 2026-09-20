import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { onlineCommandContext } from '../application/commandContext.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { verifyPassword } from '../authCenter/db.js'
import { createIdentityTestRepository } from '../testing/compatibilityRepositories.js'
import { IdentityRepository } from './identityRepository.js'
import {
  IdentityDomainError,
  OrganizationIdentityService,
} from './organizationIdentityService.js'
import { UnifiedIdentityService } from './unifiedIdentityService.js'

function setup() {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  const repository = createIdentityTestRepository(db, {}, authDb.driver)
  const unified = new UnifiedIdentityService(authDb, repository)
  const service = new OrganizationIdentityService(authDb, repository, unified)
  return { db, authDb, repository, unified, service }
}

void describe('organization identity service', () => {
  void test('creates and updates a canonical organization with its compatibility profile', async () => {
    const { db, service } = setup()
    const created = await service.createOrganization({
      name: '企业 A', code: 'ENT-A', loginMethod: 'sms', localEnabled: true,
      cloudEnabled: false, appName: 'Sudowork A', initialCreditUnits: 100,
    }, onlineCommandContext('create-org-a'))

    assert.equal(created.profile.code, 'ENT-A')
    assert.equal(created.profile.loginMethod, 'sms')
    assert.equal(created.wallet.balanceUnits, 100)
    assert.equal((await service.listOrganizations())[0]?.userCount, 0)

    const updated = await service.updateOrganization(created.organization.id, {
      name: '企业 A+', cloudEnabled: true, logo: '/uploads/a.png',
    })
    assert.equal(updated.organization.name, '企业 A+')
    assert.equal(updated.profile.cloudEnabled, true)
    assert.equal(updated.profile.logo, '/uploads/a.png')
    db.close()
  })

  void test('creates, filters, and removes invitations in one organization', async () => {
    const { db, service } = setup()
    const org = await service.createOrganization(
      { name: '企业 A', code: 'ENT-A' }, onlineCommandContext('create-org-a'),
    )
    const codes = ['CODE-A', 'CODE-B']
    const created = await service.createInvitations({
      orgId: org.organization.id, count: 2, initialCreditUnits: 50,
    }, () => codes.shift()!)

    assert.deepEqual(created.map((item) => item.code), ['CODE-A', 'CODE-B'])
    assert.equal((await service.listInvitations({ orgId: org.organization.id, status: 'pending' })).total, 2)
    assert.equal(await service.deleteInvitation(created[0]!.id), true)
    assert.equal((await service.listInvitations({ orgId: org.organization.id })).total, 1)
    db.close()
  })

  void test('maps approval, lock, disable, and roles without promoting legacy ADMIN', async () => {
    const { db, authDb, service, unified } = setup()
    const org = await service.createOrganization(
      { name: '企业 A', code: 'ENT-A' }, onlineCommandContext('create-org-a'),
    )
    const user = await unified.createUser({
      orgId: org.organization.id, username: '13800000000', password: 'StrongPass123',
      role: 'user', status: 'pending', phone: '13800000000',
    }, onlineCommandContext('create-user-a'))

    await service.setUserStatus(user.userId, 'active')
    await service.setUserRole(user.userId, 'admin')
    assert.equal((await authDb.getUserById(user.userId))?.status, 'active')
    assert.equal((await authDb.getUserById(user.userId))?.role, 'admin')
    await service.setUserStatus(user.userId, 'locked')
    assert.equal((await authDb.getUserById(user.userId))?.status, 'locked')
    await service.setUserStatus(user.userId, 'disabled')
    assert.equal((await authDb.getUserById(user.userId))?.status, 'disabled')
    assert.throws(
      () => service.mapLegacyRole('ADMIN'),
      (error: unknown) => error instanceof IdentityDomainError && error.code === 'ROLE_CONFLICT',
    )
    db.close()
  })

  void test('rolls back organization creation when a compatibility code conflicts', async () => {
    const { db, authDb, service } = setup()
    await service.createOrganization(
      { name: '企业 A', code: 'ENT-A' }, onlineCommandContext('create-org-a'),
    )
    await assert.rejects(service.createOrganization(
      { name: '企业 B', code: 'ENT-A' }, onlineCommandContext('create-org-b'),
    ), /UNIQUE constraint failed/)
    assert.equal(await authDb.getOrganizationByName('企业 B'), null)
    db.close()
  })

  void test('enforces super-admin and organization-admin boundaries in the domain service', async () => {
    const { db, service } = setup()
    const first = await service.createOrganization(
      { name: '企业 A', code: 'ENT-A' }, onlineCommandContext('create-org-a'),
    )
    const second = await service.createOrganization(
      { name: '企业 B', code: 'ENT-B' }, onlineCommandContext('create-org-b'),
    )
    const superAdmin = { userId: 'root', orgId: first.organization.id, role: 'super_admin' }
    const orgAdmin = { userId: 'admin-a', orgId: first.organization.id, role: 'admin' }
    const member = { userId: 'user-a', orgId: first.organization.id, role: 'user' }

    assert.equal((await service.listOrganizations(orgAdmin)).length, 1)
    assert.equal((await service.listOrganizations(orgAdmin))[0]?.organization.id, first.organization.id)
    assert.equal((await service.listOrganizations(superAdmin)).length, 2)
    await assert.rejects(
      service.updateOrganization(second.organization.id, { name: '越权' }, orgAdmin),
      (error: unknown) => error instanceof IdentityDomainError && error.code === 'FORBIDDEN',
    )
    await assert.rejects(
      service.createInvitations({ orgId: first.organization.id, count: 1 }, undefined, member),
      (error: unknown) => error instanceof IdentityDomainError && error.code === 'FORBIDDEN',
    )
    db.close()
  })

  void test('creates, filters, updates, and atomically moves unified users', async () => {
    const { db, authDb, service } = setup()
    const first = await service.createOrganization(
      { name: '企业 A', code: 'ENT-A' }, onlineCommandContext('create-org-a'),
    )
    const second = await service.createOrganization(
      { name: '企业 B', code: 'ENT-B' }, onlineCommandContext('create-org-b'),
    )
    const actor = { userId: 'root', orgId: first.organization.id, role: 'super_admin' }
    const [invitation] = await service.createInvitations({
      orgId: first.organization.id, count: 1,
    }, () => 'USER-CODE', actor)
    const created = await service.createUser({
      orgId: first.organization.id,
      username: '13800000000',
      displayName: '测试用户',
      password: 'StrongPass123',
      invitationCode: invitation!.code,
    }, onlineCommandContext('admin-create-user'), actor)

    assert.equal((await service.listUsers(actor, { keyword: '测试' })).length, 1)
    await service.updateUser(created.userId, {
      displayName: '新昵称', role: 'admin', status: 'locked', orgId: second.organization.id,
    }, actor)
    const updated = await authDb.getUserById(created.userId)
    assert.equal(updated?.displayName, '新昵称')
    assert.equal(updated?.role, 'admin')
    assert.equal(updated?.status, 'locked')
    assert.equal(updated?.orgId, second.organization.id)
    assert.equal((await service.listUsers({ userId: 'admin-b', orgId: second.organization.id, role: 'admin' })).length, 1)
    await service.resetUserPassword(created.userId, 'AnotherPass456', actor)
    assert.equal(verifyPassword('AnotherPass456', (await authDb.getUserById(created.userId))?.passwordHash), true)
    db.close()
  })

  void test('deletes users and empty organizations without orphaning identity records', async () => {
    const { db, authDb, repository, service } = setup()
    const first = await service.createOrganization(
      { name: '企业 A', code: 'ENT-A' }, onlineCommandContext('create-org-a'),
    )
    const second = await service.createOrganization(
      { name: '企业 B', code: 'ENT-B' }, onlineCommandContext('create-org-b'),
    )
    const actor = { userId: 'root', orgId: first.organization.id, role: 'super_admin' }
    const created = await service.createUser({
      orgId: first.organization.id, username: 'user-a', password: 'StrongPass123', phone: '13800000000',
    }, onlineCommandContext('create-user-a'), actor)

    await assert.rejects(
      service.deleteOrganization(first.organization.id, actor),
      (error: unknown) => error instanceof IdentityDomainError && error.code === 'ORGANIZATION_NOT_EMPTY',
    )
    await service.deleteUser(created.userId, actor)
    assert.equal(await authDb.getUserById(created.userId), null)
    assert.equal(await repository.getNumericAlias('user', created.userId), null)
    assert.equal(await repository.findAuthIdentity('phone', 'sudowork', '13800000000'), null)
    await service.deleteOrganization(first.organization.id, actor)
    await service.deleteOrganization(second.organization.id, actor)
    assert.equal(await authDb.getOrganization(first.organization.id), null)
    assert.equal(await repository.getOrganizationProfile(second.organization.id), null)
    db.close()
  })
})
