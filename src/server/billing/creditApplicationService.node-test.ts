import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { onlineCommandContext } from '../application/commandContext.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { BillingCoordinator } from './billingCoordinator.js'
import { BillingRepository } from './billingRepository.js'
import { ensureBillingSchema } from './billingSchema.js'
import { CreditApplicationService } from './creditApplicationService.js'
import type { QuotaSnapshot, SudorouterPort } from './sudorouterAdapter.js'
import { BillingDomainError } from './types.js'
import { WalletService } from './walletService.js'

class FakeSudorouter implements SudorouterPort {
  quota = 0
  changeCalls = 0
  fail = false
  async getUser(externalUserId: string): Promise<QuotaSnapshot> {
    return { externalUserId, quotaUnits: this.quota, usedQuotaUnits: 0 }
  }
  async changeQuota(input: { deltaUnits: number }): Promise<{ success: boolean; error?: string }> {
    this.changeCalls += 1
    if (this.fail) return { success: false, error: 'router failed' }
    this.quota += input.deltaUnits
    return { success: true }
  }
}

function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const auth = new AuthCenterDb(db)
  const identities = new IdentityRepository(db)
  auth.createOrganization('org1', 'Org 1', 1)
  auth.createOrganization('org2', 'Org 2', 1)
  for (const [id, orgId, role] of [
    ['u1', 'org1', 'user'], ['admin1', 'org1', 'admin'],
    ['admin2', 'org2', 'admin'], ['root', 'org1', 'super_admin'],
  ] as const) {
    auth.createUser({
      id, orgId, email: `${id}@example.test`, name: id, displayName: null,
      departmentId: null, role, status: 'active', localAuth: true, tokenLimit: null,
      createdAt: 1, passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null,
    })
    identities.createWallet('user', id, 0)
  }
  ensureBillingSchema(db)
  const repository = new BillingRepository(db)
  repository.upsertExternalAccount({
    provider: 'sudorouter', ownerType: 'user', ownerId: 'u1', externalAccountId: '9',
    quotaUnits: 0, usedQuotaUnits: 0, updatedAt: 1,
  })
  const fake = new FakeSudorouter()
  const wallet = new WalletService(db, repository, () => 100)
  const coordinator = new BillingCoordinator(db, repository, wallet, fake, {
    clock: () => 100, idGenerator: () => 'quota-operation-1',
  })
  let sequence = 0
  const service = new CreditApplicationService(db, repository, identities, coordinator, {
    getPolicy: () => ({ rechargeMode: 'approve', minPoints: 200, maxPoints: 2_000, allowDuplicatePending: false }),
  }, { clock: () => 100, idGenerator: () => `application-${++sequence}`, suffixGenerator: () => 'ABC123' })
  return { db, identities, repository, fake, service }
}

describe('CreditApplicationService', () => {
  test('创建申请分配永久数字别名并阻止重复待审批', () => {
    const { db, identities, service } = setup()
    const actor = { userId: 'u1', orgId: 'org1', role: 'user' as const }
    const created = service.createApplication({ requestedPoints: 500, reason: '项目需要' }, actor, onlineCommandContext('apply-1'))

    assert.equal(created.applicationNo, 'CA100ABC123')
    assert(created.legacyId >= 2_000_000_000)
    assert.equal(identities.resolveNumericAlias('credit_application', created.legacyId, 'org1'), created.id)
    assert.throws(() => service.createApplication(
      { requestedPoints: 600, reason: '再次申请' }, actor, onlineCommandContext('apply-2'),
    ), (error: unknown) => error instanceof BillingDomainError && error.code === 'DUPLICATE_PENDING_APPLICATION')
    db.close()
  })

  test('企业管理员不能审批其他组织，超级管理员审批重复调用只发放一次', async () => {
    const { db, repository, fake, service } = setup()
    const application = service.createApplication(
      { requestedPoints: 500, reason: '项目需要' },
      { userId: 'u1', orgId: 'org1', role: 'user' },
      onlineCommandContext('apply-1'),
    )
    await assert.rejects(() => service.approveApplication({
      applicationId: application.id, approvedPoints: 400, adminComment: '跨组织',
    }, { userId: 'admin2', orgId: 'org2', role: 'admin' }, onlineCommandContext('approve-other')),
    (error: unknown) => error instanceof BillingDomainError && error.code === 'CREDIT_FORBIDDEN')

    const context = onlineCommandContext('approve-1')
    const first = await service.approveApplication({
      applicationId: application.id, approvedPoints: 400, adminComment: '同意',
    }, { userId: 'root', orgId: 'org1', role: 'super_admin' }, context)
    const replay = await service.approveApplication({
      applicationId: application.id, approvedPoints: 400, adminComment: '同意',
    }, { userId: 'root', orgId: 'org1', role: 'super_admin' }, context)

    assert.equal(first.status, 'APPROVED')
    assert.deepEqual(replay, first)
    assert.equal(fake.changeCalls, 1)
    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 400)
    assert.equal(repository.getCreditApplication(application.id)?.status, 'APPROVED')
    const activities = repository.listRechargeActivities({ activityType: 'ADMIN', limit: 20, offset: 0 })
    assert.equal(activities.total, 1)
    assert.equal(activities.list[0]?.sourceType, 'CREDIT_APPLICATION')
    assert.equal(activities.list[0]?.applicationId, application.id)
    db.close()
  })

  test('外部发放失败标记 SYNC_FAILED，显式重试成功且不重复申请记录', async () => {
    const { db, repository, fake, service } = setup()
    const application = service.createApplication(
      { requestedPoints: 300, reason: '测试失败' },
      { userId: 'u1', orgId: 'org1', role: 'user' },
      onlineCommandContext('apply-fail'),
    )
    fake.fail = true
    const failed = await service.approveApplication({ applicationId: application.id },
      { userId: 'admin1', orgId: 'org1', role: 'admin' }, onlineCommandContext('approve-fail'))
    assert.equal(failed.status, 'SYNC_FAILED')
    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 0)
    assert.equal(repository.countActivityRecords(), 0)

    fake.fail = false
    const recovered = await service.retryApplication(application.id,
      { userId: 'admin1', orgId: 'org1', role: 'admin' })
    assert.equal(recovered.status, 'APPROVED')
    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 300)
    assert.equal(fake.changeCalls, 2)
    assert.equal(repository.countActivityRecords(), 1)
    db.close()
  })

  test('拒绝申请必须有原因且只允许 PENDING', () => {
    const { db, repository, service } = setup()
    const application = service.createApplication(
      { requestedPoints: 300, reason: '不再需要' },
      { userId: 'u1', orgId: 'org1', role: 'user' }, onlineCommandContext('apply-reject'),
    )
    assert.throws(() => service.rejectApplication(application.id, '',
      { userId: 'admin1', orgId: 'org1', role: 'admin' }), /拒绝原因不能为空/)
    service.rejectApplication(application.id, '不符合规则',
      { userId: 'admin1', orgId: 'org1', role: 'admin' })
    assert.equal(repository.getCreditApplication(application.id)?.status, 'REJECTED')
    assert.throws(() => service.rejectApplication(application.id, '再次拒绝',
      { userId: 'admin1', orgId: 'org1', role: 'admin' }), /当前状态不可拒绝/)
    db.close()
  })
})
