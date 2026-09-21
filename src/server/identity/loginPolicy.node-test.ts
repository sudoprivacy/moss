import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, mock, test, type TestContext } from 'node:test'
import type { ConfigStore } from '../configStore/configStore.js'
import type { OrganizationLoginMethod } from './identityRepository.js'
import type { OAuth2Identity } from '../auth/oauth2Bridge.js'

const temporaryHome = mkdtempSync(path.join(os.tmpdir(), 'moss-login-policy-'))
mock.method(os, 'homedir', () => temporaryHome)
const { AuthService, AuthServiceError } = await import('../auth/service.js')
const { AuthCenterDb, hashPassword } = await import('../authCenter/db.js')
const { ClientPolicyRepository, ensureClientPolicySchema } = await import('../configuration/clientPolicyRepository.js')
const { ensurePlatformIntegrationSettingsSchema } = await import('../configuration/platformIntegrationSettingsRepository.js')
const { resolveEffectiveLoginMethod } = await import('../configuration/loginPolicy.js')
const { IdentityRepository, ensureIdentitySchema } = await import('./identityRepository.js')
const { OAuth2Bridge } = await import('../auth/oauth2Bridge.js')
const { getSystemSettings, updateSystemSettings } = await import('../systemSettings.js')
const { ensureCompatibilityCounterTable } = await import('../db/compatibilitySchema.js')
after(() => {
  mock.restoreAll()
  rmSync(temporaryHome, { recursive: true, force: true })
})

const root = { userId: 'root', orgId: 'org-a', role: 'super_admin' }
const scopedRoot = { ...root, organizationScoped: true }
const passwordInput = { username: 'root', password: 'StrongPass123' }
const phone = '13800000000'
const forbidden = (error: unknown) => error instanceof AuthServiceError && error.statusCode === 403

async function setup(t: TestContext, defaultLoginMethod: OrganizationLoginMethod = 'password') {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  ensureIdentitySchema(db)
  ensureClientPolicySchema(db)
  ensurePlatformIntegrationSettingsSchema(db)
  ensureCompatibilityCounterTable(db)
  await authDb.setConfig('issuer', 'moss-login-policy-test')
  await authDb.setConfig('jwt_secret', 'login-policy-test-secret')
  await authDb.createOrganization('org-a', 'Org A', 1)
  await authDb.createOrganization('org-b', 'Org B', 2, 'external-b')
  await authDb.createUser({
    id: 'root', orgId: 'org-a', email: 'root@example.test', name: 'root',
    displayName: null, departmentId: null, role: 'super_admin', status: 'active',
    localAuth: true, tokenLimit: null, createdAt: 1,
    passwordHash: hashPassword(passwordInput.password), passwordUpdatedAt: null,
    lastLoginAt: null, extUserId: null, phone,
  })
  const service = new AuthService(authDb, 3600)
  t.after(() => { service.destroy(); db.close() })
  await service.initializeCompatibilityRecords()
  const identities = new IdentityRepository(authDb.driver)
  const policies = new ClientPolicyRepository(authDb.driver)
  const config = service.createSudoworkSystemConfigService({
    loginMethod: defaultLoginMethod,
    skillhubBaseUrl: 'https://moss.example.test',
    smsRuntimeAvailable: true,
    smsCredentialsAvailable: true,
    sms: {
      provider: 'tencent', sdkAppId: 'app-id', signName: 'sign', templateId: 'template',
      signId: 'sign-id', region: 'ap-beijing', codeLength: 6, expireMinutes: 5,
      sendIntervalSeconds: 60, maxPerDay: 10,
    },
    billing: {
      enabled: false,
      fuiou: { testMode: true, merchantCode: '', timeoutMs: 1000 },
      sudorouter: {
        baseUrl: '', adminUserId: '', timeoutMs: 1000, initialQuota: 0,
        modelServiceUrl: '', modelsApiUrl: '',
      },
    },
    secrets: {
      get: () => undefined,
      put: async () => {},
      remove: async () => {},
    } as unknown as ConfigStore,
  })
  const setCasPolicy = async (orgId: string) => {
    await config.update({ ...scopedRoot, orgId }, {
      login_method: 2,
      third_party_auth: {
        enabled: 1,
        default_provider: `cas-${orgId}`,
        providers: [{
          id: `cas-${orgId}`, name: 'CAS', type: 'cas', enabled: 1,
          cas_url: 'https://cas.example.test',
          server_callback_url: `https://moss.example.test/cas/${orgId}/callback`,
          app_callback_url: `sudowork://cas-callback/${orgId}/callback`,
          enterprise_code: (await identities.getOrganizationProfile(orgId))!.code,
          auto_provision: 1,
        }],
      },
    })
  }
  return { db, authDb, service, identities, policies, config, setCasPolicy }
}

