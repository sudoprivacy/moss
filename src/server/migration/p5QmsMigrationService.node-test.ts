import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { migrationCommandContext, onlineCommandContext } from '../application/commandContext.js'
import type { QmsSchemaState } from '../qms/qmsSchema.js'
import {
  P5QmsMigrationBlockedError,
  P5QmsMigrationService,
  type P5QmsMigrationTarget,
  type P5QmsTargetCheckpoint,
  type P5QmsWriteBatch,
} from './p5QmsMigrationService.js'
import {
  canonicalQmsRow,
  P5_QMS_TABLES,
  P5_QMS_TABLE_SPECS,
  type P5QmsSourceSnapshot,
  type P5QmsTableName,
} from './sudoworkP5QmsSourceReader.js'

type Row = Record<string, unknown>

class FakeSource {
  revision = 1
  constructor(readonly rows: Partial<Record<P5QmsTableName, Row[]>>) {}

  async inspect(): Promise<P5QmsSourceSnapshot> {
    const tables = {} as P5QmsSourceSnapshot['tables']
    for (const table of P5_QMS_TABLES) {
      const sourceRows = this.rows[table] ?? []
      const spec = P5_QMS_TABLE_SPECS[table]
      const columns = [...new Set([...spec.requiredColumns, ...sourceRows.flatMap(row => Object.keys(row))])]
      const times = spec.timeColumn
        ? sourceRows.map(row => new Date(String(row[spec.timeColumn!] ?? 0)).toISOString()).sort()
        : []
      tables[table] = {
        exists: true,
        relationKind: spec.derivedAggregate ? 'r' : 'r',
        columns,
        count: sourceRows.length,
        checksum: digest(sourceRows),
        tenants: [...new Set(sourceRows.map(row => String(row.tenant_id ?? '')).filter(Boolean))].sort(),
        minTime: times[0] ?? null,
        maxTime: times.at(-1) ?? null,
      }
    }
    return {
      timescaleAvailable: false,
      aggregateMode: 'regular',
      checksum: digest([this.revision, ...P5_QMS_TABLES.map(table => tables[table].checksum)]),
      tables,
    }
  }

  async readBatch(table: P5QmsTableName, offset: number, limit: number): Promise<readonly Row[]> {
    return (this.rows[table] ?? []).slice(offset, offset + limit)
  }
}

class FakeTarget implements P5QmsMigrationTarget {
  readonly rows = new Map<P5QmsTableName, Row[]>()
  readonly receipts: Row[] = []
  readonly checkpoints = new Map<string, P5QmsTargetCheckpoint>()
  readonly writes: P5QmsWriteBatch[] = []
  readonly refreshed: Array<{ start: Date; end: Date }> = []
  externalCalls = 0

