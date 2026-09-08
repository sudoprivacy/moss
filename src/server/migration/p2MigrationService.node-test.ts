import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import JSZip from 'jszip'
import { migrationCommandContext } from '../application/commandContext.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { CatalogArtifactStore } from '../catalog/catalogArtifactStore.js'
import { CatalogRepository } from '../catalog/catalogRepository.js'
import { CatalogService } from '../catalog/catalogService.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { UnifiedIdentityService } from '../identity/unifiedIdentityService.js'
import { P2CatalogImportService } from './p2CatalogImport.js'
import { P2MigrationBlockedError, P2MigrationService } from './p2MigrationService.js'
import type { SudoworkHubManifest } from './sudoworkP2SourceReader.js'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'moss-p2-migration-'))
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tenant_assistants (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT, description TEXT,
      default_init_prompt TEXT, prompts_i18n TEXT, categories TEXT, avatar TEXT, skills TEXT,
      version TEXT, author_id TEXT NOT NULL, author_name TEXT, status TEXT DEFAULT 'pending',
      source_url TEXT, checksum TEXT, file_path TEXT, enabled_skills TEXT,
      publish_note TEXT, review_note TEXT, reviewed_by TEXT, reviewed_at INTEGER,
      enabled INTEGER DEFAULT 1, visible_to TEXT, org_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE tenant_skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT, description TEXT,
      version TEXT, author_id TEXT NOT NULL, author_name TEXT, status TEXT DEFAULT 'pending',
      source_url TEXT, checksum TEXT, file_path TEXT, publish_note TEXT,
      review_note TEXT, reviewed_by TEXT, reviewed_at INTEGER,
      enabled INTEGER DEFAULT 1, visible_to TEXT, org_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
  const authDb = new AuthCenterDb(db)
  const identities = new IdentityRepository(db)
  const identity = new UnifiedIdentityService(db, authDb, identities)
  const context = migrationCommandContext('identity-run', 'org-a')
  const orgA = identity.createOrganization({ name: '企业 A', code: 'ENT-A', legacyEnterpriseId: 1 }, context)
  const orgB = identity.createOrganization({ name: '企业 B', code: 'ENT-B', legacyEnterpriseId: 2 }, migrationCommandContext('identity-run', 'org-b'))
  const owner = identity.createUser({
    orgId: orgA.organizationId, username: 'owner', password: 'secret', role: 'admin', legacyUserId: 10,
  }, migrationCommandContext('identity-run', 'user-owner'))
  const repository = new CatalogRepository(db)
  const importer = new P2CatalogImportService({
    db,
    repository,
    catalog: new CatalogService(db, repository),
    artifacts: new CatalogArtifactStore(root),
    publicBaseUrl: 'https://moss.example.test',
  })
  const skillZip = new JSZip()
  skillZip.file('SKILL.md', '# Writer')
  const skillBytes = await skillZip.generateAsync({ type: 'nodebuffer' })
  const agentZip = new JSZip()
  agentZip.file('agent.json', '{}')
  const agentBytes = await agentZip.generateAsync({ type: 'nodebuffer' })
  const artifacts = new Map([
    ['artifacts/skill.zip', skillBytes],
    ['artifacts/agent.zip', agentBytes],
  ])
  const manifest: SudoworkHubManifest = {
    schemaVersion: 1,
    source: {
      sudoworkServerCommit: 'server', sudoworkClientCommit: 'client',
      hubProviderId: 'hub-production',
      hubExportId: 'hub-export', exportedAt: '2026-09-07T00:00:00.000Z',
    },
    agents: [{
      id: 'agent-1', tenantIds: ['ENT-A', 'ENT-B'], name: 'agent', displayName: '助手',
      authorId: '10', status: 1, version: '1.0.0',
      checksum: createHash('sha256').update(agentBytes).digest('hex'),
      artifactPath: 'artifacts/agent.zip', metadata: { categories: ['效率'] },
    }],
    skills: [{
      id: 'skill-1', tenantIds: [], name: 'writer', displayName: '写作',
      authorId: '10', status: 1, version: '2.0.0',
      checksum: createHash('sha256').update(skillBytes).digest('hex'),
      artifactPath: 'artifacts/skill.zip', metadata: { categories: ['写作'], enabled: true },
    }],
  }
  const migration = new P2MigrationService({
    identities,
    repository,
    importer,
    platformCatalogOrgId: orgA.organizationId,
    source: {
      readHubManifest: async () => manifest,
      readArtifact: async path => artifacts.get(path)!,
    },
  })
  return { root, db, identities, repository, migration, orgA, orgB, owner, manifest }
}

describe('P2 目录迁移计划与执行', () => {
  test('预检无写入，执行后公共和多企业资源各只有一份且可重复运行', async () => {
    const fixture = await setup()
    try {
      const plan = await fixture.migration.plan()
      assert.equal(plan.status, 'ready')
      assert.deepEqual(plan.counts, { agents: 1, skills: 1, imports: 2, reuses: 0 })
      assert.equal(fixture.repository.listAgents({ orgId: fixture.orgA.organizationId }).items.length, 0)

      const first = await fixture.migration.execute('run-p2')
      fixture.manifest.source.hubExportId = 'hub-export-next-snapshot'
      const repeated = await fixture.migration.execute('run-p2-resume')
      assert.equal(first.imported, 2)
      assert.equal(repeated.imported, 0)
      assert.equal(repeated.reused, 2)
      assert.deepEqual(
        fixture.repository.listAgents({ orgId: fixture.orgB.organizationId }).items.map(item => item.id),
        ['agent-1'],
      )
      assert.deepEqual(fixture.repository.listSkills({ orgId: fixture.orgB.organizationId }).items.map(item => item.id), ['skill-1'])
      assert.equal(fixture.repository.findAgent('agent-1')?.authorId, fixture.owner.userId)
      assert.equal(fixture.repository.findAgent('agent-1')?.availability, 'assigned')
      assert.equal(fixture.repository.findSkill('skill-1')?.availability, 'all')
    } finally {
      fixture.db.close()
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('未知企业和同名目标资源形成阻塞报告，execute 不做部分写入', async () => {
    const fixture = await setup()
    try {
      fixture.repository.createSkill({
        id: 'existing', orgId: fixture.orgA.organizationId, name: 'writer',
        authorId: fixture.owner.userId, status: 'approved',
      })
      fixture.manifest.agents[0]!.tenantIds = ['UNKNOWN']

      const plan = await fixture.migration.plan()
      assert.equal(plan.status, 'blocked')
      assert.equal(plan.orphans.some(item => item.reason.includes('UNKNOWN')), true)
      assert.equal(plan.conflicts.some(item => item.reason.includes('writer')), true)
      await assert.rejects(
        fixture.migration.execute('blocked-run'),
        (error: unknown) => error instanceof P2MigrationBlockedError && error.report.status === 'blocked',
      )
      assert.equal(fixture.repository.findAgent('agent-1'), null)
      assert.equal(fixture.repository.findSkill('skill-1'), null)
    } finally {
      fixture.db.close()
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})
