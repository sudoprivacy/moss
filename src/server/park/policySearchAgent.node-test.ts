import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { createCatalogTestRepository } from '../testing/compatibilityRepositories.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { ensureIdentitySchema } from '../identity/identityRepository.js'
import { SqliteDriver } from '../db/driver.js'
import type { DocumentStore } from '../documentStore.js'
import { PolicySearchService } from './policySearchService.js'
import { ParkApiError } from './parkAuthorization.js'

void describe('policySearchAgent', () => {
  void test('只检索 Assistant 启用且属于园区的 Wiki，企业 org 不持有 Wiki 也可命中', async () => {
    const db = new DatabaseSync(':memory:')
    new AuthCenterDb(db)
    ensureIdentitySchema(db)
    createCatalogTestRepository(db)
    try { db.exec('ALTER TABLE tenant_assistants ADD COLUMN enabled_wikis TEXT') } catch { /* present */ }
    const root = await mkdtemp(join(tmpdir(), 'park-policy-search-'))
    try {
      const enabledDir = join(root, 'enabled')
      const disabledDir = join(root, 'disabled')
      await mkdir(enabledDir)
      await mkdir(disabledDir)
      await writeFile(join(enabledDir, '租金政策.md'), '租金减免三个月\n', 'utf8')
      await writeFile(join(disabledDir, '未启用政策.md'), '租金补贴六个月\n', 'utf8')
      db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('park-1', '园区', 1)").run()
      db.prepare(`INSERT INTO tenant_assistants
        (id, name, display_name, org_id, author_id, status, source_type, file_path, enabled_wikis, created_at, updated_at)
        VALUES ('as-1', 'consulting', '咨询', 'park-1', 'author', 'approved', 'tenant', ?, ?, 1, 1)`)
        .run(root, JSON.stringify(['wiki-enabled', 'wiki-other-org']))
      const wikis = [
        { id: 'wiki-enabled', orgId: 'park-1', storagePath: enabledDir },
        { id: 'wiki-disabled', orgId: 'park-1', storagePath: disabledDir },
        { id: 'wiki-other-org', orgId: 'park-2', storagePath: disabledDir },
      ]
      const documentStore = {
        getWiki: async (id: string, orgId: string) => wikis.find(wiki => wiki.id === id && wiki.orgId === orgId) ?? null,
      } as unknown as DocumentStore
      const service = new PolicySearchService(new SqliteDriver(db), documentStore)
      const matches = await service.search({ parkOrgId: 'park-1', assistantId: 'as-1', query: '租金' })
      assert.equal(matches.length, 1)
      assert.equal(matches[0]?.wiki_id, 'wiki-enabled')
      assert.equal(matches[0]?.file, '租金政策.md')
      assert.deepEqual(await service.search({ parkOrgId: 'enterprise-1', assistantId: 'as-1', query: '租金' }), [])
      await assert.rejects(
        service.search({ parkOrgId: 'park-1', assistantId: 'as-1', query: ' ' }),
        (error: unknown) => error instanceof ParkApiError && error.code === 'q_required',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      db.close()
    }
  })
})
