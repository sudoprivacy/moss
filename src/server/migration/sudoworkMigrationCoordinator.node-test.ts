import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { MigrationPhaseRegistry, type MigrationPhase } from './migrationPhaseRegistry.js'
import { MIGRATION_PHASES, MigrationRunStore } from './migrationRunStore.js'
import {
  SudoworkMigrationBlockedError,
  SudoworkMigrationCoordinator,
} from './sudoworkMigrationCoordinator.js'
import type { SudoworkSourceSnapshot } from './sudoworkSourceSnapshot.js'

function snapshot(fingerprint = 'sha256:source'): SudoworkSourceSnapshot {
  const component = (name: 'sqlite' | 'redis' | 'qms' | 'files') => ({
    name, checksum: `${name}-checksum`, itemCount: 1, readOnly: true, metadata: {},
  })
  return {
    fingerprint,
    capturedAt: '2026-09-08T00:00:00.000Z',
    sqlite: component('sqlite'), redis: component('redis'), qms: component('qms'), files: component('files'),
    includedDomains: [...MIGRATION_PHASES],
    excludedLocalData: ['sessions', 'client_cron', 'client_channels'],
  }
}

function setup(options: {
  blockedPhase?: string
  failingPhase?: string
  finalVerificationStatus?: 'matched' | 'mismatch'
} = {}) {
  const db = new DatabaseSync(':memory:')
  const runs = new MigrationRunStore(db, { idFactory: () => 'run-main', clock: () => 1_800_000_000_000 })
  const calls: string[] = []
  const phases = MIGRATION_PHASES.map((name): MigrationPhase => ({
    name,
    async plan() {
      calls.push(`plan:${name}`)
      return {
        status: options.blockedPhase === name ? 'blocked' : 'ready',
        issues: options.blockedPhase === name ? [{ code: 'BLOCKED', message: name }] : [],
      }
    },
    async execute(context) {
      calls.push(`execute:${name}:${context.commandContext(`item:${name}`).source}`)
      if (options.failingPhase === name) throw new Error(`failed:${name}`)
      return { imported: 1 }
    },
    async verify() {
      calls.push(`verify:${name}`)
      return { status: 'matched', issues: [] }
    },
  }))
  let current = snapshot()
  const source = {
    capture: async () => current,
    assertUnchanged: async (expected: string) => {
      if (current.fingerprint !== expected) throw new Error('source changed')
    },
  }
  const finalVerifier = options.finalVerificationStatus
    ? {
        async verify(runId: string, sourceSnapshot: SudoworkSourceSnapshot) {
          const mismatch = options.finalVerificationStatus === 'mismatch'
          return {
            runId,
            sourceFingerprint: sourceSnapshot.fingerprint,
            status: mismatch ? 'mismatch' as const : 'matched' as const,
            checks: [],
            issues: mismatch ? ['最终门禁失败'] : [],
            suppressedEffects: { count: 0, deliverableCount: 0 },
          }
        },
      }
    : undefined
  const coordinator = new SudoworkMigrationCoordinator({
    runs, source, phases: new MigrationPhaseRegistry(phases), finalVerifier,
  })
  return { db, runs, calls, coordinator, setSnapshot: (value: SudoworkSourceSnapshot) => { current = value } }
}

