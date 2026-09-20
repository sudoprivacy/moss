import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { AuthService } from '../auth/service.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { createIdentityTestRepository } from '../testing/compatibilityRepositories.js'

void test('Moss native user creation uses the unified identity command', async () => {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  await authDb.createOrganization('org-a', 'Org A', 1)
  await authDb.setConfig('issuer', 'moss-test')
  await authDb.setConfig('jwt_secret', 'test-secret')
  const repository = createIdentityTestRepository(db, {}, authDb.driver)
  const authService = new AuthService(authDb, 3600)
  await authService.initializeCompatibilityRecords()

  const created = await authService.createUser({
    orgId: 'org-a',
    name: 'new-moss-user',
    password: 'StrongPass123',
    role: 'user',
    idempotencyKey: 'native-user-1',
  })
  const alias = await repository.getNumericAlias('user', created.user.id)
  assert(alias !== null)
  assert.deepEqual(await repository.getWallet('user', created.user.id), { balanceUnits: 0, version: 0 })
  assert.equal((await repository.findAuthIdentity('password', 'moss', 'new-moss-user'))?.userId, created.user.id)
  assert.equal((await repository.getOutboxEvent('welcome:native-user-1'))?.status, 'pending')

  authService.destroy()
  db.close()
})

void test('Moss native user creation provisions Sudorouter before activating the Sudowork account', async () => {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  await authDb.createOrganization('org-a', 'Org A', 1)
  await authDb.setConfig('issuer', 'moss-test')
  await authDb.setConfig('jwt_secret', 'test-secret')
  const repository = createIdentityTestRepository(db, {}, authDb.driver)
  const authService = new AuthService(authDb, 3600)
  await authService.initializeCompatibilityRecords()
  const observedStatuses: string[] = []
  const provisionedOwners: string[] = []
  authService.configureSudorouterAccounts({
    initialQuotaUnits: 50_000_000,
    accountProvisioner: {
      ensureAccount: async input => {
        observedStatuses.push((await authDb.getUserById(input.ownerId))?.status ?? 'missing')
        provisionedOwners.push(input.ownerId)
        return {
          externalUserId: 'router-71', token: 'secret-token', tokenSecretRef: 'nexus://token/ref',
          quotaUnits: input.initialQuotaUnits, usedQuotaUnits: 0,
        }
      },
    },
  })

  const input = {
    orgId: 'org-a', name: '13800000000', password: 'StrongPass123', role: 'user',
    idempotencyKey: 'native-provisioned-user-1',
  }
  const created = await authService.createProvisionedUser(input)
  const retried = await authService.createProvisionedUser(input)

  assert.deepEqual(observedStatuses, ['pending', 'active'])
  assert.deepEqual(provisionedOwners, [created.user.id, created.user.id])
  assert.equal(retried.user.id, created.user.id)
  assert.equal((await authDb.listUsersByOrg('org-a')).length, 1)
  assert.equal((await authDb.getUserById(created.user.id))?.status, 'active')
  assert.deepEqual(await repository.getWallet('user', created.user.id), { balanceUnits: 100_000, version: 0 })
  assert.equal(
    (await repository.findAuthIdentity('phone', 'sudowork', '13800000000'))?.userId,
    created.user.id,
  )

  authService.destroy()
  db.close()
})

void test('Moss native organization creation gets a profile, numeric alias, and wallet', async () => {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  await authDb.createOrganization('bootstrap-org', 'Bootstrap', 1)
  await authDb.setConfig('issuer', 'moss-test')
  await authDb.setConfig('jwt_secret', 'test-secret')
  const repository = createIdentityTestRepository(db, {}, authDb.driver)
  const authService = new AuthService(authDb, 3600)
  await authService.initializeCompatibilityRecords()

  const created = await authService.createOrganization({
    name: 'New Organization',
    code: 'new-org',
    idempotencyKey: 'native-org-1',
  })
  assert.equal((await repository.getOrganizationProfileByCode('new-org'))?.orgId, created.organization.id)
  assert(await repository.getNumericAlias('enterprise', created.organization.id) !== null)
  assert.deepEqual(await repository.getWallet('organization', created.organization.id), { balanceUnits: 0, version: 0 })
  const listed = (await authService.listAllOrganizations()).organizations.find(item => item.id === created.organization.id)
  assert.equal(listed?.legacyId, await repository.getNumericAlias('enterprise', created.organization.id))
  assert.equal(listed?.code, 'new-org')

  authService.destroy()
  db.close()
})

