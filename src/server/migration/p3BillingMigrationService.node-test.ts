import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { migrationCommandContext } from '../application/commandContext.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { BillingRepository } from '../billing/billingRepository.js'
import { ensureBillingSchema } from '../billing/billingSchema.js'
import { WalletService } from '../billing/walletService.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import {
  P3BillingMigrationBlockedError,
  P3BillingMigrationService,
} from './p3BillingMigrationService.js'
import type { SudoworkP3Snapshot } from './sudoworkP3SourceReader.js'

function snapshot(): SudoworkP3Snapshot {
  return {
    checksum: 'a'.repeat(64),
    users: [{
      id: 17, phone: '13800000000', enterpriseId: 3, balanceUnits: 100,
      quotaUnits: 50_000, usedQuotaUnits: 1_000, externalUserId: '91',
    }],
    ledger: [
      { id: 1, userId: 17, deltaUnits: 1_100, entryType: 'RECHARGE', memo: '充值', createdAt: 10 },
      { id: 2, userId: 17, deltaUnits: -1_000, entryType: 'REFUND', memo: '退款', createdAt: 30 },
    ],
    orders: [{
      id: 7, orderNo: 'ORDER-7', userId: 17, userPhone: '13800000000', enterpriseId: 3,
      amountUsdMicros: 1_000_000, amountCents: 730, exchangeRateMicros: 7_300_000,
      quotaUnits: 500_000, pointsUnits: 1_000, bonusUnits: 100, paymentMethod: 'ALIPAY',
      orderDate: '20260907', providerOrderInfo: '{}', status: 4, callbackData: '{"paid":true}',
      callbackTime: 20, callbackAmountCents: 730, createdAt: 10, updatedAt: 30,
      expiredAt: 1_000, remark: '已退款',
    }],
    rechargeRecords: [{
      id: 8, orderId: 7, userId: 17, quotaBeforeUnits: 0, quotaAfterUnits: 500_000,
      quotaDeltaUnits: 500_000, balanceBeforeUnits: 0, balanceAfterUnits: 1_100,
      balanceDeltaUnits: 1_100, externalUserId: '91', externalSucceeded: true, createdAt: 20,
    }],
    adminRechargeRecords: [{
      id: 9, userId: 17, adminId: 17, pointsUnits: 20, quotaUnits: 10_000,
      reason: '补发', paymentReference: 'R1', externalUserId: '91', externalSucceeded: true,
      externalError: null, source: 'ADMIN_MANUAL', sourceId: null, createdAt: 25,
    }],
    creditApplications: [{
      id: 10, applicationNo: 'APP-10', userId: 17, enterpriseId: 3,
      requestedUnits: 20, approvedUnits: 20, quotaUnits: 10_000, reason: '申请',
      status: 'APPROVED', adminId: 17, adminComment: '同意', externalUserId: '91',
      externalSucceeded: true, externalError: null, createdAt: 15, reviewedAt: 25, updatedAt: 25,
    }],
    refunds: [{
      id: 11, refundNo: 'REF-11', orderId: 7, orderNo: 'ORDER-7', userId: 17,
      refundAmountCents: 730, refundQuotaUnits: 500_000, refundPointsUnits: 1_000,
      reason: '退款', refundType: 'FUIOU', status: 1, providerRefundNo: 'FR-11',
      providerResponse: '{}', createdAt: 30, processedAt: 30,
    }],
  }
}

function setup(initialBalance = 100) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const auth = new AuthCenterDb(db)
  const identities = new IdentityRepository(db)
  auth.createOrganization('org-3', '企业 3', 1)
  auth.createUser({
    id: 'user-17', orgId: 'org-3', email: 'u17@example.test', name: 'u17', displayName: '用户 17',
    departmentId: null, role: 'user', status: 'active', localAuth: true, tokenLimit: null,
    createdAt: 1, passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null,
  })
  identities.assignNumericAlias({ namespace: 'enterprise', legacyId: 3, resourceId: 'org-3', orgId: 'org-3' })
  identities.assignNumericAlias({ namespace: 'user', legacyId: 17, resourceId: 'user-17', orgId: 'org-3' })
  identities.createWallet('user', 'user-17', initialBalance)
  ensureBillingSchema(db)
  const repository = new BillingRepository(db)
  const wallet = new WalletService(db, repository, () => 1000)
  const service = new P3BillingMigrationService(db, identities, repository, wallet, () => 1000)
  return { db, identities, repository, wallet, service }
}

