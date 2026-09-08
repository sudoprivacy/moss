import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { migrationCommandContext, onlineCommandContext } from '../application/commandContext.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { CatalogRepository } from '../catalog/catalogRepository.js'
import { DifyRepository } from '../dify/difyRepository.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { P4DifyMigrationBlockedError, P4DifyMigrationService } from './p4DifyMigrationService.js'
import type { SudoworkP4Snapshot } from './sudoworkP4SourceReader.js'

function snapshot(): SudoworkP4Snapshot {
  return {
    checksum: 'a'.repeat(64),
    connections: [{
      enterpriseId: 9, tenantId: 'tenant-9', systemAccountId: 'system-9', apiKey: 'service-secret',
      createdAt: 10, updatedAt: 20,
    }],
    apps: [{
      id: 1, enterpriseId: 9, assistantId: 'agent-app', tenantId: 'tenant-9',
      appId: 'app-1', appApiKey: 'app-secret', mode: 'agent-chat', createdAt: 11, updatedAt: 21,
    }],
    datasets: [{
      id: 2, enterpriseId: 9, assistantId: 'agent-rag', tenantId: 'tenant-9',
      datasetId: 'dataset-1', createdAt: 12,
    }],
    acl: [{
      id: 3, enterpriseId: 9, assistantId: 'agent-app', subjectType: 'user', subjectId: '17', createdAt: 13,
    }],
    metadata: [{
      id: 4, enterpriseId: 9, assistantId: 'agent-app', name: '历史助手', profession: '研发',
      description: '说明', defaultInitPrompt: '提示', promptsI18n: { 'zh-CN': ['你好'] },
      categories: ['开发'], skills: ['git'], promptFile: 'prompt.md', avatar: '/avatar.png',
      version: '1.2.3', createdAt: 14, updatedAt: 24,
    }],
  }
}

