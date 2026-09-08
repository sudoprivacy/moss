import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { SudoworkP3SourceError, SudoworkP3SourceReader } from './sudoworkP3SourceReader.js'

function createSource(path: string, balance: number | string = 100): void {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, phone TEXT, enterprise_id INTEGER, balance REAL,
      quota INTEGER, used_quota INTEGER, sudorouter_user_id INTEGER
    );
    CREATE TABLE ledger (id INTEGER PRIMARY KEY, user_id INTEGER, amount REAL, type TEXT, memo TEXT, timestamp DATETIME);
    CREATE TABLE recharge_orders (
      id INTEGER PRIMARY KEY, order_no TEXT, user_id INTEGER, user_phone TEXT, enterprise_id INTEGER,
      amount_usd REAL, amount_yuan REAL, amount_cents INTEGER, exchange_rate REAL,
      quota_amount INTEGER, points_amount INTEGER, bonus_points INTEGER, payment_method TEXT,
      order_date TEXT, fuiou_order_info TEXT, status INTEGER, callback_data TEXT,
      callback_time DATETIME, callback_amount_cents INTEGER, created_at DATETIME,
      updated_at DATETIME, expired_at DATETIME, remark TEXT
    );
    CREATE TABLE recharge_records (
      id INTEGER PRIMARY KEY, order_id INTEGER, user_id INTEGER, quota_before INTEGER,
      quota_after INTEGER, quota_delta INTEGER, balance_before REAL, balance_after REAL,
      balance_delta REAL, sudorouter_user_id INTEGER, sudorouter_success INTEGER, created_at DATETIME
    );
    CREATE TABLE admin_recharge_records (
      id INTEGER PRIMARY KEY, user_id INTEGER, admin_id INTEGER, points INTEGER, quota INTEGER,
      reason TEXT, payment_reference TEXT, sudorouter_user_id INTEGER, sudorouter_success INTEGER,
      sudorouter_error TEXT, source TEXT, source_id INTEGER, created_at DATETIME
    );
    CREATE TABLE credit_applications (
      id INTEGER PRIMARY KEY, application_no TEXT, user_id INTEGER, enterprise_id INTEGER,
      requested_points INTEGER, approved_points INTEGER, quota_amount INTEGER, reason TEXT,
      status TEXT, admin_id INTEGER, admin_comment TEXT, sudorouter_user_id INTEGER,
      sudorouter_success INTEGER, sudorouter_error TEXT, created_at DATETIME,
      reviewed_at DATETIME, updated_at DATETIME
    );
    CREATE TABLE refund_records (
      id INTEGER PRIMARY KEY, refund_no TEXT, order_id INTEGER, order_no TEXT, user_id INTEGER,
      refund_amount_yuan REAL, refund_quota INTEGER, refund_points INTEGER, refund_reason TEXT,
      refund_type TEXT, status INTEGER, fuiou_refund_no TEXT, fuiou_response TEXT,
      created_at DATETIME, processed_at DATETIME
    );
  `)
  db.prepare('INSERT INTO users VALUES (17, ?, 3, ?, 50000, 1000, 91)').run('13800000000', balance)
  db.prepare("INSERT INTO ledger VALUES (1, 17, 120, 'RECHARGE', '充值', '2026-09-07 01:00:00')").run()
  db.prepare("INSERT INTO ledger VALUES (2, 17, -20, 'CONSUME', '消费', '2026-09-07 02:00:00')").run()
  db.prepare(`INSERT INTO recharge_orders VALUES (
    7, 'ORDER-7', 17, '13800000000', 3, 1, 7.3, 730, 7.3,
    500000, 1000, 0, 'ALIPAY', '20260907', '{}', 2, '{"paid":true}',
    '2026-09-07 01:00:00', 730, '2026-09-07 00:59:00',
    '2026-09-07 01:00:00', '2026-09-07 01:29:00', NULL
  )`).run()
  db.prepare("INSERT INTO recharge_records VALUES (8, 7, 17, 0, 500000, 500000, 0, 1000, 1000, 91, 1, '2026-09-07 01:00:00')").run()
  db.prepare("INSERT INTO admin_recharge_records VALUES (9, 17, 17, 20, 10000, '补发', 'R1', 91, 1, NULL, 'ADMIN_MANUAL', NULL, '2026-09-07 01:30:00')").run()
  db.prepare("INSERT INTO credit_applications VALUES (10, 'APP-10', 17, 3, 20, 20, 10000, '申请', 'APPROVED', 17, '同意', 91, 1, NULL, '2026-09-07 01:20:00', '2026-09-07 01:30:00', '2026-09-07 01:30:00')").run()
  db.prepare("INSERT INTO refund_records VALUES (11, 'REF-11', 7, 'ORDER-7', 17, 7.3, 500000, 1000, '退款', 'FUIOU', 1, 'FR-11', '{}', '2026-09-07 03:00:00', '2026-09-07 03:00:00')").run()
  db.close()
}

describe('SudoworkP3SourceReader', () => {
  test('只读提取旧财务表并无损转换为整数单位', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sudowork-p3-source-'))
    try {
      createSource(join(root, 'sudowork.sqlite'))
      const snapshot = new SudoworkP3SourceReader(root).readSnapshot()
      assert.equal(snapshot.users[0]?.balanceUnits, 100)
      assert.equal(snapshot.users[0]?.externalUserId, '91')
      assert.equal(snapshot.ledger.reduce((sum, row) => sum + row.deltaUnits, 0), 100)
      assert.equal(snapshot.orders[0]?.amountUsdMicros, 1_000_000)
      assert.equal(snapshot.orders[0]?.amountCents, 730)
      assert.equal(snapshot.refunds[0]?.refundAmountCents, 730)
      assert.equal(snapshot.checksum.length, 64)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('无损读取旧 usage/report 产生的百分之一积分', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sudowork-p3-source-'))
    try {
      createSource(join(root, 'sudowork.sqlite'), '100.25')
      const db = new DatabaseSync(join(root, 'sudowork.sqlite'))
      db.prepare('UPDATE ledger SET amount = ? WHERE id = 2').run(-19.75)
      db.close()

      const snapshot = new SudoworkP3SourceReader(root).readSnapshot()
      assert.equal(snapshot.users[0]?.balanceUnits, 100.25)
      assert.equal(snapshot.ledger.reduce((sum, row) => sum + row.deltaUnits, 0), 100.25)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('拒绝超过百分之一积分精度的旧余额', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sudowork-p3-source-'))
    try {
      createSource(join(root, 'sudowork.sqlite'), '100.001')
      assert.throws(
        () => new SudoworkP3SourceReader(root).readSnapshot(),
        (error: unknown) => error instanceof SudoworkP3SourceError && error.code === 'LOSSY_NUMBER',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