describe('P3BillingMigrationService', () => {
  test('保留旧 ID 和订单号，以可重建账本导入且不产生外部投递', () => {
    const { db, identities, repository, wallet, service } = setup()
    const source = snapshot()
    const plan = service.plan(source)
    assert.equal(plan.status, 'ready')

    const context = migrationCommandContext('batch-p3', 'batch-p3-execute')
    const first = service.execute(plan, context)
    const second = service.execute(plan, context)
    const freshPlan = service.plan(source)
    const third = service.execute(freshPlan, migrationCommandContext('batch-p3-rerun', 'batch-p3-rerun-execute'))
    const verification = service.verify(source)

    assert.equal(first.financialDifferenceUnits, 0)
    assert.equal(first.deliverableExternalOutboxCount, 0)
    assert.equal(first.importedLedgerEntries, 3)
    assert.equal(second.importedLedgerEntries, 0)
    assert.equal(third.importedLedgerEntries, 0)
    assert.equal(repository.getOrderByLegacyId(7)?.orderNo, 'ORDER-7')
    assert.equal(repository.getOrderByLegacyId(7)?.callbackAmountCents, 730)
    assert.equal(repository.getOrderByLegacyId(7)?.callbackTime, 20)
    assert.equal(identities.resolveNumericAliasGlobal('billing_order', 7)?.resourceId, repository.getOrderByOrderNo('ORDER-7')?.id)
    assert.equal(identities.resolveNumericAliasGlobal('credit_application', 10)?.resourceId, repository.getCreditApplicationByLegacyId(10)?.id)
    assert.equal(identities.resolveNumericAliasGlobal('billing_refund', 11)?.resourceId, repository.getRefundByLegacyId(11)?.id)
    assert.deepEqual(wallet.rebuild('user', 'user-17'), { stored: 100, rebuilt: 100, difference: 0 })
    assert.equal(repository.listRechargeActivities({ limit: 20, offset: 0 }).total, 2)
    assert.equal(repository.getExternalAccount('sudorouter', 'user', 'user-17')?.externalAccountId, '91')
    assert.equal(verification.status, 'matched')
    assert.equal(verification.differenceUnits, 0)
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE status = 'pending'").get() as { count: number }).count, 0)
    db.close()
  })

  test('目标钱包为空时从已验证流水原子构建余额', () => {
    const { db, repository, service } = setup(0)
    const plan = service.plan(snapshot())
    const report = service.execute(plan, migrationCommandContext('batch-zero', 'batch-zero-execute'))
    assert.equal(report.financialDifferenceUnits, 0)
    assert.deepEqual(repository.getWallet('user', 'user-17'), { balanceUnits: 100, version: 1 })
    db.close()
  })

  test('预检阻断余额矛盾、进行中业务和未完成的身份映射', () => {
    const mismatchSetup = setup()
    const mismatch = snapshot()
    mismatch.users[0]!.balanceUnits = 101
    const mismatchPlan = mismatchSetup.service.plan(mismatch)
    assert.equal(mismatchPlan.status, 'blocked')
    assert(mismatchPlan.issues.some(issue => issue.code === 'BALANCE_MISMATCH'))
    assert.throws(
      () => mismatchSetup.service.execute(mismatchPlan, migrationCommandContext('bad', 'bad-execute')),
      (error: unknown) => error instanceof P3BillingMigrationBlockedError,
    )
    mismatchSetup.db.close()

    const pendingSetup = setup()
    const pending = snapshot()
    pending.orders[0]!.status = 1
    pending.creditApplications[0]!.status = 'PROCESSING'
    pending.refunds[0]!.status = 0
    const pendingPlan = pendingSetup.service.plan(pending)
    assert(pendingPlan.issues.filter(issue => issue.code === 'IN_PROGRESS').length >= 3)
    pendingSetup.db.close()

    const orphanSetup = setup()
    orphanSetup.db.prepare("DELETE FROM resource_numeric_aliases WHERE namespace = 'user'").run()
    const orphanPlan = orphanSetup.service.plan(snapshot())
    assert(orphanPlan.issues.some(issue => issue.code === 'IDENTITY_MAPPING_MISSING'))
    orphanSetup.db.close()
  })
})
