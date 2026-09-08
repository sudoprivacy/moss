import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import JSZip from 'jszip'
import { migrationCommandContext } from '../../../application/commandContext.js'
import { AuthCenterDb } from '../../../authCenter/db.js'
import { CatalogRepository } from '../../../catalog/catalogRepository.js'
import { CatalogService } from '../../../catalog/catalogService.js'
import { CatalogArtifactStore } from '../../../catalog/catalogArtifactStore.js'
import { CatalogUploadService } from '../../../catalog/catalogUploadService.js'
import { IdentityRepository } from '../../../identity/identityRepository.js'
import { UnifiedIdentityService } from '../../../identity/unifiedIdentityService.js'
import { SudoworkCatalogError, SudoworkCatalogService } from './catalogService.js'

function setup() {
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
  const unified = new UnifiedIdentityService(db, authDb, identities)
  const orgA = unified.createOrganization({ name: '企业 A', code: 'ENT-A' }, migrationCommandContext('test', 'org-a'))
  const orgB = unified.createOrganization({ name: '企业 B', code: 'ENT-B' }, migrationCommandContext('test', 'org-b'))
  const repository = new CatalogRepository(db)
  const catalog = new CatalogService(db, repository)
  const compatibility = new SudoworkCatalogService({
    repository,
    catalog,
    identities,
    buildVisibility: (actor) => ({
      isAdmin: actor.role === 'admin' || actor.role === 'super_admin',
      userId: actor.userId,
      departmentId: null,
      visibleDepartmentIds: new Set(),
    }),
  })
  return { db, repository, catalog, identities, compatibility, orgA, orgB }
}

