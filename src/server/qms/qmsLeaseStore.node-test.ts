import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PostgresQmsLeaseStore } from './qmsLeaseStore.js'
import type { QmsSqlPort } from './qmsSchema.js'

class LeaseSql implements QmsSqlPort {
  statements: Array<{ sql: string; parameters: readonly unknown[] }> = []
  acquireResult: readonly Record<string, unknown>[] = [{ owner_id: 'worker-a' }]

  async execute(sql: string, parameters: readonly unknown[] = []) {
    this.statements.push({ sql, parameters })
    return sql.includes('RETURNING owner_id') ? this.acquireResult : []
  }
}

describe('PostgresQmsLeaseStore', () => {
  it('acquires or takes over an expired task lease atomically', async () => {
    const db = new LeaseSql()
    const leases = new PostgresQmsLeaseStore(db)

    assert.equal(await leases.tryAcquire('alert-check', 'worker-a', 1_000, 500), true)
    assert.match(db.statements[0]!.sql, /ON CONFLICT \(task_name\) DO UPDATE/)
    assert.match(db.statements[0]!.sql, /lease_until <=/)
    assert.deepEqual(db.statements[0]!.parameters, ['alert-check', 'worker-a', 1_000, 1_500])
  })

  it('reports a lease held by another live owner as unavailable', async () => {
    const db = new LeaseSql()
    db.acquireResult = []
    const leases = new PostgresQmsLeaseStore(db)
    assert.equal(await leases.tryAcquire('alert-check', 'worker-b', 1_000, 500), false)
  })

  it('records completion and failure only for the current owner', async () => {
    const db = new LeaseSql()
    const leases = new PostgresQmsLeaseStore(db)

    await leases.complete('alert-check', 'worker-a', 2_000)
    await leases.fail('queue-process', 'worker-a', 'postgres unavailable', 3_000)

    assert.match(db.statements[0]!.sql, /owner_id = \$2/)
    assert.match(db.statements[1]!.sql, /last_error = \$3/)
  })
})
