import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { MigrationReportWriter } from './migrationReportWriter.js'
import { MigrationRunStore, MigrationRunStoreError } from './migrationRunStore.js'

describe('MigrationReportWriter', () => {
  test('writes immutable canonical JSON and Chinese Markdown and registers their digest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moss-migration-report-'))
    const db = new DatabaseSync(':memory:')
    const runs = new MigrationRunStore(db, { idFactory: () => 'run-report', clock: () => 1_800_000_000_000 })
    runs.createRun({ sourceFingerprint: 'sha256:source', sourceMetadata: {} })
    const writer = new MigrationReportWriter(runs)
    const report = {
      schemaVersion: 1 as const,
      kind: 'migration' as const,
      runId: 'run-report',
      generatedAt: '2026-09-08T00:00:00.000Z',
      sourceFingerprint: 'sha256:source',
      status: 'blocked' as const,
      summary: { users: 2, organizations: 1 },
      issues: ['钱包差异 1'],
      suppressedEffects: {
        count: 1,
        deliverableCount: 0,
        items: [{
          effectType: 'sms', resourceType: 'user', resourceId: 'user-1',
          idempotencyKey: 'welcome:user-1', reason: 'migration context',
        }],
      },
      productionGates: [{ name: '真实客户端矩阵', status: 'pending' as const }],
    }
    try {
      const first = await writer.write(report, directory)
      const replay = await writer.write(report, directory)
      assert.deepEqual(replay, first)
      assert.match(await readFile(first.markdownPath, 'utf8'), /# Sudowork 到 Moss 迁移报告/)
      assert.match(await readFile(first.markdownPath, 'utf8'), /钱包差异 1/)
      assert.match(await readFile(first.markdownPath, 'utf8'), /welcome:user-1/)
      assert.equal(JSON.parse(await readFile(first.jsonPath, 'utf8')).runId, 'run-report')
      assert.equal(runs.getReport('run-report', 'migration')?.sha256, first.sha256)

      await assert.rejects(
        writer.write({ ...report, status: 'matched', issues: [] }, directory),
        (error: unknown) => error instanceof MigrationRunStoreError && error.code === 'REPORT_IMMUTABLE',
      )
    } finally {
      db.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
