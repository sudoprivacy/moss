import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { ensureCatalogSchema } from './catalogSchema.js'

function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE tenant_assistants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      enabled INTEGER DEFAULT 1,
      org_id TEXT,
      version TEXT,
      checksum TEXT
    );
    CREATE TABLE tenant_skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      enabled INTEGER DEFAULT 1,
      org_id TEXT,
      version TEXT,
      checksum TEXT
    );
    INSERT INTO tenant_assistants (id, name, status, org_id, version, checksum)
      VALUES ('agent-old', '旧智能体', 'approved', 'org-a', '1.0.0', 'agent-sha');
    INSERT INTO tenant_skills (id, name, status, org_id, version, checksum)
      VALUES ('skill-old', '旧技能', 'approved', 'org-a', '1.0.0', 'skill-sha');
  `)
  return db
}

describe('统一 Agent/Skill 目录数据库结构', () => {
  test('幂等升级旧表并为已有资源回填兼容默认值', () => {
    const db = legacyDatabase()
    ensureCatalogSchema(db)
    ensureCatalogSchema(db)

    const agent = db.prepare(`
      SELECT provider_type, provider_binding, supported_modes, availability, source_provider,
             source_resource_id FROM tenant_assistants WHERE id = 'agent-old'
    `).get() as Record<string, unknown>
    const skill = db.prepare(`
      SELECT supported_modes, availability, source_provider, source_resource_id, category, categories, icon
      FROM tenant_skills WHERE id = 'skill-old'
    `).get() as Record<string, unknown>

    assert.deepEqual({ ...agent }, {
      provider_type: 'moss_runtime',
      provider_binding: null,
      supported_modes: 'both',
      availability: 'organization',
      source_provider: 'moss',
      source_resource_id: 'agent-old',
    })
    assert.deepEqual({ ...skill }, {
      supported_modes: 'both',
      availability: 'organization',
      source_provider: 'moss',
      source_resource_id: 'skill-old',
      category: null,
      categories: null,
      icon: null,
    })
    db.close()
  })

  test('目录组织分配表拒绝无效范围和不存在的资源', () => {
    const db = legacyDatabase()
    ensureCatalogSchema(db)

    assert.throws(() => db.prepare(`
      UPDATE tenant_assistants SET availability = 'tenant_list' WHERE id = 'agent-old'
    `).run(), /catalog availability invalid/)
    assert.throws(() => db.prepare(`
      INSERT INTO catalog_resource_org_assignments (resource_type, resource_id, org_id, created_at)
      VALUES ('skill', 'missing', 'org-b', 1)
    `).run(), /catalog resource not found/)
    db.prepare(`
      INSERT INTO catalog_resource_org_assignments (resource_type, resource_id, org_id, created_at)
      VALUES ('skill', 'skill-old', 'org-b', 1)
    `).run()
    assert.equal(
      Number((db.prepare('SELECT COUNT(*) AS count FROM catalog_resource_org_assignments').get() as { count: number }).count),
      1,
    )
    db.close()
  })

  test('数据库拒绝非法 Provider、运行模式和重复外部资源身份', () => {
    const db = legacyDatabase()
    ensureCatalogSchema(db)

    assert.throws(() => db.prepare(`
      UPDATE tenant_assistants SET provider_type = 'legacy_proxy' WHERE id = 'agent-old'
    `).run(), /CHECK constraint failed/)
    assert.throws(() => db.prepare(`
      UPDATE tenant_skills SET supported_modes = 'desktop_only' WHERE id = 'skill-old'
    `).run(), /CHECK constraint failed/)

    const insert = db.prepare(`
      INSERT INTO resource_external_aliases (
        id, org_id, resource_type, resource_id, provider_type, provider_id,
        external_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run('alias-1', 'org-a', 'agent', 'agent-old', 'sudohub', 'default', 'hub-1', 1)
    assert.throws(() => insert.run(
      'alias-2', 'org-b', 'agent', 'agent-other', 'sudohub', 'default', 'hub-1', 2,
    ), /UNIQUE constraint failed/)
    insert.run('alias-3', 'org-a', 'skill', 'skill-old', 'sudohub', 'default', 'hub-1', 3)
    assert.throws(() => insert.run(
      'alias-4', 'org-b', 'skill', 'skill-other', 'sudohub', 'default', 'hub-1', 4,
    ), /UNIQUE constraint failed/)
    db.close()
  })

  test('升级后通过既有写入路径创建的资源自动获得稳定来源 ID', () => {
    const db = legacyDatabase()
    ensureCatalogSchema(db)

    db.prepare(`INSERT INTO tenant_assistants (id, name, org_id) VALUES (?, ?, ?)`)
      .run('agent-new', '新智能体', 'org-a')
    db.prepare(`INSERT INTO tenant_skills (id, name, org_id) VALUES (?, ?, ?)`)
      .run('skill-new', '新技能', 'org-a')

    assert.equal(
      (db.prepare(`SELECT source_resource_id FROM tenant_assistants WHERE id = 'agent-new'`).get() as { source_resource_id: string }).source_resource_id,
      'agent-new',
    )
    assert.equal(
      (db.prepare(`SELECT source_resource_id FROM tenant_skills WHERE id = 'skill-new'`).get() as { source_resource_id: string }).source_resource_id,
      'skill-new',
    )
    db.close()
  })
})
