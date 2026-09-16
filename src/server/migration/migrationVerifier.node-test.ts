import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { MIGRATION_PHASES, MigrationRunStore } from './migrationRunStore.js'
import {
  MigrationVerifier,
  REQUIRED_MIGRATION_CHECKS,
  type MigrationVerificationCheck,
} from './migrationVerifier.js'
import type { SudoworkSourceSnapshot } from './sudoworkSourceSnapshot.js'

const source: SudoworkSourceSnapshot = {
  fingerprint: 'sha256:source', capturedAt: '2026-09-08T00:00:00.000Z',
  sqlite: { name: 'sqlite', checksum: 'a', itemCount: 1, readOnly: true, metadata: {} },
  redis: { name: 'redis', checksum: 'b', itemCount: 1, readOnly: true, metadata: {} },
  qms: { name: 'qms', checksum: 'c', itemCount: 1, readOnly: true, metadata: {} },
  files: { name: 'files', checksum: 'd', itemCount: 1, readOnly: true, metadata: {} },
  includedDomains: [...MIGRATION_PHASES], excludedLocalData: ['sessions', 'client_cron', 'client_channels'],
}

function completedRun() {
  const db = new DatabaseSync(':memory:')
  const runs = new MigrationRunStore(db, { idFactory: () => 'run-verify' })
  runs.createRun({ sourceFingerprint: source.fingerprint, sourceMetadata: {} })
  for (const phase of MIGRATION_PHASES) {
    runs.beginPhase('run-verify', phase)
    runs.completePhase('run-verify', phase, {})
  }
  return { db, runs }
}

describe('MigrationVerifier', () => {
  test('requires every release-gate check exactly once', () => {
    const fixture = completedRun()
    try {
      const checks = REQUIRED_MIGRATION_CHECKS.slice(0, -1).map(name => ({
        name, verify: async () => ({ status: 'matched' as const, issues: [], metrics: {} }),
      }))
      assert.throws(() => new MigrationVerifier(fixture.runs, checks), /校验项清单/)
    } finally {
      fixture.db.close()
    }
  })

  test('runs every check and blocks verification on mismatch or deliverable migration effects', async () => {
    const fixture = completedRun()
    const calls: string[] = []
    try {
      fixture.runs.recordSuppressedEffect('run-verify', {
        runId: 'run-verify', effectType: 'sms', resourceType: 'user', resourceId: '1',
        idempotencyKey: 'sms:1', reason: 'migration',
      })
      const checks = REQUIRED_MIGRATION_CHECKS.map((name): MigrationVerificationCheck => ({
        name,
        async verify() {
          calls.push(name)
          return name === 'billing_reconciliation'
            ? { status: 'mismatch', issues: ['钱包差异 1'], metrics: { differences: 1 } }
            : { status: 'matched', issues: [], metrics: {} }
        },
      }))
      const report = await new MigrationVerifier(fixture.runs, checks).verify('run-verify', source)
      assert.equal(report.status, 'mismatch')
      assert.deepEqual(calls, [...REQUIRED_MIGRATION_CHECKS])
      assert.equal(report.suppressedEffects.count, 1)
      assert.equal(report.suppressedEffects.deliverableCount, 0)
      assert(report.issues.includes('钱包差异 1'))
    } finally {
      fixture.db.close()
    }
  })

  test('rejects a changed source fingerprint before running domain checks', async () => {
    const fixture = completedRun()
    let calls = 0
    try {
      const checks = REQUIRED_MIGRATION_CHECKS.map((name): MigrationVerificationCheck => ({
        name, verify: async () => { calls += 1; return { status: 'matched', issues: [], metrics: {} } },
      }))
      await assert.rejects(
        new MigrationVerifier(fixture.runs, checks).verify('run-verify', { ...source, fingerprint: 'sha256:changed' }),
        /源指纹/,
      )
      assert.equal(calls, 0)
    } finally {
      fixture.db.close()
    }
  })
})
