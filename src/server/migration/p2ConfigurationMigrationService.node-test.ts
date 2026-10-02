import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { createConfigItemsApi } from '../api/configItems.js'
import { SudoworkConfigService } from '../api/compat/sudowork/configService.js'
import { ensureConfigAvailabilitySchema } from '../configuration/configAvailabilitySchema.js'
import { DirectConnectStore } from '../db.js'
import { UnifiedIdentityService } from '../identity/unifiedIdentityService.js'
import { createIdentityTestRepository, requireSqliteTestDatabase } from '../testing/compatibilityRepositories.js'
import { migrationCommandContext } from '../application/commandContext.js'
import {
  P2ConfigurationMigrationBlockedError,
  P2ConfigurationMigrationService,
} from './p2ConfigurationMigrationService.js'
import type { SudoworkSourceConfigItem } from './sudoworkP2SourceReader.js'

async function setup(items: SudoworkSourceConfigItem[]) {
  const dir = mkdtempSync(join(tmpdir(), 'moss-p2-config-migration-'))
  const store = new DirectConnectStore(join(dir, 'moss.db'))
  const db = requireSqliteTestDatabase(store)
  ensureConfigAvailabilitySchema(db)
  const authDb = new AuthCenterDb(store)
  const identities = createIdentityTestRepository(db, {}, store.driver)
  const identity = new UnifiedIdentityService(authDb, identities)
  const platform = await identity.createOrganization(
    { name: '平台配置', code: 'PLATFORM', legacyEnterpriseId: 99 },
    migrationCommandContext('identity', 'org-platform'),
  )
  const orgA = await identity.createOrganization(
    { name: '企业 A', code: 'ENT-A', legacyEnterpriseId: 1 },
    migrationCommandContext('identity', 'org-a'),
  )
  const orgB = await identity.createOrganization(
    { name: '企业 B', code: 'ENT-B', legacyEnterpriseId: 2 },
    migrationCommandContext('identity', 'org-b'),
  )
  const config = new SudoworkConfigService({
    db: store.driver,
    configItems: createConfigItemsApi(store),
    identities,
    authDb,
  })
  const migration = new P2ConfigurationMigrationService({
    db: store.driver,
    identities,
    config,
    platformConfigOrgId: platform.organizationId,
    source: { readConfigItems: () => items },
  })
  return { dir, store, db, identities, platform, orgA, orgB, config, migration }
}

function sourceItem(overrides: Partial<SudoworkSourceConfigItem> = {}): SudoworkSourceConfigItem {
  return {
    id: 7,
    name: 'GitLab',
    description: '代码服务',
    icon: 'gitlab.png',
    pinyin: 'gitlab',
    urlPattern: 'https://git.example/*',
    scheme: 'bearer',
    bearerPrefix: 'Bearer ',
    visibleToAll: false,
    status: 1,
    createdById: 10,
    createdByName: '管理员',
    updatedById: 10,
    updatedByName: '管理员',
    createdAt: Date.parse('2026-01-01T00:00:00Z'),
    updatedAt: Date.parse('2026-01-02T00:00:00Z'),
    entries: [{
      id: 8,
      configKey: 'token',
      name: '访问令牌',
      description: '个人令牌',
      required: true,
      createdAt: Date.parse('2026-01-01T00:00:00Z'),
      updatedAt: Date.parse('2026-01-02T00:00:00Z'),
    }],
    enterpriseIds: [1, 2],
    ...overrides,
  }
}

void describe('P2 配置定义迁移', () => {
  void test('预检零写入，保留旧 ID 和字段并对多个组织保持单份主数据', async () => {
    const fixture = await setup([sourceItem()])
    try {
      const plan = await fixture.migration.plan()
      assert.equal(plan.status, 'ready')
      assert.deepEqual(plan.counts, { source: 1, imports: 1, reuses: 0 })
      assert.equal(await fixture.identities.resolveNumericAliasGlobal('config_item', 7), null)

      assert.deepEqual(await fixture.migration.execute('p2-config'), {
        migrationRunId: 'p2-config', imported: 1, reused: 0, source: 1,
      })
      assert.deepEqual(await fixture.migration.execute('p2-config-resume'), {
        migrationRunId: 'p2-config-resume', imported: 0, reused: 1, source: 1,
      })

      const root = { userId: 'migration-system', orgId: fixture.platform.organizationId, role: 'super_admin' as const }
      const item = await fixture.config.get(root, 7) as {
        name: string
        url_pattern: string
        scheme: string
        bearer_prefix: string
        entries: Array<{ config_key: string }>
        enterprises: unknown[]
      }
      assert.equal(item.name, 'GitLab')
      assert.equal(item.url_pattern, 'https://git.example/*')
      assert.equal(item.scheme, 'bearer')
      assert.equal(item.bearer_prefix, 'Bearer ')
      assert.equal(item.entries[0]?.config_key, 'token')
      assert.equal(item.enterprises.length, 2)
      assert.equal((await fixture.config.listForUser({ userId: 'a', orgId: fixture.orgA.organizationId, role: 'user' })).length, 1)
      assert.equal((await fixture.config.listForUser({ userId: 'b', orgId: fixture.orgB.organizationId, role: 'user' })).length, 1)
      assert.equal(
        Number((fixture.db.prepare('SELECT COUNT(*) AS count FROM config_items WHERE name = ?').get('GitLab') as { count: number }).count),
        1,
      )
    } finally {
      await fixture.store.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  void test('未知企业与名称冲突阻断整批配置迁移且不产生部分写入', async () => {
    const items = [sourceItem(), sourceItem({
      id: 9,
      name: '未知企业项',
      pinyin: 'orphan',
      enterpriseIds: [404],
      entries: [{ ...sourceItem().entries[0]!, id: 10 }],
    })]
    const fixture = await setup(items)
    try {
      await fixture.config.create(
        { userId: 'root', orgId: fixture.platform.organizationId, role: 'super_admin' },
        { name: 'GitLab', visible_to_all: 0 },
      )
      const before = Number((fixture.db.prepare('SELECT COUNT(*) AS count FROM config_items').get() as { count: number }).count)
      const plan = await fixture.migration.plan()
      assert.equal(plan.status, 'blocked')
      assert.equal(plan.conflicts.some(issue => issue.sourceId === '7'), true)
      assert.equal(plan.orphans.some(issue => issue.reason.includes('404')), true)
      await assert.rejects(
        fixture.migration.execute('blocked'),
        (error: unknown) => error instanceof P2ConfigurationMigrationBlockedError,
      )
      assert.equal(Number((fixture.db.prepare('SELECT COUNT(*) AS count FROM config_items').get() as { count: number }).count), before)
      assert.equal(await fixture.identities.resolveNumericAliasGlobal('config_item', 7), null)
    } finally {
      await fixture.store.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })
})
