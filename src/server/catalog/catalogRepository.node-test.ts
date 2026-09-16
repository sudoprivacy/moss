import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { CatalogPolicyError, CatalogRepository } from './catalogRepository.js'

function setup(): { db: DatabaseSync; catalog: CatalogRepository } {
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
  return { db, catalog: new CatalogRepository(db) }
}

describe('统一 Agent/Skill Catalog Repository', () => {
  test('原子更新同一 Agent 配置并替换共享组织范围', () => {
    const { db, catalog } = setup()
    catalog.createAgent({
      id: 'a-config', orgId: 'org-a', name: 'Before', authorId: 'admin-a',
      availability: 'assigned', providerType: 'moss_runtime',
    })

    const updated = catalog.updateAgentConfiguration('a-config', 'org-a', {
      name: 'After', visibleTo: { user_ids: ['user-1'], role_ids: ['reviewer'] },
      providerType: 'dify',
      providerBinding: { connectionId: 'dify-a', appId: 'app-1', datasetIds: [] },
      supportedModes: 'both', availability: 'assigned',
    })
    catalog.replaceOrganizationAssignments('agent', 'a-config', ['org-b', 'org-c', 'org-b'])

    assert.equal(updated?.name, 'After')
    assert.deepEqual(updated?.visibleTo, { user_ids: ['user-1'], role_ids: ['reviewer'] })
    assert.equal(updated?.providerType, 'dify')
    assert.deepEqual(catalog.listAssignedOrganizationIds('agent', 'a-config'), ['org-b', 'org-c'])
    db.close()
  })

  test('本地与云端模式读取同一主表并按执行能力过滤', () => {
    const { db, catalog } = setup()
    catalog.createAgent({
      id: 'both-agent', orgId: 'org-a', name: 'both', authorId: 'u1', status: 'approved',
      providerType: 'moss_runtime', supportedModes: 'both', updatedAt: 30,
    })
    catalog.createAgent({
      id: 'local-agent', orgId: 'org-a', name: 'local', authorId: 'u1', status: 'approved',
      providerType: 'local', supportedModes: 'local', updatedAt: 20,
    })
    catalog.createAgent({
      id: 'dify-agent', orgId: 'org-a', name: 'dify', authorId: 'u1', status: 'approved',
      providerType: 'dify', supportedModes: 'cloud', updatedAt: 10,
      providerBinding: { connectionId: 'dify-main', appId: 'app-1' },
    })
    catalog.createAgent({
      id: 'other-org', orgId: 'org-b', name: 'other', authorId: 'u2', status: 'approved',
      providerType: 'moss_runtime', supportedModes: 'both', updatedAt: 40,
    })

    assert.deepEqual(catalog.listAgents({ orgId: 'org-a', mode: 'local' }).items.map((item) => item.id), [
      'both-agent', 'local-agent',
    ])
    assert.deepEqual(catalog.listAgents({ orgId: 'org-a', mode: 'cloud' }).items.map((item) => item.id), [
      'both-agent', 'dify-agent',
    ])
    assert.equal(catalog.getAgent('other-org', 'org-a'), null)
    db.close()
  })

  test('可见性过滤、稳定游标和 Skill 模式使用统一规则', () => {
    const { db, catalog } = setup()
    for (const [id, visibleTo, updatedAt] of [
      ['a3', null, 30],
      ['a2', { user_ids: ['u1'] }, 20],
      ['a1', { user_ids: [] }, 10],
    ] as const) {
      catalog.createSkill({
        id, orgId: 'org-a', name: id, authorId: 'owner', status: 'approved',
        supportedModes: 'both', visibleTo, updatedAt,
      })
    }

    const first = catalog.listSkills({
      orgId: 'org-a', mode: 'local', limit: 1,
      visibility: { isAdmin: false, userId: 'u1', departmentId: null, visibleDepartmentIds: new Set() },
    })
    assert.deepEqual(first.items.map((item) => item.id), ['a3'])
    assert.equal(first.hasMore, true)
    assert(first.nextCursor)
    const second = catalog.listSkills({
      orgId: 'org-a', mode: 'local', limit: 10, cursor: first.nextCursor,
      visibility: { isAdmin: false, userId: 'u1', departmentId: null, visibleDepartmentIds: new Set() },
    })
    assert.deepEqual(second.items.map((item) => item.id), ['a2'])
    assert.equal(second.hasMore, false)
    db.close()
  })

  test('公共与显式分配资源保持单份主数据并向目标组织可见', () => {
    const { db, catalog } = setup()
    catalog.createSkill({
      id: 'public', orgId: 'catalog-owner', name: 'Public', authorId: 'owner',
      status: 'approved', supportedModes: 'both', availability: 'all', updatedAt: 30,
    })
    catalog.createSkill({
      id: 'assigned', orgId: 'org-b', name: 'Assigned', authorId: 'owner',
      status: 'approved', supportedModes: 'both', availability: 'assigned', updatedAt: 20,
    })
    catalog.createSkill({
      id: 'private', orgId: 'org-b', name: 'Private', authorId: 'owner',
      status: 'approved', supportedModes: 'both', updatedAt: 10,
    })
    catalog.assignToOrganization('skill', 'assigned', 'org-a')

    assert.deepEqual(catalog.listSkills({ orgId: 'org-a', mode: 'local' }).items.map(item => item.id), [
      'public', 'assigned',
    ])
    assert.equal(catalog.isAvailableToOrganization('skill', 'private', 'org-a'), false)
    assert.equal(catalog.isAvailableToOrganization('skill', 'assigned', 'org-a'), true)
    assert.deepEqual(catalog.listAssignedOrganizationIds('skill', 'assigned'), ['org-a'])
    db.close()
  })

  test('Provider binding 只允许引用，不允许保存明文秘密', () => {
    const { db, catalog } = setup()
    assert.throws(() => catalog.createAgent({
      id: 'unsafe', orgId: 'org-a', name: 'unsafe', authorId: 'u1',
      providerType: 'dify', supportedModes: 'cloud',
      providerBinding: { connectionId: 'dify-main', api_key: 'secret-value' },
    }), (error: unknown) => error instanceof CatalogPolicyError && error.code === 'SECRET_MATERIAL_FORBIDDEN')
    assert.equal(catalog.getAgent('unsafe', 'org-a'), null)
    db.close()
  })

  test('外部身份解析保持资源类型和组织归属', () => {
    const { db, catalog } = setup()
    catalog.createAgent({ id: 'agent-a', orgId: 'org-a', name: 'A', authorId: 'u1' })
    catalog.bindExternalIdentity({
      id: 'alias-a', orgId: 'org-a', resourceType: 'agent', resourceId: 'agent-a',
      providerType: 'sudohub', providerId: 'default', externalId: 'legacy-a',
    })
    assert.equal(catalog.resolveExternalIdentity({
      orgId: 'org-a', resourceType: 'agent', providerType: 'sudohub',
      providerId: 'default', externalId: 'legacy-a',
    }), 'agent-a')
    assert.equal(catalog.resolveExternalIdentity({
      orgId: 'org-b', resourceType: 'agent', providerType: 'sudohub',
      providerId: 'default', externalId: 'legacy-a',
    }), null)
    db.close()
  })
})
