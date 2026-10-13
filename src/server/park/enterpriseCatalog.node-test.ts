import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { createCatalogTestRepository } from '../testing/compatibilityRepositories.js'
import { SqliteDriver } from '../db/driver.js'
import type { DocumentStore } from '../documentStore.js'
import { ensureParkSchema } from './parkSchema.js'
import { ParkRepository } from './parkRepository.js'
import { PolicyCatalogService } from './policyCatalogService.js'
import { PolicySearchService } from './policySearchService.js'
import { ParkApiError } from './parkAuthorization.js'

/**
 * 企业侧目录测试（计划 5.3 enterpriseCatalog）：
 * policies/services 代理（园区 wiki 文档清单、metadata 服务清单）与
 * assistant 完整字段——跨 org 不泄漏其他园区数据。
 */

function stubStore(wikis: Array<{ id: string; name: string; storagePath: string; orgId: string }>): DocumentStore {
  return {
    getWiki: async (id: string, orgId: string) => wikis.find(w => w.id === id && w.orgId === orgId) ?? null,
    listWikis: async (orgId: string) => wikis.filter(w => w.orgId === orgId),
  } as unknown as DocumentStore
}

void describe('enterpriseCatalog（企业侧目录端点）', () => {
  void test('policies：仅列出本园区 wiki 的 .md 文件（跨 org 不泄漏）', async () => {
    const db = new DatabaseSync(':memory:')
    const root = await mkdtemp(join(tmpdir(), 'moss-park-cat-'))
    try {
      const dir1 = join(root, 'wiki-1')
      const dir2 = join(root, 'wiki-2')
      await mkdir(dir1, { recursive: true })
      await mkdir(dir2, { recursive: true })
      await writeFile(join(dir1, '租金政策.md'), 'x', 'utf8')
      await writeFile(join(dir1, 'notes.txt'), 'x', 'utf8')
      await writeFile(join(dir2, '他园区政策.md'), 'x', 'utf8')
      const store = stubStore([
        { id: 'wiki-1', name: '本园区政策库', storagePath: dir1, orgId: 'park-org' },
        { id: 'wiki-2', name: '其他园区', storagePath: dir2, orgId: 'park-other' },
      ])

      const service = new PolicySearchService(new SqliteDriver(db), store)
      const files = await service.listPolicyFiles('park-org')
      assert.equal(files.length, 1, '只列本园区 wiki')
      assert.equal(files[0]!.wiki_id, 'wiki-1')
      assert.deepEqual(files[0]!.files, ['租金政策.md'], '.txt 不进清单')
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  void test('services：读取园区 metadata 的 service_catalog 与版本', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=OFF')
    createCatalogTestRepository(db)
    ensureParkSchema(db)
    try {
      const repo = new ParkRepository(new SqliteDriver(db))
      await repo.upsertOrgProfile({
        mossOrgId: 'park-org', orgType: 'park', displayName: '园区',
        metadataJson: JSON.stringify({ service_catalog: [{ name: '工商注册协助', description: '代办' }], service_catalog_version: '3' }),
      })
      const catalog = new PolicyCatalogService(new SqliteDriver(db))
      const result = await catalog.getServiceCatalog('park-org')
      assert.equal(result.version, '3')
      assert.equal(result.items[0]?.name, '工商注册协助')

      const empty = await catalog.getServiceCatalog('park-none')
      assert.deepEqual(empty.items, [], '无配置返回空清单')
    } finally {
      db.close()
    }
  })

  void test('assistant：仅返回分配给本企业的 approved 助手完整字段', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=OFF')
    createCatalogTestRepository(db)
    for (const col of ['enabled_wikis TEXT', 'emoji TEXT']) {
      try { db.exec(`ALTER TABLE tenant_assistants ADD COLUMN ${col}`) } catch { /* present */ }
    }
    ensureParkSchema(db)
    try {
      const dir = join(tmpdir(), `moss-cat-agent-${Date.now()}`)
      await mkdir(dir, { recursive: true })
      db.prepare(`
        INSERT INTO tenant_assistants (id, name, display_name, description, avatar, org_id, author_id, status, source_type, file_path, enabled_wikis, created_at, updated_at)
        VALUES ('as-1', 'park-consultation', '园区咨询', '咨询政策', NULL, 'park-org', 't', 'approved', 'tenant', ?, '["wiki-1"]', 1, 1)
      `).run(dir)
      db.prepare(`
        INSERT INTO tenant_assistants (id, name, display_name, org_id, author_id, status, source_type, file_path, created_at, updated_at)
        VALUES ('as-pending', 'pending-agent', 'P', 'park-org', 't', 'pending', 'tenant', ?, 1, 1)
      `).run(dir)

      const repo = new ParkRepository(new SqliteDriver(db))
      await repo.insertAssignment({ parkOrgId: 'park-org', assistantId: 'as-1', enterpriseOrgId: 'ent-org' })
      await repo.insertAssignment({ parkOrgId: 'park-org', assistantId: 'as-pending', enterpriseOrgId: 'ent-org' })

      const catalog = new PolicyCatalogService(new SqliteDriver(db))
      const assistants = await catalog.getAssignedAssistants('ent-org')
      assert.equal(assistants.length, 1, 'pending 助手不返回')
      assert.equal(assistants[0]!.assistant_id, 'as-1')
      assert.equal(assistants[0]!.display_name, '园区咨询')
      assert.deepEqual(assistants[0]!.enabled_wikis, ['wiki-1'])

      // 其他企业查不到
      const other = await catalog.getAssignedAssistants('ent-other')
      assert.equal(other.length, 0)
    } finally {
      db.close()
    }
  })

  void test('policy.search：q 为空 → 400；无 enabledWikis → 空结果', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=OFF')
    createCatalogTestRepository(db)
    try { db.exec('ALTER TABLE tenant_assistants ADD COLUMN enabled_wikis TEXT') } catch { /* present */ }
    const root = await mkdtemp(join(tmpdir(), 'moss-park-cat-'))
    try {
      const dir = join(root, 'w')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, '政策.md'), '园区租金减免政策内容', 'utf8')
      const store = stubStore([{ id: 'wiki-1', name: '库', storagePath: dir, orgId: 'park-org' }])
      const driver = new SqliteDriver(db)
      const service = new PolicySearchService(driver, store)

      await assert.rejects(
        service.search({ parkOrgId: 'park-org', assistantId: 'as-1', query: '  ' }),
        (err: unknown) => err instanceof ParkApiError && err.code === 'q_required',
      )

      // 无 tenant_assistants 表记录（assistant 无 enabledWikis）→ 空结果不抛错
      const matches = await service.search({ parkOrgId: 'park-org', assistantId: 'as-none', query: '租金' })
      assert.deepEqual(matches, [])
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