function providerIdentity(patch: Partial<OAuth2Identity> = {}): OAuth2Identity {
  return {
    extOrgId: 'new-external-org', extOrgName: 'New External Org',
    extUserId: 'external-user', username: 'external-user', email: 'external@example.test',
    extDeptId: 'external-dept', department: 'External Department',
    expiresIn: 3600, accessToken: 'provider-access', refreshToken: 'provider-refresh',
    ...patch,
  }
}

void test('resolver precedence includes numeric zero, string policies and inherited profile values', async t => {
  const { identities, policies } = await setup(t)
  const profile = (await identities.getOrganizationProfile('org-a'))!
  await identities.putOrganizationProfile({ ...profile, loginMethod: 'cas' })
  const sources = { identities, policies, defaults: { loginMethod: 'sms' as const } }
  assert.equal((await resolveEffectiveLoginMethod(sources, 'org-a')), 'cas')
  assert.equal((await resolveEffectiveLoginMethod(sources, 'missing')), 'sms')
  assert.equal((await resolveEffectiveLoginMethod({ identities, policies }, 'missing')), 'password')
  assert.equal((await resolveEffectiveLoginMethod(sources)), 'sms')

  for (const platform of [0, 'sms'] as const) {
    await policies.putPlatform({ loginMethod: platform }, 'root')
    assert.equal((await resolveEffectiveLoginMethod(sources, 'org-a')), 'sms')
    await policies.putOrganization('org-a', { loginMethod: 'password' }, 'root')
    assert.equal((await resolveEffectiveLoginMethod(sources, 'org-a')), 'password')
    assert.equal((await resolveEffectiveLoginMethod(sources, 'org-b')), 'sms')
    assert.equal((await resolveEffectiveLoginMethod(sources, 'org-a', { ignoreOrganizationPolicy: true })), 'sms')
    await policies.removeOrganizationKeys('org-a', ['loginMethod'], 'root')
  }
  await policies.putPlatform({ loginMethod: null }, 'root')
  await policies.putOrganization('org-a', { loginMethod: 1 }, 'root')
  assert.equal((await resolveEffectiveLoginMethod(sources, 'org-a', { ignoreOrganizationPolicy: true })), 'cas')
  await policies.putOrganization('org-a', { loginMethod: 'invalid' }, 'root')
  assert.equal((await resolveEffectiveLoginMethod(sources, 'org-a')), 'cas')
})

void test('saving organization SMS policy gates native password, SMS and refresh without changing profile', async t => {
  const { service, identities, policies, config } = await setup(t)
  const passwordSession = await service.issueTokenFromPassword(passwordInput)
  await config.update(scopedRoot, { login_method: 0 })
  assert.equal((await policies.getOrganization('org-a')).loginMethod, 0)
  assert.equal((await identities.getOrganizationProfile('org-a'))?.loginMethod, 'password')
  assert.equal((await config.getLoginMethod('org-a')), 'sms')
  assert.equal((await config.getPublicConfig('org-a')).login_method, 0)
  await assert.rejects(service.issueTokenFromPassword(passwordInput), forbidden)
  await assert.rejects(service.refreshToken(passwordSession.refresh_token), forbidden)
  const smsSession = await service.issueTokenFromPhone(phone)
  assert.equal((await service.refreshToken(smsSession.refresh_token)).user.id, 'root')
  await config.update(scopedRoot, { login_method: 1 })
  await assert.rejects(service.issueTokenFromPhone(phone), forbidden)
  await assert.rejects(service.refreshToken(smsSession.refresh_token), forbidden)
  assert.equal((await service.issueTokenFromPassword(passwordInput)).user.id, 'root')
})

