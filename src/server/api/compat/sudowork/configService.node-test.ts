import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { migrationCommandContext, onlineCommandContext } from '../../../application/commandContext.js'
import { AuthCenterDb } from '../../../authCenter/db.js'
import { AuthService } from '../../../auth/service.js'
import { createConfigItemsApi } from '../../configItems.js'
import { DirectConnectStore } from '../../../db.js'
import { IdentityRepository } from '../../../identity/identityRepository.js'
import { UnifiedIdentityService } from '../../../identity/unifiedIdentityService.js'
import { SudoworkConfigError, SudoworkConfigService } from './configService.js'

function setup(options: { managedImages?: { read(kind: 'enterprise', filename: string): Promise<{ bytes: Buffer; mimeType: string }> } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'moss-config-compat-'))
  const store = new DirectConnectStore(join(dir, 'moss.db'))
  const authDb = new AuthCenterDb(store.db)
  const identities = new IdentityRepository(store.db)
  const unified = new UnifiedIdentityService(store.db, authDb, identities)
  const orgA = unified.createOrganization({ name: '企业 A', code: 'ENT-A' }, migrationCommandContext('test', 'org-a'))
  const orgB = unified.createOrganization({ name: '企业 B', code: 'ENT-B' }, migrationCommandContext('test', 'org-b'))
  const service = new SudoworkConfigService({
    db: store.db,
    configItems: createConfigItemsApi(store),
    identities,
    authDb,
    managedImages: options.managedImages,
  })
  return { dir, store, service, orgA, orgB }
}