function setup(options: {
  source?: SudoworkP4Snapshot
  putSecret?: (namespace: string, key: string, value: string) => Promise<void>
} = {}) {
  const db = new DatabaseSync(':memory:')
  const auth = new AuthCenterDb(db)
  auth.createOrganization('org-a', '企业 A', 1)
  auth.createUser({
    id: 'user-17', orgId: 'org-a', email: 'u17@example.test', name: 'u17', displayName: '用户 17',
    departmentId: null, role: 'user', status: 'active', localAuth: true, tokenLimit: null,
    createdAt: 1, passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null,
  })
  db.exec(`
    CREATE TABLE tenant_assistants (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT, description TEXT,
      default_init_prompt TEXT, prompts_i18n TEXT, categories TEXT, avatar TEXT, skills TEXT,
      prompt_file TEXT, sort_order INTEGER DEFAULT 0, version TEXT, author_id TEXT NOT NULL,
      author_name TEXT, status TEXT DEFAULT 'pending', source_url TEXT, checksum TEXT, file_path TEXT,
      enabled_skills TEXT, publish_note TEXT, review_note TEXT, reviewed_by TEXT, reviewed_at INTEGER,
      enabled INTEGER DEFAULT 1, visible_to TEXT, org_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
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
  const identities = new IdentityRepository(db)
  identities.putOrganizationProfile({ orgId: 'org-a', code: 'ENT-A', loginMethod: 'password', localEnabled: true, cloudEnabled: true })
  identities.assignNumericAlias({ namespace: 'enterprise', legacyId: 9, resourceId: 'org-a', orgId: 'org-a' })
  identities.assignNumericAlias({ namespace: 'user', legacyId: 17, resourceId: 'user-17', orgId: 'org-a' })
  const catalog = new CatalogRepository(db)
  catalog.createAgent({ id: 'agent-app', orgId: 'org-a', name: 'App', authorId: 'user-17', status: 'approved' })
  catalog.createAgent({ id: 'agent-rag', orgId: 'org-a', name: 'Rag', authorId: 'user-17', status: 'approved' })
  const dify = new DifyRepository(db)
  const secretWrites: Array<{ namespace: string; key: string; value: string }> = []
  const service = new P4DifyMigrationService({
    db, auth, identities, catalog, dify,
    source: { readSnapshot: () => options.source ?? snapshot() },
    secrets: {
      async putSecret(namespace: string, key: string, value: string) {
        await options.putSecret?.(namespace, key, value)
        secretWrites.push({ namespace, key, value })
      },
      async getSecret(namespace: string, key: string) {
        const found = secretWrites.find(item => item.namespace === namespace && item.key === key)
        return found ? { value: found.value } : null
      },
    },
  })
  return { db, identities, catalog, dify, service, secretWrites }
}

describe('P4 Dify 迁移', () => {
  test('统一迁移连接、App、Dataset、ACL 和元数据且不调用 Dify', async () => {
    const { db, identities, catalog, dify, service, secretWrites } = setup()
    const plan = service.plan()
    assert.equal(plan.status, 'ready')
    const first = await service.execute(plan, migrationCommandContext('p4-run', 'p4:execute'))
    const second = await service.execute(service.plan(), migrationCommandContext('p4-rerun', 'p4:execute:rerun'))

    assert.equal(first.connections, 1)
    assert.equal(first.apps, 1)
    assert.equal(first.datasets, 1)
    assert.equal(first.deliverableExternalOutboxCount, 0)
    assert.equal(second.apps, 1)
    assert.deepEqual(identities.listIntegrationConnections('org-a', 'dify')[0]?.secretRef,
      'nexus://org:org-a:dify/service-api-key')
    assert.equal(JSON.stringify(identities.listIntegrationConnections('org-a', 'dify')).includes('service-secret'), false)
    const app = catalog.getAgent('agent-app', 'org-a')
    assert.deepEqual(app?.visibleTo, { user_ids: ['user-17'], role_ids: null, department_ids: null })
    assert.equal(app?.name, '历史助手')
    assert.equal(app?.providerBinding?.appSecretRef, 'nexus://org:org-a:dify/apps/app-1-api-key')
    assert.deepEqual(catalog.getAgent('agent-rag', 'org-a')?.providerBinding?.datasetIds, ['dataset-1'])
    assert.equal(dify.getResourceByExternalId('org-a', 'dify:org-a', 'dataset', 'dataset-1')?.externalId, 'dataset-1')
    assert(secretWrites.some(item => item.value === 'service-secret'))
    assert(secretWrites.some(item => item.value === 'app-secret'))
    assert.equal(dify.getOperationByIdempotencyKey('p4:execute'), null)
    assert.equal((await service.verify()).status, 'matched')
    db.close()
  })

  test('缺失企业或 Agent 映射时预检阻断且不写 Nexus', async () => {
    const { db, identities, service, secretWrites } = setup()
    db.prepare("DELETE FROM resource_numeric_aliases WHERE namespace = 'enterprise'").run()
    const plan = service.plan()
    assert.equal(plan.status, 'blocked')
    assert(plan.issues.some(issue => issue.code === 'ORGANIZATION_MAPPING_MISSING'))
    await assert.rejects(
      service.execute(plan, migrationCommandContext('p4-bad', 'p4:bad')),
      P4DifyMigrationBlockedError,
    )
    assert.equal(secretWrites.length, 0)
    identities.assignNumericAlias({ namespace: 'enterprise', legacyId: 9, resourceId: 'org-a', orgId: 'org-a' })
    db.prepare("DELETE FROM tenant_assistants WHERE id = 'agent-app'").run()
    assert(service.plan().issues.some(issue => issue.code === 'AGENT_MAPPING_MISSING'))
    db.close()
  })

  test('拒绝在线上下文执行迁移', async () => {
    const { db, service } = setup()
    await assert.rejects(service.execute(service.plan(), onlineCommandContext('bad')), /迁移上下文/)
    db.close()
  })

  test('预检阻断已被其他 Agent 占用的 Dify App 外部别名', () => {
    const { db, catalog, service } = setup()
    catalog.createAgent({ id: 'agent-other', orgId: 'org-a', name: 'Other', authorId: 'user-17', status: 'approved' })
    catalog.bindExternalIdentity({
      id: 'alias-conflict', orgId: 'org-a', resourceType: 'agent', resourceId: 'agent-other',
      providerType: 'dify', providerId: 'dify:org-a', externalId: 'app-1',
    })

    const plan = service.plan()
    assert.equal(plan.status, 'blocked')
    assert(plan.issues.some(issue => issue.code === 'TARGET_CONFLICT' && issue.source === 'app:1'))
    db.close()
  })

  test('预检明确报告旧 App API Key 缺失', () => {
    const source = snapshot()
    source.apps[0] = { ...source.apps[0]!, appApiKey: null }
    const { db, service } = setup({ source })

    const plan = service.plan()
    assert.equal(plan.status, 'blocked')
    assert(plan.issues.some(issue => issue.code === 'CREDENTIAL_MISSING' && issue.source === 'app:1'))
    db.close()
  })

  test('Nexus 写入失败时不落连接、binding 或 Dataset 业务数据', async () => {
    let writes = 0
    const { db, identities, catalog, dify, service } = setup({
      putSecret: async () => {
        writes += 1
        if (writes === 2) throw new Error('nexus unavailable')
      },
    })

    await assert.rejects(
      service.execute(service.plan(), migrationCommandContext('p4-nexus-fail', 'p4:nexus-fail')),
      /nexus unavailable/,
    )
    assert.equal(identities.listIntegrationConnections('org-a', 'dify').length, 0)
    assert.equal(catalog.getAgent('agent-app', 'org-a')?.providerType, 'moss_runtime')
    assert.equal(dify.listResources('org-a', 'dataset').length, 0)
    db.close()
  })

  test('校验覆盖 Nexus 密钥、ACL 和元数据', async () => {
    const { db, catalog, service, secretWrites } = setup()
    await service.execute(service.plan(), migrationCommandContext('p4-verify', 'p4:verify'))
    secretWrites.splice(secretWrites.findIndex(item => item.key === 'service-api-key'), 1)
    catalog.updateAgentConfiguration('agent-app', 'org-a', {
      name: '被篡改', visibleTo: null,
    })

    const verification = await service.verify()
    assert.equal(verification.status, 'mismatch')
    assert(verification.issues.some(issue => issue.includes('Service API Key')))
    assert(verification.issues.some(issue => issue.includes('ACL')))
    assert(verification.issues.some(issue => issue.includes('元数据')))
    db.close()
  })
})
