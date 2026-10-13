import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { ensureIdentitySchema } from '../identity/identityRepository.js'
import { ensureParkSchema } from './parkSchema.js'

function setup(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  new AuthCenterDb(db)
  ensureIdentitySchema(db)
  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('org1', 'Org 1', 1)").run()
  db.prepare(`
    INSERT INTO users (id, org_id, email, name, role, status, local_auth, created_at)
    VALUES ('u1', 'org1', 'u1@example.test', 'U1', 'user', 'active', 1, 1)
  `).run()
  return db
}

void describe('Park Schema', () => {
  void test('可重复初始化完整的园区业务表', () => {
    const db = setup()
    ensureParkSchema(db)
    ensureParkSchema(db)

    const tables = (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'park_org_profiles', 'park_enterprise_bindings', 'park_members',
        'enterprise_profiles', 'inquiries', 'leads', 'lead_watches',
        'park_assistant_assignments', 'park_audit_events', 'exit_cases'
      )
      ORDER BY name
    `).all() as Array<{ name: string }>).map(row => row.name)
    assert.deepEqual(tables, [
      'enterprise_profiles',
      'exit_cases',
      'inquiries',
      'lead_watches',
      'leads',
      'park_assistant_assignments',
      'park_audit_events',
      'park_enterprise_bindings',
      'park_members',
      'park_org_profiles',
    ])
    db.close()
  })

  void test('拒绝非法枚举值', () => {
    const db = setup()
    ensureParkSchema(db)

    assert.throws(() => db.prepare(`
      INSERT INTO park_org_profiles (moss_org_id, org_type, display_name, created_at, updated_at)
      VALUES ('org1', 'vendor', 'X', 1, 1)
    `).run(), /CHECK constraint failed/)

    assert.throws(() => db.prepare(`
      INSERT INTO park_members (id, park_org_id, user_id, park_role, created_at)
      VALUES ('m1', 'org1', 'u1', 'ceo', 1)
    `).run(), /CHECK constraint failed/)

    assert.throws(() => db.prepare(`
      INSERT INTO leads (lead_id, park_org_id, enterprise_org_id, source, status, idempotency_key, created_at, updated_at)
      VALUES ('l1', 'org1', 'org1', 'inquiry', 'closed', 'k1', 1, 1)
    `).run(), /CHECK constraint failed/)
    db.close()
  })

  void test('默认园区唯一：第二个默认园区被拒绝', () => {
    const db = setup()
    ensureParkSchema(db)
    db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('org2', 'Org 2', 1)").run()
    db.prepare(`
      INSERT INTO park_org_profiles (moss_org_id, org_type, display_name, is_default_park, created_at, updated_at)
      VALUES ('org1', 'park', '园区一', 1, 1, 1)
    `).run()

    assert.throws(() => db.prepare(`
      INSERT INTO park_org_profiles (moss_org_id, org_type, display_name, is_default_park, created_at, updated_at)
      VALUES ('org2', 'park', '园区二', 1, 1, 1)
    `).run(), /UNIQUE constraint failed/)

    // 非默认园区不受限
    db.prepare(`
      INSERT INTO park_org_profiles (moss_org_id, org_type, display_name, is_default_park, created_at, updated_at)
      VALUES ('org2', 'park', '园区二', 0, 1, 1)
    `).run()
    db.close()
  })

  void test('审计事件只追加：更新与删除被触发器拒绝', () => {
    const db = setup()
    ensureParkSchema(db)
    db.prepare(`
      INSERT INTO park_audit_events (audit_id, park_org_id, actor_user_id, actor_org_id, action, target_type, created_at)
      VALUES ('a1', 'org1', 'u1', 'org1', 'lead.confirm', 'lead', 1)
    `).run()

    assert.throws(
      () => db.prepare("UPDATE park_audit_events SET action = 'x' WHERE audit_id = 'a1'").run(),
      /park audit events are append-only/,
    )
    assert.throws(
      () => db.prepare("DELETE FROM park_audit_events WHERE audit_id = 'a1'").run(),
      /park audit events are append-only/,
    )
    db.close()
  })

  void test('线索幂等键在园区内唯一且园区-企业绑定唯一', () => {
    const db = setup()
    ensureParkSchema(db)
    db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('ent1', 'Ent 1', 1)").run()

    db.prepare(`
      INSERT INTO leads (lead_id, park_org_id, enterprise_org_id, source, status, idempotency_key, created_at, updated_at)
      VALUES ('l1', 'org1', 'ent1', 'inquiry', 'proposed', 'k1', 1, 1)
    `).run()
    assert.throws(() => db.prepare(`
      INSERT INTO leads (lead_id, park_org_id, enterprise_org_id, source, status, idempotency_key, created_at, updated_at)
      VALUES ('l2', 'org1', 'ent1', 'inquiry', 'proposed', 'k1', 1, 1)
    `).run(), /UNIQUE constraint failed/)

    db.prepare(`
      INSERT INTO park_enterprise_bindings (binding_id, park_org_id, enterprise_org_id, created_at, updated_at)
      VALUES ('b1', 'org1', 'ent1', 1, 1)
    `).run()
    assert.throws(() => db.prepare(`
      INSERT INTO park_enterprise_bindings (binding_id, park_org_id, enterprise_org_id, created_at, updated_at)
      VALUES ('b2', 'org1', 'ent1', 1, 1)
    `).run(), /UNIQUE constraint failed/)
    db.close()
  })
})
