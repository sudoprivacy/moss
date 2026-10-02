import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { SqliteDriver } from '../db/driver.js'
import { createCatalogTestRepository } from '../testing/compatibilityRepositories.js'
import type { StagedCatalogArtifact } from './catalogArtifactStore.js'
import { CatalogService } from './catalogService.js'
import { CatalogUploadService, type CatalogArtifactPort } from './catalogUploadService.js'

function setup(failPublish = false) {
  const db = new DatabaseSync(':memory:')
  const driver = new SqliteDriver(db)
  const repository = createCatalogTestRepository(db, driver)
  const staged: StagedCatalogArtifact[] = []
  const discarded: StagedCatalogArtifact[] = []
  const artifacts: CatalogArtifactPort = {
    async stage(input) {
      const value = {
        kind: input.kind, checksum: 'a'.repeat(64), size: input.bytes.length,
        stagingPath: `/managed/staging/${input.resourceId}.zip`,
        finalPath: `/managed/${input.resourceId}.zip`,
      }
      staged.push(value)
      return value
    },
    async publish() { if (failPublish) throw new Error('disk full') },
    async discard(value) { discarded.push(value) },
    async read() { return Buffer.from('artifact') },
  }
  const service = new CatalogUploadService({
    db: driver, repository, catalog: new CatalogService(repository), artifacts,
    publicBaseUrl: 'https://moss.example.test/',
  })
  return { db, repository, service, staged, discarded }
}

void describe('统一目录上传编排', () => {
  void test('上传 Skill 写入统一主表并保持命令幂等', async () => {
    const { db, repository, service, staged } = setup()
    const actor = { userId: 'user-a', orgId: 'org-a', role: 'user' }
    const first = await service.uploadSkill({
      actor, name: 'writer', displayName: '写作', categories: ['效率'], bytes: Buffer.from('zip'),
      idempotencyKey: 'upload-skill-a',
    })
    const repeated = await service.uploadSkill({
      actor, name: 'ignored', displayName: 'ignored', bytes: Buffer.from('zip'),
      idempotencyKey: 'upload-skill-a',
    })
    assert.equal(first.id, repeated.id)
    assert.equal(staged.length, 1)
    assert.equal(first.sourceUrl, `https://moss.example.test/api/catalog/artifacts/skill/${first.id}`)
    assert.equal((await repository.listSkills({ orgId: 'org-a' })).items.length, 1)
    db.close()
  })

  void test('制品发布失败时撤销资源和幂等记录并清理暂存文件', async () => {
    const { db, repository, service, discarded } = setup(true)
    const input = {
      actor: { userId: 'user-a', orgId: 'org-a', role: 'user' },
      name: 'agent', profession: '助手', bytes: Buffer.from('zip'), idempotencyKey: 'upload-agent-a',
    }
    await assert.rejects(service.uploadAgent(input), /disk full/)
    assert.equal((await repository.listAgents({ orgId: 'org-a' })).items.length, 0)
    assert.equal(await repository.getCommandResult('catalog.create_agent', 'upload-agent-a'), null)
    assert.equal(discarded.length, 1)
    db.close()
  })
})
