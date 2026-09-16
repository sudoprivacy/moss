import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../../../authCenter/db.js'
import { BillingCoordinator } from '../../../billing/billingCoordinator.js'
import { BillingRepository } from '../../../billing/billingRepository.js'
import { ensureBillingSchema } from '../../../billing/billingSchema.js'
import { CreditApplicationService } from '../../../billing/creditApplicationService.js'
import { RechargeService } from '../../../billing/rechargeService.js'
import { RefundService } from '../../../billing/refundService.js'
import type { QuotaSnapshot, SudorouterPort } from '../../../billing/sudorouterAdapter.js'
import { WalletService } from '../../../billing/walletService.js'
import { IdentityRepository } from '../../../identity/identityRepository.js'
import { SudoworkBillingService, type BillingPaymentPort } from './billingService.js'

class FakeRouter implements SudorouterPort {
  quota = 0
  calls = 0
  async getUser(externalUserId: string): Promise<QuotaSnapshot> {
    return { externalUserId, quotaUnits: this.quota, usedQuotaUnits: 0 }
  }
  async changeQuota(input: { deltaUnits: number }): Promise<{ success: boolean }> {
    this.calls += 1
    this.quota += input.deltaUnits
    return { success: true }
  }
}

function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const auth = new AuthCenterDb(db)
  const identities = new IdentityRepository(db)
  auth.createOrganization('org-1', '企业一', 1)
  identities.putOrganizationProfile({
    orgId: 'org-1', code: 'ENT-1', loginMethod: 'password', localEnabled: true, cloudEnabled: true,
  })
  identities.assignNumericAlias({ namespace: 'enterprise', legacyId: 9, resourceId: 'org-1', orgId: 'org-1' })
  for (const [id, role] of [['user-1', 'user'], ['admin-1', 'admin'], ['root-1', 'super_admin']] as const) {
    auth.createUser({
      id, orgId: 'org-1', email: `${id}@example.test`, name: id,
      displayName: id === 'user-1' ? '新 Moss 用户' : id, departmentId: null, role,
      status: 'active', localAuth: true, tokenLimit: null, createdAt: 1,
      passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null,
    })
    identities.ensureWallet('user', id)
  }
  identities.assignNumericAlias({ namespace: 'user', legacyId: 17, resourceId: 'user-1', orgId: 'org-1' })
  identities.createAuthIdentity({
    id: 'phone-user-1', orgId: 'org-1', userId: 'user-1', provider: 'phone', issuer: 'sudowork',
    normalizedSubject: '13800000000', metadata: {},
  })
  ensureBillingSchema(db)
  const repository = new BillingRepository(db)
  repository.upsertExternalAccount({
    provider: 'sudorouter', ownerType: 'user', ownerId: 'user-1', externalAccountId: '91',
    quotaUnits: 0, usedQuotaUnits: 0, updatedAt: 1,
  })
  let now = Date.parse('2026-09-07T10:00:00.000Z')
  const wallet = new WalletService(db, repository, () => now)
  const router = new FakeRouter()
  const coordinator = new BillingCoordinator(db, repository, wallet, router, {
    clock: () => now, idGenerator: (() => { let id = 0; return () => `quota-${++id}` })(),
  })
  const recharge = new RechargeService(db, repository, {
    clock: () => now, idGenerator: (() => { let id = 0; return () => `order-${++id}` })(),
    suffixGenerator: () => 'ABC123',
    numericAliasAllocator: (id, orgId) => identities.allocateNumericAlias('billing_order', id, orgId),
  })
  const credit = new CreditApplicationService(db, repository, identities, coordinator, {
    getPolicy: () => ({ rechargeMode: 'approve', minPoints: 1, maxPoints: 100_000, allowDuplicatePending: false }),
  }, { clock: () => now, idGenerator: () => 'credit-1', suffixGenerator: () => 'ABC123' })
  const refund = new RefundService(db, repository, identities, wallet, coordinator, {
    async refund(input) { return { success: true, providerRefundNo: input.refundNo } },
  }, { clock: () => now })
  const payment: BillingPaymentPort = {
    async createPayment(intent) { return { qrCodeUrl: 'https://pay.test/qr', orderInfo: `qr:${intent.orderNo}` } },
    async verifyCallback() { throw new Error('unused') },
    async queryPayment() { return { status: 'PENDING' } },
    simulationEnabled: false,
  }
  const service = new SudoworkBillingService({
    db, auth, identities, repository, wallet, recharge, coordinator, credit, refund, payment,
    clock: () => now,
  })
  return { db, auth, identities, repository, router, service, setNow(value: number) { now = value } }
}

