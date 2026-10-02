import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { migrationCommandContext, onlineCommandContext } from '../application/commandContext.js'
import { createCatalogTestRepository } from '../testing/compatibilityRepositories.js'
import { CatalogDomainError, CatalogService } from './catalogService.js'

function setup() {
  const db = new DatabaseSync(':memory:')
  const repository = createCatalogTestRepository(db)
  return { db, repository, service: new CatalogService(repository) }
}

void describe('统一 Agent/Skill Catalog Service', () => {
  void test('创建资源与外部身份原子提交，别名冲突时完整回滚', async () => {
    const { db, repository, service } = setup()
    const actor = { userId: 'admin-a', orgId: 'org-a', role: 'admin' }
    const context = onlineCommandContext('create-agent-a')
    const created = await service.createAgent({
      actor, name: 'Agent A', providerType: 'moss_runtime', supportedModes: 'both',
      externalIdentity: { providerType: 'sudohub', providerId: 'default', externalId: 'legacy-1' },
    }, context)
    const repeated = await service.createAgent({
      actor, name: 'ignored on retry', providerType: 'moss_runtime', supportedModes: 'both',
    }, context)
    assert.equal(repeated.id, created.id)

    await assert.rejects(service.createAgent({
      actor: { userId: 'admin-b', orgId: 'org-b', role: 'admin' },
      name: 'Agent B', providerType: 'moss_runtime', supportedModes: 'both',
      externalIdentity: { providerType: 'sudohub', providerId: 'default', externalId: 'legacy-1' },
    }, migrationCommandContext('run-1', 'migrate-agent-b')), /UNIQUE constraint failed/)
    assert.equal((await repository.listAgents({ orgId: 'org-a' })).items.length, 1)
    assert.equal((await repository.listAgents({ orgId: 'org-b' })).items.length, 0)
    db.close()
  })

  void test('Skill 创建复用统一幂等命令并保留 Hub 元数据', async () => {
    const { db, service } = setup()
    const actor = { userId: 'user-a', orgId: 'org-a', role: 'user' }
    const context = onlineCommandContext('create-skill-a')
    const created = await service.createSkill({
      actor,
      name: 'writer',
      displayName: '写作技能',
      categories: ['写作'],
      version: '1.0.0',
      checksum: 'abc',
      filePath: '/managed/skill.zip',
      supportedModes: 'local',
    }, context)
    const repeated = await service.createSkill({ actor, name: 'ignored', supportedModes: 'local' }, context)
    assert.equal(repeated.id, created.id)
    assert.equal(created.status, 'pending')
    assert.deepEqual(created.categories, ['写作'])
    assert.equal(created.filePath, '/managed/skill.zip')
    db.close()
  })

  void test('迁移命令保留历史资源身份、状态、作者和时间且拒绝在线伪装', async () => {
    const { db, repository, service } = setup()
    const actor = { userId: 'migration-admin', orgId: 'org-a', role: 'super_admin' }
    const context = migrationCommandContext('run-p2', 'catalog:skill:legacy-skill-7')

    const created = await service.importSkill({
      actor,
      orgId: 'org-a',
      id: 'legacy-skill-7',
      name: 'legacy-writer',
      displayName: '历史写作技能',
      status: 'rejected',
      enabled: false,
      authorId: 'legacy-owner-mapped',
      authorName: '历史作者',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      version: '2.3.4',
      checksum: 'abc123',
      filePath: '/managed/legacy-skill.zip',
      supportedModes: 'both',
      externalIdentity: { providerType: 'sudohub', providerId: 'legacy-prod', externalId: 'legacy-skill-7' },
    }, context)
    const repeated = await service.importSkill({
      actor, orgId: 'org-a', id: 'ignored', name: 'ignored', status: 'pending',
      authorId: 'ignored', supportedModes: 'local',
    }, context)

    assert.equal(repeated.id, created.id)
    assert.equal(created.id, 'legacy-skill-7')
    assert.equal(created.status, 'rejected')
    assert.equal(created.enabled, false)
    assert.equal(created.authorId, 'legacy-owner-mapped')
    assert.equal(created.createdAt, 1_700_000_000_000)
    assert.equal(await repository.resolveExternalIdentity({
      orgId: 'org-a', resourceType: 'skill', providerType: 'sudohub',
      providerId: 'legacy-prod', externalId: 'legacy-skill-7',
    }), 'legacy-skill-7')
    assert.throws(() => service.importSkill({
      actor, orgId: 'org-a', id: 'online-import', name: 'forbidden', status: 'approved',
      authorId: 'migration-admin', supportedModes: 'local',
    }, onlineCommandContext('online-import')), /迁移导入命令/)
    db.close()
  })

  void test('组织管理员不能管理其他组织，超级管理员可以显式管理目标组织', async () => {
    const { db, repository, service } = setup()
    await repository.createSkill({ id: 's1', orgId: 'org-b', name: 'Skill', authorId: 'owner' })

    await assert.rejects(
      service.reviewSkill({
        actor: { userId: 'admin-a', orgId: 'org-a', role: 'admin' },
        orgId: 'org-b', skillId: 's1', approved: true,
      }),
      (error: unknown) => error instanceof CatalogDomainError && error.code === 'FORBIDDEN',
    )
    await service.reviewSkill({
      actor: { userId: 'root', orgId: 'root-org', role: 'super_admin' },
      orgId: 'org-b', skillId: 's1', approved: true,
    })
    assert.equal((await repository.getSkill('s1', 'org-b'))?.status, 'approved')
    db.close()
  })

  void test('用户目录仅返回已审批且对当前用户可见的资源', async () => {
    const { db, repository, service } = setup()
    await repository.createAgent({
      id: 'visible', orgId: 'org-a', name: 'Visible', authorId: 'u2', status: 'approved',
      visibleTo: { user_ids: ['u1'] },
    })
    await repository.createAgent({
      id: 'pending', orgId: 'org-a', name: 'Pending', authorId: 'u1', status: 'pending',
    })
    await repository.createAgent({
      id: 'hidden', orgId: 'org-a', name: 'Hidden', authorId: 'u2', status: 'approved',
      visibleTo: { user_ids: [] },
    })

    const result = await service.listVisibleAgents({
      actor: { userId: 'u1', orgId: 'org-a', role: 'user' },
      mode: 'local',
      visibility: { isAdmin: false, userId: 'u1', departmentId: null, visibleDepartmentIds: new Set() },
    })
    assert.deepEqual(result.items.map((item) => item.id), ['visible'])
    db.close()
  })
})