void test('configured platform policy overrides legacy profiles and organization override wins', async t => {
  const { service, identities, policies, config } = await setup(t)
  const passwordSession = await service.issueTokenFromPassword(passwordInput)
  await config.update(root, { login_method: 0 })
  assert.deepEqual((await policies.getOrganization('org-a')), {})
  assert.equal((await identities.getOrganizationProfile('org-a'))?.loginMethod, 'password')
  assert.equal((await config.getLoginMethod('org-a')), 'sms')
  assert.equal((await config.getLoginMethod('org-b')), 'sms')
  await assert.rejects(service.refreshToken(passwordSession.refresh_token), forbidden)
  await assert.rejects(service.issueTokenFromPassword(passwordInput), forbidden)
  await service.issueTokenFromPhone(phone)
  await config.update(scopedRoot, { login_method: 1 })
  assert.equal((await policies.getOrganization('org-a')).loginMethod, 1)
  await service.issueTokenFromPassword(passwordInput)
  await assert.rejects(service.issueTokenFromPhone(phone), forbidden)
  await config.update(scopedRoot, { login_method: 0 })
  assert.equal((await policies.getOrganization('org-a')).loginMethod, undefined)
  assert.equal((await config.getLoginMethod('org-a')), 'sms')
})

void test('native and configuration defaults agree when the organization has no profile', async t => {
  const { db, service, config } = await setup(t, 'sms')
  db.prepare('DELETE FROM organization_profiles WHERE org_id = ?').run('org-a')
  assert.equal((await config.getLoginMethod('org-a')), 'sms')
  await service.issueTokenFromPhone(phone)
  await assert.rejects(service.issueTokenFromPassword(passwordInput), forbidden)
})

void test('clearing an organization override restores its legacy profile when platform policy is absent', async t => {
  const { service, identities, policies, config, setCasPolicy } = await setup(t)
  await setCasPolicy('org-b')
  await identities.putOrganizationProfile({ ...(await identities.getOrganizationProfile('org-b'))!, loginMethod: 'cas' })
  await config.update({ ...scopedRoot, orgId: 'org-b' }, { login_method: 1 })
  assert.equal((await policies.getOrganization('org-b')).loginMethod, 1)
  await config.update({ ...scopedRoot, orgId: 'org-b' }, { login_method: 2 })
  assert.equal((await policies.getOrganization('org-b')).loginMethod, undefined)
  assert.equal((await config.getLoginMethod('org-b')), 'cas')
  t.mock.method(OAuth2Bridge.prototype, 'resolve', async () => providerIdentity({ extOrgId: 'external-b' }))
  assert.equal((await service.issueTokenFromOAuth2({ params: {} })).organization?.id, 'org-b')
})

void test('first OAuth login provisions CAS profile, aliases and wallets and can refresh', async t => {
  const { service, identities, authDb, config } = await setup(t)
  t.mock.method(OAuth2Bridge.prototype, 'resolve', async () => providerIdentity())
  t.mock.method(OAuth2Bridge.prototype, 'refresh', async () => providerIdentity({ accessToken: 'rotated-access' }))
  const issued = await service.issueTokenFromOAuth2({ params: {} })
  const orgId = issued.organization!.id
  assert.equal((await identities.getOrganizationProfile(orgId))?.loginMethod, 'cas')
  assert.equal((await config.getLoginMethod(orgId)), 'cas')
  assert.notEqual((await identities.getNumericAlias('enterprise', orgId)), null)
  assert.notEqual((await identities.getNumericAlias('user', issued.user.id)), null)
  assert((await identities.getWallet('organization', orgId)))
  assert((await identities.getWallet('user', issued.user.id)))
  assert.equal((await authDb.getUserById(issued.user.id))?.localAuth, false)
  assert.equal((await service.getProviderTokenForUser(issued.user.id))?.token, 'provider-access')
  const refreshed = await service.refreshOAuth2Token({ params: { refresh_token: 'provider-refresh' } })
  assert.equal(refreshed.user.id, issued.user.id)
  assert.equal(refreshed.organization?.id, orgId)
  assert.equal((await service.getProviderTokenForUser(issued.user.id))?.token, 'rotated-access')
  assert.equal((await authDb.listUsersByOrg(orgId)).length, 1)
})