void test('AuthService startup backfills compatibility records without external outbox events', async () => {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  await authDb.createOrganization('org-existing', 'Existing Org', 1)
  await authDb.createUser({
    id: 'user-existing', orgId: 'org-existing', email: 'existing@example.test', name: 'existing',
    displayName: null, departmentId: null, role: 'user', status: 'active', localAuth: true,
    tokenLimit: null, createdAt: 1, passwordHash: null, passwordUpdatedAt: null,
    lastLoginAt: null, extUserId: null,
  })
  await authDb.createUser({
    id: 'user-oauth', orgId: 'org-existing', email: 'oauth@example.test', name: 'oauth-user',
    displayName: null, departmentId: null, role: 'user', status: 'active', localAuth: false,
    tokenLimit: null, createdAt: 2, passwordHash: null, passwordUpdatedAt: null,
    lastLoginAt: null, extUserId: 'oauth-1',
  })
  await authDb.setConfig('issuer', 'moss-test')
  await authDb.setConfig('jwt_secret', 'test-secret')
  const repository = createIdentityTestRepository(db, {}, authDb.driver)
  const authService = new AuthService(authDb, 3600)
  await authService.initializeCompatibilityRecords()

  assert(await repository.getNumericAlias('enterprise', 'org-existing') !== null)
  assert(await repository.getNumericAlias('user', 'user-existing') !== null)
  assert(await repository.getOrganizationProfileByCode('moss-org-existing'))
  assert.deepEqual(await repository.getWallet('organization', 'org-existing'), { balanceUnits: 0, version: 0 })
  assert.deepEqual(await repository.getWallet('user', 'user-existing'), { balanceUnits: 0, version: 0 })
  assert.equal((await repository.findAuthIdentity('password', 'moss', 'existing'))?.userId, 'user-existing')
  assert.equal(await repository.findAuthIdentityByUser('user-oauth', 'password', 'moss'), null)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM outbox_events').get() as { count: number }).count, 0)

  authService.destroy()
  db.close()
})

void test('Moss native user list exposes stable legacy alias, wallet summary and full account state', async () => {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  await authDb.createOrganization('org-a', 'Org A', 1)
  await authDb.createUser({
    id: 'pending-user', orgId: 'org-a', email: 'pending@example.test', name: 'pending',
    displayName: '待审批用户', departmentId: null, role: 'user', status: 'pending', localAuth: true,
    tokenLimit: null, createdAt: 1, passwordHash: 'secret-hash', passwordUpdatedAt: null,
    lastLoginAt: null, extUserId: null,
  })
  await authDb.setConfig('issuer', 'moss-test')
  await authDb.setConfig('jwt_secret', 'test-secret')
  const repository = createIdentityTestRepository(db, {}, authDb.driver)
  const authService = new AuthService(authDb, 3600)
  await authService.initializeCompatibilityRecords()
  const legacyId = await repository.getNumericAlias('user', 'pending-user')
  db.prepare("UPDATE wallets SET balance_units = ? WHERE owner_type = 'user' AND owner_id = ?")
    .run(125_000, 'pending-user')

  const listed = (await authService.listUsers('org-a')).users[0]!
  assert.equal(listed.status, 'pending')
  assert.equal(listed.legacyId, legacyId)
  assert.equal(listed.balanceUnits, 1250)
  assert.equal('passwordHash' in listed, false)

  authService.destroy()
  db.close()
})

void test('Moss /me organization carries the active organization legacy alias and code', async () => {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  await authDb.createOrganization('org-a', 'Org A', 1)
  await authDb.createUser({
    id: 'admin-a', orgId: 'org-a', email: 'admin@example.test', name: 'admin', displayName: null,
    departmentId: null, role: 'admin', status: 'active', localAuth: true, tokenLimit: null,
    createdAt: 1, passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null,
  })
  await authDb.setConfig('issuer', 'moss-test')
  await authDb.setConfig('jwt_secret', 'test-secret')
  const repository = createIdentityTestRepository(db, {}, authDb.driver)
  const authService = new AuthService(authDb, 3600)
  await authService.initializeCompatibilityRecords()
  const response = await authService.getMe({
    rawToken: 'token',
    userId: 'admin-a',
    orgId: 'org-a',
    role: 'admin',
    scopes: ['*'],
    keyId: 'key',
    jti: 'jti',
    exp: 1,
  })
  assert.equal(response.organization?.legacyId, await repository.getNumericAlias('enterprise', 'org-a'))
  assert.equal(response.organization?.code, (await repository.getOrganizationProfile('org-a'))?.code)
  authService.destroy()
  db.close()
})
