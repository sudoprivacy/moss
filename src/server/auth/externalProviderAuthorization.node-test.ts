import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registryHttpFixture } from '../testing/registryHttpFixture.js'
import type { RegistryRequest } from '../agentFederation/registryClient.js'
import { AuthService } from './service.js'
import { AuthCenterDb, hashPassword } from '../authCenter/db.js'
import { createCatalogTestRepository, createIdentityTestRepository } from '../testing/compatibilityRepositories.js'
import { dispatchExternalProvider } from '../externalProviders/routes.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { definitionDigest } from '../externalProviders/definition.js'
import { queryOnlyDefinition } from '../testing/externalProviderDefinitionFixture.js'
import { SESSION_SCHEMA } from '../storage/sessionSchema.js'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

for (const registryEnabled of [false, true]) void test(`switched super admin stays organization-scoped (${registryEnabled ? 'Registry' : 'legacy'})`, async t => {
  const remote = registryHttpFixture()
  const configVariable = 'MOSS_AGENT_REGISTRY_CONFIG_FILE'
  const previousConfig = process.env[configVariable]
  const directory = await mkdtemp(join(tmpdir(), 'registry-authorization-'))
  cleanups.push(async () => {
    if (previousConfig === undefined) delete process.env[configVariable]
    else process.env[configVariable] = previousConfig
    await rm(directory, { recursive: true, force: true })
  })
  delete process.env[configVariable]
  if (registryEnabled) {
    const tokenFile = join(directory, 'token')
    await writeFile(tokenFile, 'synthetic-test-token', { mode: 0o600 })
    const config = join(directory, 'registry.json')
    await writeFile(config, JSON.stringify({ endpoint: 'http://127.0.0.1:12345', tokenFile, publicKeys: [remote.publicPem],
      organizations: { 'org-a': { trustDomain: 'a.example', zoneId: 'zone-a' }, 'org-b': { trustDomain: 'b.example', zoneId: 'zone-1' } } }))
    process.env[configVariable] = config
    t.mock.method(globalThis, 'fetch', (url: string, init: Parameters<RegistryRequest>[1]) => {
      assert.equal(init.headers['X-Nexus-Zone-ID'], 'zone-1')
      return remote.request(url, init)
    })
  }
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  createIdentityTestRepository(db, {}, authDb.driver)
  createCatalogTestRepository(db, authDb.driver)
  await authDb.setConfig('issuer', 'external-provider-authorization-test')
  await authDb.setConfig('jwt_secret', 'external-provider-authorization-secret')
  await authDb.createOrganization('org-a', 'Organization A', 1)
  await authDb.createOrganization('org-b', 'Organization B', 2)

  const password = 'StrongPass123!'
  const baseUser = {
    displayName: null,
    departmentId: null,
    status: 'active' as const,
    localAuth: true,
    tokenLimit: null,
    createdAt: 1,
    passwordHash: hashPassword(password),
    passwordUpdatedAt: null,
    lastLoginAt: null,
    extUserId: null,
    phone: null,
  }
  await authDb.createUser({ ...baseUser, id: 'root', orgId: 'org-a', email: 'root@example.test', name: 'root', role: 'super_admin' })
  await authDb.createUser({ ...baseUser, id: 'admin-a', orgId: 'org-a', email: 'admin-a@example.test', name: 'admin-a', role: 'admin' })
  await authDb.createUser({ ...baseUser, id: 'member-b', orgId: 'org-b', email: 'member-b@example.test', name: 'member-b', role: 'user' })

  const auth = new AuthService(authDb, 3600)
  await auth.initializeCompatibilityRecords()
  db.exec(SESSION_SCHEMA)
  db.prepare(`INSERT INTO server_instances(instance_id, host, pid, started_at, heartbeat_at, status)
    VALUES (?, 'test', ?, 1, 1, 'running')`).run('authorization-test', process.pid)
  const providers = auth.createExternalProviderService({ getSecret: async () => null }, 'authorization-test')
  cleanups.push(async () => {
    await providers.close()
    auth.destroy()
    db.close()
  })

  await providers.ownership.ready
  assert.equal(providers.ownership.ownerId, 'authorization-test')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM server_instances').get()?.count, 1)

  const login = await auth.issueTokenFromPassword({ username: 'root', password })
  const homeAuth = (await auth.verifyAccessToken(login.access_token))!
  const switched = await auth.switchOrg(homeAuth, 'org-b')
  const switchedAuth = (await auth.verifyAccessToken(switched.access_token))!
  assert.equal(switchedAuth.orgId, 'org-b')

  const policyRoute = await dispatchExternalProvider(
    providers,
    switchedAuth,
    'GET',
    new URL('http://moss.test/api/v1/external-agents/admin/policy'),
    {},
    () => {},
    () => {},
  )
  assert.equal(policyRoute.status, 200)

  await providers.administration.setPolicy(switchedAuth, {
    enabled: true,
    endpoints: ['http://127.0.0.1:8089/v1'],
    revision: 0,
  })
  const sourceDefinition = JSON.stringify(queryOnlyDefinition())
  const registration = {
    provider_kind: 'dify',
    request_id: randomUUID(),
    source_definition: sourceDefinition,
    source_digest: definitionDigest(sourceDefinition),
    name: 'Organization B agent',
    endpoint: 'http://127.0.0.1:8089/v1',
    app_id: 'app-b',
    workspace_id: 'workspace-b',
    credential_ref: 'nexus://org:org-b:system:dify/app-key',
    decoder: 'text',
    review_expires_at: Date.now() + 86_400_000,
    review_note: 'Synthetic authorization test.',
  }

  await assert.rejects(
    providers.register(switchedAuth, { ...registration, allowed_user_ids: ['root'] }),
    (error) => error instanceof ExternalProviderError && error.status === 400 && error.code === 'INVALID_MEMBER',
  )
  const agent = await providers.register(switchedAuth, { ...registration, request_id: randomUUID(), allowed_user_ids: ['member-b'] })
  assert.equal((await providers.administration.list(switchedAuth)).length, 1)
  assert.equal((await providers.administration.list(homeAuth)).length, 0)

  // Reads after an organization switch must neither publish nor cross the tenant boundary.
  remote.state.beforeRequest = method => assert.equal(method, 'GET')
  for (const action of ['versions', 'registry-status']) {
    const url = new URL(`http://moss.test/api/v1/external-agents/admin/${agent.id}/${action}`)
    const selected = await dispatchExternalProvider(providers, switchedAuth, 'GET', url, {}, () => {})
    assert.equal(selected.status, 200)
    if (action === 'registry-status') assert.equal((selected.body.data as { authority: string }).authority, registryEnabled ? 'nexus_registry' : 'moss_legacy')
    assert.equal((await dispatchExternalProvider(providers, homeAuth, 'GET', url, {}, () => {})).status, 404)
    const memberLogin = await auth.issueTokenFromPassword({ username: 'member-b', password })
    const member = (await auth.verifyAccessToken(memberLogin.access_token))!
    assert.equal((await dispatchExternalProvider(providers, member, 'GET', url, {}, () => {
      throw new ExternalProviderError(403, 'ADMIN_REQUIRED')
    })).status, 403)
  }
  assert.equal(remote.versions.size, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_versions').get()?.count, 0)

  await assert.rejects(
    providers.authorize({ userId: 'admin-a', orgId: 'org-b' }),
    (error) => error instanceof ExternalProviderError && error.status === 401 && error.code === 'USER_NOT_ACTIVE',
  )
})
