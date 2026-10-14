import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { SqliteDriver } from '../db/driver.js'
import { ensureParkSchema } from './parkSchema.js'
import { ParkAuditService } from './parkAuditService.js'
import { ParkRepository } from './parkRepository.js'

void describe('parkAudit', () => {
  void test('状态变更审计保存操作人、理由及前后摘要，记录不可改删', async () => {
    const db = new DatabaseSync(':memory:')
    ensureParkSchema(db)
    try {
      const driver = new SqliteDriver(db)
      const audit = new ParkAuditService(driver)
      await audit.record({
        parkOrgId: 'park-1', actorUserId: 'ops-1', actorOrgId: 'park-1',
        action: 'park.lead_transition', targetType: 'lead', targetId: 'lead-1',
        reason: '重复线索', before: { status: 'proposed' }, after: { status: 'rejected' },
      })
      const rows = await new ParkRepository(driver).listAuditEvents({ parkOrgId: 'park-1', actorUserId: 'ops-1' })
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.reason, '重复线索')
      assert.deepEqual(JSON.parse(rows[0]!.beforeSummaryJson!), { status: 'proposed' })
      assert.deepEqual(JSON.parse(rows[0]!.afterSummaryJson!), { status: 'rejected' })
      assert.equal((await new ParkRepository(driver).listAuditEvents({ parkOrgId: 'park-1', actorUserId: 'other' })).length, 0)
      assert.throws(() => db.prepare('UPDATE park_audit_events SET reason = ? WHERE audit_id = ?').run('changed', rows[0]!.auditId), /append-only/)
      assert.throws(() => db.prepare('DELETE FROM park_audit_events WHERE audit_id = ?').run(rows[0]!.auditId), /append-only/)
    } finally {
      db.close()
    }
  })
})
