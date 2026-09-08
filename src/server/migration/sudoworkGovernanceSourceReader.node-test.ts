import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  SudoworkGovernanceSourceError,
  SudoworkGovernanceSourceReader,
} from './sudoworkGovernanceSourceReader.js'

function fixture(sql = ''): { directory: string; db: DatabaseSync } {
  const directory = mkdtempSync(join(tmpdir(), 'moss-governance-source-'))
  const db = new DatabaseSync(join(directory, 'sudowork.sqlite'))
  db.exec(`
    CREATE TABLE invitation_codes (
      id INTEGER PRIMARY KEY, code TEXT, enterprise_id INTEGER, status INTEGER,
      initial_quota_usd REAL, used_by_user_id INTEGER, created_at TEXT, used_at TEXT
    );
    CREATE TABLE operation_logs (
      id INTEGER PRIMARY KEY, user_id INTEGER, user_phone TEXT, action TEXT,
      resource TEXT, resource_id INTEGER, method TEXT, path TEXT, params TEXT,
      request_data TEXT, response_data TEXT, response_status INTEGER,
      ip_address TEXT, user_agent TEXT, duration_ms INTEGER, error_message TEXT,
      created_at TEXT
    );
    ${sql}
  `)
  return { directory, db }
}

describe('SudoworkGovernanceSourceReader', () => {
  test('只读并确定性保留邀请码与操作日志的全部旧字段', () => {
    const { directory, db } = fixture(`
      INSERT INTO invitation_codes VALUES
        (1, 'PENDING', 7, 0, NULL, NULL, '2026-09-01 01:02:03', NULL),
        (2, 'USED', 7, 1, 12.5, 17, '2026-09-02 01:02:03', '2026-09-03 04:05:06');
      INSERT INTO operation_logs VALUES (
        9, 17, '13800000000', 'USER_UPDATE', 'user', 17, 'PATCH', '/api/v1/admin/users/17',
        '{"page": 1}', '{"b":2, "a":1}', 'not-json', 200,
        '127.0.0.1', 'Sudowork/1.0', 23, NULL, '2026-09-04 05:06:07'
      );
    `)
    db.close()
    try {
      const first = new SudoworkGovernanceSourceReader(directory).readSnapshot()
      const second = new SudoworkGovernanceSourceReader(directory).readSnapshot()
      assert.equal(first.checksum, second.checksum)
      assert.deepEqual(first.invitations, [
        {
          id: 1, code: 'PENDING', enterpriseId: 7, status: 'pending',
          initialQuotaUsd: null, usedByUserId: null,
          createdAt: Date.parse('2026-09-01T01:02:03Z'), usedAt: null,
        },
        {
          id: 2, code: 'USED', enterpriseId: 7, status: 'used',
          initialQuotaUsd: 12.5, usedByUserId: 17,
          createdAt: Date.parse('2026-09-02T01:02:03Z'),
          usedAt: Date.parse('2026-09-03T04:05:06Z'),
        },
      ])
      assert.deepEqual(first.operationLogs, [{
        id: 9,
        userId: 17,
        userPhone: '13800000000',
        action: 'USER_UPDATE',
        resource: 'user',
        resourceId: 17,
        method: 'PATCH',
        path: '/api/v1/admin/users/17',
        paramsRaw: '{"page": 1}',
        requestDataRaw: '{"b":2, "a":1}',
        responseDataRaw: 'not-json',
        responseStatus: 200,
        ipAddress: '127.0.0.1',
        userAgent: 'Sudowork/1.0',
        durationMs: 23,
        errorMessage: null,
        createdAt: Date.parse('2026-09-04T05:06:07Z'),
      }])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('非法邀请码状态和不完整的已使用记录会阻断读取', () => {
    const invalidStatus = fixture(`
      INSERT INTO invitation_codes VALUES (1, 'BAD', 7, 3, NULL, NULL, CURRENT_TIMESTAMP, NULL);
    `)
    invalidStatus.db.close()
    const incompleteUsed = fixture(`
      INSERT INTO invitation_codes VALUES (2, 'USED', 7, 1, NULL, NULL, CURRENT_TIMESTAMP, NULL);
    `)
    incompleteUsed.db.close()
    try {
      assert.throws(
        () => new SudoworkGovernanceSourceReader(invalidStatus.directory).readSnapshot(),
        (error: unknown) => error instanceof SudoworkGovernanceSourceError && /status/.test(error.message),
      )
      assert.throws(
        () => new SudoworkGovernanceSourceReader(incompleteUsed.directory).readSnapshot(),
        /used_by_user_id|used_at/,
      )
    } finally {
      rmSync(invalidStatus.directory, { recursive: true, force: true })
      rmSync(incompleteUsed.directory, { recursive: true, force: true })
    }
  })

  test('缺少必需治理表时拒绝不完整快照', () => {
    const directory = mkdtempSync(join(tmpdir(), 'moss-governance-source-'))
    const db = new DatabaseSync(join(directory, 'sudowork.sqlite'))
    db.exec('CREATE TABLE invitation_codes (id INTEGER PRIMARY KEY)')
    db.close()
    try {
      assert.throws(
        () => new SudoworkGovernanceSourceReader(directory).readSnapshot(),
        /operation_logs/,
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
