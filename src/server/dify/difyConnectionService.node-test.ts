import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb, type AuthCenterUser } from '../authCenter/db.js'
import { CatalogRepository } from '../catalog/catalogRepository.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { DifyConnectionService, DifyDomainError, parseNexusSecretRef } from './difyConnectionService.js'

function setup() {
  const db = new DatabaseSync(':memory:')
  const auth = new AuthCenterDb(db)
  auth.createOrganization('org-a', 'Org A', 1)
  auth.createOrganization('org-b', 'Org B', 1)
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
  const identities = new IdentityRepository(db)
  const catalog = new CatalogRepository(db)
  const user: AuthCenterUser = {
    id: 'user-a', orgId: 'org-a', email: 'user-a@example.test', name: 'user-a', displayName: null,
    departmentId: null, role: 'user', status: 'active', localAuth: true, tokenLimit: null,
    createdAt: 1, passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null,
  }
  auth.createUser(user)
  identities.assignNumericAlias({ namespace: 'enterprise', legacyId: 9, resourceId: 'org-a', orgId: 'org-a' })
  identities.assignNumericAlias({ namespace: 'user', legacyId: 17, resourceId: 'user-a', orgId: 'org-a' })
  identities.putIntegrationConnection({
    id: 'dify-org-a', orgId: 'org-a', providerType: 'dify', name: 'Dify A', enabled: true,
    secretRef: 'nexus://org:org-a:dify/service-api-key',
    config: { tenantId: 'tenant-a', systemAccountId: 'account-a', baseUrl: 'https://dify.example.test' },
  })
  catalog.createAgent({
    id: 'agent-a', orgId: 'org-a', name: 'Agent A', authorId: 'admin-a', status: 'approved',
    providerType: 'dify', supportedModes: 'cloud',
    providerBinding: { connectionId: 'dify-org-a', appId: 'app-a', mode: 'agent-chat', tenantId: 'tenant-a' },
  })
  const reads: Array<{ namespace: string; key: string }> = []
  const service = new DifyConnectionService({
    auth, identities, catalog,
    secrets: {
      async getSecret(namespace, key) {
        reads.push({ namespace, key })
        return { value: 'service-api-secret', status: 'enabled', version: 1 }
      },
    },
  })
  return { db, auth, identities, catalog, service, reads }
}

const actor = { userId: 'user-a', orgId: 'org-a', role: 'user' }
const visibility = { isAdmin: false, userId: 'user-a', departmentId: null, visibleDepartmentIds: new Set<string>() }

