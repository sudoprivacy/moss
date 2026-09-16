import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { MIGRATION_PHASES } from './migrationRunStore.js'
import { MigrationPhaseRegistry, type MigrationPhase } from './migrationPhaseRegistry.js'
import { createPhaseBackedMigrationChecks } from './phaseBackedMigrationChecks.js'
import type { SudoworkSourceSnapshot } from './sudoworkSourceSnapshot.js'

const snapshot: SudoworkSourceSnapshot = {
  fingerprint: 'source', capturedAt: '2026-09-08T00:00:00.000Z',
  sqlite: { name: 'sqlite', checksum: 'a', itemCount: 0, readOnly: true, metadata: {} },
  redis: { name: 'redis', checksum: 'b', itemCount: 0, readOnly: true, metadata: {} },
  qms: { name: 'qms', checksum: 'c', itemCount: 0, readOnly: true, metadata: {} },
  files: { name: 'files', checksum: 'd', itemCount: 0, readOnly: true, metadata: {} },
  includedDomains: [...MIGRATION_PHASES],
  excludedLocalData: ['sessions', 'client_cron', 'client_channels'],
}

describe('createPhaseBackedMigrationChecks', () => {
  test('十项门禁复用真实阶段校验，缓存查询并传播 mismatch', async () => {
    const calls = new Map<string, number>()
    const phases = MIGRATION_PHASES.map((name): MigrationPhase => ({
      name,
      async plan() { return { status: 'ready', issues: [] } },
      async execute() { return {} },
      async verify() {
        calls.set(name, (calls.get(name) ?? 0) + 1)
        return name === 'billing'
          ? { status: 'mismatch', issues: ['财务差异'] }
          : { status: 'matched', issues: [] }
      },
    }))
    const checks = createPhaseBackedMigrationChecks(new MigrationPhaseRegistry(phases))
    const results = await Promise.all(checks.map(check => check.verify({ runId: 'run-1', snapshot })))

    assert.equal(results[4]?.status, 'mismatch')
    assert.deepEqual(results[4]?.issues, ['billing: 财务差异'])
    assert.equal(results[0]?.status, 'matched')
    assert.deepEqual(Object.fromEntries(calls), Object.fromEntries(MIGRATION_PHASES.map(name => [name, 1])))
  })
})