describe('Sudowork 配置项兼容服务', () => {
  test('全部企业与指定企业映射到统一可用范围', () => {
    const { dir, store, service, orgA, orgB } = setup()
    try {
      const root = { userId: 'root', orgId: orgA.organizationId, role: 'super_admin' }
      const global = service.create(root, { name: '全局令牌', visible_to_all: 1 })
      service.replaceEntries(root, global.id, [{ config_key: 'token', name: 'Token', required: 1 }])
      assert.equal(Number(service.entriesFor(root, global.id)[0]?.id) >= 2_000_000_000, true)
      assert.equal(service.listForUser({ userId: 'user-b', orgId: orgB.organizationId, role: 'user' }).length, 1)

      const assigned = service.create(root, { name: '指定企业', visible_to_all: 0 })
      service.replaceEntries(root, assigned.id, [{ config_key: 'key', name: 'Key', required: 1 }])
      service.associate(root, assigned.id, orgB.legacyEnterpriseId)
      assert.equal(service.get(root, assigned.id).enterprises.some(row => row.id === orgB.legacyEnterpriseId), true)
      assert.equal(service.listForUser({ userId: 'user-b', orgId: orgB.organizationId, role: 'user' }).length, 2)
      service.dissociate(root, assigned.id, orgB.legacyEnterpriseId)
      assert.equal(service.listForUser({ userId: 'user-b', orgId: orgB.organizationId, role: 'user' }).length, 1)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('企业管理员不能把配置项扩散到全部企业或管理其他组织', () => {
    const { dir, store, service, orgA, orgB } = setup()
    try {
      const admin = { userId: 'admin-a', orgId: orgA.organizationId, role: 'admin' }
      const created = service.create(admin, { name: '本企业配置', visible_to_all: 1 })
      assert.equal(service.get(admin, created.id).visible_to_all, 0)
      assert.throws(
        () => service.associate(admin, created.id, orgB.legacyEnterpriseId),
        (error: unknown) => error instanceof SudoworkConfigError && error.statusCode === 403,
      )
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('创建和更新配置项时可用范围写入失败会回滚统一配置数据', () => {
    const { dir, store, service, orgA } = setup()
    try {
      const root = { userId: 'root', orgId: orgA.organizationId, role: 'super_admin' }
      store.db.exec(`
        CREATE TRIGGER reject_config_availability_update
        BEFORE UPDATE OF availability ON config_items
        BEGIN
          SELECT RAISE(ABORT, 'availability write rejected');
        END
      `)
      assert.throws(
        () => service.create(root, { name: '不能残留', visible_to_all: 1 }),
        /availability write rejected/,
      )
      assert.equal(
        Number((store.db.prepare('SELECT COUNT(*) AS count FROM config_items WHERE name = ?').get('不能残留') as { count: number }).count),
        0,
      )
      assert.equal(
        Number((store.db.prepare(`SELECT COUNT(*) AS count FROM resource_numeric_aliases WHERE namespace = 'config_item'`).get() as { count: number }).count),
        0,
      )

      store.db.exec('DROP TRIGGER reject_config_availability_update')
      const created = service.create(root, { name: '更新前', visible_to_all: 0 })
      store.db.exec(`
        CREATE TRIGGER reject_config_availability_update
        BEFORE UPDATE OF availability ON config_items
        BEGIN
          SELECT RAISE(ABORT, 'availability write rejected');
        END
      `)
      assert.throws(
        () => service.update(root, created.id, { name: '不应保存', visible_to_all: 1 }),
        /availability write rejected/,
      )
      assert.equal(service.get(root, created.id).name, '更新前')
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('AuthService 从 Moss 主存储创建同一套配置兼容服务', () => {
    const { dir, store, orgA } = setup()
    const authService = new AuthService(new AuthCenterDb(store.db), 3600)
    try {
      const service = authService.createSudoworkConfigService(store)
      const created = service.create(
        { userId: 'root', orgId: orgA.organizationId, role: 'super_admin' },
        { name: '生产接线配置', visible_to_all: 0 },
      )
      assert.equal(service.get(
        { userId: 'root', orgId: orgA.organizationId, role: 'super_admin' },
        created.id,
      ).name, '生产接线配置')
    } finally {
      authService.destroy()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('租户配置把统一组织 Logo 文件投影成旧客户端使用的 data URL', async () => {
    const { dir, store, service, orgA } = setup({
      managedImages: {
        async read(kind, filename) {
          assert.equal(kind, 'enterprise')
          assert.equal(filename, 'brand.png')
          return { bytes: Buffer.from('brand-image'), mimeType: 'image/png' }
        },
      },
    })
    try {
      const identities = new IdentityRepository(store.db)
      identities.putOrganizationProfile({
        ...identities.getOrganizationProfile(orgA.organizationId)!,
        logo: 'brand.png',
      })
      const result = await service.getTenantConfig(
        { userId: 'user-a', orgId: orgA.organizationId, role: 'user' },
        'ENT-A',
      )
      assert.equal(result.logo, `data:image/png;base64,${Buffer.from('brand-image').toString('base64')}`)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('配置兼容 ID 与 Moss 主键解耦，迁移保留旧 ID 且新建项使用保留区', () => {
    const { dir, store, service, orgA, orgB } = setup()
    try {
      const root = { userId: 'root', orgId: orgA.organizationId, role: 'super_admin' as const }
      const created = service.create(root, { name: 'mossconfig', visible_to_all: 0 })
      assert.equal(created.id >= 2_000_000_000, true)
      assert.equal(service.get(root, created.id).name, 'mossconfig')

      const imported = service.importConfigItem(root, {
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
      const repeated = service.importConfigItem(root, {
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
      assert.equal(service.get(root, 7).name, '旧配置')
      assert.equal(service.get(root, 7).entries[0]?.id, 8)
      assert.equal(service.listForUser({ userId: 'user-b', orgId: orgB.organizationId, role: 'user' })
        .some(item => item.name === '旧配置'), true)
      assert.throws(() => service.importConfigItem(root, {
        legacyId: 8, ownerOrgId: orgA.organizationId, assignedOrgIds: [],
        name: '非法在线导入', pinyin: 'bad', visibleToAll: false, status: 1, entries: [],
      }, onlineCommandContext('bad-import')), /迁移导入命令/)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
