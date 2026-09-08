import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { onlineCommandContext } from '../application/commandContext.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { verifyPassword } from '../authCenter/db.js'
import { IdentityRepository } from './identityRepository.js'
import {
  IdentityDomainError,
  OrganizationIdentityService,
} from './organizationIdentityService.js'
import { UnifiedIdentityService } from './unifiedIdentityService.js'

function setup() {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  const repository = new IdentityRepository(db)
  const unified = new UnifiedIdentityService(db, authDb, repository)
  const service = new OrganizationIdentityService(db, authDb, repository, unified)
  return { db, authDb, repository, unified, service }
}

describe('organization identity service', () => {
  test('creates and updates a canonical organization with its compatibility profile', () => {
    const { db, service } = setup()
    const created = service.createOrganization({
      name: '企业 A', code: 'ENT-A', loginMethod: 'sms', localEnabled: true,
      cloudEnabled: false, appName: 'Sudowork A', initialCreditUnits: 100,
    }, onlineCommandContext('create-org-a'))

    assert.equal(created.profile.code, 'ENT-A')
    assert.equal(created.profile.loginMethod, 'sms')
    assert.equal(created.wallet.balanceUnits, 100)
    assert.equal(service.listOrganizations()[0]?.userCount, 0)

    const updated = service.updateOrganization(created.organization.id, {
      name: '企业 A+', cloudEnabled: true, logo: '/uploads/a.png',
    })
    assert.equal(updated.organization.name, '企业 A+')
    assert.equal(updated.profile.cloudEnabled, true)
    assert.equal(updated.profile.logo, '/uploads/a.png')
    db.close()
  })

  test('creates, filters, and removes invitations in one organization', () => {
    const { db, service } = setup()
    const org = service.createOrganization(
      { name: '企业 A', code: 'ENT-A' }, onlineCommandContext('create-org-a'),
    )
    const codes = ['CODE-A', 'CODE-B']
    const created = service.createInvitations({
      orgId: org.organization.id, count: 2, initialCreditUnits: 50,
    }, () => codes.shift()!)

    assert.deepEqual(created.map((item) => item.code), ['CODE-A', 'CODE-B'])
    assert.equal(service.listInvitations({ orgId: org.organization.id, status: 'pending' }).total, 2)
    assert.equal(service.deleteInvitation(created[0]!.id), true)
    assert.equal(service.listInvitations({ orgId: org.organization.id }).total, 1)
    db.close()
  })

  test('maps approval, lock, disable, and roles without promoting legacy ADMIN', () => {
    const { db, authDb, service, unified } = setup()
    const org = service.createOrganization(
      { name: '企业 A', code: 'ENT-A' }, onlineCommandContext('create-org-a'),
    )
    const user = unified.createUser({
      orgId: org.organization.id, username: '13800000000', password: 'StrongPass123',
      role: 'user', status: 'pending', phone: '13800000000',
    }, onlineCommandContext('create-user-a'))

    service.setUserStatus(user.userId, 'active')
    service.setUserRole(user.userId, 'admin')
    assert.equal(authDb.getUserById(user.userId)?.status, 'active')
    assert.equal(authDb.getUserById(user.userId)?.role, 'admin')
    service.setUserStatus(user.userId, 'locked')
    assert.equal(authDb.getUserById(user.userId)?.status, 'locked')
    service.setUserStatus(user.userId, 'disabled')
    assert.equal(authDb.getUserById(user.userId)?.status, 'disabled')
    assert.throws(
      () => service.mapLegacyRole('ADMIN'),
      (error: unknown) => error instanceof IdentityDomainError && error.code === 'ROLE_CONFLICT',
    )
    db.close()
  })

  test('rolls back organization creation when a compatibility code conflicts', () => {
    const { db, authDb, service } = setup()
    service.createOrganization(
      { name: '企业 A', code: 'ENT-A' }, onlineCommandContext('create-org-a'),
    )
    assert.throws(() => service.createOrganization(
      { name: '企业 B', code: 'ENT-A' }, onlineCommandContext('create-org-b'),
    ), /UNIQUE constraint failed/)
    assert.equal(authDb.getOrganizationByName('企业 B'), null)
    db.close()
  })

  test('enforces super-admin and organization-admin boundaries in the domain service', () => {
    const { db, service } = setup()
    const first = service.createOrganization(
      { name: '企业 A', code: 'ENT-A' }, onlineCommandContext('create-org-a'),
    )
    const second = service.createOrganization(
      { name: '企业 B', code: 'ENT-B' }, onlineCommandContext('create-org-b'),
    )
    const superAdmin = { userId: 'root', orgId: first.organization.id, role: 'super_admin' }
    const orgAdmin = { userId: 'admin-a', orgId: first.organization.id, role: 'admin' }
    const member = { userId: 'user-a', orgId: first.organization.id, role: 'user' }

    assert.equal(service.listOrganizations(orgAdmin).length, 1)
    assert.equal(service.listOrganizations(orgAdmin)[0]?.organization.id, first.organization.id)
    assert.equal(service.listOrganizations(superAdmin).length, 2)
    assert.throws(
      () => service.updateOrganization(second.organization.id, { name: '越权' }, orgAdmin),
      (error: unknown) => error instanceof IdentityDomainError && error.code === 'FORBIDDEN',
    )
    assert.throws(
      () => service.createInvitations({ orgId: first.organization.id, count: 1 }, undefined, member),
      (error: unknown) => error instanceof IdentityDomainError && error.code === 'FORBIDDEN',
    )
    db.close()
  })

  test('creates, filters, updates, and atomically moves unified users', () => {
    const { db, authDb, service } = setup()
    const first = service.createOrganization(
      { name: '企业 A', code: 'ENT-A' }, onlineCommandContext('create-org-a'),
    )
    const second = service.createOrganization(
      { name: '企业 B', code: 'ENT-B' }, onlineCommandContext('create-org-b'),
    )
    const actor = { userId: 'root', orgId: first.organization.id, role: 'super_admin' }
    const [invitation] = service.createInvitations({
      orgId: first.organization.id, count: 1,
    }, () => 'USER-CODE', actor)
    const created = service.createUser({
      orgId: first.organization.id,
      username: '13800000000',
      displayName: '测试用户',
      password: 'StrongPass123',
      invitationCode: invitation!.code,
    }, onlineCommandContext('admin-create-user'), actor)

    assert.equal(service.listUsers(actor, { keyword: '测试' }).length, 1)
    service.updateUser(created.userId, {
      displayName: '新昵称', role: 'admin', status: 'locked', orgId: second.organization.id,
    }, actor)
    const updated = authDb.getUserById(created.userId)
    assert.equal(updated?.displayName, '新昵称')
    assert.equal(updated?.role, 'admin')
    assert.equal(updated?.status, 'locked')
    assert.equal(updated?.orgId, second.organization.id)
    assert.equal(service.listUsers({ userId: 'admin-b', orgId: second.organization.id, role: 'admin' }).length, 1)
    service.resetUserPassword(created.userId, 'AnotherPass456', actor)
    assert.equal(verifyPassword('AnotherPass456', authDb.getUserById(created.userId)?.passwordHash), true)
    db.close()
  })

  test('deletes users and empty organizations without orphaning identity records', () => {
    const { db, authDb, repository, service } = setup()
    const first = service.createOrganization(
      { name: '企业 A', code: 'ENT-A' }, onlineCommandContext('create-org-a'),
    )
    const second = service.createOrganization(
      { name: '企业 B', code: 'ENT-B' }, onlineCommandContext('create-org-b'),
    )
    const actor = { userId: 'root', orgId: first.organization.id, role: 'super_admin' }
    const created = service.createUser({
      orgId: first.organization.id, username: 'user-a', password: 'StrongPass123', phone: '13800000000',
    }, onlineCommandContext('create-user-a'), actor)

    assert.throws(
      () => service.deleteOrganization(first.organization.id, actor),
      (error: unknown) => error instanceof IdentityDomainError && error.code === 'ORGANIZATION_NOT_EMPTY',
    )
    service.deleteUser(created.userId, actor)
    assert.equal(authDb.getUserById(created.userId), null)
    assert.equal(repository.getNumericAlias('user', created.userId), null)
    assert.equal(repository.findAuthIdentity('phone', 'sudowork', '13800000000'), null)
    service.deleteOrganization(first.organization.id, actor)
    service.deleteOrganization(second.organization.id, actor)
    assert.equal(authDb.getOrganization(first.organization.id), null)
    assert.equal(repository.getOrganizationProfile(second.organization.id), null)
    db.close()
  })
})