const userActor = { userId: 'user-1', orgId: 'org-1', role: 'user' }
const adminActor = { userId: 'admin-1', orgId: 'org-1', role: 'admin' }

describe('SudoworkBillingService', () => {
  test('新 Moss 用户可立即创建并通过旧接口查询永久数字 ID 订单', () => {
    const { db, repository, service } = setup()
    const created = service.createOrder({
      actor: userActor, amount: 5, paymentMethod: 'ALIPAY', idempotencyKey: 'compat-create-1',
    }) as Record<string, unknown>

    assert.equal(created.order_no, 'USR17NO1788775200000ABC123')
    assert.equal(created.points, 5_500)
    assert.equal(repository.getOrderByOrderNo(String(created.order_no))?.legacyId, 2_000_000_000)
    assert.equal((service.queryOrder(userActor, String(created.order_no)) as any).status, 0)
    assert.equal((service.listUserOrders({ actor: userActor, page: 1, pageSize: 20 }) as any).total, 1)
    db.close()
  })

  test('管理员积分调整复用统一钱包与云端额度 Saga', async () => {
    const { db, repository, router, service } = setup()
    const result = await service.adjustUserPoints({
      actor: adminActor, legacyUserId: 17, amount: 100, operation: 'add',
      reason: '运营补发', syncSudorouter: true, idempotencyKey: 'compat-adjust-1',
    }) as any

    assert.equal(result.new_balance, 100)
    assert.equal(result.quota_delta, 50_000)
    assert.equal(repository.getWallet('user', 'user-1')?.balanceUnits, 100)
    assert.equal(router.quota, 50_000)
    assert.equal(router.calls, 1)
    assert.equal(repository.listRechargeActivities({ limit: 20, offset: 0 }).total, 0)
    db.close()
  })

  test('超级管理员充值写入统一管理员活动记录', async () => {
    const { db, repository, service } = setup()
    const rootActor = { userId: 'root-1', orgId: 'org-1', role: 'super_admin' }
    await service.rechargeUser({
      actor: rootActor, legacyUserId: 17, points: 100, reason: '运营充值',
      paymentReference: 'PAY-1', idempotencyKey: 'compat-recharge-1',
    })

    const activities = repository.listRechargeActivities({ limit: 20, offset: 0 })
    assert.equal(activities.total, 1)
    assert.equal(activities.list[0]?.activityType, 'ADMIN')
    assert.equal(activities.list[0]?.pointsUnits, 100)
    assert.equal(activities.list[0]?.paymentReference, 'PAY-1')
    db.close()
  })

  test('充值记录列表从统一活动模型返回旧字段和数字 ID', () => {
    const { db, repository, service } = setup()
    repository.insertActivityRecord({
      id: 'activity-client', legacyId: 8, activityType: 'CLIENT', userId: 'user-1', orgId: 'org-1',
      orderId: null, actorUserId: null, applicationId: null, pointsUnits: 1000, quotaUnits: 500000,
      amountCents: 730, paymentMethod: 'ALIPAY', reason: null, paymentReference: null,
      sourceType: 'CLIENT_RECHARGE', sourceId: 'ORDER-7', details: { orderNo: 'ORDER-7' },
      idempotencyKey: 'activity-client', createdAt: Date.parse('2026-09-07T09:00:00Z'),
      processedAt: Date.parse('2026-09-07T09:01:00Z'),
    })
    repository.insertActivityRecord({
      id: 'activity-admin', legacyId: 9, activityType: 'ADMIN', userId: 'user-1', orgId: 'org-1',
      orderId: null, actorUserId: 'admin-1', applicationId: null, pointsUnits: 20, quotaUnits: 10000,
      amountCents: null, paymentMethod: null, reason: '补发', paymentReference: 'R1',
      sourceType: 'ADMIN_MANUAL', sourceId: null, details: {}, idempotencyKey: 'activity-admin',
      createdAt: Date.parse('2026-09-07T10:00:00Z'), processedAt: Date.parse('2026-09-07T10:00:00Z'),
    })

    const result = service.listRechargeRecords({ actor: adminActor, query: {} }) as any
    assert.equal(result.total, 2)
    assert.deepEqual(result.list[0], {
      id: 9, type: 'ADMIN', order_no: null, user_phone: '13800000000', user_nickname: '新 Moss 用户',
      points: 20, quota: 10000, amount_cny: null, payment_method: null, admin_nickname: 'admin-1',
      reason: '补发', created_at: '2026-09-07 10:00:00', source: 'ADMIN_MANUAL',
      source_text: '后台手工充值', application_id: null, application_no: null,
      requested_points: null, approved_points: null, application_reason: null, admin_comment: null,
    })
    assert.equal(result.list[1].id, 8)
    assert.equal(result.list[1].order_no, 'ORDER-7')
    assert.equal(result.list[1].amount_cny, 7.3)
    assert.equal((service.listRechargeRecords({ actor: adminActor, query: { type: 'CLIENT' } }) as any).total, 1)
    assert.equal((service.listRechargeRecords({ actor: adminActor, query: { payment_method: 'WECHAT' } }) as any).total, 0)
    assert.equal((service.listRechargeRecords({ actor: adminActor, query: { keyword: '1380000' } }) as any).total, 2)
    db.close()
  })

  test('Moss 组织作用域下的超级管理员只能查看和操作当前组织计费数据', async () => {
    const context = setup()
    context.auth.createOrganization('org-2', '企业二', 2)
    context.identities.putOrganizationProfile({
      orgId: 'org-2', code: 'ENT-2', loginMethod: 'password', localEnabled: true, cloudEnabled: true,
    })
    context.identities.assignNumericAlias({ namespace: 'enterprise', legacyId: 10, resourceId: 'org-2', orgId: 'org-2' })
    context.auth.createUser({
      id: 'user-2', orgId: 'org-2', email: 'user-2@example.test', name: 'user-2',
      displayName: '企业二用户', departmentId: null, role: 'user', status: 'active', localAuth: true,
      tokenLimit: null, createdAt: 2, passwordHash: null, passwordUpdatedAt: null,
      lastLoginAt: null, extUserId: null,
    })
    context.identities.ensureWallet('user', 'user-2')
    context.identities.assignNumericAlias({ namespace: 'user', legacyId: 18, resourceId: 'user-2', orgId: 'org-2' })
    context.repository.upsertExternalAccount({
      provider: 'sudorouter', ownerType: 'user', ownerId: 'user-2', externalAccountId: '92',
      quotaUnits: 0, usedQuotaUnits: 0, updatedAt: 2,
    })
    const first = context.service.createOrder({
      actor: userActor, amount: 5, paymentMethod: 'ALIPAY', idempotencyKey: 'org-1-order',
    }) as Record<string, unknown>
    context.service.createOrder({
      actor: { userId: 'user-2', orgId: 'org-2', role: 'user' },
      amount: 8, paymentMethod: 'WECHAT', idempotencyKey: 'org-2-order',
    })
    const globalRoot = { userId: 'root-1', orgId: 'org-1', role: 'super_admin' }
    const scopedRoot = {
      ...globalRoot,
      orgId: 'org-2',
      organizationScoped: true,
    }

    assert.equal((context.service.listAdminOrders({ actor: globalRoot, query: {} }) as any).total, 2)
    assert.equal((context.service.listAdminOrders({ actor: scopedRoot, query: {} }) as any).total, 1)
    assert.equal((context.service.getRechargeStats(scopedRoot) as any).total.orders, 1)
    assert.throws(
      () => context.service.getAdminOrder(scopedRoot, String(first.order_no)),
      /权限不足/,
    )
    await assert.rejects(
      context.service.rechargeUser({
        actor: scopedRoot, legacyUserId: 17, points: 10, idempotencyKey: 'cross-org-recharge',
      }),
      /权限不足/,
    )
    context.db.close()
  })

  test('用户积分申请与管理员审批使用同一申请和钱包模型', async () => {
    const { db, repository, service } = setup()
    const application = service.createCreditApplication({
      actor: userActor, requestedPoints: 200, reason: '项目扩容', idempotencyKey: 'compat-credit-create',
    }) as any
    assert.equal(application.id, 2_000_000_000)
    assert.equal(application.status, 'PENDING')

    const scopedRoot = {
      userId: 'root-1', orgId: 'org-2', role: 'super_admin', organizationScoped: true,
    }
    assert.equal((service.listAdminCreditApplications({ actor: scopedRoot, query: {} }) as any).total, 0)
    await assert.rejects(
      service.approveCreditApplication({
        actor: scopedRoot,
        legacyApplicationId: application.id,
        approvedPoints: 180,
        idempotencyKey: 'cross-org-credit-approve',
      }),
      /权限不足/,
    )

    const approved = await service.approveCreditApplication({
      actor: adminActor, legacyApplicationId: application.id, approvedPoints: 180,
      adminComment: '通过', idempotencyKey: 'compat-credit-approve',
    }) as any
    assert.equal(approved.status, 'APPROVED')
    assert.equal(repository.getWallet('user', 'user-1')?.balanceUnits, 180)
    db.close()
  })
})
