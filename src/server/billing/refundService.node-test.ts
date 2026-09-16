import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { onlineCommandContext } from '../application/commandContext.js'
import { migrationCommandContext } from '../application/commandContext.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { BillingCoordinator } from './billingCoordinator.js'
import { BillingRepository } from './billingRepository.js'
import { ensureBillingSchema } from './billingSchema.js'
import type { QuotaSnapshot, SudorouterPort } from './sudorouterAdapter.js'
import { RefundService, type FuiouRefundPort } from './refundService.js'
import { WalletService } from './walletService.js'

class FakeSudorouter implements SudorouterPort {
  quota = 2_750_000
  async getUser(externalUserId: string): Promise<QuotaSnapshot> {
    return { externalUserId, quotaUnits: this.quota, usedQuotaUnits: 0 }
  }
  async changeQuota(input: { deltaUnits: number }): Promise<{ success: boolean }> {
    this.quota += input.deltaUnits
    return { success: true }
  }
}

class FakeFuiouRefund implements FuiouRefundPort {
  calls = 0
  async refund(input: { refundNo: string }): Promise<{ success: boolean; providerRefundNo?: string; raw?: Record<string, unknown>; error?: string }> {
    this.calls += 1
    return { success: true, providerRefundNo: `provider-${input.refundNo}`, raw: { refund_st: '5' } }
  }
}

function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const auth = new AuthCenterDb(db)
  const identities = new IdentityRepository(db)
  auth.createOrganization('org1', 'Org 1', 1)
  for (const [id, role] of [['u1', 'user'], ['admin1', 'admin']] as const) {
    auth.createUser({
      id, orgId: 'org1', email: `${id}@example.test`, name: id, displayName: null,
      departmentId: null, role, status: 'active', localAuth: true, tokenLimit: null,
      createdAt: 1, passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null,
    })
    identities.createWallet('user', id, 0)
  }
  ensureBillingSchema(db)
  const repository = new BillingRepository(db)
  const wallet = new WalletService(db, repository, () => 100)
  wallet.post({
    ownerType: 'user', ownerId: 'u1', deltaUnits: 5_500, entryType: 'RECHARGE',
    sourceType: 'payment_order', sourceId: 'order-1', orgId: 'org1',
  }, onlineCommandContext('seed-order-balance'))
  repository.insertOrder({
    id: 'order-1', legacyId: 7, orderNo: 'USR17NO1', userId: 'u1', orgId: 'org1', userPhone: null,
    amountUsdMicros: 5_000_000, amountCents: 3_650, exchangeRateMicros: 7_300_000,
    quotaUnits: 2_750_000, pointsUnits: 5_500, bonusUnits: 500, paymentMethod: 'ALIPAY',
    orderDate: '20260907', providerOrderInfo: null, status: 'SUCCESS', idempotencyKey: 'seed-order',
    createdAt: 1, updatedAt: 1, expiredAt: 999_999, remark: null,
  })
  repository.upsertExternalAccount({
    provider: 'sudorouter', ownerType: 'user', ownerId: 'u1', externalAccountId: '9',
    quotaUnits: 2_750_000, usedQuotaUnits: 0, updatedAt: 1,
  })
  const router = new FakeSudorouter()
  const coordinator = new BillingCoordinator(db, repository, wallet, router, {
    clock: () => 100, idGenerator: () => 'refund-quota-operation',
  })
  const fuiou = new FakeFuiouRefund()
  const service = new RefundService(db, repository, identities, wallet, coordinator, fuiou, {
    clock: () => 100, idGenerator: () => 'refund-1', suffixGenerator: () => 'ABC123',
  })
  return { db, identities, repository, wallet, router, fuiou, service }
}

describe('RefundService', () => {
  test('按订单真实到账总积分计算，赠送积分不重复相加', () => {
    const { db, service } = setup()
    assert.deepEqual(service.calculate('USR17NO1'), {
      orderPoints: 5_500, userBalance: 5_500, usedPoints: 0,
      refundAmountCents: 3_650, deductPoints: 5_500, originalAmountCents: 3_650,
    })
    db.close()
  })

  test('部分积分已使用时按旧汇率公式扣除已用金额', () => {
    const { db, service, wallet } = setup()
    wallet.post({
      ownerType: 'user', ownerId: 'u1', deltaUnits: -1_000, entryType: 'CONSUME',
      sourceType: 'usage', sourceId: 'usage-1', orgId: 'org1',
    }, onlineCommandContext('consume-before-refund'))
    assert.deepEqual(service.calculate('USR17NO1'), {
      orderPoints: 5_500, userBalance: 4_500, usedPoints: 1_000,
      refundAmountCents: 2_920, deductPoints: 4_500, originalAmountCents: 3_650,
    })
    db.close()
  })

  test('同一订单并发退款只调用一次支付方并只扣一次钱包', async () => {
    const { db, repository, fuiou, service } = setup()
    const actor = { userId: 'admin1', orgId: 'org1', role: 'admin' as const }
    const requests = await Promise.allSettled([
      service.request({ orderNo: 'USR17NO1', reason: '用户申请退款' }, actor, onlineCommandContext('refund-request-1')),
      service.request({ orderNo: 'USR17NO1', reason: '用户申请退款' }, actor, onlineCommandContext('refund-request-2')),
    ])

    assert.equal(requests.filter(item => item.status === 'fulfilled').length, 1)
    assert.equal(fuiou.calls, 1)
    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 0)
    assert.equal(repository.getOrderByOrderNo('USR17NO1')?.status, 'REFUNDED')
    assert.equal(repository.countRefundsForOrder('order-1'), 1)
    db.close()
  })

  test('缺少 Sudorouter 绑定时不调用支付方', async () => {
    const { db, repository, fuiou, service } = setup()
    db.prepare("DELETE FROM billing_external_accounts WHERE provider = 'sudorouter' AND owner_id = 'u1'").run()
    const actor = { userId: 'admin1', orgId: 'org1', role: 'admin' as const }

    await assert.rejects(
      () => service.request(
        { orderNo: 'USR17NO1', reason: '绑定缺失' }, actor,
        onlineCommandContext('refund-missing-binding'),
      ),
      /未绑定 sudorouter 账号/,
    )

    assert.equal(fuiou.calls, 0)
    assert.equal(repository.countRefundsForOrder('order-1'), 0)
    db.close()
  })

  test('migration 上下文写退款、钱包和留痕但不调用外部服务', async () => {
    const { db, repository, fuiou, service } = setup()
    const actor = { userId: 'admin1', orgId: 'org1', role: 'admin' as const }

    const refund = await service.request(
      { orderNo: 'USR17NO1', reason: '历史退款迁移' }, actor,
      migrationCommandContext('migration-run-1', 'refund-migration-1'),
    )

    assert.equal(refund.status, 'SUPPRESSED')
    assert.equal(fuiou.calls, 0)
    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 0)
    assert.equal(repository.getOrderByOrderNo('USR17NO1')?.status, 'REFUNDED')
    db.close()
  })
})
