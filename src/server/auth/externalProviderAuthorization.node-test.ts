import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
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

void test('switched super admin can manage only the selected organization without becoming its member', async () => {
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
  await providers.register(switchedAuth, { ...registration, request_id: randomUUID(), allowed_user_ids: ['member-b'] })
  assert.equal((await providers.administration.list(switchedAuth)).length, 1)
  assert.equal((await providers.administration.list(homeAuth)).length, 0)

  await assert.rejects(
    providers.authorize({ userId: 'admin-a', orgId: 'org-b' }),
    (error) => error instanceof ExternalProviderError && error.status === 401 && error.code === 'USER_NOT_ACTIVE',
  )
})
