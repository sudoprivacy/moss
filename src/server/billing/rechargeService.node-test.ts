import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { onlineCommandContext } from '../application/commandContext.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { BillingRepository } from './billingRepository.js'
import { ensureBillingSchema } from './billingSchema.js'
import { RechargeService } from './rechargeService.js'
import { BillingDomainError } from './types.js'
import type { VerifiedPaymentEvent } from './fuiouAdapter.js'
import { WalletService } from './walletService.js'
import { BillingCoordinator } from './billingCoordinator.js'
import type { QuotaSnapshot, SudorouterPort } from './sudorouterAdapter.js'

class CallbackSudorouter implements SudorouterPort {
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

function setup(): {
  db: DatabaseSync
  repository: BillingRepository
  service: RechargeService
  setNow(value: number): void
} {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const auth = new AuthCenterDb(db)
  const identities = new IdentityRepository(db)
  auth.createOrganization('org1', 'Org 1', 1)
  for (const id of ['u1', 'u2']) {
    auth.createUser({
      id, orgId: 'org1', email: `${id}@example.test`, name: id, displayName: null,
      departmentId: null, role: 'user', status: 'active', localAuth: true, tokenLimit: null,
      createdAt: 1, passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null,
    })
    identities.createWallet('user', id, 0)
  }
  ensureBillingSchema(db)
  const repository = new BillingRepository(db)
  let now = Date.parse('2026-09-07T10:00:00.000Z')
  const service = new RechargeService(db, repository, {
    clock: () => now,
    idGenerator: (() => {
      let sequence = 0
      return () => `id-${++sequence}`
    })(),
    suffixGenerator: () => 'ABC123',
    numericAliasAllocator: (orderId, orgId) => identities.allocateNumericAlias('billing_order', orderId, orgId),
  })
  return { db, repository, service, setNow(value) { now = value } }
}

describe('RechargeService 套餐与订单', () => {
  test('保留旧套餐、积分赠送和人民币展示字段', () => {
    const { db, service } = setup()
    assert.deepEqual(service.listPackages(), [
      { amount: 1, points: 1000, bonus: 0, description: '基础充值', amount_cny: 7.3, exchange_rate: 7.3 },
      { amount: 5, points: 5000, bonus: 500, description: '充5送500积分', amount_cny: 36.5, exchange_rate: 7.3 },
      { amount: 10, points: 10000, bonus: 1000, description: '充10送1000积分', amount_cny: 73, exchange_rate: 7.3 },
      { amount: 20, points: 20000, bonus: 3000, description: '充20送3000积分', amount_cny: 146, exchange_rate: 7.3 },
      { amount: 50, points: 50000, bonus: 10000, description: '充50送10000积分', amount_cny: 365, exchange_rate: 7.3 },
    ])
    db.close()
  })

  test('同一创建幂等键只产生一个旧格式订单号', () => {
    const { db, repository, service } = setup()
    const input = {
      userId: 'u1', legacyUserId: 17, orgId: 'org1', userPhone: '13800000000',
      amountUsd: 5, paymentMethod: 'ALIPAY' as const,
    }
    const context = onlineCommandContext('create-order-1')
    const first = service.createOrder(input, context)
    const replay = service.createOrder(input, context)

    assert.deepEqual(replay, first)
    assert.equal(first.orderNo, 'USR17NO1788775200000ABC123')
    assert.equal(first.amountUsd, 5)
    assert.equal(first.amountCny, 36.5)
    assert.equal(first.pointsUnits, 5500)
    assert.equal(first.bonusUnits, 500)
    assert.equal(first.quotaUnits, 2_750_000)
    assert.equal(repository.countOrders(), 1)
    assert.equal(repository.getOrderByOrderNo(first.orderNo)?.legacyId, 2_000_000_000)
    db.close()
  })

  test('同一订单幂等键绑定不同金额时拒绝', () => {
    const { db, service } = setup()
    const context = onlineCommandContext('create-order-conflict')
    const base = {
      userId: 'u1', legacyUserId: 17, orgId: 'org1', userPhone: null,
      paymentMethod: 'WECHAT' as const,
    }
    service.createOrder({ ...base, amountUsd: 1 }, context)
    assert.throws(
      () => service.createOrder({ ...base, amountUsd: 10 }, context),
      (error: unknown) => error instanceof BillingDomainError && error.code === 'IDEMPOTENCY_CONFLICT',
    )
    db.close()
  })

  test('过期订单转为取消且其他用户不能准备支付', () => {
    const { db, repository, service, setNow } = setup()
    const order = service.createOrder({
      userId: 'u1', legacyUserId: 17, orgId: 'org1', userPhone: null,
      amountUsd: 1, paymentMethod: 'ALIPAY',
    }, onlineCommandContext('create-expiring'))

    assert.throws(
      () => service.preparePayment(order.orderNo, 'u2', onlineCommandContext('pay-other')),
      (error: unknown) => error instanceof BillingDomainError && error.code === 'ORDER_NOT_FOUND',
    )
    setNow(order.expiredAt + 1)
    assert.throws(
      () => service.preparePayment(order.orderNo, 'u1', onlineCommandContext('pay-expired')),
      (error: unknown) => error instanceof BillingDomainError && error.code === 'ORDER_EXPIRED',
    )
    assert.equal(repository.getOrderByOrderNo(order.orderNo)?.status, 'CANCELLED')
    assert.equal(repository.countPaymentAttempts(), 0)
    db.close()
  })

  test('合法支付回调重复处理只入账一次，金额不符零写入', () => {
    const { db, repository, service } = setup()
    const wallet = new WalletService(db, repository)
    const order = service.createOrder({
      userId: 'u1', legacyUserId: 17, orgId: 'org1', userPhone: null,
      amountUsd: 1, paymentMethod: 'ALIPAY',
    }, onlineCommandContext('create-callback-order'))
    const event: VerifiedPaymentEvent = {
      providerEventId: 'fuiou:event-1', orderNo: order.orderNo, status: 'SUCCESS',
      amountCents: 730, orderDate: '20260907',
      raw: { order_id: order.orderNo, order_st: '1', order_amt: '730', order_date: '20260907' },
    }

    assert.throws(() => service.acceptVerifiedCallback({ ...event, providerEventId: 'fuiou:bad', amountCents: 731 }, wallet),
      (error: unknown) => error instanceof BillingDomainError && error.code === 'PAYMENT_AMOUNT_MISMATCH')
    assert.equal(repository.countProviderEvents(), 0)

    for (let index = 0; index < 10; index += 1) {
      const result = service.acceptVerifiedCallback(index === 0 ? event : {
        ...event,
        raw: { order_date: '20260907', order_amt: '730', order_st: '1', order_id: order.orderNo },
      }, wallet)
      assert.deepEqual(result, { success: true, orderNo: order.orderNo, alreadyProcessed: index > 0 })
    }
    assert.equal(repository.countProviderEvents(), 1)
    assert.equal(repository.countLedgerEntries(`wallet:payment:${order.orderNo}`), 1)
    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 1000)
    assert.equal(repository.getOrderByOrderNo(order.orderNo)?.status, 'SUCCESS')
    assert.equal(repository.getOrderByOrderNo(order.orderNo)?.callbackAmountCents, 730)
    assert.equal(repository.listRechargeActivities({ activityType: 'CLIENT', limit: 20, offset: 0 }).total, 1)
    db.close()
  })

  test('生产回调通过统一 Saga 同时发放钱包积分和 Sudorouter 额度', async () => {
    const { db, repository, service } = setup()
    const wallet = new WalletService(db, repository)
    const router = new CallbackSudorouter()
    const coordinator = new BillingCoordinator(db, repository, wallet, router)
    repository.upsertExternalAccount({
      provider: 'sudorouter', ownerType: 'user', ownerId: 'u1', externalAccountId: '91',
      quotaUnits: 0, usedQuotaUnits: 0, updatedAt: 1,
    })
    const order = service.createOrder({
      userId: 'u1', legacyUserId: 17, orgId: 'org1', userPhone: null,
      amountUsd: 1, paymentMethod: 'ALIPAY',
    }, onlineCommandContext('create-saga-callback-order'))
    const event: VerifiedPaymentEvent = {
      providerEventId: 'fuiou:saga-event-1', orderNo: order.orderNo, status: 'SUCCESS',
      amountCents: 730, orderDate: '20260907',
      raw: { order_id: order.orderNo, order_st: '1', order_amt: '730', order_date: '20260907' },
    }

    const first = await service.acceptVerifiedCallbackWithCoordinator(event, coordinator)
    const repeated = await service.acceptVerifiedCallbackWithCoordinator(event, coordinator)

    assert.deepEqual(first, { success: true, orderNo: order.orderNo, alreadyProcessed: false })
    assert.deepEqual(repeated, { success: true, orderNo: order.orderNo, alreadyProcessed: true })
    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 1000)
    assert.equal(router.quota, 500_000)
    assert.equal(router.calls, 1)
    assert.equal(repository.getOrderByOrderNo(order.orderNo)?.status, 'SUCCESS')
    assert.equal(repository.countProviderEvents(), 1)
    assert.equal(repository.listRechargeActivities({ activityType: 'CLIENT', limit: 20, offset: 0 }).total, 1)
    db.close()
  })
})
