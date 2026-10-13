import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { createCatalogTestRepository } from '../testing/compatibilityRepositories.js'
import { ensureIdentitySchema } from '../identity/identityRepository.js'
import { SqliteDriver } from '../db/driver.js'
import { ensureParkSchema } from './parkSchema.js'
import { ParkRepository } from './parkRepository.js'
import {
  assertParkAssistantAllowed,
  getParkRole,
  ParkApiError,
  requireEnterpriseOfPark,
  requireParkMember,
} from './parkAuthorization.js'

/**
 * 权限矩阵（plan 5.3）：四类身份 × 核心接口；跨园区/跨企业越权；
 * assertParkAssistantAllowed 的同 org 放行 / 分配命中 / 未分配拒绝。
 */

async function setup(): Promise<{ db: DatabaseSync; teardown: () => void }> {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=OFF')
  new AuthCenterDb(db)
  ensureIdentitySchema(db)
  createCatalogTestRepository(db)
  try { db.exec('ALTER TABLE tenant_assistants ADD COLUMN enabled_wikis TEXT') } catch { /* already present */ }
  ensureParkSchema(db)

  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('park-org', '园区', 1)").run()
  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('park-org-2', '园区二', 1)").run()
  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('ent-org', '企业', 1)").run()
  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('ent-org-b', '企业B', 1)").run()
  for (const [userId, orgId] of [['leader', 'park-org'], ['ops', 'park-org'], ['sysop', 'park-org'], ['ops2', 'park-org-2'], ['ent-user', 'ent-org'], ['ent-user-b', 'ent-org-b']] as const) {
    db.prepare(`
      INSERT INTO users (id, org_id, email, name, role, status, local_auth, created_at)
      VALUES (?, ?, ?, ?, 'user', 'active', 1, 1)
    `).run(userId, orgId, `${userId}@test`, userId)
  }

  return { db, teardown: () => db.close() }
}

async function seedPark(ctx: { db: DatabaseSync }, root: string): Promise<void> {
  const repo = new ParkRepository(new SqliteDriver(ctx.db))
  await repo.upsertOrgProfile({ mossOrgId: 'park-org', orgType: 'park', displayName: '园区', isDefaultPark: true })
  await repo.upsertOrgProfile({ mossOrgId: 'park-org-2', orgType: 'park', displayName: '园区二' })
  await repo.upsertOrgProfile({ mossOrgId: 'ent-org', orgType: 'enterprise', displayName: '企业' })
  await repo.upsertOrgProfile({ mossOrgId: 'ent-org-b', orgType: 'enterprise', displayName: '企业B' })
  await repo.insertMember({ parkOrgId: 'park-org', userId: 'leader', parkRole: 'park_leader' })
  await repo.insertMember({ parkOrgId: 'park-org', userId: 'ops', parkRole: 'park_ops' })
  await repo.insertMember({ parkOrgId: 'park-org', userId: 'sysop', parkRole: 'park_system_operator' })
  await repo.insertMember({ parkOrgId: 'park-org-2', userId: 'ops2', parkRole: 'park_ops' })
  await repo.upsertEnterpriseProfile({ enterpriseOrgId: 'ent-org', parkOrgId: 'park-org', enterpriseName: '企业' })
  await repo.upsertEnterpriseProfile({ enterpriseOrgId: 'ent-org-b', parkOrgId: 'park-org', enterpriseName: '企业B' })
  await repo.insertBinding({ parkOrgId: 'park-org', enterpriseOrgId: 'ent-org', lifecycle: 'active' })
  await repo.insertBinding({ parkOrgId: 'park-org', enterpriseOrgId: 'ent-org-b', lifecycle: 'prospect' })

  // tenant assistant fixture（分配表用）
  const dir = join(root, 'agent-as-1')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '_moss_meta.json'), JSON.stringify({ id: 'as-1', name: 'park-consultation' }))
  ctx.db.prepare(`
    INSERT INTO tenant_assistants (id, name, display_name, org_id, author_id, status, source_type, file_path, created_at, updated_at)
    VALUES ('as-1', 'park-consultation', '园区咨询', 'park-org', 'test-author', 'approved', 'tenant', ?, 1, 1)
  `).run(dir)
}

