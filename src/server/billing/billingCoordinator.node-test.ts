import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { migrationCommandContext, onlineCommandContext } from '../application/commandContext.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { BillingCoordinator } from './billingCoordinator.js'
import { BillingRepository } from './billingRepository.js'
import { ensureBillingSchema } from './billingSchema.js'
import type { QuotaSnapshot, SudorouterPort } from './sudorouterAdapter.js'
import { WalletService } from './walletService.js'

class FakeSudorouter implements SudorouterPort {
  quotaUnits = 1_000
  usedQuotaUnits = 20
  getUserCalls = 0
  changeCalls = 0
  failChange = false

  async getUser(externalUserId: string): Promise<QuotaSnapshot | null> {
    this.getUserCalls += 1
    return { externalUserId, quotaUnits: this.quotaUnits, usedQuotaUnits: this.usedQuotaUnits }
  }

  async changeQuota(input: { externalUserId: string; deltaUnits: number }): Promise<{ success: boolean; error?: string }> {
    this.changeCalls += 1
    if (this.failChange) return { success: false, error: 'upstream failed' }
    this.quotaUnits += input.deltaUnits
    return { success: true }
  }
}

function setup(): {
  db: DatabaseSync
  repository: BillingRepository
  fake: FakeSudorouter
  coordinator: BillingCoordinator
} {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const auth = new AuthCenterDb(db)
  const identities = new IdentityRepository(db)
  auth.createOrganization('org1', 'Org 1', 1)
  auth.createUser({
    id: 'u1', orgId: 'org1', email: 'u1@example.test', name: 'u1', displayName: null,
    departmentId: null, role: 'user', status: 'active', localAuth: true, tokenLimit: null,
    createdAt: 1, passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null,
  })
  identities.createWallet('user', 'u1', 0)
  ensureBillingSchema(db)
  const repository = new BillingRepository(db)
  repository.upsertExternalAccount({
    provider: 'sudorouter', ownerType: 'user', ownerId: 'u1', externalAccountId: '9',
    quotaUnits: 1_000, usedQuotaUnits: 20, updatedAt: 1,
  })
  const fake = new FakeSudorouter()
  const wallet = new WalletService(db, repository, () => 100)
  return {
    db, repository, fake,
    coordinator: new BillingCoordinator(db, repository, wallet, fake, { clock: () => 100, idGenerator: () => 'operation-1' }),
  }
}

const adjustment = {
  ownerType: 'user' as const,
  ownerId: 'u1',
  orgId: 'org1',
  externalUserId: '9',
  pointsDelta: 50,
  reason: '后台充值',
  sourceType: 'admin_adjustment',
  sourceId: 'adjustment-1',
  actorUserId: 'admin1',
}

describe('BillingCoordinator Sudorouter Saga', () => {
  test('外部额度成功后才原子入账钱包，并保持操作幂等', async () => {
    const { db, repository, fake, coordinator } = setup()
    const context = onlineCommandContext('adjust-1')
    const first = await coordinator.adjustPoints(adjustment, context)
    const replay = await coordinator.adjustPoints(adjustment, context)

    assert.deepEqual(first, { operationId: 'operation-1', status: 'SUCCEEDED', newBalanceUnits: 50, newQuotaUnits: 26_000 })
    assert.deepEqual(replay, first)
    assert.equal(fake.changeCalls, 1)
    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 50)
    assert.equal(repository.getQuotaOperationById('operation-1')?.status, 'SUCCEEDED')
    db.close()
  })

  test('迁移上下文保留钱包和审计但抑制外部调用', async () => {
    const { db, repository, fake, coordinator } = setup()
    const result = await coordinator.adjustPoints(adjustment, migrationCommandContext('batch-1', 'adjust-migration'))

    assert.equal(result.status, 'SUPPRESSED')
    assert.equal(fake.getUserCalls, 0)
    assert.equal(fake.changeCalls, 0)
    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 50)
    assert.equal(repository.getQuotaOperationById('operation-1')?.status, 'SUPPRESSED')
    db.close()
  })

  test('迁移钱包入账失败时不留下 SUPPRESSED 半成品操作', async () => {
    const { db, repository, coordinator } = setup()
    db.exec(`
      CREATE TRIGGER fail_migration_ledger BEFORE INSERT ON billing_ledger_entries
      WHEN NEW.source_type = 'quota_operation'
      BEGIN SELECT RAISE(ABORT, 'injected migration ledger failure'); END;
    `)

    await assert.rejects(
      () => coordinator.adjustPoints(adjustment, migrationCommandContext('batch-1', 'adjust-migration-fail')),
      /injected migration ledger failure/,
    )
    assert.equal(repository.getQuotaOperationById('operation-1'), null)
    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 0)
    db.close()
  })

  test('外部成功但本地入账失败进入 UNKNOWN，重试查询确认后不重复增额', async () => {
    const { db, repository, fake, coordinator } = setup()
    db.exec(`
      CREATE TRIGGER fail_quota_finalize BEFORE INSERT ON billing_ledger_entries
      WHEN NEW.source_type = 'quota_operation'
      BEGIN SELECT RAISE(ABORT, 'injected finalize failure'); END;
    `)

    const first = await coordinator.adjustPoints(adjustment, onlineCommandContext('adjust-unknown'))
    assert.equal(first.status, 'UNKNOWN')
    assert.equal(fake.changeCalls, 1)
    assert.equal(fake.quotaUnits, 26_000)
    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 0)

    db.exec('DROP TRIGGER fail_quota_finalize')
    const recovered = await coordinator.retry('operation-1')
    assert.equal(recovered.status, 'SUCCEEDED')
    assert.equal(fake.changeCalls, 1)
    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 50)
    db.close()
  })

  test('额度同步只更新绑定快照，不直接覆盖钱包账本余额', async () => {
    const { db, repository, fake, coordinator } = setup()
    fake.quotaUnits = 2_000
    fake.usedQuotaUnits = 40
    const result = await coordinator.syncQuota('user', 'u1', '9')

    assert.deepEqual(result, { externalUserId: '9', quotaUnits: 2_000, usedQuotaUnits: 40 })
    assert.deepEqual(repository.getExternalAccount('sudorouter', 'user', 'u1'), {
      provider: 'sudorouter', ownerType: 'user', ownerId: 'u1', externalAccountId: '9',
      quotaUnits: 2_000, usedQuotaUnits: 40, updatedAt: 100,
    })
    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 0)
    db.close()
  })

  test('可恢复进程退出前留下的 PENDING 操作', async () => {
    const { db, repository, fake, coordinator } = setup()
    repository.insertQuotaOperation({
      id: 'pending-operation', ownerType: 'user', ownerId: 'u1', externalUserId: '9',
      deltaUnits: 5_000, status: 'PENDING', idempotencyKey: 'pending-key',
      sourceType: 'admin_adjustment', sourceId: 'pending-source', orgId: 'org1',
      reason: '恢复任务', requestFingerprint: 'fingerprint', contextSource: 'online', createdAt: 1,
    })

    const result = await coordinator.retry('pending-operation')

    assert.equal(result.status, 'SUCCEEDED')
    assert.equal(fake.changeCalls, 1)
    assert.equal(fake.quotaUnits, 6_000)
    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 10)
    db.close()
  })
})
