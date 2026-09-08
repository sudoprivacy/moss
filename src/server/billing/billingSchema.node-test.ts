import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { ensureBillingSchema } from './billingSchema.js'

function setup(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  new AuthCenterDb(db)
  new IdentityRepository(db)
  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('org1', 'Org 1', 1)").run()
  db.prepare(`
    INSERT INTO users (id, org_id, email, name, role, status, local_auth, created_at)
    VALUES ('u1', 'org1', 'u1@example.test', 'U1', 'user', 'active', 1, 1)
  `).run()
  return db
}

describe('Billing Schema', () => {
  test('可重复初始化完整的统一计费表', () => {
    const db = setup()
    ensureBillingSchema(db)
    ensureBillingSchema(db)

    const tables = (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'billing_%'
      ORDER BY name
    `).all() as Array<{ name: string }>).map(row => row.name)
    assert.deepEqual(tables, [
      'billing_activity_records',
      'billing_audit_events',
      'billing_credit_applications',
      'billing_external_accounts',
      'billing_ledger_entries',
      'billing_migration_checkpoints',
      'billing_orders',
      'billing_packages',
      'billing_payment_attempts',
      'billing_provider_events',
      'billing_quota_operations',
      'billing_reconciliations',
      'billing_refunds',
      'billing_usage_records',
    ])
    db.close()
  })

  test('拒绝非法订单状态和非整数财务单位', () => {
    const db = setup()
    ensureBillingSchema(db)

    assert.throws(() => db.prepare(`
      INSERT INTO billing_orders (
        id, order_no, user_id, org_id, amount_usd_micros, amount_cents,
        exchange_rate_micros, quota_units, points_units, bonus_units,
        payment_method, order_date, status, idempotency_key, created_at, updated_at, expired_at
      ) VALUES ('o1', 'NO1', 'u1', 'org1', 1000000, 730, 7300000, 1000, 1000, 0,
        'ALIPAY', '20260907', 'NOT_A_STATE', 'create:o1', 1, 1, 2)
    `).run(), /CHECK constraint failed/)

    assert.throws(() => db.prepare(`
      INSERT INTO billing_ledger_entries (
        id, owner_type, owner_id, delta_units, balance_before_units, balance_after_units,
        entry_type, source_type, source_id, idempotency_key, context_source, created_at
      ) VALUES ('l1', 'user', 'u1', 1.5, 0, 1.5, 'BONUS', 'test', '1', 'ledger:1', 'online', 1)
    `).run(), /CHECK constraint failed/)
    db.close()
  })

  test('账本幂等键唯一且已入账记录不可更新或删除', () => {
    const db = setup()
    ensureBillingSchema(db)
    const insert = db.prepare(`
      INSERT INTO billing_ledger_entries (
        id, owner_type, owner_id, delta_units, balance_before_units, balance_after_units,
        entry_type, source_type, source_id, idempotency_key, context_source, created_at
      ) VALUES (?, 'user', 'u1', 100, 0, 100, 'OPENING', 'migration', 'legacy-u1', 'opening:u1', 'migration', 1)
    `)
    insert.run('l1')

    assert.throws(() => insert.run('l2'), /UNIQUE constraint failed/)
    assert.throws(
      () => db.prepare("UPDATE billing_ledger_entries SET delta_units = 99 WHERE id = 'l1'").run(),
      /billing ledger entries are append-only/,
    )
    assert.throws(
      () => db.prepare("DELETE FROM billing_ledger_entries WHERE id = 'l1'").run(),
      /billing ledger entries are append-only/,
    )
    db.close()
  })

  test('旧账本表升级时补齐稳定数字 ID 并恢复只追加约束', () => {
    const db = setup()
    db.exec(`
      CREATE TABLE billing_ledger_entries (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        delta_units INTEGER NOT NULL,
        balance_before_units INTEGER NOT NULL,
        balance_after_units INTEGER NOT NULL,
        entry_type TEXT NOT NULL,
        memo TEXT,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        context_source TEXT NOT NULL,
        actor_user_id TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO billing_ledger_entries VALUES
        ('old-2', 'user', 'u1', 200, 100, 300, 'BONUS', NULL, 'test', '2', 'old:2', 'online', NULL, 2),
        ('old-1', 'user', 'u1', 100, 0, 100, 'BONUS', NULL, 'test', '1', 'old:1', 'online', NULL, 1);
    `)

    ensureBillingSchema(db)
    const rows = (db.prepare(`
      SELECT id, legacy_id FROM billing_ledger_entries ORDER BY created_at, id
    `).all() as Array<{ id: string; legacy_id: number }>).map(row => ({ ...row }))
    assert.deepEqual(rows, [
      { id: 'old-1', legacy_id: 2_000_000_000 },
      { id: 'old-2', legacy_id: 2_000_000_001 },
    ])
    assert.throws(
      () => db.prepare("UPDATE billing_ledger_entries SET legacy_id = 1 WHERE id = 'old-1'").run(),
      /billing ledger entries are append-only/,
    )
    db.close()
  })
})
