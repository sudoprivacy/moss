import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import type { StagedCatalogArtifact } from './catalogArtifactStore.js'
import { CatalogRepository } from './catalogRepository.js'
import { CatalogService } from './catalogService.js'
import { CatalogUploadService, type CatalogArtifactPort } from './catalogUploadService.js'

function setup(failPublish = false) {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tenant_assistants (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT, description TEXT,
      default_init_prompt TEXT, prompts_i18n TEXT, categories TEXT, avatar TEXT, skills TEXT,
      version TEXT, author_id TEXT NOT NULL, author_name TEXT, status TEXT DEFAULT 'pending',
      source_url TEXT, checksum TEXT, file_path TEXT, enabled_skills TEXT,
      publish_note TEXT, review_note TEXT, reviewed_by TEXT, reviewed_at INTEGER,
      enabled INTEGER DEFAULT 1, visible_to TEXT, org_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE tenant_skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT, description TEXT,
      version TEXT, author_id TEXT NOT NULL, author_name TEXT, status TEXT DEFAULT 'pending',
      source_url TEXT, checksum TEXT, file_path TEXT, publish_note TEXT, review_note TEXT,
      reviewed_by TEXT, reviewed_at INTEGER, enabled INTEGER DEFAULT 1, visible_to TEXT,
      org_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
  const repository = new CatalogRepository(db)
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
    db, repository, catalog: new CatalogService(db, repository), artifacts,
    publicBaseUrl: 'https://moss.example.test/',
  })
  return { db, repository, service, staged, discarded }
}

describe('统一目录上传编排', () => {
  test('上传 Skill 写入统一主表并保持命令幂等', async () => {
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
    assert.equal(repository.listSkills({ orgId: 'org-a' }).items.length, 1)
    db.close()
  })

  test('制品发布失败时撤销资源和幂等记录并清理暂存文件', async () => {
    const { db, repository, service, discarded } = setup(true)
    const input = {
      actor: { userId: 'user-a', orgId: 'org-a', role: 'user' },
      name: 'agent', profession: '助手', bytes: Buffer.from('zip'), idempotencyKey: 'upload-agent-a',
    }
    await assert.rejects(service.uploadAgent(input), /disk full/)
    assert.equal(repository.listAgents({ orgId: 'org-a' }).items.length, 0)
    assert.equal(repository.getCommandResult('catalog.create_agent', 'upload-agent-a'), null)
    assert.equal(discarded.length, 1)
    db.close()
  })
})
