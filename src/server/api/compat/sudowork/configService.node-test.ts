import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { migrationCommandContext, onlineCommandContext } from '../../../application/commandContext.js'
import { AuthCenterDb } from '../../../authCenter/db.js'
import { AuthService } from '../../../auth/service.js'
import { ensureConfigAvailabilitySchema } from '../../../configuration/configAvailabilitySchema.js'
import { createConfigItemsApi } from '../../configItems.js'
import { DirectConnectStore } from '../../../db.js'
import { UnifiedIdentityService } from '../../../identity/unifiedIdentityService.js'
import { createIdentityTestRepository, requireSqliteTestDatabase } from '../../../testing/compatibilityRepositories.js'
import { SudoworkConfigError, SudoworkConfigService } from './configService.js'

async function setup(options: { managedImages?: { read(kind: 'enterprise', filename: string): Promise<{ bytes: Buffer; mimeType: string }> } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'moss-config-compat-'))
  const store = new DirectConnectStore(join(dir, 'moss.db'))
  const db = requireSqliteTestDatabase(store)
  ensureConfigAvailabilitySchema(db)
  const authDb = new AuthCenterDb(store)
  const identities = createIdentityTestRepository(db, {}, store.driver)
  const unified = new UnifiedIdentityService(authDb, identities)
  const orgA = await unified.createOrganization({ name: '企业 A', code: 'ENT-A' }, migrationCommandContext('test', 'org-a'))
  const orgB = await unified.createOrganization({ name: '企业 B', code: 'ENT-B' }, migrationCommandContext('test', 'org-b'))
  const service = new SudoworkConfigService({
    db: store.driver,
    configItems: createConfigItemsApi(store),
    identities,
    authDb,
    managedImages: options.managedImages,
  })
  return { dir, store, db, service, orgA, orgB }
}

