import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildMigrationReport } from './migrationReportFactory.js'

test('校验报告保留最终门禁问题、阶段问题和真实副作用计数', () => {
  const report = buildMigrationReport({
    mode: 'verify',
    result: {
      runId: 'run-1', sourceFingerprint: 'source', status: 'mismatch',
      phases: [{ name: 'billing', verification: { status: 'mismatch', issues: ['阶段财务差异'] } }],
      finalVerification: {
        checks: [{ name: 'billing_reconciliation', result: { status: 'mismatch', issues: ['最终财务差异'] } }],
        issues: ['最终财务差异'],
      },
    },
    createdAt: 1_800_000_000_000,
    suppressedEffects: {
      count: 3,
      deliverableCount: 1,
      items: [{
        effectType: 'sms', resourceType: 'user', resourceId: 'user-1',
        idempotencyKey: 'welcome:user-1', reason: 'migration context',
      }],
    },
  })

  assert.equal(report.kind, 'verification')
  assert.equal(report.status, 'mismatch')
  assert.deepEqual(report.issues, ['最终财务差异', '阶段财务差异'])
  assert.deepEqual(report.summary, { checkCount: 1, phaseCount: 1 })
  assert.equal(report.suppressedEffects.items[0]?.resourceId, 'user-1')
})
