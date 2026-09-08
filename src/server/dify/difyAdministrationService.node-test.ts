import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import JSZip from 'jszip'
import { migrationCommandContext, onlineCommandContext } from '../application/commandContext.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { CatalogRepository } from '../catalog/catalogRepository.js'
import { CatalogService } from '../catalog/catalogService.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { DifyAdministrationService } from './difyAdministrationService.js'
import { DifyProviderError } from './difyHttpAdapter.js'
import { DifyRepository } from './difyRepository.js'

function setup(options: { failArtifactPublish?: boolean; failFirstProvision?: boolean } = {}) {
  const db = new DatabaseSync(':memory:')
  const auth = new AuthCenterDb(db)
  auth.createOrganization('org-a', 'Organization A', 1)
  auth.createOrganization('org-b', 'Organization B', 2)
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
  identities.putOrganizationProfile({
    orgId: 'org-a', code: 'ENT-A', loginMethod: 'password', localEnabled: true, cloudEnabled: true,
  })
  identities.putOrganizationProfile({
    orgId: 'org-b', code: 'ENT-B', loginMethod: 'password', localEnabled: true, cloudEnabled: true,
  })
  identities.assignNumericAlias({ namespace: 'enterprise', legacyId: 1, resourceId: 'org-a', orgId: 'org-a' })
  identities.assignNumericAlias({ namespace: 'enterprise', legacyId: 2, resourceId: 'org-b', orgId: 'org-b' })
  const catalog = new CatalogRepository(db)
  const difyRepository = new DifyRepository(db)
  const secretWrites: Array<{ namespace: string; key: string; value: string }> = []
  const secretDeletes: Array<{ namespace: string; key: string }> = []
  const externalCalls: Array<{ method: string; args: unknown[] }> = []
  const artifactCalls: Array<{ method: string; input: unknown }> = []
  let provisionAttempts = 0
  const adapter = {
    async provisionTenant(input: unknown) {
      provisionAttempts += 1
      externalCalls.push({ method: 'provisionTenant', args: [input] })
      if (options.failFirstProvision && provisionAttempts === 1) {
        throw new DifyProviderError(503, 'temporary provider rejection', null)
      }
      return { dify_tenant_id: 'tenant-a', system_account_id: 'system-a', service_api_key: 'service-secret' }
    },
    async systemJson(...args: unknown[]) {
      externalCalls.push({ method: 'systemJson', args })
      if (args[1] === 'POST') return { app_id: 'app-1', mode: 'agent-chat', name: 'Dify Agent', app_api_key: 'app-secret' }
      if (args[2] === '/sudowork/system/datasets') return { datasets: [{ id: 'dataset-1' }] }
      return { ok: true }
    },
  }
  const service = new DifyAdministrationService({
    db, auth, identities, catalog, difyRepository,
    catalogService: new CatalogService(db, catalog),
    adapter: adapter as never,
    secrets: {
      async putSecret(namespace: string, key: string, value: string) {
        secretWrites.push({ namespace, key, value })
      },
      async deleteSecret(namespace: string, key: string) { secretDeletes.push({ namespace, key }) },
    },
    artifacts: {
      async stage(input: unknown) {
        artifactCalls.push({ method: 'stage', input })
        return { kind: 'agent', checksum: 'checksum-1', size: 10, stagingPath: '/tmp/staged', finalPath: '/managed/agent.zip' }
      },
      async publish(input: unknown) {
        artifactCalls.push({ method: 'publish', input })
        if (options.failArtifactPublish) throw new Error('publish failed')
      },
      async discard(input: unknown) { artifactCalls.push({ method: 'discard', input }) },
      async read() { return Buffer.from('') },
    },
    publicBaseUrl: 'https://moss.example.test',
    ssoSecret: 'sso-secret',
    difyBaseUrl: 'https://dify.example.test',
    clock: () => 1_700_000_000_000,
    idFactory: () => 'agent-new',
  })
  return { db, identities, catalog, difyRepository, service, secretWrites, secretDeletes, externalCalls, artifactCalls }
}