describe('DifyConnectionService', () => {
  test('uses legacy aliases for Dify EndUser and resolves the API key only through Nexus', async () => {
    const { db, service, reads } = setup()

    const context = await service.resolveRuntimeContext(actor, 'agent-a', visibility)

    assert.equal(context.endUserId, 'sudowork:9:17')
    assert.equal(context.apiKey, 'service-api-secret')
    assert.equal(context.tenantId, 'tenant-a')
    assert.equal(context.appId, 'app-a')
    assert.deepEqual(reads, [{ namespace: 'org:org-a:dify', key: 'service-api-key' }])
    const row = db.prepare('SELECT secret_ref, config_json FROM integration_connections WHERE id = ?').get('dify-org-a') as Record<string, unknown>
    assert.equal(JSON.stringify(row).includes('service-api-secret'), false)
    db.close()
  })

  test('rejects an invisible agent before reading any secret', async () => {
    const { db, catalog, service, reads } = setup()
    db.prepare('UPDATE tenant_assistants SET visible_to = ? WHERE id = ?')
      .run(JSON.stringify({ user_ids: ['someone-else'] }), 'agent-a')
    assert(catalog.findAgent('agent-a'))

    await assert.rejects(
      () => service.resolveRuntimeContext(actor, 'agent-a', visibility),
      (error: unknown) => error instanceof DifyDomainError && error.status === 403 && error.message === 'agent not visible to user',
    )
    assert.equal(reads.length, 0)
    db.close()
  })

  test('never falls back to a connection owned by another organization', async () => {
    const { db, identities, catalog, service, reads } = setup()
    identities.putIntegrationConnection({
      id: 'dify-org-b', orgId: 'org-b', providerType: 'dify', name: 'Dify B', enabled: true,
      secretRef: 'nexus://org:org-b:dify/service-api-key', config: { tenantId: 'tenant-b' },
    })
    db.prepare('UPDATE tenant_assistants SET provider_binding = ? WHERE id = ?')
      .run(JSON.stringify({ connectionId: 'dify-org-b', appId: 'app-b', mode: 'agent-chat' }), 'agent-a')
    assert(catalog.findAgent('agent-a'))

    await assert.rejects(
      () => service.resolveRuntimeContext(actor, 'agent-a', visibility),
      (error: unknown) => error instanceof DifyDomainError && error.code === 'CONNECTION_NOT_FOUND',
    )
    assert.equal(reads.length, 0)
    db.close()
  })

  test('fails closed when a permanent legacy alias is missing', async () => {
    const { db, identities, service, reads } = setup()
    db.prepare("DELETE FROM resource_numeric_aliases WHERE namespace = 'user' AND resource_id = 'user-a'").run()
    assert.equal(identities.getNumericAlias('user', 'user-a'), null)

    await assert.rejects(
      () => service.resolveRuntimeContext(actor, 'agent-a', visibility),
      (error: unknown) => error instanceof DifyDomainError && error.code === 'LEGACY_ALIAS_MISSING',
    )
    assert.equal(reads.length, 0)
    db.close()
  })

  test('parses a Nexus reference without confusing colons in the namespace', () => {
    assert.deepEqual(parseNexusSecretRef('nexus://org:org-a:dify/service-api-key'), {
      namespace: 'org:org-a:dify', key: 'service-api-key',
    })
    assert.throws(() => parseNexusSecretRef('plaintext-secret'), /Nexus secret reference/)
  })

  test('resolves app-scoped enhancement keys from appSecretRef', async () => {
    const { db, catalog, service, reads } = setup()
    db.prepare('UPDATE tenant_assistants SET provider_binding = ? WHERE id = ?').run(JSON.stringify({
      connectionId: 'dify-org-a', appId: 'app-a', mode: 'workflow', tenantId: 'tenant-a',
      appSecretRef: 'nexus://org:org-a:dify/apps/app-a',
    }), 'agent-a')
    assert(catalog.findAgent('agent-a'))

    const context = await service.resolveEnhancementContext(actor, 'agent-a', visibility)

    assert.equal(context.mode, 'workflow')
    assert.equal(context.appId, 'app-a')
    assert.equal(context.appApiKey, 'service-api-secret')
    assert.deepEqual(reads.map(item => item.key), ['service-api-key', 'app-a'])
    db.close()
  })

  test('resolves pure dataset enhancement without requiring an app id or app key', async () => {
    const { db, catalog, service, reads } = setup()
    catalog.createAgent({
      id: 'rag-a', orgId: 'org-a', name: 'RAG A', authorId: 'admin-a', status: 'approved',
      providerType: 'dify', supportedModes: 'both',
      providerBinding: { connectionId: 'dify-org-a', mode: 'rag-only', datasetIds: ['dataset-1', 'dataset-2'] },
    })

    const context = await service.resolveEnhancementContext(actor, 'rag-a', visibility)

    assert.equal(context.mode, 'rag-only')
    assert.equal(context.appId, null)
    assert.equal(context.appApiKey, null)
    assert.deepEqual(context.datasetIds, ['dataset-1', 'dataset-2'])
    assert.deepEqual(reads.map(item => item.key), ['service-api-key'])
    db.close()
  })

  test('describes enhancement without reading Nexus secrets', () => {
    const { db, service, reads } = setup()
    const probe = service.describeEnhancement(actor, 'agent-a', visibility)
    assert.deepEqual(probe, { enabled: true, mode: 'agent-chat' })
    assert.equal(reads.length, 0)
    db.close()
  })

  test('resolves one organization connection and rejects an ambiguous default', async () => {
    const { db, identities, service, reads } = setup()
    const resolved = await service.resolveOrganizationContext('org-a')
    assert.equal(resolved.connectionId, 'dify-org-a')
    assert.equal(resolved.apiKey, 'service-api-secret')

    identities.putIntegrationConnection({
      id: 'dify-org-a-second', orgId: 'org-a', providerType: 'dify', name: 'Dify A2', enabled: true,
      secretRef: 'nexus://org:org-a:dify/service-api-key-2', config: { tenantId: 'tenant-a2' },
    })
    await assert.rejects(
      () => service.resolveOrganizationContext('org-a'),
      (error: unknown) => error instanceof DifyDomainError && error.code === 'CONNECTION_AMBIGUOUS',
    )
    assert.equal(reads.length, 1)
    db.close()
  })
})
