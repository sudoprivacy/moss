import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { createCatalogTestRepository, createIdentityTestRepository } from '../testing/compatibilityRepositories.js'
import { IdentityMergePlanner, type LegacyIdentitySnapshot } from './identityMergePlanner.js'
import { PlanningCatalogProjection, PlanningIdentityProjection } from './planningProjections.js'

void describe('migration planning projections', () => {
  void test('后续阶段可只读解析本批次将创建的组织、用户与认证身份', async () => {
    const db = new DatabaseSync(':memory:')
    const auth = new AuthCenterDb(db)
    const base = createIdentityTestRepository(db, {}, auth.driver)
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
    await projection.install(plan, source)
    const repository = projection.repository
    const org = await repository.resolveNumericAliasGlobal('enterprise', 7)
    const user = await repository.resolveNumericAliasGlobal('user', 17)
    assert(org)
    assert(user)
    assert.equal(user.orgId, org.resourceId)
    assert.equal((await repository.getOrganizationProfileByCode('ENT-A'))?.orgId, org.resourceId)
    assert.equal((await repository.findAuthIdentity('phone', 'sudowork', '13800000000'))?.userId, user.resourceId)
    assert.equal(projection.isProjected('user', user.resourceId), true)
    projection.deactivate()
    assert.equal(await repository.resolveNumericAliasGlobal('user', 17), null)
    assert.equal(await repository.findAuthIdentity('phone', 'sudowork', '13800000000'), null)
    assert.equal((await auth.listOrganizations()).length, 0)
    db.close()
  })

  void test('Dify 预检可看到本批次 Catalog 将导入的 Agent，但不写目标表', async () => {
    const db = new DatabaseSync(':memory:')
    const base = createCatalogTestRepository(db)
    const projection = new PlanningCatalogProjection(base)
    projection.install({ resources: [{
      kind: 'agent', action: 'import', orgId: 'org-a', assignedOrgIds: ['org-b'],
      availability: 'assigned', source: { id: 'agent-a' },
    }] })
    assert(await projection.repository.findAgent('agent-a'))
    assert.equal(await projection.repository.isAvailableToOrganization('agent', 'agent-a', 'org-a'), true)
    assert.equal(await projection.repository.isAvailableToOrganization('agent', 'agent-a', 'org-b'), true)
    assert.equal(await base.findAgent('agent-a'), null)
    db.close()
  })
})
