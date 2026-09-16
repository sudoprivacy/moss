import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BillingOutboxWorker } from './billingOutboxWorker.js'

test('Billing 后台执行器只恢复可投递额度操作并隔离单项失败', async () => {
  const retried: string[] = []
  const worker = new BillingOutboxWorker({
    listRecoverableQuotaOperationIds() {
      return ['pending-1', 'unknown-1', 'broken-1']
    },
  }, {
    async retry(operationId: string) {
      retried.push(operationId)
      if (operationId === 'broken-1') throw new Error('still broken')
      return { operationId, status: 'SUCCEEDED' as const }
    },
  })

  const result = await worker.runOnce(10)

  assert.deepEqual(retried, ['pending-1', 'unknown-1', 'broken-1'])
  assert.deepEqual(result, { attempted: 3, succeeded: 2, failed: 1 })
})
