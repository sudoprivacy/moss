import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { onlineCommandContext } from '../../../application/commandContext.js'
import { AuthCenterDb } from '../../../authCenter/db.js'
import { IdentityRepository } from '../../../identity/identityRepository.js'
import { OrganizationIdentityService } from '../../../identity/organizationIdentityService.js'
import { UnifiedIdentityService } from '../../../identity/unifiedIdentityService.js'
import { ensureBillingSchema } from '../../../billing/billingSchema.js'
import { BillingRepository } from '../../../billing/billingRepository.js'
import { SudoworkAdministrationService } from './adminService.js'

function setup(options: { defaultInitialQuota?: number } = {}) {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  const identities = new IdentityRepository(db)
  ensureBillingSchema(db)
  const unified = new UnifiedIdentityService(db, authDb, identities)
  const organizations = new OrganizationIdentityService(db, authDb, identities, unified)
  const service = new SudoworkAdministrationService(organizations, identities, authDb, {
    getDifyFeatureFlags: () => ({ enabled: true, missingEnv: [] }),
    defaultInitialQuota: options.defaultInitialQuota,
  })
  const first = organizations.createOrganization({
    name: '企业 A', code: 'ENT-A', initialCreditUnits: 10_000, appName: '应用 A',
  }, onlineCommandContext('org-a'))
  const second = organizations.createOrganization({
    name: '企业 B', code: 'ENT-B', initialCreditUnits: 20_000,
  }, onlineCommandContext('org-b'))
  return { db, authDb, identities, service, organizations, first, second }
}

function createUser(
  context: ReturnType<typeof setup>,
  input: { id: string; legacyId: number; orgId: string; name: string; status?: 'pending' | 'active' | 'disabled'; role?: string; balance?: number },
): void {
  context.authDb.createUser({
    id: input.id,
    orgId: input.orgId,
    email: `${input.name}@example.test`,
    name: input.name,
    displayName: input.name,
    departmentId: null,
    role: input.role ?? 'user',
    status: input.status ?? 'active',
    localAuth: true,
    tokenLimit: null,
    createdAt: input.legacyId,
    passwordHash: null,
    passwordUpdatedAt: null,
    lastLoginAt: null,
    extUserId: null,
  })
  context.identities.assignNumericAlias({
    namespace: 'user', legacyId: input.legacyId, resourceId: input.id, orgId: input.orgId,
  })
  context.identities.createWallet('user', input.id, input.balance ?? 0)
}