void describe('parkAuthorization 权限矩阵', () => {
  void test('requireParkMember：园区成员/角色/跨园区越权', async () => {
    const ctx = await setup()
    const root = await mkdtemp(join(tmpdir(), 'moss-park-auth-'))
    try {
      await seedPark(ctx, root)
      const driver = new SqliteDriver(ctx.db)

      assert.equal(await getParkRole(driver, 'park-org', 'leader'), 'park_leader')
      assert.equal(await getParkRole(driver, 'park-org', 'ent-user'), null)

      await requireParkMember(driver, { userId: 'leader', orgId: 'park-org' }, 'park-org', ['park_leader'])
      await requireParkMember(driver, { userId: 'ops', orgId: 'park-org' }, 'park-org', ['park_ops'])
      await assert.rejects(
        requireParkMember(driver, { userId: 'ops', orgId: 'park-org' }, 'park-org', ['park_system_operator']),
        (err: unknown) => err instanceof ParkApiError && err.status === 403,
      )
      // 非成员（企业用户）访问园区端点
      await assert.rejects(
        requireParkMember(driver, { userId: 'ent-user', orgId: 'ent-org' }, 'park-org'),
        (err: unknown) => err instanceof ParkApiError && err.code === 'park_member_required',
      )
      // 跨园区越权
      await assert.rejects(
        requireParkMember(driver, { userId: 'ops', orgId: 'park-org' }, 'park-org-2'),
        (err: unknown) => err instanceof ParkApiError && err.code === 'park_cross_org',
      )
      // 本园区成员但对方园区无成员身份
      await assert.rejects(
        requireParkMember(driver, { userId: 'ops2', orgId: 'park-org-2' }, 'park-org'),
        (err: unknown) => err instanceof ParkApiError && err.status === 403,
      )
    } finally {
      ctx.teardown()
      await rm(root, { recursive: true, force: true })
    }
  })

  void test('requireEnterpriseOfPark：企业用户拿到所属园区，园区用户被拒', async () => {
    const ctx = await setup()
    const root = await mkdtemp(join(tmpdir(), 'moss-park-auth-'))
    try {
      await seedPark(ctx, root)
      const driver = new SqliteDriver(ctx.db)

      assert.equal(await requireEnterpriseOfPark(driver, { userId: 'ent-user', orgId: 'ent-org' }), 'park-org')
      await assert.rejects(
        requireEnterpriseOfPark(driver, { userId: 'leader', orgId: 'park-org' }),
        (err: unknown) => err instanceof ParkApiError,
      )
    } finally {
      ctx.teardown()
      await rm(root, { recursive: true, force: true })
    }
  })

  void test('assertParkAssistantAllowed：分配命中放行 / 未分配拒绝 / 同 org 放行 / 非分配表放行', async () => {
    const ctx = await setup()
    const root = await mkdtemp(join(tmpdir(), 'moss-park-auth-'))
    try {
      await seedPark(ctx, root)
      const driver = new SqliteDriver(ctx.db)
      const repo = new ParkRepository(driver)
      await repo.insertAssignment({ parkOrgId: 'park-org', assistantId: 'as-1', enterpriseOrgId: 'ent-org' })

      // 分配命中 → 放行
      await assertParkAssistantAllowed(driver, { userId: 'ent-user', orgId: 'ent-org' }, 'as-1')
      // 未被分配的企业 → 403
      await assert.rejects(
        assertParkAssistantAllowed(driver, { userId: 'ent-user-b', orgId: 'ent-org-b' }, 'as-1'),
        (err: unknown) => err instanceof ParkApiError && err.status === 403,
      )
      // 同 org（园区自身用户）→ 放行（visible_to 路径自测）
      await assertParkAssistantAllowed(driver, { userId: 'ops', orgId: 'park-org' }, 'as-1')
      // 名字形式同样生效
      await assertParkAssistantAllowed(driver, { userId: 'ent-user', orgId: 'ent-org' }, 'park-consultation')
      await assert.rejects(
        assertParkAssistantAllowed(driver, { userId: 'ent-user-b', orgId: 'ent-org-b' }, 'park-consultation'),
        (err: unknown) => err instanceof ParkApiError,
      )
      // 不在分配表的普通 assistant → 放行（非园区流程不受影响）
      await assertParkAssistantAllowed(driver, { userId: 'ent-user', orgId: 'ent-org' }, 'some-regular-agent')
    } finally {
      ctx.teardown()
      await rm(root, { recursive: true, force: true })
    }
  })
})