void describe('Sudowork 配置项兼容服务', () => {
  void test('全部企业与指定企业映射到统一可用范围', async () => {
    const { dir, store, service, orgA, orgB } = await setup()
    try {
      const root = { userId: 'root', orgId: orgA.organizationId, role: 'super_admin' }
      const global = await service.create(root, { name: '全局令牌', visible_to_all: 1 })
      await service.replaceEntries(root, global.id, [{ config_key: 'token', name: 'Token', required: 1 }])
      assert.equal(Number((await service.entriesFor(root, global.id))[0]?.id) >= 2_000_000_000, true)
      assert.equal((await service.listForUser({ userId: 'user-b', orgId: orgB.organizationId, role: 'user' })).length, 1)

      const assigned = await service.create(root, { name: '指定企业', visible_to_all: 0 })
      await service.replaceEntries(root, assigned.id, [{ config_key: 'key', name: 'Key', required: 1 }])
      await service.associate(root, assigned.id, orgB.legacyEnterpriseId)
      assert.equal((await service.get(root, assigned.id)).enterprises.some(row => row.id === orgB.legacyEnterpriseId), true)
      assert.equal((await service.listForUser({ userId: 'user-b', orgId: orgB.organizationId, role: 'user' })).length, 2)
      await service.dissociate(root, assigned.id, orgB.legacyEnterpriseId)
      assert.equal((await service.listForUser({ userId: 'user-b', orgId: orgB.organizationId, role: 'user' })).length, 1)
    } finally {
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  void test('企业管理员不能把配置项扩散到全部企业或管理其他组织', async () => {
    const { dir, store, service, orgA, orgB } = await setup()
    try {
      const admin = { userId: 'admin-a', orgId: orgA.organizationId, role: 'admin' }
      const created = await service.create(admin, { name: '本企业配置', visible_to_all: 1 })
      assert.equal((await service.get(admin, created.id) as any).visible_to_all, 0)
      await assert.rejects(
        service.associate(admin, created.id, orgB.legacyEnterpriseId),
        (error: unknown) => error instanceof SudoworkConfigError && error.statusCode === 403,
      )
    } finally {
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  void test('创建和更新配置项时可用范围写入失败会回滚统一配置数据', async () => {
    const { dir, store, db, service, orgA } = await setup()
    try {
      const root = { userId: 'root', orgId: orgA.organizationId, role: 'super_admin' }
      db.exec(`
        CREATE TRIGGER reject_config_availability_update
        BEFORE UPDATE OF availability ON config_items
        BEGIN
          SELECT RAISE(ABORT, 'availability write rejected');
        END
      `)
      await assert.rejects(
        service.create(root, { name: '不能残留', visible_to_all: 1 }),
        /availability write rejected/,
      )
      assert.equal(
        Number((db.prepare('SELECT COUNT(*) AS count FROM config_items WHERE name = ?').get('不能残留') as { count: number }).count),
        0,
      )
      assert.equal(
        Number((db.prepare(`SELECT COUNT(*) AS count FROM resource_numeric_aliases WHERE namespace = 'config_item'`).get() as { count: number }).count),
        0,
      )

      db.exec('DROP TRIGGER reject_config_availability_update')
      const created = await service.create(root, { name: '更新前', visible_to_all: 0 })
      db.exec(`
        CREATE TRIGGER reject_config_availability_update
        BEFORE UPDATE OF availability ON config_items
        BEGIN
          SELECT RAISE(ABORT, 'availability write rejected');
        END
      `)
      await assert.rejects(
        service.update(root, created.id, { name: '不应保存', visible_to_all: 1 }),
        /availability write rejected/,
      )
      assert.equal((await service.get(root, created.id) as any).name, '更新前')
    } finally {
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  void test('AuthService 从 Moss 主存储创建同一套配置兼容服务', async () => {
    const { dir, store, orgA } = await setup()
    const authService = new AuthService(new AuthCenterDb(store), 3600)
    try {
      const service = authService.createSudoworkConfigService(store)
      const created = await service.create(
        { userId: 'root', orgId: orgA.organizationId, role: 'super_admin' },
        { name: '生产接线配置', visible_to_all: 0 },
      )
      assert.equal((await service.get(
        { userId: 'root', orgId: orgA.organizationId, role: 'super_admin' },
        created.id,
      ) as any).name, '生产接线配置')
    } finally {
      authService.destroy()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  void test('租户配置把统一组织 Logo 文件投影成旧客户端使用的 data URL', async () => {
    const { dir, store, db, service, orgA } = await setup({
      managedImages: {
        async read(kind, filename) {
          assert.equal(kind, 'enterprise')
          assert.equal(filename, 'brand.png')
          return { bytes: Buffer.from('brand-image'), mimeType: 'image/png' }
        },
      },
    })
    try {
      const identities = createIdentityTestRepository(db, {}, store.driver)
      await identities.putOrganizationProfile({
        ...(await identities.getOrganizationProfile(orgA.organizationId))!,
        logo: 'brand.png',
      })
      const result = await service.getTenantConfig(
        { userId: 'user-a', orgId: orgA.organizationId, role: 'user' },
        'ENT-A',
      )
      assert.equal(result.logo, `data:image/png;base64,${Buffer.from('brand-image').toString('base64')}`)
    } finally {
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  void test('配置兼容 ID 与 Moss 主键解耦，迁移保留旧 ID 且新建项使用保留区', async () => {
    const { dir, store, service, orgA, orgB } = await setup()
    try {
      const root = { userId: 'root', orgId: orgA.organizationId, role: 'super_admin' as const }
      const created = await service.create(root, { name: 'mossconfig', visible_to_all: 0 })
      assert.equal(created.id >= 2_000_000_000, true)
      assert.equal((await service.get(root, created.id) as any).name, 'mossconfig')

      const imported = await service.importConfigItem(root, {
        legacyId: 7,
        ownerOrgId: orgA.organizationId,
        assignedOrgIds: [orgB.organizationId],
        name: '旧配置',
        description: '迁移项',
        pinyin: 'legacy_config',
        visibleToAll: false,
        status: 1,
        entries: [{ legacyId: 8, config_key: 'token', name: 'Token', required: true }],
      }, migrationCommandContext('run-p2', 'config-item:7'))
      const repeated = await service.importConfigItem(root, {
        legacyId: 7,
        ownerOrgId: orgA.organizationId,
        assignedOrgIds: [orgB.organizationId],
        name: 'ignored',
        pinyin: 'ignored',
        visibleToAll: false,
        status: 1,
        entries: [],
      }, migrationCommandContext('run-p2-resume', 'config-item:7'))

      assert.equal(imported.id, 7)
      assert.equal(repeated.id, 7)
      assert.equal((await service.get(root, 7) as any).name, '旧配置')
      assert.equal((await service.get(root, 7) as any).entries[0]?.id, 8)
      assert.equal(((await service.listForUser({ userId: 'user-b', orgId: orgB.organizationId, role: 'user' })) as any[])
        .some(item => item.name === '旧配置'), true)
      await assert.rejects(service.importConfigItem(root, {
        legacyId: 8, ownerOrgId: orgA.organizationId, assignedOrgIds: [],
        name: '非法在线导入', pinyin: 'bad', visibleToAll: false, status: 1, entries: [],
      }, onlineCommandContext('bad-import')), /迁移导入命令/)
    } finally {
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  void test('迁移导入中途失败整体回滚，不留部分写入', async () => {
    const { dir, store, db, service, orgA } = await setup()
    try {
      const root = { userId: 'root', orgId: orgA.organizationId, role: 'super_admin' as const }
      const ok = await service.importConfigItem(root, {
        legacyId: 21, ownerOrgId: orgA.organizationId, assignedOrgIds: [],
        name: '占位配置', pinyin: 'dup-first', visibleToAll: false, status: 1,
        entries: [],
      }, migrationCommandContext('run-p2', 'config-item:21'))
      assert.equal(ok.id, 21)

      // 不同幂等键导入同一 legacyId：resource_numeric_aliases 唯一冲突，
      // 整个导入事务必须回滚（不残留 config item，也不写幂等记录）
      await assert.rejects(service.importConfigItem(root, {
        legacyId: 21, ownerOrgId: orgA.organizationId, assignedOrgIds: [],
        name: '冲突残留探测', pinyin: 'dup-second', visibleToAll: false, status: 1,
        entries: [],
      }, migrationCommandContext('run-p2', 'config-item:21-dup')), /UNIQUE constraint failed/)

      const leftover = db.prepare(
        "SELECT COUNT(*) AS count FROM config_items WHERE pinyin = 'dup-second'",
      ).get() as { count: number }
      assert.equal(leftover.count, 0, '冲突导入不得残留 config item')
      const command = db.prepare(
        "SELECT COUNT(*) AS count FROM command_executions WHERE idempotency_key = 'config-item:21-dup'",
      ).get() as { count: number }
      assert.equal(command.count, 0, '失败命令不得写入幂等记录')
    } finally {
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