describe('Sudowork administration compatibility service', () => {
  test('默认生成旧客户端兼容的 6 位无歧义邀请码', () => {
    const { db, service, first } = setup()
    const actor = { userId: 'root', orgId: first.organization.id, role: 'super_admin' }
    const created = service.createInvitationCodes({ actor, count: 20 })

    assert.equal(created.codes.length, 20)
    assert.equal(new Set(created.codes).size, 20)
    for (const code of created.codes) {
      assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
    }
    db.close()
  })

  test('projects organizations through stable legacy ids and admin scope', () => {
    const { db, service, first, identities } = setup()
    const actor = { userId: 'admin-a', orgId: first.organization.id, role: 'admin' }
    assert.deepEqual(service.listEnterprises(actor), [{
      id: first.legacyEnterpriseId,
      name: '企业 A',
      code: 'ENT-A',
      credit_pool: 10_000,
      logo: null,
      app_name: '应用 A',
      top_name: null,
      about_name: null,
      app_company_name: null,
      login_desp: null,
      userCount: 0,
    }])
    db.close()
  })

  test('creates and lists legacy invitation DTOs without introducing legacy tables', () => {
    const { db, service, first } = setup()
    const actor = { userId: 'root', orgId: first.organization.id, role: 'super_admin' }
    const generated = ['FIRST-CODE', 'SECOND-CODE']
    const created = service.createInvitationCodes({
      actor, enterpriseId: first.legacyEnterpriseId, count: 2, initialQuotaUsd: 12.5,
    }, () => generated.shift()!)
    assert.deepEqual(created.codes, ['FIRST-CODE', 'SECOND-CODE'])

    const listed = service.listInvitationCodes({
      actor, enterpriseId: first.legacyEnterpriseId, status: 0, page: 1, pageSize: 20,
    })
    assert.equal(listed.total, 2)
    assert.equal(listed.items[0]?.enterprise_id, first.legacyEnterpriseId)
    assert.equal(listed.items[0]?.status, 0)
    assert.equal(typeof listed.items[0]?.id, 'number')
    assert.equal(service.deleteInvitationCode(actor, listed.items[0]!.id), true)
    db.close()
  })

  test('defaults invitation creation to the Moss actor organization', () => {
    const { db, service, first, identities } = setup()
    const actor = { userId: 'admin-a', orgId: first.organization.id, role: 'admin' }

    const created = service.createInvitationCodes({
      actor, count: 1, initialQuotaUsd: 6,
    }, () => 'MOSS-ORG-CODE')

    assert.deepEqual(created, { codes: ['MOSS-ORG-CODE'], count: 1 })
    const invitation = service.listInvitationCodes({ actor }).items[0]
    assert.equal(invitation?.enterprise_id, first.legacyEnterpriseId)
    assert.equal(invitation?.initial_quota_usd, 6)
    const resourceId = identities.resolveNumericAliasGlobal('invitation', invitation!.id)!.resourceId
    const stored = identities.getInvitationById(resourceId)!
    assert.equal(stored.initialCreditUnits, 6_000)
    assert.equal(stored.legacyInitialQuotaUsd, 6)
    db.close()
  })

  test('Moss 组织作用域下的超级管理员只读取当前组织邀请码且不能跨组织删除', () => {
    const { db, service, first, second } = setup()
    const root = { userId: 'root', orgId: first.organization.id, role: 'super_admin' }
    service.createInvitationCodes({
      actor: root, enterpriseId: first.legacyEnterpriseId, count: 1,
    }, () => 'FIRST-ORG')
    service.createInvitationCodes({
      actor: root, enterpriseId: second.legacyEnterpriseId, count: 1,
    }, () => 'SECOND-ORG')

    assert.equal(service.listInvitationCodes({ actor: root }).total, 2)
    const scopedRoot = {
      ...root,
      orgId: second.organization.id,
      organizationScoped: true,
    } as typeof root & { organizationScoped: true }
    const scoped = service.listInvitationCodes({ actor: scopedRoot })

    assert.deepEqual(scoped.items.map(item => item.code), ['SECOND-ORG'])
    const firstInvitation = service.listInvitationCodes({
      actor: root, enterpriseId: first.legacyEnterpriseId,
    }).items[0]!
    assert.throws(
      () => service.deleteInvitationCode(scopedRoot, firstInvitation.id),
      /Administrator permission required for this organization/,
    )
    db.close()
  })

  test('preserves null legacy quota while applying the configured Sudorouter default', () => {
    const { db, service, first, identities } = setup({ defaultInitialQuota: 500_000 })
    const actor = { userId: 'admin-a', orgId: first.organization.id, role: 'admin' }

    service.createInvitationCodes({ actor, count: 1, initialQuotaUsd: null }, () => 'DEFAULT-CODE')

    const invitation = service.listInvitationCodes({ actor }).items[0]!
    const resourceId = identities.resolveNumericAliasGlobal('invitation', invitation.id)!.resourceId
    const stored = identities.getInvitationById(resourceId)!
    assert.equal(invitation.initial_quota_usd, null)
    assert.equal(stored.initialCreditUnits, 1_000)
    assert.equal(stored.legacyInitialQuotaUsd, null)
    db.close()
  })

  test('creates and manages users through canonical identity commands', () => {
    const { db, service, first } = setup()
    const actor = { userId: 'root', orgId: first.organization.id, role: 'super_admin' }
    service.createInvitationCodes({ actor, enterpriseId: first.legacyEnterpriseId, count: 1 }, () => 'USER-CODE')
    const invitation = service.listInvitationCodes({ actor, enterpriseId: first.legacyEnterpriseId }).items[0]!
    const created = service.createPasswordUser({
      actor,
      phone: 'new-user',
      nickname: '新用户',
      password: 'StrongPass123',
      enterpriseId: first.legacyEnterpriseId,
      invitationCodeId: invitation.id,
      idempotencyKey: 'legacy-admin-create-user',
    })
    assert.equal(typeof created.id, 'number')
    assert.equal(created.initial_points, 200)

    const users = service.listUsers({ actor, enterpriseId: first.legacyEnterpriseId })
    assert.equal(users.length, 1)
    assert.equal(users[0]?.phone, 'new-user')
    assert.equal(users[0]?.enterprise_name, '企业 A')
    service.updateUser({ actor, userId: created.id, nickname: '已更新', status: 2 })
    service.setUserRole({ actor, userId: created.id, role: 'ENTERPRISE_ADMIN' })
    assert.equal(service.listUsers({ actor })[0]?.nickname, '已更新')
    assert.equal(service.listUsers({ actor })[0]?.status, 2)
    assert.equal(service.listUsers({ actor })[0]?.role, 'ENTERPRISE_ADMIN')
    service.deleteUser(actor, created.id)
    assert.equal(service.listUsers({ actor }).length, 0)
    db.close()
  })

  test('成员列表与统计按企业管理员组织隔离，超级管理员可见全局', () => {
    const context = setup()
    createUser(context, { id: 'pending-a', legacyId: 11, orgId: context.first.organization.id, name: 'a', status: 'pending', balance: 5 })
    createUser(context, { id: 'active-b', legacyId: 12, orgId: context.second.organization.id, name: 'b', status: 'active', balance: 9 })
    const admin = { userId: 'admin-a', orgId: context.first.organization.id, role: 'admin' }
    const root = { userId: 'root', orgId: context.first.organization.id, role: 'super_admin' }

    assert.deepEqual(serviceIds(context.service.listMembers(admin)), [11])
    assert.deepEqual(serviceIds(context.service.listMembers(root)), [11, 12])
    assert.deepEqual(context.service.getAdminStats(admin), {
      enterprises: 1,
      users: 1,
      approved: 0,
      pending: 1,
      points: { total: 5, bonus: 0, consumed: 0 },
    })
    assert.equal((context.service.getAdminStats(root) as any).enterprises, 2)
    const scopedRoot = {
      ...root,
      orgId: context.second.organization.id,
      organizationScoped: true,
    }
    assert.deepEqual(serviceIds(context.service.listMembers(scopedRoot)), [12])
    assert.deepEqual(context.service.getAdminStats(scopedRoot), {
      enterprises: 1,
      users: 1,
      approved: 1,
      pending: 0,
      points: { total: 9, bonus: 0, consumed: 0 },
    })
    assert.deepEqual(context.service.getFeatureFlags(admin), { dify: { enabled: true, missingEnv: [] } })
    context.db.close()
  })

  test('Moss 组织作用域下的超级管理员只能查询当前组织审计并操作当前组织成员', () => {
    const context = setup()
    createUser(context, { id: 'pending-a', legacyId: 41, orgId: context.first.organization.id, name: 'a', status: 'pending' })
    createUser(context, { id: 'pending-b', legacyId: 42, orgId: context.second.organization.id, name: 'b', status: 'pending' })
    for (const [id, orgId] of [['audit-a', context.first.organization.id], ['audit-b', context.second.organization.id]]) {
      context.identities.insertOperationAudit({
        id,
        orgId,
        action: 'TEST_ACTION',
        resource: 'user',
        idempotencyKey: id,
      })
    }
    const scopedRoot = {
      userId: 'root',
      orgId: context.second.organization.id,
      role: 'super_admin',
      organizationScoped: true,
    }

    assert.equal(context.service.listOperationLogs({ actor: scopedRoot, query: {} }).total, 1)
    assert.throws(
      () => context.service.rejectUser({ actor: scopedRoot, legacyUserId: 41 }),
      /无权操作该用户/,
    )
    assert.doesNotThrow(
      () => context.service.rejectUser({ actor: scopedRoot, legacyUserId: 42 }),
    )
    context.db.close()
  })

  test('审批通过原子激活并只赠送一次积分，拒绝写统一审计且隔离其他组织', () => {
    const context = setup()
    createUser(context, { id: 'pending-a', legacyId: 21, orgId: context.first.organization.id, name: 'pending-a', status: 'pending' })
    createUser(context, { id: 'pending-b', legacyId: 22, orgId: context.second.organization.id, name: 'pending-b', status: 'pending' })
    createUser(context, { id: 'reject-a', legacyId: 23, orgId: context.first.organization.id, name: 'reject-a', status: 'pending' })
    const admin = { userId: 'admin-a', orgId: context.first.organization.id, role: 'admin' }

    context.service.approveUser({ actor: admin, legacyUserId: 21, idempotencyKey: 'approve-21' })
    context.service.approveUser({ actor: admin, legacyUserId: 21, idempotencyKey: 'approve-21' })
    assert.equal(context.authDb.getUserById('pending-a')?.status, 'active')
    assert.equal(context.identities.getWallet('user', 'pending-a')?.balanceUnits, 100)
    assert.equal(new BillingRepository(context.db).listLedgerEntries({ userId: 'pending-a', entryType: 'BONUS', limit: 20, offset: 0 }).total, 1)

    assert.throws(
      () => context.service.rejectUser({ actor: admin, legacyUserId: 22, idempotencyKey: 'reject-22' }),
      /无权操作该用户/,
    )
    context.service.rejectUser({ actor: admin, legacyUserId: 23, idempotencyKey: 'reject-23' })
    assert.equal(context.authDb.getUserById('reject-a')?.status, 'disabled')
    assert.equal(context.service.listOperationLogs({ actor: admin, query: { action: 'USER_REJECT' } }).total, 1)
    context.db.close()
  })

  test('兼容删除只清理同组织待审批用户并保留审计', () => {
    const context = setup()
    createUser(context, { id: 'pending-a', legacyId: 31, orgId: context.first.organization.id, name: 'pending-a', status: 'pending' })
    createUser(context, { id: 'active-a', legacyId: 32, orgId: context.first.organization.id, name: 'active-a', status: 'active' })
    const admin = { userId: 'admin-a', orgId: context.first.organization.id, role: 'admin' }

    assert.throws(
      () => context.service.deletePendingUser({ actor: admin, legacyUserId: 32, idempotencyKey: 'delete-active' }),
      /只能删除待审批用户/,
    )
    context.service.deletePendingUser({ actor: admin, legacyUserId: 31, idempotencyKey: 'delete-pending' })
    assert.equal(context.authDb.getUserById('pending-a'), null)
    const logs = context.service.listOperationLogs({ actor: admin, query: { page: '1', page_size: '10' } })
    assert.equal(logs.total, 1)
    assert.equal(logs.items[0]?.action, 'USER_DELETE')
    context.db.close()
  })

  test('历史操作日志保留旧接口的完整字段和 JSON 原文', () => {
    const context = setup()
    context.identities.insertOperationAudit({
      id: 'legacy-operation-77',
      legacyId: 77,
      orgId: context.first.organization.id,
      actorName: '13800000000',
      action: 'LEGACY_ACTION',
      resource: 'user',
      resourceId: '17',
      method: 'POST',
      path: '/api/v1/example',
      legacyParamsRaw: '{"page": 1}',
      legacyRequestDataRaw: '{"b":2, "a":1}',
      legacyResponseDataRaw: 'not-json',
      responseStatus: 201,
      ipAddress: '127.0.0.1',
      userAgent: 'Sudowork/1.0',
      durationMs: 12,
      idempotencyKey: 'migration:operation:77',
      createdAt: 1_700_000_000_000,
    })

    const item = context.service.listOperationLogs({
      actor: { userId: 'root', orgId: context.first.organization.id, role: 'super_admin' },
      query: {},
    }).items[0]
    assert.deepEqual(item, {
      id: 77,
      user_id: null,
      user_phone: '13800000000',
      action: 'LEGACY_ACTION',
      resource: 'user',
      resource_id: 17,
      method: 'POST',
      path: '/api/v1/example',
      params: '{"page": 1}',
      request_data: '{"b":2, "a":1}',
      response_data: 'not-json',
      response_status: 201,
      ip_address: '127.0.0.1',
      user_agent: 'Sudowork/1.0',
      duration_ms: 12,
      error_message: null,
      created_at: new Date(1_700_000_000_000).toISOString(),
    })
    context.db.close()
  })
})

function serviceIds(users: Array<{ id: number }>): number[] {
  return users.map(user => user.id).sort((left, right) => left - right)
}
