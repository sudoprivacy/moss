import assert from 'node:assert/strict'
import { test } from 'node:test'
import { onlineCommandContext } from '../application/commandContext.js'
import { setupBillingTestContext } from './testContext.node-test-helper.js'
import { ReconciliationService } from './reconciliationService.js'

test('钱包对账只记录差异，不自动覆盖余额或账本', () => {
  const { db, repository, wallet } = setupBillingTestContext()
  wallet.post({
    ownerType: 'user', ownerId: 'u1', deltaUnits: 100, entryType: 'BONUS',
    sourceType: 'test', sourceId: 'reconcile-seed', orgId: 'org1',
  }, onlineCommandContext('reconcile-seed'))
  db.prepare("UPDATE wallets SET balance_units = 10100 WHERE owner_type = 'user' AND owner_id = 'u1'").run()
  const service = new ReconciliationService(db, repository, wallet, { clock: () => 100, idGenerator: () => 'reconciliation-1' })

  const report = service.run({ ownerType: 'user', ownerId: 'u1' }, onlineCommandContext('reconcile-1'))

  assert.deepEqual(report, {
    id: 'reconciliation-1', status: 'MISMATCH', expectedUnits: 100, actualUnits: 101, differenceUnits: 1,
  })
  assert.equal(repository.getWallet('user', 'u1')?.balanceUnits, 101)
  assert.equal(repository.countReconciliations(), 1)
  db.close()
})
