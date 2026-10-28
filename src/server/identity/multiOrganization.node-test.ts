import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { AuthCenterDb, hashPassword } from '../authCenter/db.js'
import { AuthService, AuthServiceError } from '../auth/service.js'
import type { AuthContext } from '../auth/token.js'
import { createIdentityTestRepository } from '../testing/compatibilityRepositories.js'
import { AccountMemberships } from './accountMemberships.js'

const PHONE = '13900000001'
const PRIMARY = 'ethan-opc'

async function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  createIdentityTestRepository(db, {}, authDb.driver)
  await authDb.setConfig('issuer', 'multi-organization-test')
  await authDb.setConfig('jwt_secret', 'isolated-multi-organization-fixture-secret')
  const service = new AuthService(authDb, 3600)
  t.after(() => { service.destroy(); db.close() })
  for (const [id, name] of [['opc', 'Ethan OPC'], ['company', 'Company'], ['foreign', 'Foreign']]) {
    await authDb.createOrganization(id, name, 1)
  }
  async function createUser(id: string, orgId: string, role = 'user', phone: string | null = null, password: string | null = null) {
    await authDb.createUser({ id, orgId, name: id, displayName: id === PRIMARY ? 'Ethan' : id,
      email: id + '@example.test', departmentId: null, role, status: 'active', localAuth: Boolean(password),
      tokenLimit: null, createdAt: 1, passwordHash: password ? hashPassword(password) : null,
      passwordUpdatedAt: null, lastLoginAt: null, extUserId: null, phone })
    return (await authDb.getUserById(id))!
  }
  await createUser(PRIMARY, 'opc', 'admin', PHONE)
  await createUser('company-admin', 'company', 'admin', null, 'Company-admin-password-1')
  await service.initializeCompatibilityRecords()
  for (const org of ['opc', 'company', 'foreign']) {
    await service.putOrganizationClientPolicy(org, { loginMethod: 'sms', loginMethodInherited: false }, 'fixture')
  }
  const primaryTokens = await service.issueTokenFromPhone(PHONE)
  const primary = (await service.verifyAccessToken(primaryTokens.access_token))!
  const adminTokens = await service.issueMossTokenFromPassword({ username: 'company-admin', password: 'Company-admin-password-1' })
  const admin = (await service.verifyAccessToken(adminTokens.access_token))!
  assert(primary && admin)
  return { db, authDb, service, createUser, primaryTokens, primary, admin,
    accounts: new AccountMemberships(authDb.driver) }
}

function status(code: number) {
  return (error: unknown) => error instanceof AuthServiceError && error.statusCode === code
}

void test('an SMS account switches into its own company membership with that company role and model key', async t => {
  const f = await fixture(t)
  const before = await f.authDb.getUserById(PRIMARY)
  await f.accounts.ensureExisting(before!)
  // Arrange an existing membership independently of the new administrative API.
  const company = await f.createUser('ethan-company', 'company')
  await f.accounts.attach(PRIMARY, company)
  await f.authDb.setUserModelCredential(PRIMARY, { sudorouterUserId: '1', sudorouterKey: 'fixture-opc-key' })
  await f.authDb.setUserModelCredential(company.id, { sudorouterUserId: '2', sudorouterKey: 'fixture-company-key' })
  const token = await f.service.switchOrg(f.primary, 'company')
  const selected = (await f.service.verifyAccessToken(token.access_token))!
  assert.equal(selected.userId, company.id)
  assert.equal(selected.accountId, PRIMARY)
  assert.equal(selected.orgId, 'company')
  assert.equal(selected.role, 'user')
  assert(!selected.scopes.includes('*'))
  assert.equal((await f.authDb.getUserModelCredential(selected.userId))?.sudorouterKey, 'fixture-company-key')
  assert.deepEqual(await f.authDb.getUserById(PRIMARY), before)
  assert.deepEqual(new Set((await f.service.listAccountOrganizations(selected)).organizations.map(org => org.id)), new Set(['opc', 'company']))
  const original = await f.service.switchOrg(selected, 'opc')
  assert.equal(original.user.id, PRIMARY)
  assert.equal(original.user.role, 'admin')
})

void test('adding the existing account creates one ordinary membership without moving the OPC identity', async t => {
  const f = await fixture(t)
  const original = await f.authDb.getUserById(PRIMARY)
  const result = await f.service.addOrganizationMember(f.admin, PHONE)
  assert.equal(result.created, true)
  assert.notEqual(result.user.id, PRIMARY)
  assert.equal(result.user.orgId, 'company')
  assert.equal(result.user.role, 'user')
  assert.equal((await f.authDb.getUserById(result.user.id))?.passwordHash, null)
  assert.equal((await f.authDb.getUserById(result.user.id))?.phone, null)
  assert.deepEqual(await f.authDb.getUserById(PRIMARY), original)
  const again = await f.service.addOrganizationMember(f.admin, PHONE)
  assert.equal(again.created, false)
  assert.equal(again.user.id, result.user.id)
  assert.equal((await f.authDb.listUsersByOrg('company')).length, 2)
  assert.equal(await f.service.mossAgents.canUse('company', result.user.id), false)
  await f.service.mossAgents.setAccess(f.admin, result.user.id, true)
  const opcAgent = await f.service.mossAgents.getAgent('opc', PRIMARY)
  const companyAgent = await f.service.mossAgents.getAgent('company', result.user.id)
  assert.notEqual(companyAgent.agentName, opcAgent.agentName)
  assert.notEqual(companyAgent.ownerId, opcAgent.ownerId)
})

