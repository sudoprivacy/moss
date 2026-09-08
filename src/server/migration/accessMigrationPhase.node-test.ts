import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { migrationCommandContext } from '../application/commandContext.js'
import {
  AccessMigrationPhase,
  SudoworkAccessSourceReader,
  type AccessKeyValueStore,
} from './accessMigrationPhase.js'
import type { SudoworkSourceSnapshot } from './sudoworkSourceSnapshot.js'

class MemoryStore implements AccessKeyValueStore {
  readonly values = new Map<string, { value: string; ttl: number }>()

  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern
    return [...this.values.keys()].filter(key => key.startsWith(prefix))
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key)?.value ?? null
  }

  async ttl(key: string): Promise<number> {
    return this.values.get(key)?.ttl ?? -2
  }

  async setex(key: string, seconds: number, value: string): Promise<void> {
    this.values.set(key, { value, ttl: seconds })
  }
}

function fixture(sql = ''): { directory: string; db: DatabaseSync } {
  const directory = mkdtempSync(join(tmpdir(), 'moss-access-source-'))
  const db = new DatabaseSync(join(directory, 'sudowork.sqlite'))
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, phone TEXT, enterprise_id INTEGER);
    CREATE TABLE third_party_auth_handoffs (
      id INTEGER PRIMARY KEY, code_hash TEXT, provider_id TEXT, user_id INTEGER,
      external_user_id TEXT, expires_at INTEGER, used_at TEXT, created_at TEXT
    );
    ${sql}
  `)
  return { directory, db }
}

function globalSnapshot(): SudoworkSourceSnapshot {
  return {
    fingerprint: 'source-fingerprint', capturedAt: '2026-09-08T00:00:00.000Z',
    sqlite: { name: 'sqlite', checksum: 'sqlite', itemCount: 1, readOnly: true, metadata: {} },
    redis: { name: 'redis', checksum: 'redis', itemCount: 2, readOnly: true, metadata: {} },
    qms: { name: 'qms', checksum: 'qms', itemCount: 0, readOnly: true, metadata: {} },
    files: { name: 'files', checksum: 'files', itemCount: 0, readOnly: true, metadata: {} },
    includedDomains: [
      'organizations', 'identities', 'governance', 'catalog', 'configuration',
      'dify', 'billing', 'automation', 'qms', 'access',
    ],
    excludedLocalData: ['sessions', 'client_cron', 'client_channels'],
  }
}

const aliases = {
  resolveNumericAliasGlobal(kind: string, legacyId: number) {
    if (kind === 'enterprise' && legacyId === 7) return { resourceId: 'org-7', orgId: 'org-7' }
    if (kind === 'user' && legacyId === 17) return { resourceId: 'user-17', orgId: 'org-7' }
    return null
  },
}

describe('Sudowork access migration', () => {
  test('只读取需连续保留的 Redis 登录态和 SQLite CAS handoff', async () => {
    const { directory, db } = fixture(`
      INSERT INTO users VALUES (17, 'cas-user', 7);
      INSERT INTO third_party_auth_handoffs VALUES
        (1, 'active-hash', 'cas-main', 17, 'external-17', 1060, NULL, '2026-09-08'),
        (2, 'used-hash', 'cas-main', 17, 'external-17', 1060, '2026-09-08', '2026-09-08'),
        (3, 'expired-hash', 'cas-main', 17, 'external-17', 999, NULL, '2026-09-08');
    `)
    db.close()
    const redis = new MemoryStore()
    redis.values.set('refresh_token:17:desktop-a:token-a', {
      value: JSON.stringify({ phone: '13800000000', role: 'USER', enterprise_id: 7 }), ttl: 300,
    })
    redis.values.set('register_token:register-a', {
      value: JSON.stringify({ phone: '13900000000', verified: true, created_at: 1 }), ttl: 60,
    })
    redis.values.set('sms_code:ignored', { value: '123456', ttl: 50 })
    try {
      const reader = new SudoworkAccessSourceReader(directory, redis, { nowSeconds: () => 1000 })
      const first = await reader.readSnapshot()
      const second = await reader.readSnapshot()
      assert.equal(first.checksum, second.checksum)
      assert.deepEqual(first.redisEntries.map(item => item.key), [
        'refresh_token:17:desktop-a:token-a', 'register_token:register-a',
      ])
      assert.deepEqual(first.handoffs.map(item => item.codeHash), ['active-hash'])
      assert.equal(first.handoffs[0]?.account, 'cas-user')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('JWT 密钥不一致、无主令牌和非法令牌内容均阻断预检', async () => {
    const source = {
      async readSnapshot() {
        return {
          checksum: 'access-source',
          redisEntries: [
            { key: 'refresh_token:99:d:t', value: '{"phone":"x","role":"USER","enterprise_id":7}', ttlSeconds: 30 },
            { key: 'register_token:r', value: '{bad', ttlSeconds: 30 },
          ],
          handoffs: [],
        }
      },
    }
    const phase = new AccessMigrationPhase({
      source, target: new MemoryStore(), identities: aliases,
      sourceLegacyJwtSecret: 'old-secret', targetLegacyJwtSecret: 'different-secret',
    })
    const plan = await phase.plan({ snapshot: globalSnapshot() })
    assert.equal(plan.status, 'blocked')
    assert.deepEqual(plan.issues.map(issue => issue.code), [
      'LEGACY_JWT_SECRET_MISMATCH', 'REFRESH_TOKEN_USER_ORPHAN', 'INVALID_REGISTER_HANDOFF',
    ])
  })

  test('幂等迁移 Refresh Token、注册 handoff 和有效 CAS handoff，并保持旧 key', async () => {
    const sourceStore = new MemoryStore()
    const refreshValue = JSON.stringify({ phone: '13800000000', role: 'USER', enterprise_id: 7 })
    const registerValue = JSON.stringify({ phone: '13900000000', verified: true, created_at: 1 })
    sourceStore.values.set('refresh_token:17:desktop-a:token-a', { value: refreshValue, ttl: 300 })
    sourceStore.values.set('register_token:register-a', { value: registerValue, ttl: 60 })
    const target = new MemoryStore()
    const source = {
      async readSnapshot() {
        return {
          checksum: 'access-source',
          redisEntries: [
            { key: 'refresh_token:17:desktop-a:token-a', value: refreshValue, ttlSeconds: 300 },
            { key: 'register_token:register-a', value: registerValue, ttlSeconds: 60 },
          ],
          handoffs: [{
            id: 1, codeHash: 'handoff-hash', providerId: 'cas-main', userId: 17,
            enterpriseId: 7, account: 'cas-user', externalUserId: 'external-17', expiresAt: 1060,
          }],
        }
      },
    }
    const phase = new AccessMigrationPhase({
      source, target, identities: aliases,
      sourceLegacyJwtSecret: 'same-secret', targetLegacyJwtSecret: 'same-secret',
      nowSeconds: () => 1000,
    })
    const context = {
      runId: 'run-1', snapshot: globalSnapshot(),
      commandContext: (key: string) => migrationCommandContext('run-1', key),
    }
    const plan = await phase.plan({ snapshot: context.snapshot })
    assert.equal(plan.status, 'ready')
    assert.deepEqual(await phase.execute(context, plan), { imported: 3, reused: 0, skippedExpired: 0 })
    assert.equal(target.values.get('refresh_token:17:desktop-a:token-a')?.value, refreshValue)
    assert.equal(target.values.get('register_token:register-a')?.value, registerValue)
    assert.deepEqual(JSON.parse(target.values.get('cas_handoff:handoff-hash')!.value), {
      providerId: 'cas-main', userId: 'user-17', account: 'cas-user',
    })
    assert.deepEqual(await phase.execute(context, plan), { imported: 0, reused: 3, skippedExpired: 0 })
    assert.equal((await phase.verify({ runId: 'run-1', snapshot: context.snapshot })).status, 'matched')
  })

  test('目标 key 内容冲突或执行阶段源内容变化时拒绝覆盖', async () => {
    const target = new MemoryStore()
    target.values.set('register_token:r', { value: 'different', ttl: 30 })
    let checksum = 'first'
    const source = {
      async readSnapshot() {
        return {
          checksum,
          redisEntries: [{
            key: 'register_token:r',
            value: JSON.stringify({ phone: '13900000000', verified: true }),
            ttlSeconds: 30,
          }],
          handoffs: [],
        }
      },
    }
    const phase = new AccessMigrationPhase({
      source, target, identities: aliases,
      sourceLegacyJwtSecret: 'same', targetLegacyJwtSecret: 'same',
    })
    const plan = await phase.plan({ snapshot: globalSnapshot() })
    assert.equal(plan.status, 'blocked')
    assert.equal(plan.issues[0]?.code, 'ACCESS_TARGET_CONFLICT')

    target.values.clear()
    const ready = await phase.plan({ snapshot: globalSnapshot() })
    checksum = 'changed'
    await assert.rejects(
      () => phase.execute({
        runId: 'run-1', snapshot: globalSnapshot(),
        commandContext: key => migrationCommandContext('run-1', key),
      }, ready),
      /快照已变化/,
    )
  })
})
