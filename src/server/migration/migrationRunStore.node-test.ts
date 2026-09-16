import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import {
  MIGRATION_PHASES,
  MigrationRunStore,
  MigrationRunStoreError,
} from './migrationRunStore.js'

function setup() {
  const db = new DatabaseSync(':memory:')
  let idSequence = 0
  let timeSequence = 0
  const store = new MigrationRunStore(db, {
    clock: () => 1_800_000_000_000 + ++timeSequence,
    idFactory: () => `migration-${++idSequence}`,
  })
  return { db, store }
}

describe('MigrationRunStore', () => {
  test('creates unique durable runs with normalized source metadata', () => {
    const { db, store } = setup()
    try {
      const first = store.createRun({
        sourceFingerprint: 'sha256:first',
        sourceMetadata: { z: 1, nested: { b: 2, a: 1 }, a: 2 },
      })
      const second = store.createRun({ sourceFingerprint: 'sha256:first', sourceMetadata: { a: 2 } })

      assert.equal(first.id, 'migration-1')
      assert.equal(first.status, 'planned')
      assert.equal(first.sourceMetadataJson, '{"a":2,"nested":{"a":1,"b":2},"z":1}')
      assert.equal(second.id, 'migration-2')
      assert.notEqual(first.id, second.id)
      assert.deepEqual(store.getRun(first.id), first)
    } finally {
      db.close()
    }
  })

  test('enforces the fixed phase order and records phase completion atomically', () => {
    const { db, store } = setup()
    try {
      const run = store.createRun({ sourceFingerprint: 'sha256:source', sourceMetadata: {} })
      assert.throws(
        () => store.beginPhase(run.id, MIGRATION_PHASES[1]),
        (error: unknown) => error instanceof MigrationRunStoreError && error.code === 'PHASE_ORDER_VIOLATION',
      )

      const started = store.beginPhase(run.id, MIGRATION_PHASES[0])
      assert.equal(started.status, 'running')
      assert.equal(store.getRun(run.id)?.status, 'running')

      store.completePhase(run.id, MIGRATION_PHASES[0], { imported: 3 })
      assert.deepEqual(store.getPhase(run.id, MIGRATION_PHASES[0]), {
        runId: run.id,
        phase: MIGRATION_PHASES[0],
        ordinal: 0,
        status: 'complete',
        result: { imported: 3 },
        error: null,
        startedAt: started.startedAt,
        completedAt: 1_800_000_000_003,
      })
      assert.equal(store.beginPhase(run.id, MIGRATION_PHASES[1]).ordinal, 1)
    } finally {
      db.close()
    }
  })

  test('keeps stable mappings idempotent and rejects source or target remapping', () => {
    const { db, store } = setup()
    try {
      const run = store.createRun({ sourceFingerprint: 'sha256:source', sourceMetadata: {} })
      const mapping = {
        runId: run.id,
        namespace: 'user',
        sourceId: '17',
        targetId: 'user-a',
        metadata: { method: 'verified_phone' },
      }
      store.putMapping(mapping)
      store.putMapping(mapping)
      assert.deepEqual(store.listMappings(run.id), [mapping])

      assert.throws(
        () => store.putMapping({ ...mapping, targetId: 'user-b' }),
        (error: unknown) => error instanceof MigrationRunStoreError && error.code === 'MAPPING_CONFLICT',
      )
      assert.throws(
        () => store.putMapping({ ...mapping, sourceId: '18' }),
        (error: unknown) => error instanceof MigrationRunStoreError && error.code === 'MAPPING_CONFLICT',
      )
    } finally {
      db.close()
    }
  })

  test('resumes failed and running runs only when the source fingerprint is unchanged', () => {
    const { db, store } = setup()
    try {
      const run = store.createRun({ sourceFingerprint: 'sha256:source', sourceMetadata: {} })
      store.beginPhase(run.id, MIGRATION_PHASES[0])
      assert.equal(store.requireResumableRun(run.id, 'sha256:source').status, 'running')
      assert.throws(
        () => store.requireResumableRun(run.id, 'sha256:changed'),
        (error: unknown) => error instanceof MigrationRunStoreError && error.code === 'SOURCE_FINGERPRINT_MISMATCH',
      )

      store.failPhase(run.id, MIGRATION_PHASES[0], {
        phase: MIGRATION_PHASES[0],
        code: 'SOURCE_READ_FAILED',
        severity: 'blocker',
        resourceType: 'organization',
        resourceId: '3',
        message: '源记录无法读取',
        detail: { table: 'enterprises' },
      })
      assert.equal(store.requireResumableRun(run.id, 'sha256:source').status, 'failed')
      assert.equal(store.listIssues(run.id).length, 1)

      store.beginPhase(run.id, MIGRATION_PHASES[0])
      store.completePhase(run.id, MIGRATION_PHASES[0], { recovered: true })
      for (const phase of MIGRATION_PHASES.slice(1)) {
        store.beginPhase(run.id, phase)
        store.completePhase(run.id, phase, {})
      }
      store.markVerified(run.id)
      assert.throws(
        () => store.requireResumableRun(run.id, 'sha256:source'),
        (error: unknown) => error instanceof MigrationRunStoreError && error.code === 'RUN_NOT_RESUMABLE',
      )
      assert.throws(
        () => store.requireResumableRun('missing', 'sha256:source'),
        (error: unknown) => error instanceof MigrationRunStoreError && error.code === 'RUN_NOT_FOUND',
      )
    } finally {
      db.close()
    }
  })

  test('records suppressed effects idempotently without turning them into deliverable work', () => {
    const { db, store } = setup()
    try {
      const run = store.createRun({ sourceFingerprint: 'sha256:source', sourceMetadata: {} })
      const effect = {
        runId: run.id,
        effectType: 'welcome_sms',
        resourceType: 'user',
        resourceId: '17',
        idempotencyKey: 'welcome:legacy-user-17',
        reason: 'migration context suppresses external effects',
      }
      store.recordSuppressedEffect(run.id, effect)
      store.recordSuppressedEffect(run.id, effect)
      assert.deepEqual(store.listSuppressedEffects(run.id), [effect])
      assert.equal(store.countDeliverableMigrationEffects(run.id), 0)
    } finally {
      db.close()
    }
  })

  test('stores immutable migration and verification reports', () => {
    const { db, store } = setup()
    try {
      const run = store.createRun({ sourceFingerprint: 'sha256:source', sourceMetadata: {} })
      store.saveReport(run.id, 'migration', 'sha256:report-a', '{"ok":true}', '# 迁移报告')
      store.saveReport(run.id, 'migration', 'sha256:report-a', '{"ok":true}', '# 迁移报告')
      assert.equal(store.getReport(run.id, 'migration')?.sha256, 'sha256:report-a')

      assert.throws(
        () => store.saveReport(run.id, 'migration', 'sha256:report-b', '{"ok":false}', '# 被覆盖'),
        (error: unknown) => error instanceof MigrationRunStoreError && error.code === 'REPORT_IMMUTABLE',
      )
    } finally {
      db.close()
    }
  })
})