describe('Sudowork Catalog 协议投影', () => {
  test('按企业码返回旧 Hub 游标结构且不泄漏内部文件路径', () => {
    const { db, repository, compatibility, orgA } = setup()
    repository.createAgent({
      id: 'agent-1', orgId: orgA.organizationId, name: 'writer', displayName: '写作助手',
      profession: '内容创作', description: 'desc', defaultInitPrompt: '开始',
      promptsI18n: { 'zh-CN': ['写一篇文章'] }, categories: ['写作'], skills: ['skill-1'],
      version: '1.2.0', checksum: 'sha256:abc', filePath: '/private/moss/agent-1',
      sourceUrl: 'https://moss.example.test/catalog/agents/agent-1/download',
      authorId: 'admin-a', status: 'approved', providerType: 'moss_runtime', supportedModes: 'both',
      updatedAt: 100,
    })

    const result = compatibility.listAgents({
      actor: { userId: 'admin-a', orgId: orgA.organizationId, role: 'admin' },
      tenantCode: 'ENT-A', limit: 20,
    })
    assert.equal(result.success, true)
    assert.equal(result.data.assistants[0]?.tenantId, 'ENT-A')
    assert.equal(result.data.assistants[0]?.latestVersion?.version, '1.2.0')
    assert.equal(result.data.assistants[0]?.latestVersion?.checksum, 'sha256:abc')
    assert.equal(JSON.stringify(result).includes('/private/moss'), false)
    db.close()
  })

  test('企业管理员不能借 tenant_id 查询或变更其他组织资源', () => {
    const { db, repository, compatibility, orgA, orgB } = setup()
    repository.createSkill({ id: 'skill-b', orgId: orgB.organizationId, name: 'B', authorId: 'admin-b' })
    const actor = { userId: 'admin-a', orgId: orgA.organizationId, role: 'admin' }

    assert.throws(
      () => compatibility.listSkills({ actor, tenantCode: 'ENT-B' }),
      (error: unknown) => error instanceof SudoworkCatalogError && error.statusCode === 403,
    )
    assert.throws(
      () => compatibility.deleteSkill(actor, 'skill-b'),
      (error: unknown) => error instanceof SudoworkCatalogError && error.statusCode === 403,
    )
    db.close()
  })

  test('普通用户的 Hub 列表只返回本地模式下已审批、启用且可见的统一资源', () => {
    const { db, repository, compatibility, orgA } = setup()
    const common = { orgId: orgA.organizationId, authorId: 'admin-a' }
    repository.createAgent({
      id: 'visible-agent', name: 'Visible Agent', status: 'approved',
      providerType: 'local', supportedModes: 'local', ...common,
    })
    repository.createAgent({
      id: 'cloud-agent', name: 'Cloud Agent', status: 'approved',
      providerType: 'moss_runtime', supportedModes: 'cloud', ...common,
    })
    repository.createSkill({ id: 'visible', name: 'Visible', status: 'approved', supportedModes: 'local', ...common })
    repository.createSkill({ id: 'pending', name: 'Pending', status: 'pending', supportedModes: 'local', ...common })
    repository.createSkill({ id: 'disabled', name: 'Disabled', status: 'approved', enabled: false, supportedModes: 'local', ...common })
    repository.createSkill({ id: 'cloud', name: 'Cloud', status: 'approved', supportedModes: 'cloud', ...common })
    repository.createSkill({
      id: 'hidden', name: 'Hidden', status: 'approved', supportedModes: 'local',
      visibleTo: { user_ids: ['other-user'] }, ...common,
    })
    const actor = { userId: 'user-a', orgId: orgA.organizationId, role: 'user' }

    assert.deepEqual(compatibility.listAgents({ actor }).data.assistants.map(agent => agent.id), ['visible-agent'])
    assert.deepEqual(compatibility.listSkills({ actor }).data.skills.map(skill => skill.id), ['visible'])
    db.close()
  })

  test('用户可见列表与 Dify binding 都来自同一 Agent 行', () => {
    const { db, repository, compatibility, orgA } = setup()
    repository.createAgent({
      id: 'dify-1', orgId: orgA.organizationId, name: 'Dify', authorId: 'admin-a', status: 'approved',
      providerType: 'dify', supportedModes: 'both',
      providerBinding: { connectionId: 'dify-main', appId: 'app-1', mode: 'agent-chat', tenantId: 'tenant-1' },
    })
    const actor = { userId: 'user-a', orgId: orgA.organizationId, role: 'user' }

    assert.equal(compatibility.listVisibleAgents(actor).data[0]?.id, 'dify-1')
    const bindings = compatibility.listVisibleBindings(actor).data
    assert.equal(typeof bindings[0]?.created_at, 'number')
    assert.equal(typeof bindings[0]?.updated_at, 'number')
    assert.deepEqual(bindings.map(({ created_at: _createdAt, updated_at: _updatedAt, ...binding }) => binding), [{
      assistant_id: 'dify-1', runtime: 'dify', dify_app_id: 'app-1',
      dify_app_mode: 'agent-chat', dify_tenant_id: 'tenant-1',
    }])
    db.close()
  })

  test('分类列表覆盖全部可见资源而不是只扫描第一页', () => {
    const { db, repository, compatibility, orgA } = setup()
    for (let index = 0; index < 101; index += 1) {
      repository.createSkill({
        id: `skill-${String(index).padStart(3, '0')}`,
        orgId: orgA.organizationId,
        name: `skill-${index}`,
        authorId: 'admin-a',
        status: 'approved',
        supportedModes: 'local',
        categories: [index === 100 ? '末页分类' : '常用分类'],
        updatedAt: 1_000 - index,
      })
    }

    const result = compatibility.listCategories(
      { userId: 'user-a', orgId: orgA.organizationId, role: 'user' },
      'skill',
    )

    assert.deepEqual(result.data, ['常用分类', '末页分类'])
    db.close()
  })

  test('公共和分配资源详情按访问者企业投影且私有资源不跨企业泄漏', () => {
    const { db, repository, compatibility, orgA, orgB } = setup()
    repository.createAgent({
      id: 'public-agent', orgId: orgB.organizationId, name: 'Public', authorId: 'owner-b',
      status: 'approved', supportedModes: 'both', availability: 'all',
    })
    repository.createSkill({
      id: 'assigned-skill', orgId: orgB.organizationId, name: 'Assigned', authorId: 'owner-b',
      status: 'approved', supportedModes: 'both', availability: 'assigned',
    })
    repository.createSkill({
      id: 'private-skill', orgId: orgB.organizationId, name: 'Private', authorId: 'owner-b',
      status: 'approved', supportedModes: 'both',
    })
    repository.assignToOrganization('skill', 'assigned-skill', orgA.organizationId)
    const actor = { userId: 'user-a', orgId: orgA.organizationId, role: 'user' }

    assert.equal(compatibility.getAgentDetail(actor, 'public-agent').data.assistant.tenantId, 'ENT-A')
    assert.equal(compatibility.getSkillDetail(actor, 'assigned-skill').data.skill.tenant_id, 'ENT-A')
    assert.throws(
      () => compatibility.getSkillDetail(actor, 'private-skill'),
      (error: unknown) => error instanceof SudoworkCatalogError && error.statusCode === 404,
    )
    db.close()
  })

  test('旧上传、审批、详情和下载共用统一 Catalog 与制品', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moss-catalog-compat-'))
    const fixture = setup()
    try {
      const uploads = new CatalogUploadService({
        db: fixture.db,
        repository: fixture.repository,
        catalog: fixture.catalog,
        artifacts: new CatalogArtifactStore(root),
        publicBaseUrl: 'https://moss.example.test',
      })
      const compatibility = new SudoworkCatalogService({
        repository: fixture.repository,
        catalog: fixture.catalog,
        identities: fixture.identities,
        uploads,
        buildVisibility: actor => ({
          isAdmin: actor.role === 'admin' || actor.role === 'super_admin',
          userId: actor.userId, departmentId: null, visibleDepartmentIds: new Set(),
        }),
      })
      const archive = new JSZip()
      archive.file('SKILL.md', '# Writer')
      const bytes = await archive.generateAsync({ type: 'nodebuffer' })
      const actor = { userId: 'user-a', orgId: fixture.orgA.organizationId, role: 'user' }
      const uploaded = await compatibility.uploadSkill({
        actor, tenantCode: 'ENT-A', name: 'writer', displayName: '写作技能',
        categories: ['效率'], bytes, idempotencyKey: 'legacy-upload-skill',
      })
      const id = uploaded.data.skill.id
      assert.equal(uploaded.data.skill.status, 0)
      assert.equal(compatibility.getSkillDetail(actor, id).data.skill.id, id)
      await assert.rejects(compatibility.getArtifact('skill', id), /制品不存在/)

      compatibility.reviewSkill({ userId: 'admin-a', orgId: fixture.orgA.organizationId, role: 'admin' }, id)
      const artifact = await compatibility.getArtifact('skill', id)
      assert.deepEqual(artifact.bytes, bytes)
      assert.equal(artifact.filename, 'writer-1.0.0.zip')
    } finally {
      fixture.db.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