  constructor(readonly state: QmsSchemaState = { timescaleAvailable: false, continuousAggregates: false }) {}
  schemaState() { return Promise.resolve(this.state) }
  count(table: P5QmsTableName) { return Promise.resolve(this.rows.get(table)?.length ?? 0) }
  checkpoint(migrationId: string, table: P5QmsTableName) {
    return Promise.resolve(this.checkpoints.get(`${migrationId}:${table}`) ?? null)
  }
  async writeBatch(input: P5QmsWriteBatch) {
    this.writes.push(input)
    const current = this.rows.get(input.table) ?? []
    current.push(...input.rows.map(row => ({ ...row })))
    this.rows.set(input.table, current)
    this.receipts.push(...input.receipts)
    this.checkpoints.set(`${input.migrationId}:${input.table}`, {
      sourceChecksum: input.sourceChecksum,
      offset: input.nextOffset,
      migratedRows: input.migratedRows,
      status: input.complete ? 'complete' : 'running',
    })
  }
  readBatch(table: P5QmsTableName, columns: readonly string[], offset: number, limit: number) {
    return Promise.resolve((this.rows.get(table) ?? []).slice(offset, offset + limit)
      .map(row => Object.fromEntries(columns.map(column => [column, row[column]]))))
  }
  async resetSequence() {}
  async refreshContinuousAggregates(start: Date, end: Date) { this.refreshed.push({ start, end }) }
  async summary(table: P5QmsTableName, timeColumn: string) {
    const rows = this.rows.get(table) ?? []
    const times = rows.map(row => row[timeColumn]).filter(value => value != null)
      .map(value => new Date(String(value)).toISOString()).sort()
    return { count: rows.length, minTime: times[0] ?? null, maxTime: times.at(-1) ?? null }
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function validRows(): Partial<Record<P5QmsTableName, Row[]>> {
  return {
    telemetry_perf_raw: [{
      id: 1, timestamp: new Date('2026-09-01T01:00:00Z'), version: '1.0.0', platform: 'darwin',
      tenant_id: 'ENT-A', metric: 'startup', value_ms: 120, created_at: new Date('2026-09-01T01:00:01Z'),
    }],
    crash_issues: [{
      id: 7, fingerprint: 'fp-7', tenant_id: 'ENT-A', title: 'boom', type: 'main', level: 'error',
      count: 1, first_seen: new Date('2026-09-01T02:00:00Z'), last_seen: new Date('2026-09-01T02:00:00Z'), status: 'unresolved',
    }],
    crash_events: [{
      id: 8, timestamp: new Date('2026-09-01T02:00:00Z'), version: '1.0.0', platform: 'darwin',
      tenant_id: 'ENT-A', process_type: 'main', type: 'uncaughtException', fingerprint: 'fp-7', issue_id: 7,
    }],
    source_maps: [{
      id: 4, version: '1.0.0', platform: 'darwin', file_name: 'main.js', map_content: '{}',
      uploaded_at: new Date('2026-09-01T00:00:00Z'),
    }],
  }
}

describe('P5 QMS 数据迁移', () => {
  it('按批次迁移、生成稳定 ingest receipt、写 checkpoint 并可幂等重跑', async () => {
    const source = new FakeSource(validRows())
    const target = new FakeTarget()
    const service = new P5QmsMigrationService({
      source,
      target,
      organizations: { hasCode: code => code === 'ENT-A' },
      batchSize: 1,
    })

    const plan = await service.plan()
    assert.equal(plan.status, 'ready')
    const first = await service.execute(plan, migrationCommandContext('cutover-1', 'p5:execute'))
    const second = await service.execute(await service.plan(), migrationCommandContext('cutover-2', 'p5:rerun'))

    assert.equal(first.status, 'matched')
    assert.equal(second.status, 'matched')
    assert.equal(target.rows.get('telemetry_perf_raw')?.length, 1)
    assert.equal(target.rows.get('crash_events')?.length, 1)
    assert.equal(target.receipts.length, 2)
    assert(target.receipts.every(row => String(row.ingest_id).startsWith('migration:p5:')))
    assert.equal(target.externalCalls, 0)
    assert(target.writes.some(write => write.complete))
  })

  it('预检同时阻断未知企业、明文密钥、孤立 Crash 和重复聚合，且零写入', async () => {
    const rows = validRows()
    rows.system_config = [{ key: 'notification_email_smtp_pass', value: 'plaintext-secret', updated_at: new Date() }]
    rows.crash_events![0] = { ...rows.crash_events![0], issue_id: 999, tenant_id: 'UNKNOWN' }
    const aggregate = {
      id: 1, bucket: new Date('2026-09-01T00:00:00Z'), version: '1', platform: 'darwin', arch: 'arm64',
      tenant_id: 'ENT-A', metric: 'startup', count: 1,
    }
    rows.telemetry_perf_daily = [aggregate, { ...aggregate, id: 2 }]
    const target = new FakeTarget()
    const service = new P5QmsMigrationService({ source: new FakeSource(rows), target, organizations: { hasCode: () => false } })

    const plan = await service.plan()
    assert.equal(plan.status, 'blocked')
    for (const code of ['UNKNOWN_ORGANIZATION', 'PLAINTEXT_SECRET', 'ORPHAN_CRASH_ISSUE', 'DUPLICATE_SOURCE_IDENTITY']) {
      assert(plan.issues.some(issue => issue.code === code), code)
    }
    await assert.rejects(
      service.execute(plan, migrationCommandContext('blocked', 'p5:blocked')),
      P5QmsMigrationBlockedError,
    )
    assert.equal(target.writes.length, 0)
  })

  it('拒绝在线上下文以及预检后发生变化的源库', async () => {
    const source = new FakeSource(validRows())
    const service = new P5QmsMigrationService({
      source,
      target: new FakeTarget(),
      organizations: { hasCode: () => true },
    })
    const plan = await service.plan()
    await assert.rejects(service.execute(plan, onlineCommandContext('bad')), /迁移上下文/)
    source.revision += 1
    await assert.rejects(
      service.execute(plan, migrationCommandContext('changed', 'p5:changed')),
      /源快照在预检后发生变化/,
    )
  })

  it('目标存在非本次 checkpoint 管理的数据时阻断覆盖', async () => {
    const target = new FakeTarget()
    target.rows.set('source_maps', [{ id: 99 }])
    const service = new P5QmsMigrationService({
      source: new FakeSource(validRows()),
      target,
      organizations: { hasCode: () => true },
    })

    const plan = await service.plan()
    assert(plan.issues.some(issue => issue.code === 'TARGET_CONFLICT' && issue.table === 'source_maps'))
  })

  it('checkpoint 游标与目标行数不一致时在写入前阻断', async () => {
    const source = new FakeSource(validRows())
    const snapshot = await source.inspect()
    const target = new FakeTarget()
    target.rows.set('source_maps', [{ id: 4 }, { id: 99 }])
    target.checkpoints.set('sudowork-p5-qms-v1:source_maps', {
      sourceChecksum: snapshot.tables.source_maps.checksum,
      offset: 1,
      migratedRows: 1,
      status: 'running',
    })
    const service = new P5QmsMigrationService({ source, target, organizations: { hasCode: () => true } })

    const plan = await service.plan()

    assert(plan.issues.some(issue => issue.code === 'TARGET_CONFLICT' && issue.table === 'source_maps'))
    assert.equal(target.writes.length, 0)
  })
})
