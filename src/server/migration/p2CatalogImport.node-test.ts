import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import JSZip from 'jszip'
import { CatalogArtifactStore } from '../catalog/catalogArtifactStore.js'
import { CatalogService } from '../catalog/catalogService.js'
import { SqliteDriver } from '../db/driver.js'
import { createCatalogTestRepository } from '../testing/compatibilityRepositories.js'
import { P2CatalogImportService } from './p2CatalogImport.js'

function setup(root: string) {
  const db = new DatabaseSync(':memory:')
  const driver = new SqliteDriver(db)
  const repository = createCatalogTestRepository(db, driver)
  return {
    db,
    repository,
    importer: new P2CatalogImportService({
      db: driver,
      repository,
      catalog: new CatalogService(repository),
      artifacts: new CatalogArtifactStore(root),
      publicBaseUrl: 'https://moss.example.test',
    }),
  }
}

async function skillArchive(): Promise<Buffer> {
  const archive = new JSZip()
  archive.file('SKILL.md', '# Imported')
  return archive.generateAsync({ type: 'nodebuffer' })
}

void describe('P2 目录迁移编排', () => {
  void test('保留历史 Skill 元数据并发布经过校验的制品，重复执行不会复制数据', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moss-p2-import-'))
    const fixture = setup(root)
    try {
      const bytes = await skillArchive()
      const checksum = createHash('sha256').update(bytes).digest('hex')
      const input = {
        migrationRunId: 'run-p2',
        actor: { userId: 'migration-admin', orgId: 'root', role: 'super_admin' as const },
        orgId: 'org-a',
        resource: {
          id: 'legacy-skill-7', name: 'writer', displayName: '历史技能',
          authorId: 'mapped-owner', authorName: '旧作者', status: 'approved',
          enabled: true, supportedModes: 'both' as const, version: '2.0.0',
          checksum, createdAt: 100, updatedAt: 200,
          externalIdentity: { providerType: 'sudohub', providerId: 'legacy-prod', externalId: 'legacy-skill-7' },
        },
        bytes,
      }

      const first = await fixture.importer.importSkill(input)
      const repeated = await fixture.importer.importSkill(input)

      assert.equal(first.id, 'legacy-skill-7')
      assert.equal(repeated.filePath, first.filePath)
      assert.equal(first.sourceUrl, 'https://moss.example.test/api/catalog/artifacts/skill/legacy-skill-7')
      assert.deepEqual(await fixture.importer.readArtifact(first.filePath!, checksum), bytes)
      assert.equal((await fixture.repository.listSkills({ orgId: 'org-a' })).items.length, 1)
    } finally {
      fixture.db.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  void test('源 checksum 不一致时不写主数据和幂等记录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moss-p2-import-'))
    const fixture = setup(root)
    try {
      const bytes = await skillArchive()
      await assert.rejects(fixture.importer.importSkill({
        migrationRunId: 'run-p2',
        actor: { userId: 'migration-admin', orgId: 'root', role: 'super_admin' },
        orgId: 'org-a',
        resource: {
          id: 'bad-checksum', name: 'bad', authorId: 'mapped-owner', status: 'approved',
          supportedModes: 'local', version: '1.0.0', checksum: 'not-the-real-checksum',
          externalIdentity: { providerType: 'sudohub', providerId: 'legacy-prod', externalId: 'bad-checksum' },
        },
        bytes,
      }), /checksum/)
      assert.equal(await fixture.repository.getSkill('bad-checksum', 'org-a'), null)
      assert.equal(await fixture.repository.getCommandResult('catalog.import_skill', 'p2:skill:legacy-prod:bad-checksum'), null)
    } finally {
      fixture.db.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
