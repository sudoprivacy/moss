import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DirectConnectStore } from '../db.js'
import { createCatalogTestRepository, requireSqliteTestDatabase } from '../testing/compatibilityRepositories.js'

void test('native tenant listing and management exclude hosted agents without deleting their Catalog records', async () => {
  const store = new DirectConnectStore(':memory:')
  const catalog = createCatalogTestRepository(requireSqliteTestDatabase(store))
  try {
    await catalog.createAgent({ id: 'native', orgId: 'org-a', name: 'Native template', authorId: 'admin-a', status: 'approved' })
    await catalog.createAgent({ id: 'hosted', orgId: 'org-a', name: 'Dify agent', authorId: 'admin-a', status: 'approved', providerType: 'dify', providerBinding: { executionMode: 'external_hosted', appId: 'app' } })
    await catalog.createAgent({ id: 'internal', orgId: 'org-a', name: 'Hosted artifact', authorId: 'admin-a', status: 'approved', providerType: 'moss_runtime', providerBinding: { executionMode: 'internal_hosted', assetId: 'asset-a' } })
    assert.equal(await store.getTenantAssistant('internal', 'org-a'), null)
    assert.equal(await store.getTenantAssistantByName('Hosted artifact', 'org-a'), null)
    assert.deepEqual((await store.listTenantAssistants()).map(row => row.id), ['native'])
    assert.deepEqual((await store.listTenantAssistants('approved', 'org-a')).map(row => row.id), ['native'])
    assert.deepEqual(await store.listTenantAssistants(undefined, 'org-b'), [])
    assert.equal((await store.getTenantAssistant('native', 'org-a'))?.id, 'native')
    assert.equal(await store.getTenantAssistant('native', 'org-b'), null)
    assert.equal(await store.getTenantAssistant('hosted', 'org-a'), null)
    assert.equal(await store.getTenantAssistant('hosted'), null)
    assert.equal(await store.getTenantAssistantByName('Dify agent', 'org-a'), null)
    assert.equal(await store.getTenantAssistantByName('Dify agent'), null)
    assert.equal((await store.getTenantAssistantByName('Native template', 'org-a'))?.id, 'native')
    assert.equal((await catalog.getAgent('hosted', 'org-a'))?.providerBinding?.executionMode, 'external_hosted')
  } finally {
    await store.close()
  }
})
