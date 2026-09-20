import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { migrationCommandContext } from '../application/commandContext.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { WalletService } from '../billing/walletService.js'
import { createBillingTestRepository, createIdentityTestRepository } from '../testing/compatibilityRepositories.js'
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
      sudorouterToken: 'legacy-router-token',
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

async function setup(initialBalance = 100) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const auth = new AuthCenterDb(db)
  const identities = createIdentityTestRepository(db, {}, auth.driver)
  await auth.createOrganization('org-3', '企业 3', 1)
  await auth.createUser({
    id: 'user-17', orgId: 'org-3', email: 'u17@example.test', name: 'u17', displayName: '用户 17',
    departmentId: null, role: 'user', status: 'active', localAuth: true, tokenLimit: null,
    createdAt: 1, passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null,
  })
  await identities.assignNumericAlias({ namespace: 'enterprise', legacyId: 3, resourceId: 'org-3', orgId: 'org-3' })
  await identities.assignNumericAlias({ namespace: 'user', legacyId: 17, resourceId: 'user-17', orgId: 'org-3' })
  await identities.createWallet('user', 'user-17', initialBalance)
  const repository = createBillingTestRepository(db, auth.driver)
  const wallet = new WalletService(auth.driver, repository, () => 1000)
  const secretValues = new Map<string, string>()
  const secrets = {
    async putSecret(namespace: string, key: string, value: string) {
      secretValues.set(`${namespace}:${key}`, value)
    },
    async getSecret(namespace: string, key: string) {
      const value = secretValues.get(`${namespace}:${key}`)
      return value === undefined ? null : { value, status: 'enabled', version: 1 }
    },
  }
  const service = new P3BillingMigrationService(
    auth.driver, identities, repository, wallet, () => 1000, undefined, secrets,
  )
  return { db, identities, repository, wallet, service, secretValues }
}

void describe('P3BillingMigrationService', () => {
  void test('保留旧 ID、订单号和 Nexus Token，以可重建账本导入且不产生外部投递', async () => {
    const { db, identities, repository, wallet, service, secretValues } = await setup()
    const source = snapshot()
    const plan = await service.plan(source)
    assert.equal(plan.status, 'ready')

    const context = migrationCommandContext('batch-p3', 'batch-p3-execute')
    const first = await service.execute(plan, context)
    const second = await service.execute(plan, context)
    const freshPlan = await service.plan(source)
    const third = await service.execute(freshPlan, migrationCommandContext('batch-p3-rerun', 'batch-p3-rerun-execute'))
    const verification = await service.verify(source)

    assert.equal(first.financialDifferenceUnits, 0)
    assert.equal(first.deliverableExternalOutboxCount, 0)
    assert.equal(first.importedLedgerEntries, 3)
    assert.equal(second.importedLedgerEntries, 0)
    assert.equal(third.importedLedgerEntries, 0)
    assert.equal((await repository.getOrderByLegacyId(7))?.orderNo, 'ORDER-7')
    assert.equal((await repository.getOrderByLegacyId(7))?.callbackAmountCents, 730)
    assert.equal((await repository.getOrderByLegacyId(7))?.callbackTime, 20)
    assert.equal((await identities.resolveNumericAliasGlobal('billing_order', 7))?.resourceId, (await repository.getOrderByOrderNo('ORDER-7'))?.id)
    assert.equal((await identities.resolveNumericAliasGlobal('credit_application', 10))?.resourceId, (await repository.getCreditApplicationByLegacyId(10))?.id)
    assert.equal((await identities.resolveNumericAliasGlobal('billing_refund', 11))?.resourceId, (await repository.getRefundByLegacyId(11))?.id)
    assert.deepEqual(await wallet.rebuild('user', 'user-17'), { stored: 100, rebuilt: 100, difference: 0 })
    assert.equal((await repository.listRechargeActivities({ limit: 20, offset: 0 })).total, 2)
    const account = await repository.getExternalAccount('sudorouter', 'user', 'user-17')
    assert.equal(account?.externalAccountId, '91')
    assert.equal(account?.tokenSecretRef, 'nexus://moss:sudorouter-users/user-17')
    assert.equal(secretValues.get('moss:sudorouter-users:user-17'), 'sk-legacy-router-token')
    assert.equal(JSON.stringify(first).includes('legacy-router-token'), false)
    assert.equal(verification.status, 'matched')
    assert.equal(verification.differenceUnits, 0)
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE status = 'pending'").get() as { count: number }).count, 0)
    db.close()
  })

  void test('目标钱包为空时从已验证流水原子构建余额', async () => {
    const { db, repository, service } = await setup(0)
    const plan = await service.plan(snapshot())
    const report = await service.execute(plan, migrationCommandContext('batch-zero', 'batch-zero-execute'))
    assert.equal(report.financialDifferenceUnits, 0)
    assert.deepEqual(await repository.getWallet('user', 'user-17'), { balanceUnits: 100, version: 1 })
    db.close()
  })

  void test('Nexus Token 缺失会阻断历史用户校验', async () => {
    const { db, service, secretValues } = await setup()
    const source = snapshot()
    await service.execute(await service.plan(source), migrationCommandContext('batch-token', 'batch-token-execute'))
    secretValues.clear()
    const verification = await service.verify(source)
    assert.equal(verification.status, 'mismatch')
    assert(verification.issues.some(issue => issue.includes('Token')))
    db.close()
  })

  void test('预检阻断余额矛盾、进行中业务和未完成的身份映射', async () => {
    const mismatchSetup = await setup()
    const mismatch = snapshot()
    mismatch.users[0]!.balanceUnits = 101
    const mismatchPlan = await mismatchSetup.service.plan(mismatch)
    assert.equal(mismatchPlan.status, 'blocked')
    assert(mismatchPlan.issues.some(issue => issue.code === 'BALANCE_MISMATCH'))
    await assert.rejects(
      mismatchSetup.service.execute(mismatchPlan, migrationCommandContext('bad', 'bad-execute')),
      (error: unknown) => error instanceof P3BillingMigrationBlockedError,
    )
    mismatchSetup.db.close()

    const pendingSetup = await setup()
    const pending = snapshot()
    pending.orders[0]!.status = 1
    pending.creditApplications[0]!.status = 'PROCESSING'
    pending.refunds[0]!.status = 0
    const pendingPlan = await pendingSetup.service.plan(pending)
    assert(pendingPlan.issues.filter(issue => issue.code === 'IN_PROGRESS').length >= 3)
    pendingSetup.db.close()

    const orphanSetup = await setup()
    orphanSetup.db.prepare("DELETE FROM resource_numeric_aliases WHERE namespace = 'user'").run()
    const orphanPlan = await orphanSetup.service.plan(snapshot())
    assert(orphanPlan.issues.some(issue => issue.code === 'IDENTITY_MAPPING_MISSING'))
    orphanSetup.db.close()
  })
})
