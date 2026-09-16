import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CrashServiceError,
  CrashService,
  generateCrashFingerprint,
  generateCrashIssueTitle,
  type CrashEvent,
} from './crashService.js'
import type { QmsSqlPort } from './qmsSchema.js'
import type { QmsTransactionalSqlPort } from './telemetryPostgresWriter.js'

class CrashSql implements QmsTransactionalSqlPort {
  statements: Array<{ sql: string; parameters: readonly unknown[] }> = []
  existingEvent: Record<string, unknown> | undefined
  existingIssue: Record<string, unknown> | undefined

  async execute(sql: string, parameters: readonly unknown[] = []) {
    this.statements.push({ sql, parameters })
    if (sql.includes('INSERT INTO qms_ingest_receipts')) {
      return this.existingEvent ? [] : [{ ingest_id: parameters[0] }]
    }
    if (sql.includes('FROM crash_events') && sql.includes('ingest_id')) return this.existingEvent ? [this.existingEvent] : []
    if (sql.includes('FROM crash_issues') && sql.includes('fingerprint')) return this.existingIssue ? [this.existingIssue] : []
    if (sql.includes('INSERT INTO crash_issues')) return [{ id: 41 }]
    return []
  }

  async transaction<T>(operation: (client: QmsSqlPort) => Promise<T>): Promise<T> {
    return operation(this)
  }
}

const event: CrashEvent = {
  type: 'js_exception', timestamp: 1_000, version: '1.0.0', platform: 'darwin', arch: 'arm64',
  tenant_id: 'tenant-a', process_type: 'renderer', error_name: 'TypeError',
  error_message: 'boom', stack_trace: 'at fn (/app/a.js:10:20)\nat run (/app/b.js:30:40)',
}

describe('CrashService', () => {
  it('keeps the legacy normalized stack fingerprint and issue title', () => {
    assert.equal(generateCrashFingerprint(event), 'TypeError:f5f14a8ff7962c26')
    assert.equal(generateCrashIssueTitle(event), 'TypeError: boom')
  })

  it('locks by tenant and fingerprint, creates one issue and inserts an idempotent event', async () => {
    const db = new CrashSql()
    const service = new CrashService({ db, tenants: { hasCode: code => code === 'tenant-a' } })

    const result = await service.ingest(event, 'event-1')

    assert.deepEqual(result, { issueId: 41, duplicate: false })
    assert.match(db.statements[0]!.sql, /pg_advisory_xact_lock/)
    assert.match(db.statements.at(-1)!.sql, /INSERT INTO crash_events/)
    assert.ok(db.statements.some(item => item.sql.includes('INSERT INTO qms_ingest_receipts')))
    assert.equal(db.statements.at(-1)!.parameters[0], 'event-1')
  })

  it('stores a symbolicated stack resolved for the event tenant and release', async () => {
    const db = new CrashSql()
    const calls: unknown[] = []
    const service = new CrashService({
      db,
      tenants: { hasCode: () => true },
      sourceMaps: {
        symbolicate: async input => {
          calls.push(input)
          return 'at fn (src/a.ts:1:2)'
        },
      },
    })

    await service.ingest(event, 'event-symbolicated')

    assert.deepEqual(calls, [{
      tenantId: 'tenant-a', version: '1.0.0', platform: 'darwin', stack: event.stack_trace,
    }])
    const insert = db.statements.find(item => item.sql.includes('INSERT INTO crash_events'))!
    assert.match(insert.sql, /symbolicated_stack/)
    assert.ok(insert.parameters.includes('at fn (src/a.ts:1:2)'))
  })

  it('returns the existing issue without incrementing when ingest id is replayed', async () => {
    const db = new CrashSql()
    db.existingEvent = { issue_id: 9 }
    const service = new CrashService({ db, tenants: { hasCode: () => true } })

    assert.deepEqual(await service.ingest(event, 'event-1'), { issueId: 9, duplicate: true })
    assert.equal(db.statements.some(item => item.sql.includes('UPDATE crash_issues')), false)
    assert.equal(db.statements.some(item => item.sql.includes('INSERT INTO crash_issues')), false)
  })

  it('rejects missing required fields and unknown tenants before opening a transaction', async () => {
    const db = new CrashSql()
    const service = new CrashService({ db, tenants: { hasCode: () => false } })

    await assert.rejects(() => service.ingest({ ...event, tenant_id: '' }, 'x'), /tenant_id/)
    await assert.rejects(() => service.ingest(event, 'x'), /Unknown QMS tenant/)
    assert.equal(db.statements.length, 0)
  })

  it('validates the entire batch before writing any event', async () => {
    const db = new CrashSql()
    const service = new CrashService({ db, tenants: { hasCode: code => code === 'tenant-a' } })

    await assert.rejects(async () => {
      await service.ingestBatch([event, { ...event, tenant_id: 'unknown' }])
    }, (error: unknown) => {
      assert(error instanceof CrashServiceError)
      assert.equal(error.status, 400)
      assert.equal(error.code, 'TENANT_NOT_FOUND')
      assert.deepEqual(error.items, ['events[1]'])
      return true
    })

    assert.equal(db.statements.length, 0)
  })

  it('keeps legacy partial batch handling for malformed events after tenant validation', async () => {
    const db = new CrashSql()
    const service = new CrashService({ db, tenants: { hasCode: () => true } })

    const result = await service.ingestBatch([event, { ...event, type: '' as CrashEvent['type'] }])

    assert.equal(result.received, 1)
    assert.deepEqual(result.errors, ['Invalid event: missing required fields'])
  })

  it('scopes issue and event queries to the authorized tenant', async () => {
    const db = new CrashSql()
    const service = new CrashService({ db, tenants: { hasCode: () => true } })

    await service.listIssues({ tenantId: 'tenant-a', status: 'unresolved', limit: 20, offset: 5 })
    await service.listEvents({ tenantId: 'tenant-a', issueId: 2, limit: 10, offset: 0 })

    assert.match(db.statements[0]!.sql, /tenant_id = \$/)
    assert.equal(db.statements[0]!.parameters.includes('tenant-a'), true)
    assert.match(db.statements[2]!.sql, /tenant_id = \$/)
    assert.equal(db.statements[2]!.parameters.includes('tenant-a'), true)
  })

  it('restricts distribution dimensions to the legacy allowlist', async () => {
    const db = new CrashSql()
    const service = new CrashService({ db, tenants: { hasCode: () => true } })
    await assert.rejects(() => service.distribution('tenant-a', 'tenant_id' as 'type'), /Invalid 'by' parameter/)
    assert.equal(db.statements.length, 0)
  })

  it('reads crash trends from daily aggregates within the authorized tenant', async () => {
    const db = new CrashSql()
    db.execute = async (sql, parameters = []) => {
      db.statements.push({ sql, parameters })
      if (sql.includes('FROM crash_daily_stats')) return [{ date: new Date('2026-09-06T00:00:00Z'), type: 'js_exception', count: '2' }]
      return []
    }
    const service = new CrashService({ db, tenants: { hasCode: () => true } })

    const result = await service.trend(7, 'tenant-a', new Date('2026-09-07T00:00:00Z'))

    assert.deepEqual(result, [{ date: '2026-09-06', type: 'js_exception', count: 2 }])
    assert.match(db.statements[0]!.sql, /tenant_id = \$2/)
  })
})