void test('explicit platform policy forbids first OAuth provisioning without side effects', async t => {
  const { service, authDb, config, db } = await setup(t)
  await config.update(root, { login_method: 1 })
  t.mock.method(OAuth2Bridge.prototype, 'resolve', async () => providerIdentity())
  const before = db.prepare('SELECT COUNT(*) AS count FROM resource_numeric_aliases').get()!.count
  await assert.rejects(service.issueTokenFromOAuth2({ params: {} }), forbidden)
  assert.equal(await authDb.getOrganizationByExtId('new-external-org'), null)
  assert.equal(await authDb.getUserByEmail('external@example.test'), null)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM resource_numeric_aliases').get()!.count, before)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM departments').get()!.count, 0)
})

void test('organization policy forbids OAuth login and refresh before identity synchronization', async t => {
  const { service, authDb, config, setCasPolicy } = await setup(t)
  await setCasPolicy('org-b')
  let external = providerIdentity({ extOrgId: 'external-b', extOrgName: 'Original Org' })
  t.mock.method(OAuth2Bridge.prototype, 'resolve', async () => external)
  t.mock.method(OAuth2Bridge.prototype, 'refresh', async () => external)
  const issued = await service.issueTokenFromOAuth2({ params: {} })
  const before = await authDb.getUserById(issued.user.id)
  await config.update({ ...scopedRoot, orgId: 'org-b' }, { login_method: 1 })
  external = { ...external, extOrgName: 'Rejected Rename', username: 'rejected-user', department: 'Rejected Department', accessToken: 'rejected-token' }
  await assert.rejects(service.issueTokenFromOAuth2({ params: {} }), forbidden)
  await assert.rejects(service.refreshOAuth2Token({ params: { refresh_token: 'provider-refresh' } }), forbidden)
  assert.deepEqual(await authDb.getUserById(issued.user.id), before)
  assert.equal((await authDb.getOrganization('org-b'))?.name, 'Original Org')
  assert.equal((await authDb.getDepartmentByExtId('org-b', 'external-dept'))?.name, 'External Department')
  assert.equal((await service.getProviderTokenForUser(issued.user.id))?.token, 'provider-access')
})

void test('switched root refresh validates home policy, retains selected scope and cannot bypass revocation by switching', async t => {
  const { service, config, setCasPolicy } = await setup(t)
  await setCasPolicy('org-b')
  const issued = await service.issueTokenFromPassword(passwordInput)
  const auth = await service.verifyAccessToken(issued.access_token)
  assert(auth)
  const switched = await service.switchOrg(auth, 'org-b')
  const refreshed = await service.refreshToken(switched.refresh_token)
  assert.equal(refreshed.organization?.id, 'org-b')
  assert.equal(refreshed.user.orgId, 'org-a')
  const refreshedAuth = await service.verifyAccessToken(refreshed.access_token)
  assert(refreshedAuth)
  assert.equal(refreshedAuth.orgId, 'org-b')
  assert.equal(refreshedAuth.userId, 'root')
  const secondRefresh = await service.refreshToken(refreshed.refresh_token)
  assert.equal(secondRefresh.organization?.id, 'org-b')
  await config.update(scopedRoot, { login_method: 0 })
  await assert.rejects(service.refreshToken(secondRefresh.refresh_token), forbidden)
  await assert.rejects(service.switchOrg(refreshedAuth, 'org-a'), forbidden)
})

