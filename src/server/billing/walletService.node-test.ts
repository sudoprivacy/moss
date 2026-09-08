import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { migrationCommandContext, onlineCommandContext } from '../application/commandContext.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { BillingRepository } from './billingRepository.js'
import { ensureBillingSchema } from './billingSchema.js'
import { BillingDomainError } from './types.js'
import { WalletService } from './walletService.js'

function setup(initialBalance = 0): {
  db: DatabaseSync
  repository: BillingRepository
  service: WalletService
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
  identities.createWallet('user', 'u1', initialBalance)
  ensureBillingSchema(db)
  const repository = new BillingRepository(db)
  return { db, repository, service: new WalletService(db, repository) }
}

describe('WalletService', () => {
  test('余额、版本、流水和审计原子提交且重复幂等键只入账一次', () => {
    const { db, repository, service } = setup()
    const context = onlineCommandContext('admin-bonus-1')
    const command = {
      ownerType: 'user' as const,
      ownerId: 'u1',
      deltaUnits: 100,
      entryType: 'BONUS',
      memo: '活动赠送',
      sourceType: 'admin_adjustment',
      sourceId: 'adjustment-1',
      actorUserId: 'admin1',
    }

    const first = service.post(command, context)
    const replay = service.post(command, context)

    assert.deepEqual(replay, first)
    assert.deepEqual(first, { balanceBeforeUnits: 0, balanceAfterUnits: 100, deltaUnits: 100, version: 1 })
    assert.equal(repository.countLedgerEntries('wallet:admin-bonus-1'), 1)
    assert.equal(repository.countAuditEvents('wallet:admin-bonus-1'), 1)
    assert.deepEqual(service.rebuild('user', 'u1'), { stored: 100, rebuilt: 100, difference: 0 })
    db.close()
  })

  test('余额不足时不写钱包、流水或审计', () => {
    const { db, repository, service } = setup(20)

    assert.throws(() => service.post({
      ownerType: 'user', ownerId: 'u1', deltaUnits: -21, entryType: 'CONSUME',
      sourceType: 'usage', sourceId: 'usage-1',
    }, onlineCommandContext('consume-1')), (error: unknown) =>
      error instanceof BillingDomainError && error.code === 'INSUFFICIENT_BALANCE')

    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 20)
    assert.equal(repository.countLedgerEntries('wallet:consume-1'), 0)
    assert.equal(repository.countAuditEvents('wallet:consume-1'), 0)
    db.close()
  })

  test('按百分之一积分精确入账并可从流水重建余额', () => {
    const { db, repository, service } = setup(1)

    const result = service.post({
      ownerType: 'user', ownerId: 'u1', deltaUnits: -0.01, entryType: 'CONSUME',
      sourceType: 'usage', sourceId: 'usage-centipoint-1',
    }, onlineCommandContext('usage-centipoint-1'))

    assert.deepEqual(result, {
      balanceBeforeUnits: 1,
      balanceAfterUnits: 0.99,
      deltaUnits: -0.01,
      version: 1,
    })
    assert.equal(repository.getLedgerEntry('wallet:usage-centipoint-1')?.deltaUnits, -0.01)
    assert.deepEqual(service.rebuild('user', 'u1'), { stored: 0.99, rebuilt: 0.99, difference: 0 })
    db.close()
  })

  test('同一幂等键绑定不同财务命令时拒绝而不是返回旧结果', () => {
    const { db, repository, service } = setup()
    const context = onlineCommandContext('conflicting-key')
    service.post({
      ownerType: 'user', ownerId: 'u1', deltaUnits: 10, entryType: 'BONUS',
      sourceType: 'admin_adjustment', sourceId: 'adjustment-1',
    }, context)

    assert.throws(() => service.post({
      ownerType: 'user', ownerId: 'u1', deltaUnits: 20, entryType: 'BONUS',
      sourceType: 'admin_adjustment', sourceId: 'adjustment-2',
    }, context), (error: unknown) =>
      error instanceof BillingDomainError && error.code === 'IDEMPOTENCY_CONFLICT')
    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 10)
    assert.equal(repository.countLedgerEntries('wallet:conflicting-key'), 1)
    db.close()
  })

  test('流水插入失败时钱包版本和余额一并回滚', () => {
    const { db, repository, service } = setup()
    db.exec(`
      CREATE TRIGGER fail_test_ledger BEFORE INSERT ON billing_ledger_entries
      WHEN NEW.idempotency_key = 'wallet:rollback-1'
      BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END;
    `)

    assert.throws(() => service.post({
      ownerType: 'user', ownerId: 'u1', deltaUnits: 30, entryType: 'BONUS',
      sourceType: 'test', sourceId: 'rollback-1',
    }, onlineCommandContext('rollback-1')), /injected ledger failure/)

    assert.deepEqual(repository.getWallet('user', 'u1'), { balanceUnits: 0, version: 0 })
    assert.equal(repository.countLedgerEntries('wallet:rollback-1'), 0)
    db.close()
  })

  test('余额重建只报告差异而不偷偷修复快照', () => {
    const { db, repository, service } = setup()
    service.post({
      ownerType: 'user', ownerId: 'u1', deltaUnits: 40, entryType: 'BONUS',
      sourceType: 'test', sourceId: 'rebuild-1',
    }, onlineCommandContext('rebuild-1'))
    db.prepare("UPDATE wallets SET balance_units = 4100 WHERE owner_type = 'user' AND owner_id = 'u1'").run()

    assert.deepEqual(service.rebuild('user', 'u1'), { stored: 41, rebuilt: 40, difference: 1 })
    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 41)
    db.close()
  })

  test('迁移已验证历史流水时不重复增加 P1 已导入的钱包余额', () => {
    const { db, repository, service } = setup(100)
    const context = migrationCommandContext('p3-run', 'p3-wallet-user-17')
    const input = {
      ownerId: 'u1', legacyUserId: 17, balanceUnits: 100, sourceChecksum: 'a'.repeat(64),
      entries: [
        { legacyId: 1, deltaUnits: 120, entryType: 'RECHARGE', memo: '充值', createdAt: 10 },
        { legacyId: 2, deltaUnits: -20, entryType: 'CONSUME', memo: '消费', createdAt: 20 },
      ],
    }

    const first = service.importLegacySnapshot(input, context)
    const replay = service.importLegacySnapshot(input, context)

    assert.deepEqual(first, { balanceUnits: 100, importedEntries: 3, version: 0 })
    assert.deepEqual(replay, first)
    assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 100)
    assert.equal(repository.countOwnerLedgerEntries('user', 'u1'), 3)
    assert.deepEqual(service.rebuild('user', 'u1'), { stored: 100, rebuilt: 100, difference: 0 })
    db.close()
  })

  test('迁移历史流水有矛盾时整条命令回滚且不覆盖钱包找平', () => {
    const { db, repository, service } = setup()

    assert.throws(() => service.importLegacySnapshot({
      ownerId: 'u1', legacyUserId: 17, balanceUnits: 100, sourceChecksum: 'b'.repeat(64),
      entries: [{ legacyId: 1, deltaUnits: 99, entryType: 'RECHARGE', memo: null, createdAt: 10 }],
    }, migrationCommandContext('p3-run', 'p3-wallet-bad')), /流水合计与余额不一致/)

    assert.deepEqual(repository.getWallet('user', 'u1'), { balanceUnits: 0, version: 0 })
    assert.equal(repository.countOwnerLedgerEntries('user', 'u1'), 0)
    db.close()
  })
})
