import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { migrationCommandContext } from '../application/commandContext.js'
import {
  AutomationMigrationPhase,
  SudoworkAutomationSourceReader,
} from './automationMigrationPhase.js'
import type { SudoworkSourceSnapshot } from './sudoworkSourceSnapshot.js'

function fixture(sql = ''): { directory: string; db: DatabaseSync } {
  const directory = mkdtempSync(join(tmpdir(), 'moss-automation-source-'))
  const db = new DatabaseSync(join(directory, 'sudowork.sqlite'))
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    ${sql}
  `)
  return { directory, db }
}

function snapshot(overrides: Partial<SudoworkSourceSnapshot> = {}): SudoworkSourceSnapshot {
  return {
    fingerprint: 'source-fingerprint',
    capturedAt: '2026-09-08T00:00:00.000Z',
    sqlite: { name: 'sqlite', checksum: 'sqlite', itemCount: 1, readOnly: true, metadata: {} },
    redis: { name: 'redis', checksum: 'redis', itemCount: 0, readOnly: true, metadata: {} },
    qms: { name: 'qms', checksum: 'qms', itemCount: 0, readOnly: true, metadata: {} },
    files: { name: 'files', checksum: 'files', itemCount: 0, readOnly: true, metadata: {} },
    includedDomains: [
      'organizations', 'identities', 'governance', 'catalog', 'configuration',
      'dify', 'billing', 'automation', 'qms', 'access',
    ],
    excludedLocalData: ['sessions', 'client_cron', 'client_channels'],
    ...overrides,
  }
}

describe('AutomationMigrationPhase', () => {
  test('旧服务端没有持久自动化数据时记录可审计的零迁移证据', async () => {
    const { directory, db } = fixture()
    db.close()
    try {
      const phase = new AutomationMigrationPhase(new SudoworkAutomationSourceReader(directory))
      const source = snapshot()
      const plan = await phase.plan({ snapshot: source })

      assert.equal(plan.status, 'ready')
      assert.deepEqual(plan.issues, [])
      assert.deepEqual(plan.excludedLocalData, ['sessions', 'client_cron', 'client_channels'])
      assert.deepEqual(plan.detectedTables, [])

      const result = await phase.execute({
        runId: 'run-1',
        snapshot: source,
        commandContext: key => migrationCommandContext('run-1', key),
      }, plan)
      assert.deepEqual(result, {
        migrated: 0,
        detectedTables: [],
        excludedLocalData: ['sessions', 'client_cron', 'client_channels'],
      })
      assert.deepEqual(await phase.verify({ runId: 'run-1', snapshot: source }), {
        status: 'matched',
        issues: [],
        migrated: 0,
        detectedTables: [],
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('发现含数据的旧服务端自动化表时阻断，不能把未支持数据当作空迁移', async () => {
    const { directory, db } = fixture(`
      CREATE TABLE cron_jobs (id INTEGER PRIMARY KEY, expression TEXT);
      INSERT INTO cron_jobs VALUES (1, '0 * * * *');
      CREATE TABLE channel_configs (id INTEGER PRIMARY KEY);
    `)
    db.close()
    try {
      const phase = new AutomationMigrationPhase(new SudoworkAutomationSourceReader(directory))
      const plan = await phase.plan({ snapshot: snapshot() })
      assert.equal(plan.status, 'blocked')
      assert.deepEqual(plan.detectedTables, [
        { name: 'channel_configs', rowCount: 0 },
        { name: 'cron_jobs', rowCount: 1 },
      ])
      assert.equal(plan.issues[0]?.code, 'UNSUPPORTED_SERVER_AUTOMATION_DATA')
      await assert.rejects(
        () => phase.execute({
          runId: 'run-1', snapshot: snapshot(),
          commandContext: key => migrationCommandContext('run-1', key),
        }, plan),
        /预检未通过/,
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('本地数据排除声明不完整时阻断', async () => {
    const { directory, db } = fixture()
    db.close()
    try {
      const phase = new AutomationMigrationPhase(new SudoworkAutomationSourceReader(directory))
      const source = snapshot({ excludedLocalData: ['sessions', 'client_cron'] as never })
      const plan = await phase.plan({ snapshot: source })
      assert.equal(plan.status, 'blocked')
      assert.equal(plan.issues[0]?.code, 'LOCAL_AUTOMATION_EXCLUSION_MISSING')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('执行前自动化源扫描结果变化时拒绝执行', async () => {
    const { directory, db } = fixture()
    db.close()
    try {
      const phase = new AutomationMigrationPhase(new SudoworkAutomationSourceReader(directory))
      const source = snapshot()
      const plan = await phase.plan({ snapshot: source })
      const changed = new DatabaseSync(join(directory, 'sudowork.sqlite'))
      changed.exec('CREATE TABLE scheduled_tasks (id INTEGER PRIMARY KEY); INSERT INTO scheduled_tasks VALUES (1)')
      changed.close()

      await assert.rejects(
        () => phase.execute({
          runId: 'run-1', snapshot: source,
          commandContext: key => migrationCommandContext('run-1', key),
        }, plan),
        /扫描结果已变化/,
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
