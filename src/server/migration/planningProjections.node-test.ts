import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { CatalogRepository } from '../catalog/catalogRepository.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { IdentityMergePlanner, type LegacyIdentitySnapshot } from './identityMergePlanner.js'
import { PlanningCatalogProjection, PlanningIdentityProjection } from './planningProjections.js'

describe('migration planning projections', () => {
  test('后续阶段可只读解析本批次将创建的组织、用户与认证身份', () => {
    const db = new DatabaseSync(':memory:')
    const auth = new AuthCenterDb(db)
    const base = new IdentityRepository(db)
    const source: LegacyIdentitySnapshot = {
      organizations: [{ legacyId: 7, name: '企业 A', code: 'ENT-A', codeVerified: true }],
      users: [{
        legacyId: 17, enterpriseId: 7, username: '13800000000', displayName: '用户 A',
        phone: '13800000000', phoneVerified: true, email: null, emailVerified: false,
        passwordHash: 'hash', role: 'USER', status: 'ACTIVE',
        providerIdentity: { provider: 'cas', issuer: 'main', subject: 'external-a' },
      }],
    }
    const plan = new IdentityMergePlanner({ organizations: [], users: [] }).plan(source, [])
    const projection = new PlanningIdentityProjection(base)
    projection.install(plan, source)
    const repository = projection.repository
    const org = repository.resolveNumericAliasGlobal('enterprise', 7)
    const user = repository.resolveNumericAliasGlobal('user', 17)
    assert(org)
    assert(user)
    assert.equal(user.orgId, org.resourceId)
    assert.equal(repository.getOrganizationProfileByCode('ENT-A')?.orgId, org.resourceId)
    assert.equal(repository.findAuthIdentity('phone', 'sudowork', '13800000000')?.userId, user.resourceId)
    assert.equal(projection.isProjected('user', user.resourceId), true)
    projection.deactivate()
    assert.equal(repository.resolveNumericAliasGlobal('user', 17), null)
    assert.equal(repository.findAuthIdentity('phone', 'sudowork', '13800000000'), null)
    assert.equal(auth.listOrganizations().length, 0)
    db.close()
  })

  test('Dify 预检可看到本批次 Catalog 将导入的 Agent，但不写目标表', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE tenant_assistants (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT, description TEXT,
        default_init_prompt TEXT, prompts_i18n TEXT, categories TEXT, avatar TEXT, skills TEXT,
        version TEXT, author_id TEXT NOT NULL, author_name TEXT, status TEXT, source_url TEXT,
        checksum TEXT, file_path TEXT, enabled_skills TEXT, publish_note TEXT, review_note TEXT,
        reviewed_by TEXT, reviewed_at INTEGER, enabled INTEGER, visible_to TEXT, org_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE tenant_skills (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT, description TEXT,
        version TEXT, author_id TEXT NOT NULL, author_name TEXT, status TEXT, source_url TEXT,
        checksum TEXT, file_path TEXT, publish_note TEXT, review_note TEXT, reviewed_by TEXT,
        reviewed_at INTEGER, enabled INTEGER, visible_to TEXT, org_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `)
    const base = new CatalogRepository(db)
    const projection = new PlanningCatalogProjection(base)
    projection.install({ resources: [{
      kind: 'agent', action: 'import', orgId: 'org-a', assignedOrgIds: ['org-b'],
      availability: 'assigned', source: { id: 'agent-a' },
    }] })
    assert(projection.repository.findAgent('agent-a'))
    assert.equal(projection.repository.isAvailableToOrganization('agent', 'agent-a', 'org-a'), true)
    assert.equal(projection.repository.isAvailableToOrganization('agent', 'agent-a', 'org-b'), true)
    assert.equal(base.findAgent('agent-a'), null)
    db.close()
  })
})
