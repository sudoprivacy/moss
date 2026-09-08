import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { QmsSqlPort } from '../qms/qmsSchema.js'
import {
  P5_QMS_TABLES,
  SudoworkP5QmsSourceReader,
} from './sudoworkP5QmsSourceReader.js'

class FakeSourceDatabase implements QmsSqlPort {
  readonly queries: Array<{ sql: string; parameters: readonly unknown[] }> = []
  readonly rows = [
    { id: 2, timestamp: new Date('2026-01-02T00:00:00Z'), tenant_id: 'ENT-A', metric: 'cold_start' },
    { id: 1, timestamp: new Date('2026-01-01T00:00:00Z'), tenant_id: 'ENT-A', metric: 'cold_start' },
  ]

  async execute(sql: string, parameters: readonly unknown[] = []): Promise<readonly Record<string, unknown>[]> {
    this.queries.push({ sql, parameters })
    if (sql.includes('FROM pg_extension')) return [{ available: true }]
    if (sql.includes('FROM pg_class') && parameters[0] === 'telemetry_perf_raw') return [{ relkind: 'r' }]
    if (sql.includes('FROM pg_class')) return []
    if (sql.includes('FROM information_schema.columns')) {
      return ['id', 'timestamp', 'tenant_id', 'metric'].map(column_name => ({ column_name }))
    }
    if (sql.includes('FROM "telemetry_perf_raw"')) {
      const offset = Number(parameters[0])
      const limit = Number(parameters[1])
      return this.rows.slice(offset, offset + limit)
    }
    throw new Error(`Unexpected query: ${sql}`)
  }
}

describe('Sudowork P5 QMS 只读源快照', () => {
  it('只读取固定白名单、稳定分页并生成不暴露数据的确定性摘要', async () => {
    const db = new FakeSourceDatabase()
    const reader = new SudoworkP5QmsSourceReader(db)

    const first = await reader.inspect(1)
    const second = await reader.inspect(2)

    assert.equal(first.timescaleAvailable, true)
    assert.equal(first.tables.telemetry_perf_raw.count, 2)
    assert.deepEqual(first.tables.telemetry_perf_raw.tenants, ['ENT-A'])
    assert.equal(first.tables.telemetry_perf_raw.minTime, '2026-01-01T00:00:00.000Z')
    assert.equal(first.tables.telemetry_perf_raw.maxTime, '2026-01-02T00:00:00.000Z')
    assert.equal(first.checksum, second.checksum)
    assert.equal(first.checksum.length, 64)
    assert.equal(JSON.stringify(first).includes('cold_start'), false)
    assert.equal(Object.keys(first.tables).length, P5_QMS_TABLES.length)
    assert(db.queries.every(query => !/DROP|UPDATE|INSERT|DELETE/i.test(query.sql)))
  })

  it('拒绝读取白名单外的数据表', async () => {
    const reader = new SudoworkP5QmsSourceReader(new FakeSourceDatabase())
    await assert.rejects(
      reader.readBatch('users' as never, 0, 100),
      /不允许读取 QMS 白名单外数据表/,
    )
  })
})
