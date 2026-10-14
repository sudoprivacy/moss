import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { createCatalogTestRepository } from '../testing/compatibilityRepositories.js'
import { SqliteDriver, type DbDriver } from '../db/driver.js'
import {
  findOrganizationResource,
  withOrganizationResources,
  type OrganizationResourceScope,
} from '../catalog/organizationResources.js'
import { ensureParkSchema } from './parkSchema.js'
import { resolveParkScopedResources } from './parkAuthorization.js'
import { ParkRepository } from './parkRepository.js'

/**
 * Root-cause layer assertions for the session resource-resolution wall fix
 * (plan 2.6 #4/#5): an enterprise-org scope with grantedResources resolves
 * the park org's assistant/skill; without the grant it does not; granted rows
 * bypass the caller-visibility filter (:94 exemption); pending / non-tenant
 * park resources never enter the grant.
 */

async function setup(): Promise<{ db: DatabaseSync; driver: DbDriver; root: string; teardown: () => Promise<void> }> {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=OFF')
  createCatalogTestRepository(db)
  // The test fixture's tenant_assistants lacks the enabled_wikis column the
  // production table carries — add it for park resolution paths.
  try { db.exec('ALTER TABLE tenant_assistants ADD COLUMN enabled_wikis TEXT') } catch { /* already present */ }
  try { db.exec('ALTER TABLE tenant_skills ADD COLUMN enabled_corp_apps TEXT') } catch { /* unused here */ }
  ensureParkSchema(db)
  const driver = new SqliteDriver(db)
  const root = await mkdtemp(join(tmpdir(), 'moss-park-scope-'))
  return {
    db,
    driver,
    root,
    teardown: async () => {
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function insertTenantAssistant(
  db: DatabaseSync, root: string,
  input: { id: string; name: string; orgId: string; status?: string; sourceType?: string; visibleTo?: string | null; enabledSkills?: string },
): Promise<void> {
  const dir = join(root, `agent-${input.id}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '_moss_meta.json'), JSON.stringify({ id: input.id, name: input.name, enabled: true }))
  db.prepare(`
    INSERT INTO tenant_assistants (id, name, display_name, org_id, author_id, status, source_type, file_path, visible_to, enabled_skills, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'test-author', ?, ?, ?, ?, ?, 1, 1)
  `).run(input.id, input.name, input.name, input.orgId, input.status ?? 'approved', input.sourceType ?? 'tenant', dir, input.visibleTo ?? null, input.enabledSkills ?? null)
}

async function insertTenantSkill(
  db: DatabaseSync, root: string,
  input: { id: string; name: string; orgId: string; status?: string; sourceType?: string },
): Promise<void> {
  const dir = join(root, `skill-${input.id}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '_moss_meta.json'), JSON.stringify({ id: input.id, name: input.name, enabled: true }))
  db.prepare(`
    INSERT INTO tenant_skills (id, name, display_name, org_id, author_id, status, source_type, file_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'test-author', ?, ?, ?, 1, 1)
  `).run(input.id, input.name, input.name, input.orgId, input.status ?? 'approved', input.sourceType ?? 'tenant', dir)
}

void describe('parkResourceScope（会话资源解析墙修复根因层）', () => {
  void test('企业 org scope + grantedResources 能解析园区 assistant 与 park skill', async () => {
    const ctx = await setup()
    try {
      const { db, driver, root } = ctx
      await insertTenantSkill(db, root, { id: 'sk-1', name: 'park-consultation-tools', orgId: 'park-org' })
      await insertTenantAssistant(db, root, {
        id: 'as-1', name: 'park-consultation', orgId: 'park-org',
        enabledSkills: JSON.stringify(['sk-1']),
      })
      const repo = new ParkRepository(driver)
      await repo.insertAssignment({ parkOrgId: 'park-org', assistantId: 'as-1', enterpriseOrgId: 'ent-org' })

      const enterpriseScope: OrganizationResourceScope = {
        orgId: 'ent-org', userId: 'ent-user', driver,
        grantedResources: await resolveParkScopedResources(driver, 'ent-org', 'as-1'),
      }
      assert.ok(enterpriseScope.grantedResources, 'grant 应命中')
      assert.equal(enterpriseScope.grantedResources.parkOrgId, 'park-org')
      assert.deepEqual(enterpriseScope.grantedResources.agentIds, ['as-1'])
      assert.deepEqual(enterpriseScope.grantedResources.skillIds, ['sk-1'], 'skillIds 应来自 assistant 的 enabled_skills')

      const agent = await withOrganizationResources(enterpriseScope, () => findOrganizationResource('agent', 'as-1'))
      assert.ok(agent, '企业 scope 内应能解析园区 assistant（按 UUID）')
      const agentByName = await withOrganizationResources(enterpriseScope, () => findOrganizationResource('agent', 'park-consultation'))
      assert.ok(agentByName, '企业 scope 内应能解析园区 assistant（按名字）')

      const skill = await withOrganizationResources(enterpriseScope, () => findOrganizationResource('skill', 'sk-1'))
      assert.ok(skill, '企业 scope 内应能解析 park skill')
    } finally {
      await ctx.teardown()
    }
  })

  void test('resolveParkScopedResources 对名字与 UUID 两种引用形式均命中', async () => {
    const ctx = await setup()
    try {
      const { db, driver, root } = ctx
      await insertTenantAssistant(db, root, { id: 'as-2', name: 'park-consultation', orgId: 'park-org' })
      const repo = new ParkRepository(driver)
      await repo.insertAssignment({ parkOrgId: 'park-org', assistantId: 'as-2', enterpriseOrgId: 'ent-org' })

      const byId = await resolveParkScopedResources(driver, 'ent-org', 'as-2')
      const byName = await resolveParkScopedResources(driver, 'ent-org', 'park-consultation')
      assert.ok(byId && byName)
      assert.equal(byId.agentIds[0], 'as-2')
      assert.equal(byName.agentIds[0], 'as-2')
    } finally {
      await ctx.teardown()
    }
  })

  void test('无 grantedResources 时企业 scope 找不到园区资源（404 语义）', async () => {
    const ctx = await setup()
    try {
      const { db, driver, root } = ctx
      await insertTenantAssistant(db, root, { id: 'as-3', name: 'park-consultation', orgId: 'park-org' })
      const repo = new ParkRepository(driver)
      await repo.insertAssignment({ parkOrgId: 'park-org', assistantId: 'as-3', enterpriseOrgId: 'other-ent' })

      const grant = await resolveParkScopedResources(driver, 'ent-org', 'as-3')
      assert.equal(grant, null, '未分配企业不应命中 grant')

      const enterpriseScope: OrganizationResourceScope = { orgId: 'ent-org', userId: 'ent-user', driver }
      const agent = await withOrganizationResources(enterpriseScope, () => findOrganizationResource('agent', 'as-3'))
      assert.equal(agent, null, '无 grant 时企业 scope 解析不到园区资源')
    } finally {
      await ctx.teardown()
    }
  })

  void test('granted 行即使 visible_to 为非空白名单仍可见（:94 豁免生效）', async () => {
    const ctx = await setup()
    try {
      const { db, driver, root } = ctx
      // 白名单指向园区 org 内部用户 —— 企业用户永不可能命中
      await insertTenantAssistant(db, root, {
        id: 'as-4', name: 'park-consultation', orgId: 'park-org',
        visibleTo: JSON.stringify({ user_ids: ['park-internal-user'] }),
      })
      const repo = new ParkRepository(driver)
      await repo.insertAssignment({ parkOrgId: 'park-org', assistantId: 'as-4', enterpriseOrgId: 'ent-org' })

      const grant = await resolveParkScopedResources(driver, 'ent-org', 'as-4')
      assert.ok(grant)
      const enterpriseScope: OrganizationResourceScope = { orgId: 'ent-org', userId: 'ent-user', driver, grantedResources: grant }
      const agent = await withOrganizationResources(enterpriseScope, () => findOrganizationResource('agent', 'as-4'))
      assert.ok(agent, 'granted 行应豁免调用者视角 visibility 过滤')
    } finally {
      await ctx.teardown()
    }
  })

  void test('非 granted 的园区资源对企业 scope 不可见', async () => {
    const ctx = await setup()
    try {
      const { db, driver, root } = ctx
      await insertTenantAssistant(db, root, { id: 'as-5', name: 'other-park-assistant', orgId: 'park-org' })
      await insertTenantAssistant(db, root, { id: 'as-6', name: 'park-consultation', orgId: 'park-org' })
      const repo = new ParkRepository(driver)
      await repo.insertAssignment({ parkOrgId: 'park-org', assistantId: 'as-6', enterpriseOrgId: 'ent-org' })

      const grant = await resolveParkScopedResources(driver, 'ent-org', 'as-6')
      assert.ok(grant)
      const enterpriseScope: OrganizationResourceScope = { orgId: 'ent-org', userId: 'ent-user', driver, grantedResources: grant }
      const other = await withOrganizationResources(enterpriseScope, () => findOrganizationResource('agent', 'as-5'))
      assert.equal(other, null, '未分配的园区资源不应进入企业 scope')
    } finally {
      await ctx.teardown()
    }
  })

  void test('grantedIds 仅含 approved+tenant/custom 资源（pending 被排除）', async () => {
    const ctx = await setup()
    try {
      const { db, driver, root } = ctx
      await insertTenantAssistant(db, root, { id: 'as-7', name: 'park-consultation', orgId: 'park-org', status: 'pending' })
      const grant = await resolveParkScopedResources(driver, 'ent-org', 'as-7')
      assert.equal(grant, null, 'pending 状态的园区 assistant 不应进入 grant')

      await insertTenantAssistant(db, root, { id: 'as-8', name: 'park-hub-agent', orgId: 'park-org', sourceType: 'hub' })
      const grant2 = await resolveParkScopedResources(driver, 'ent-org', 'as-8')
      assert.equal(grant2, null, '非 tenant/custom 来源不应进入 grant')
    } finally {
      await ctx.teardown()
    }
  })

  void test('grant 生成后资源被置 pending：消费侧 SQL 复查拒绝（组织资源 OR 分支）', async () => {
    const ctx = await setup()
    try {
      const { db, driver, root } = ctx
      await insertTenantAssistant(db, root, { id: 'as-9', name: 'park-consultation', orgId: 'park-org' })
      const repo = new ParkRepository(driver)
      await repo.insertAssignment({ parkOrgId: 'park-org', assistantId: 'as-9', enterpriseOrgId: 'ent-org' })
      // Grant resolved while the resource was approved (session scope persists).
      const grant = await resolveParkScopedResources(driver, 'ent-org', 'as-9')
      assert.ok(grant, 'approved 资源应进入 grant')

      // The resource is re-reviewed to pending while the grant is still live.
      db.prepare("UPDATE tenant_assistants SET status = 'pending' WHERE id = 'as-9'").run()
      const enterpriseScope: OrganizationResourceScope = {
        orgId: 'ent-org', userId: 'ent-user', driver, grantedResources: grant,
      }
      const agent = await withOrganizationResources(enterpriseScope, () => findOrganizationResource('agent', 'as-9'))
      assert.equal(agent, null, '消费侧 granted OR 分支复查 status，pending 不再放行')
    } finally {
      await ctx.teardown()
    }
  })
})