describe('SudoworkMigrationCoordinator', () => {
  test('plans every phase in fixed order and does not create a run when any phase is blocked', async () => {
    const fixture = setup({ blockedPhase: 'billing' })
    try {
      const dryRun = await fixture.coordinator.dryRun()
      assert.equal(dryRun.status, 'blocked')
      assert.deepEqual(fixture.calls, MIGRATION_PHASES.map(name => `plan:${name}`))
      await assert.rejects(fixture.coordinator.execute(), SudoworkMigrationBlockedError)
      assert.equal(fixture.runs.getRun('run-main'), null)
      assert.equal(fixture.calls.some(call => call.startsWith('execute:')), false)
    } finally {
      fixture.db.close()
    }
  })

  test('executes all phases in order with trusted migration contexts and verifies the run', async () => {
    const fixture = setup()
    try {
      const report = await fixture.coordinator.execute()
      assert.equal(report.runId, 'run-main')
      assert.deepEqual(
        fixture.calls.filter(call => call.startsWith('execute:')),
        MIGRATION_PHASES.map(name => `execute:${name}:migration`),
      )
      assert.equal(fixture.runs.listPhases('run-main').every(phase => phase.status === 'complete'), true)

      const verified = await fixture.coordinator.verify('run-main')
      assert.equal(verified.status, 'matched')
      assert.equal(fixture.runs.getRun('run-main')?.status, 'verified')
    } finally {
      fixture.db.close()
    }
  })

  test('最终门禁 mismatch 时不得把批次标记为 verified', async () => {
    const fixture = setup({ finalVerificationStatus: 'mismatch' })
    try {
      await fixture.coordinator.execute()
      const verified = await fixture.coordinator.verify('run-main')
      assert.equal(verified.status, 'mismatch')
      assert.deepEqual(verified.finalVerification?.issues, ['最终门禁失败'])
      assert.notEqual(fixture.runs.getRun('run-main')?.status, 'verified')
    } finally {
      fixture.db.close()
    }
  })

  test('persists a failed checkpoint, skips completed phases on resume, and never starts later phases early', async () => {
    const fixture = setup({ failingPhase: 'configuration' })
    try {
      await assert.rejects(fixture.coordinator.execute(), /failed:configuration/)
      assert.equal(fixture.runs.getRun('run-main')?.status, 'failed')
      assert.equal(fixture.runs.getPhase('run-main', 'catalog')?.status, 'complete')
      assert.equal(fixture.runs.getPhase('run-main', 'configuration')?.status, 'failed')
      assert.equal(fixture.runs.getPhase('run-main', 'dify'), null)

      const resumedCalls: string[] = []
      const phases = MIGRATION_PHASES.map((name): MigrationPhase => ({
        name,
        async plan() { return { status: 'ready', issues: [] } },
        async execute() { resumedCalls.push(name); return { imported: 1 } },
        async verify() { return { status: 'matched', issues: [] } },
      }))
      const resumed = new SudoworkMigrationCoordinator({
        runs: fixture.runs,
        source: { capture: async () => snapshot(), assertUnchanged: async () => undefined },
        phases: new MigrationPhaseRegistry(phases),
      })
      await resumed.resume('run-main')
      assert.deepEqual(resumedCalls, MIGRATION_PHASES.slice(MIGRATION_PHASES.indexOf('configuration')))
    } finally {
      fixture.db.close()
    }
  })

  test('refuses resume and verify when the frozen source fingerprint changed', async () => {
    const fixture = setup({ failingPhase: 'organizations' })
    try {
      await assert.rejects(fixture.coordinator.execute(), /failed:organizations/)
      fixture.setSnapshot(snapshot('sha256:changed'))
      await assert.rejects(fixture.coordinator.resume('run-main'), /指纹|fingerprint/i)
      await assert.rejects(fixture.coordinator.verify('run-main'), /指纹|fingerprint/i)
    } finally {
      fixture.db.close()
    }
  })
})

describe('MigrationPhaseRegistry', () => {
  test('rejects missing, duplicate, unknown, or reordered phases', () => {
    const phase = (name: string) => ({ name, plan: async () => ({ status: 'ready' as const, issues: [] }), execute: async () => ({}), verify: async () => ({ status: 'matched' as const, issues: [] }) })
    assert.throws(() => new MigrationPhaseRegistry(MIGRATION_PHASES.slice(0, -1).map(phase) as MigrationPhase[]), /阶段清单/)
    assert.throws(() => new MigrationPhaseRegistry([...MIGRATION_PHASES.slice(0, -1), 'organizations'].map(phase) as MigrationPhase[]), /阶段清单/)
    assert.throws(() => new MigrationPhaseRegistry([...MIGRATION_PHASES].reverse().map(phase) as MigrationPhase[]), /阶段顺序/)
  })
})