void test('native actor resolver scopes switched roots and ordinary admins but preserves home root platform access', async t => {
  const { service, authDb } = await setup(t)
  const issued = await service.issueTokenFromPassword(passwordInput)
  const auth = await service.verifyAccessToken(issued.access_token)
  assert(auth)
  const switched = await service.switchOrg(auth, 'org-b')
  const identity = service.createSudoworkIdentityService({
    legacyJwtSecret: 'legacy-secret',
    tokenStore: { get: async () => null, setex: async () => {}, keys: async () => [], del: async () => {} },
  })
  assert.deepEqual(await identity.getActor(issued.access_token), root)
  assert.deepEqual(await identity.getActor(switched.access_token), { ...root, orgId: 'org-b', organizationScoped: true })
  const refreshed = await service.refreshToken(switched.refresh_token)
  assert.equal((await identity.getActor(refreshed.access_token))?.organizationScoped, true)
  const returned = await service.switchOrg((await service.verifyAccessToken(refreshed.access_token))!, 'org-a')
  assert.equal((await identity.getActor(returned.access_token))?.organizationScoped, undefined)
  await authDb.updateUser('root', { role: 'admin' })
  assert.equal(await identity.getActor(switched.access_token), null)
  assert.deepEqual(await identity.getActor(issued.access_token), { ...scopedRoot, role: 'admin' })
})

void test('new organizations on an upgraded DEFAULT 0 schema still obey the current global cron switch', async t => {
  const previousGlobal = getSystemSettings().clientCronEnabled
  await updateSystemSettings({ clientCronEnabled: false })
  t.after(async () => { await updateSystemSettings({ clientCronEnabled: previousGlobal }) })
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  await authDb.setConfig('issuer', 'moss-cron-test')
  await authDb.setConfig('jwt_secret', 'cron-test-secret')
  await authDb.createOrganization('legacy', 'Legacy Org', 1)
  db.exec(`
    CREATE TABLE organization_profiles (
      org_id TEXT PRIMARY KEY REFERENCES organizations(id),
      code TEXT NOT NULL UNIQUE, login_method TEXT NOT NULL,
      local_enabled INTEGER NOT NULL, cloud_enabled INTEGER NOT NULL,
      logo TEXT, app_name TEXT, top_name TEXT, about_name TEXT,
      app_company_name TEXT, login_description TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO organization_profiles (
      org_id, code, login_method, local_enabled, cloud_enabled, created_at, updated_at
    ) VALUES ('legacy', 'LEGACY', 'password', 1, 1, 1, 1);
  `)
  ensureIdentitySchema(db, { legacyClientCronEnabled: false })
  ensureClientPolicySchema(db)
  ensureCompatibilityCounterTable(db)
  const service = new AuthService(authDb, 3600)
  t.after(() => { service.destroy(); db.close() })
  await service.initializeCompatibilityRecords()
  const identities = new IdentityRepository(authDb.driver)
  assert.equal(db.prepare('PRAGMA table_info(organization_profiles)').all()
    .find(column => column.name === 'client_cron_enabled')?.dflt_value, '0')
  assert.equal((await identities.getOrganizationProfile('legacy'))?.clientCronEnabled, false)
  const created = await service.createOrganization({ name: 'New Org', idempotencyKey: 'cron-new-org' })
  const orgId = created.organization.id
  assert.equal((await identities.getOrganizationProfile(orgId))?.clientCronEnabled, true)
  assert.equal((await service.isOrganizationClientCronEnabled(orgId)), false)
  await updateSystemSettings({ clientCronEnabled: true })
  assert.equal((await service.isOrganizationClientCronEnabled(orgId)), true)
  assert.equal((await service.isOrganizationClientCronEnabled('legacy')), false)
  await identities.setOrganizationClientCronEnabled(orgId, false)
  await identities.putOrganizationProfile({ ...(await identities.getOrganizationProfile(orgId))!, loginMethod: 'cas' })
  assert.equal((await service.isOrganizationClientCronEnabled(orgId)), false)
})