const admin = { userId: 'admin-a', orgId: 'org-a', role: 'admin' }

describe('DifyAdministrationService', () => {
  test('migration provisioning is suppressed without resolving external dependencies', async () => {
    const { db, identities, difyRepository, service, externalCalls, secretWrites } = setup()
    const result = await service.provision('org-a', migrationCommandContext('run-1', 'provision:org-a'))
    assert.deepEqual(result, { suppressed: true })
    assert.equal(externalCalls.length, 0)
    assert.equal(secretWrites.length, 0)
    assert.equal(identities.listIntegrationConnections('org-a', 'dify').length, 0)
    assert.equal(difyRepository.getOperationByIdempotencyKey('provision:org-a')?.status, 'SUPPRESSED')
    db.close()
  })

  test('provisions once, puts plaintext service key only in Nexus, and persists one connection reference', async () => {
    const { db, identities, service, externalCalls, secretWrites } = setup()
    const first = await service.provision('org-a', onlineCommandContext('provision:org-a'))
    const repeated = await service.provision('org-a', onlineCommandContext('provision:org-a:again'))
    assert.deepEqual(first, { dify_tenant_id: 'tenant-a', dify_system_account_id: 'system-a' })
    assert.deepEqual(repeated, first)
    assert.equal(externalCalls.filter(call => call.method === 'provisionTenant').length, 1)
    assert.deepEqual(secretWrites, [{ namespace: 'org:org-a:dify', key: 'service-api-key', value: 'service-secret' }])
    const connection = identities.listIntegrationConnections('org-a', 'dify')[0]
    assert.equal(connection?.secretRef, 'nexus://org:org-a:dify/service-api-key')
    assert.deepEqual(connection?.config, {
      tenantId: 'tenant-a', systemAccountId: 'system-a', isDefault: true, createdAt: 1_700_000_000,
    })
    assert.equal(JSON.stringify(connection).includes('service-secret'), false)
    db.close()
  })

  test('dataset listing preserves legacy first-read tenant provisioning', async () => {
    const { db, service, externalCalls } = setup()
    assert.deepEqual(await service.listAvailableDatasets('org-a'), [{ id: 'dataset-1' }])
    assert.deepEqual(externalCalls.map(call => call.method), ['provisionTenant', 'systemJson'])
    db.close()
  })

  test('retries a definitively failed auto-provision operation with the same stable key', async () => {
    const { db, service, externalCalls } = setup({ failFirstProvision: true })
    await assert.rejects(service.listAvailableDatasets('org-a'), /temporary provider rejection/)
    assert.deepEqual(await service.listAvailableDatasets('org-a'), [{ id: 'dataset-1' }])
    assert.equal(externalCalls.filter(call => call.method === 'provisionTenant').length, 2)
    db.close()
  })

  test('creates a Dify app as one canonical Catalog agent and stores its key only in Nexus', async () => {
    const { db, catalog, difyRepository, service, externalCalls, secretWrites } = setup()
    const result = await service.createAgent({
      actor: admin, orgId: 'org-a', name: 'Dify Agent', description: 'desc', mode: 'agent-chat',
    }, onlineCommandContext('agent:create:1'))

    assert(!('suppressed' in result))
    assert.equal(result.assistantId, 'agent-new')
    assert.equal(externalCalls.filter(call => call.method === 'provisionTenant').length, 1)
    assert.equal(externalCalls.filter(call => call.method === 'systemJson').length, 1)
    const agent = catalog.getAgent('agent-new', 'org-a')
    assert.equal(agent?.providerType, 'dify')
    assert.equal(agent?.supportedModes, 'both')
    assert.deepEqual(agent?.providerBinding, {
      connectionId: 'dify:org-a', tenantId: 'tenant-a', appId: 'app-1', mode: 'agent-chat',
      appSecretRef: 'nexus://org:org-a:dify/apps/app-1-api-key', datasetIds: [],
    })
    assert.equal(JSON.stringify(agent).includes('app-secret'), false)
    assert(secretWrites.some(write => write.key === 'apps/app-1-api-key' && write.value === 'app-secret'))
    assert.equal(difyRepository.getOperationByIdempotencyKey('agent:create:1')?.status, 'SUCCEEDED')
    const repeated = await service.createAgent({
      actor: admin, orgId: 'org-a', name: 'Dify Agent', description: 'desc', mode: 'agent-chat',
    }, onlineCommandContext('agent:create:1'))
    assert(!('suppressed' in repeated))
    assert.equal(repeated.assistantId, 'agent-new')
    assert.equal(externalCalls.filter(call => call.method === 'systemJson' && call.args[1] === 'POST').length, 1)
    db.close()
  })

  test('rejects a reused app-create idempotency key with a different payload', async () => {
    const { db, service } = setup()
    await service.createAgent({ actor: admin, orgId: 'org-a', name: 'First' }, onlineCommandContext('agent:create:conflict'))
    await assert.rejects(
      service.createAgent({ actor: admin, orgId: 'org-a', name: 'Different' }, onlineCommandContext('agent:create:conflict')),
      /idempotency key.*different/i,
    )
    db.close()
  })

  test('maps ACL and dataset bindings into the same Catalog record and forbids method changes', () => {
    const { db, catalog, service, externalCalls } = setup()
    catalog.createAgent({
      id: 'rag-1', orgId: 'org-a', name: 'RAG', authorId: 'admin-a', providerType: 'dify',
      supportedModes: 'both', status: 'approved',
      providerBinding: { connectionId: 'dify:org-a', tenantId: 'tenant-a', datasetIds: ['ds-1'] },
    })
    assert.deepEqual(service.replaceAcl('org-a', 'rag-1', [
      { subjectType: 'user', subjectId: 'u1' }, { subjectType: 'role', subjectId: 'reviewer' },
    ]), [
      { subjectType: 'user', subjectId: 'u1' }, { subjectType: 'role', subjectId: 'reviewer' },
    ])
    assert.deepEqual(service.replaceDatasets('org-a', 'rag-1', ['ds-2', 'ds-2']), ['ds-2'])
    assert.throws(() => service.replaceDatasets('org-a', 'rag-1', []), /enhancement method cannot be changed/)
    assert.deepEqual(catalog.getAgent('rag-1', 'org-a')?.visibleTo, {
      user_ids: ['u1'], role_ids: ['reviewer'], department_ids: null,
    })
    db.close()
  })

  test('creates and reads an enterprise assistant from the single Catalog model', async () => {
    const { db, catalog, service, artifactCalls } = setup()
    const source = new JSZip()
    source.file('Assistant.md', '# Prompt')
    const form = new FormData()
    form.set('name', 'Assistant')
    form.set('profession', '研发')
    form.set('description', '统一智能体')
    form.set('source_url', new File([await source.generateAsync({ type: 'uint8array' })], 'source.zip'))
    form.set('dataset_ids', JSON.stringify(['ds-1']))
    form.set('acl_entries', JSON.stringify([{ subjectType: 'user', subjectId: 'u1' }]))
    form.set('shared_tenant_scope', 'selected')
    form.set('shared_tenant_ids', JSON.stringify(['ENT-B']))

    const created = await service.createEnterpriseAssistant(
      { actor: admin, orgId: 'org-a', form }, onlineCommandContext('enterprise-agent:1'),
    ) as Record<string, unknown>
    const replayed = await service.createEnterpriseAssistant(
      { actor: admin, orgId: 'org-a', form }, onlineCommandContext('enterprise-agent:1'),
    ) as Record<string, unknown>
    assert.equal(created.assistantId, 'agent-new')
    assert.equal(replayed.assistantId, 'agent-new')
    const agent = catalog.getAgent('agent-new', 'org-a')
    assert.equal(agent?.providerType, 'dify')
    assert.deepEqual(agent?.providerBinding, {
      connectionId: 'dify:org-a', tenantId: 'tenant-a', datasetIds: ['ds-1'], mode: 'rag-only',
    })
    assert.deepEqual(agent?.visibleTo, { user_ids: ['u1'], role_ids: null, department_ids: null })
    assert.deepEqual(catalog.listAssignedOrganizationIds('agent', 'agent-new'), ['org-b'])
    assert.deepEqual(artifactCalls.map(call => call.method), ['stage', 'publish'])
    assert(((artifactCalls[0]?.input as { bytes: Buffer }).bytes.length) > 0)

    const detail = await service.getEnterpriseAssistant('org-a', 'agent-new') as Record<string, unknown>
    assert.equal((detail.assistant as Record<string, unknown>).name, 'Assistant')
    assert.equal(detail.promptText, null)
    assert.deepEqual(detail.dataset_ids, ['ds-1'])
    db.close()
  })

  test('replays enhanced enterprise assistant creation without creating another Dify App', async () => {
    const { db, service, externalCalls } = setup()
    const form = new FormData()
    form.set('name', 'Enhanced Assistant')
    form.set('profession', '研发')
    form.set('enable_enhancement', 'true')
    form.set('enhancement_mode', 'agent-chat')
    const context = onlineCommandContext('enterprise-agent:enhanced')

    const first = await service.createEnterpriseAssistant({ actor: admin, orgId: 'org-a', form }, context) as Record<string, unknown>
    const replayed = await service.createEnterpriseAssistant({ actor: admin, orgId: 'org-a', form }, context) as Record<string, unknown>

    assert.equal(first.assistantId, 'agent-new')
    assert.equal(replayed.assistantId, 'agent-new')
    assert.equal(externalCalls.filter(call => call.method === 'systemJson' && call.args[1] === 'POST').length, 1)
    db.close()
  })

  test('deletes a Dify agent idempotently and suppresses migration deletion', async () => {
    const { db, catalog, difyRepository, service, externalCalls } = setup()
    await service.createAgent({ actor: admin, orgId: 'org-a', name: 'Delete me' }, onlineCommandContext('agent:create:delete'))

    await service.deleteAgent('org-a', 'agent-new', migrationCommandContext('run-delete', 'agent:delete:suppressed'))
    assert(catalog.getAgent('agent-new', 'org-a'))
    assert.equal(difyRepository.getOperationByIdempotencyKey('agent:delete:suppressed')?.status, 'SUPPRESSED')

    const context = onlineCommandContext('agent:delete:1')
    await service.deleteAgent('org-a', 'agent-new', context)
    await service.deleteAgent('org-a', 'agent-new', context)
    assert.equal(catalog.getAgent('agent-new', 'org-a'), null)
    assert.equal(externalCalls.filter(call => call.method === 'systemJson' && call.args[1] === 'DELETE').length, 1)
    assert.equal(difyRepository.getOperationByIdempotencyKey('agent:delete:1')?.status, 'SUCCEEDED')
    db.close()
  })

  test('service layer rejects enhancement method changes even without the HTTP adapter', async () => {
    const { db, catalog, service } = setup()
    catalog.createAgent({
      id: 'enhanced', orgId: 'org-a', name: 'Enhanced', authorId: 'admin-a', status: 'approved',
      providerType: 'dify', supportedModes: 'both',
      providerBinding: { connectionId: 'dify:org-a', tenantId: 'tenant-a', appId: 'app-1', mode: 'agent-chat' },
    })
    await assert.rejects(service.setEnhancement({
      actor: admin, orgId: 'org-a', assistantId: 'enhanced', enable: false,
    }, onlineCommandContext('enhancement:change')), /enhancement method cannot be changed/)
    db.close()
  })

  test('compensates Catalog, command result, app secret, and Dify app when artifact publish fails', async () => {
    const { db, catalog, service, externalCalls, secretDeletes } = setup({ failArtifactPublish: true })
    const form = new FormData()
    form.set('name', 'Assistant')
    form.set('profession', '研发')
    form.set('prompt_file', new File(['# Prompt'], 'prompt.md'))
    form.set('enable_enhancement', 'true')
    form.set('enhancement_mode', 'agent-chat')

    await assert.rejects(
      service.createEnterpriseAssistant(
        { actor: admin, orgId: 'org-a', form }, onlineCommandContext('enterprise-agent:rollback'),
      ),
      /publish failed/,
    )

    assert.equal(catalog.getAgent('agent-new', 'org-a'), null)
    assert.equal(catalog.getCommandResult('catalog.create_agent', 'enterprise-agent:rollback'), null)
    assert(secretDeletes.some(item => item.key === 'apps/app-1-api-key'))
    assert(externalCalls.some(call => call.method === 'systemJson'
      && call.args[1] === 'DELETE'
      && call.args[2] === '/sudowork/system/apps/app-1'))
    db.close()
  })

  test('returns legacy enterprise aliases and tenant codes instead of Moss organization ids', async () => {
    const { db, catalog, service } = setup()
    catalog.createAgent({
      id: 'shared-1', orgId: 'org-a', name: 'Shared', authorId: 'admin-a', status: 'approved',
      providerType: 'local', supportedModes: 'local', availability: 'assigned',
    })
    catalog.replaceOrganizationAssignments('agent', 'shared-1', ['org-b'])

    const list = await service.listEnterpriseAssistants('org-a') as Array<Record<string, unknown>>
    assert.equal(list[0]?.enterprise_id, 1)
    assert.deepEqual(list[0]?.tenantIds, ['ENT-A', 'ENT-B'])
    assert.deepEqual(list[0]?.shared_tenant_ids, ['ENT-B'])
    db.close()
  })

  test('publishes a replacement artifact and updates its checksum and path', async () => {
    const { db, catalog, service, artifactCalls } = setup()
    catalog.createAgent({
      id: 'existing-1', orgId: 'org-a', name: 'Old', authorId: 'admin-a', status: 'approved',
      providerType: 'local', supportedModes: 'local', version: '1.0.0',
      checksum: 'old-checksum', filePath: '/managed/old.zip',
    })
    const form = new FormData()
    form.set('name', 'Updated')
    form.set('profession', '研发')
    form.set('prompt_file', new File(['# Updated'], 'prompt.md'))

    await service.updateEnterpriseAssistant(
      { actor: admin, orgId: 'org-a', assistantId: 'existing-1', form },
      onlineCommandContext('enterprise-agent:update:1'),
    )

    const updated = catalog.getAgent('existing-1', 'org-a')
    assert.equal(updated?.checksum, 'checksum-1')
    assert.equal(updated?.filePath, '/managed/agent.zip')
    assert.equal(updated?.version, '1.0.1')
    assert.deepEqual(artifactCalls.map(call => call.method), ['stage', 'publish'])
    db.close()
  })

  test('builds a short-lived organization-scoped SSO link', async () => {
    const { db, identities, service } = setup()
    new AuthCenterDb(db).createUser({
      id: 'admin-a', orgId: 'org-a', email: 'admin@example.test', name: 'admin',
      displayName: 'Admin', departmentId: null, role: 'admin', status: 'active',
      localAuth: true, tokenLimit: null, createdAt: 1, passwordHash: null,
      passwordUpdatedAt: null, lastLoginAt: null, extUserId: null,
    })
    identities.assignNumericAlias({ namespace: 'user', legacyId: 17, resourceId: 'admin-a', orgId: 'org-a' })
    await service.provision('org-a', onlineCommandContext('provision:sso'))
    const link = await service.buildSsoLink({ actor: admin, orgId: 'org-a', next: '/datasets' })
    assert(link.url.startsWith('https://dify.example.test/sudowork/sso/exchange?token='))
    assert(link.url.endsWith('&next=%2Fdatasets'))
    assert.equal(link.expiresAt, 1_700_000_300)
    db.close()
  })
})