void test('concurrent invitations keep one membership and no orphan user', async t => {
  const f = await fixture(t)
  const [first, second] = await Promise.all([
    f.service.addOrganizationMember(f.admin, PHONE), f.service.addOrganizationMember(f.admin, PHONE),
  ])
  assert.equal(first.user.id, second.user.id)
  assert.equal((await f.authDb.listUsersByOrg('company')).length, 2)
})

void test('a company password reset does not prove access to the persons other organizations', async t => {
  const f = await fixture(t)
  const member = (await f.service.addOrganizationMember(f.admin, PHONE)).user
  await f.service.setUserPassword({ orgId: 'company', userId: member.id, password: 'Reset-by-company-1' }, f.admin)
  const stored = (await f.authDb.getUserById(member.id))!
  const login = await f.service.issueMossTokenFromPassword({ username: stored.name, password: 'Reset-by-company-1' })
  const scoped = (await f.service.verifyAccessToken(login.access_token))!
  assert(scoped)
  assert.equal(scoped.accountId, undefined)
  await assert.rejects(f.service.listAccountOrganizations(scoped), status(403))
  await assert.rejects(f.service.switchOrg(scoped, 'opc'), status(403))
  assert.equal((await f.authDb.getUserById(PRIMARY))?.passwordHash, null)
  assert(await f.service.verifyAccessToken(f.primaryTokens.access_token))
})

void test('an unrelated organization, forged account mapping and API key cannot switch the human', async t => {
  const f = await fixture(t)
  await f.service.addOrganizationMember(f.admin, PHONE)
  await assert.rejects(f.service.switchOrg(f.primary, 'foreign'), status(403))
  await assert.rejects(f.service.switchOrg({ ...f.primary, accountId: 'another-human' }, 'company'), status(403))
  const api: AuthContext = { ...f.primary, accountId: undefined, authApp: undefined, keyId: 'organization-api-key' }
  await assert.rejects(f.service.switchOrg(api, 'company'), status(403))
  await assert.rejects(f.service.listAccountOrganizations(api), status(403))
})

void test('membership revocation applies immediately and keeps the OPC membership active', async t => {
  const f = await fixture(t)
  const member = (await f.service.addOrganizationMember(f.admin, PHONE)).user
  const selected = await f.service.switchOrg(f.primary, 'company')
  await f.authDb.updateUser(member.id, { status: 'disabled' })
  assert.equal(await f.service.verifyAccessToken(selected.access_token), null)
  assert(await f.service.verifyAccessToken(f.primaryTokens.access_token))
  await assert.rejects(f.service.switchOrg(f.primary, 'company'), status(403))
  assert.deepEqual((await f.service.listAccountOrganizations(f.primary)).organizations.map(org => org.id), ['opc'])
})

void test('refresh preserves the selected membership and recomputes a downgraded role', async t => {
  const f = await fixture(t)
  const member = (await f.service.addOrganizationMember(f.admin, PHONE)).user
  await f.authDb.updateUser(member.id, { role: 'admin' })
  const selected = await f.service.switchOrg(f.primary, 'company')
  assert(selected.scopes.includes('*'))
  await f.authDb.updateUser(member.id, { role: 'user' })
  const refreshed = await f.service.refreshToken(selected.refresh_token)
  const auth = (await f.service.verifyAccessToken(refreshed.access_token))!
  assert(auth)
  assert.equal(auth.userId, member.id)
  assert.equal(auth.accountId, PRIMARY)
  assert.equal(auth.orgId, 'company')
  assert.equal(auth.role, 'user')
  assert(!auth.scopes.includes('*'))
})

void test('the target enterprises authentication policy still applies', async t => {
  const f = await fixture(t)
  await f.service.addOrganizationMember(f.admin, PHONE)
  await f.service.putOrganizationClientPolicy('company', { loginMethod: 'password', loginMethodInherited: false }, 'fixture')
  await assert.rejects(f.service.switchOrg(f.primary, 'company'), status(403))
  assert(await f.service.verifyAccessToken(f.primaryTokens.access_token))
})

void test('ordinary and department members cannot grant an organization membership', async t => {
  const f = await fixture(t)
  const member = (await f.service.addOrganizationMember(f.admin, PHONE)).user
  const tokens = await f.service.switchOrg(f.primary, 'company')
  const ordinary = (await f.service.verifyAccessToken(tokens.access_token))!
  await assert.rejects(f.service.addOrganizationMember(ordinary, PHONE), status(403))
  await f.authDb.updateUser(member.id, { role: 'dept_admin' })
  await assert.rejects(f.service.addOrganizationMember({ ...ordinary, role: 'dept_admin', scopes: ['*'] }, PHONE), status(403))
})

void test('disabling the human account revokes both enterprise sessions and refreshes', async t => {
  const f = await fixture(t)
  await f.service.addOrganizationMember(f.admin, PHONE)
  const company = await f.service.switchOrg(f.primary, 'company')
  await f.authDb.driver.run("UPDATE human_accounts SET status = 'disabled' WHERE id = ?", [PRIMARY])
  assert.equal(await f.service.verifyAccessToken(company.access_token), null)
  assert.equal(await f.service.verifyAccessToken(f.primaryTokens.access_token), null)
  await assert.rejects(f.service.refreshToken(company.refresh_token), status(401))
  await assert.rejects(f.service.issueTokenFromPhone(PHONE), status(403))
})

void test('phone login survives revoking the original company membership', async t => {
  const f = await fixture(t)
  const company = await f.service.addOrganizationMember(f.admin, PHONE)
  await f.authDb.updateUser(PRIMARY, { status: 'disabled' })
  const session = await f.service.issueTokenFromPhone(PHONE)
  assert.equal(session.user.id, company.user.id)
  assert.equal((await f.service.verifyAccessToken(session.access_token))?.accountId, PRIMARY)
})
