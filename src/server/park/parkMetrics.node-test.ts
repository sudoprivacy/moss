import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { SqliteDriver } from '../db/driver.js'
import { ensureParkSchema } from './parkSchema.js'
import { MetricsService } from './metricsService.js'
import { ParkRepository } from './parkRepository.js'

void describe('parkMetrics', () => {
  void test('SQL 聚合不受列表 10000 条上限影响，按园区隔离且高分阈值生效', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=OFF')
    ensureParkSchema(db)
    try {
      db.prepare(`INSERT INTO park_enterprise_bindings
        (binding_id, park_org_id, enterprise_org_id, lifecycle, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 1)`).run('binding-1', 'park-1', 'ent-1', 'prospect')
      db.prepare(`INSERT INTO enterprise_profiles
        (enterprise_org_id, park_org_id, enterprise_name, created_at, updated_at)
        VALUES ('ent-1', 'park-1', '企业', 1, 1)`).run()
      const insertInquiry = db.prepare(`INSERT INTO inquiries
        (inquiry_id, park_org_id, enterprise_org_id, user_id, created_at)
        VALUES (?, ?, 'ent-1', 'user-1', 1)`)
      const insertLead = db.prepare(`INSERT INTO leads
        (lead_id, park_org_id, enterprise_org_id, source, score, status, idempotency_key, created_at, updated_at)
        VALUES (?, ?, 'ent-1', 'manual', ?, ?, ?, 1, 1)`)
      db.exec('BEGIN')
      for (let i = 0; i < 10_001; i += 1) {
        insertInquiry.run(`inquiry-${i}`, 'park-1')
        insertLead.run(`lead-${i}`, 'park-1', i === 0 ? 90 : 10, i === 0 ? 'confirmed' : 'proposed', `key-${i}`)
      }
      insertInquiry.run('other-inquiry', 'park-2')
      insertLead.run('other-lead', 'park-2', 100, 'converted', 'other-key')
      db.exec('COMMIT')

      const driver = new SqliteDriver(db)
      const metrics = await new MetricsService(driver).getMetrics('park-1')
      assert.deepEqual(metrics.totals, { enterprises: 1, inquiries: 10_001, leads: 10_001 })
      assert.equal(metrics.funnel.prospect, 1)
      assert.equal(metrics.lead_status.proposed, 10_000)
      assert.equal(metrics.lead_status.confirmed, 1)
      assert.equal(metrics.lead_status.converted ?? 0, 0)
      assert.deepEqual(metrics.high_score_leads.map(lead => lead.lead_id), ['lead-0'])
      const perEnterprise = await new ParkRepository(driver).countLeadsByEnterprise('park-1')
      assert.equal(perEnterprise['ent-1'], 10_001)
    } finally {
      db.close()
    }
  })
})
