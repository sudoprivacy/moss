import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { AuthCenterDb } from '../authCenter/db.js'
import { AuthService } from '../auth/service.js'
import { createIdentityTestRepository } from '../testing/compatibilityRepositories.js'
import { OrganizationRouterAdapter } from './organizationRouterAdapter.js'
import { RouterMock } from './testing/routerMock.js'
import { dispatchOrganizationBilling } from './organizationBillingRoutes.js'

void test('native creation, invitation registration, key lifecycle and member route isolation share one organization account', async () => {
  const sqlite = new DatabaseSync(':memory:')
  const db = new AuthCenterDb(sqlite)
  await db.createOrganization('bootstrap', 'Bootstrap', 1)
  await db.setConfig('issuer', 'test'); await db.setConfig('jwt_secret', 'test-secret')
  const identities = createIdentityTestRepository(sqlite, {}, db.driver)
  const auth = new AuthService(db, 3600)
  try {
    await auth.initializeCompatibilityRecords()
    let serviceKey = ''
    Object.assign(auth, { updateOrganizationSystemSettings: async (_org: string, patch: { apiKey: string }) => { serviceKey = patch.apiKey; return {} } })
    const mock = new RouterMock({ adminToken: 'test' })
    const router = new OrganizationRouterAdapter({ baseUrl: 'http://mock', apiToken: 'test', adminUserId: '1', fetch: mock.fetch })
    const secrets = new Map<string, string>()
    const secretPort = {
      putSecret: async (_ns: string, key: string, value: string) => { secrets.set(key, value) },
      getSecret: async (_ns: string, key: string) => { const value = secrets.get(key); return value ? { value, status: 'enabled', version: 1 } : null },
    }
    const billing = await auth.configureOrganizationBilling(router, secretPort)
    const org = (await auth.createOrganization({ name: 'Shared', code: 'shared', idempotencyKey: 'create-org', modelBilling: { initialAmountUsd: '20', defaultMemberLimitUsd: '3' } })).organization
    assert.equal((await billing.account(org.id))?.status, 'ready')
    await assert.rejects(auth.deleteOrganization({ orgId: org.id }), /模型账户及资金记录/)
    assert.ok(await db.getOrganization(org.id), 'deletion guard preserves the funded organization')
    const input = { orgId: org.id, name: 'Admin Example', password: 'Password123', role: 'admin', memberLimitUsd: null, idempotencyKey: 'admin-example' }
    const admin = (await auth.createProvisionedUser(input)).user
    assert.equal((await auth.createProvisionedUser(input)).user.id, admin.id)
    await assert.rejects(auth.createProvisionedUser({ ...input, memberLimitUsd: '99' }), /操作标识/)
    assert.notEqual((await auth.getUserModelCredential(admin.id))?.sudorouterKey, serviceKey)
    const legacyCredential = { sudorouterUserId: 'historical-personal-account', sudorouterKey: 'sk-historical-personal' }
    await db.setUserModelCredential(admin.id, legacyCredential)
    assert.deepEqual(await auth.getLegacyUserModelCredential(admin.id), legacyCredential, 'historical orders keep their personal recipient')
    assert.notEqual((await auth.getUserModelCredential(admin.id))?.sudorouterUserId, legacyCredential.sudorouterUserId)
    assert.equal('balanceUnits' in (await auth.listUsers(org.id)).users[0]!, false, 'shared users expose no personal points')
    const adminActor = { userId: admin.id, orgId: org.id }
    assert.equal((await billing.dashboard(adminActor)).can_recharge, false, 'unconfigured payment stays hidden')
    const payment = { simulationEnabled: false, createPayment: async () => ({ qrCodeUrl: 'test', orderInfo: 'test' }), verifyCallback: async () => { throw new Error('test only') }, queryPayment: async () => ({ status: 'PENDING' }) }
    auth.configureOrganizationRecharge(payment, true)
    assert.equal((await billing.dashboard(adminActor)).can_recharge, true)
    auth.configureOrganizationRecharge(payment, false)
    assert.equal((await billing.dashboard(adminActor)).can_recharge, false)
    const organizationIdentity = auth.createOrganizationIdentityService()
    await organizationIdentity.createInvitations({ orgId: org.id, count: 1, initialCreditUnits: 999999 }, () => 'ABCDEF')
    const tokens = new Map<string, string>()
    const identity = auth.createSudoworkIdentityService({
      tokenStore: { setex: async (k, _seconds, v) => { tokens.set(k, v) }, get: async k => tokens.get(k) ?? null, keys: async () => [...tokens.keys()], del: async (...keys) => { keys.forEach(k => tokens.delete(k)) } },
      legacyJwtSecret: 'legacy-test', getLoginMethod: () => 'password',
      accountProvisioner: { ensureAccount: request => billing.provisionMemberAccount(request.orgId, request.ownerId) },
    })
    const session = await identity.registerByPassword({ phone: '13800001111', password: 'Password123', nickname: 'Member', invitationCode: 'ABCDEF', idempotencyKey: 'register-member' })
    const alias = await identities.resolveNumericAliasGlobal('user', session.user.id)
    const memberId = alias!.resourceId
    const member = (await billing.token(org.id, memberId))!
    assert.equal(member.initial_quota, 1_500_000, 'untrusted invitation gift cannot grant a member higher model limit')
    assert.equal((await identities.getWallet('user', memberId))!.balanceUnits, 0)
    assert.equal(mock.snapshot().accounts.length, 1)
    const actor = { userId: memberId, orgId: org.id }
    const denied = await dispatchOrganizationBilling(billing, actor, 'GET', new URL('http://moss/api/v1/model-account/members'), {})
    assert.equal(denied.status, 403)
    const own = await dispatchOrganizationBilling(billing, actor, 'GET', new URL('http://moss/api/v1/model-account'), {})
    assert.equal(own.status, 200)
    assert.equal(JSON.stringify(own.body).includes('model_balance_usd'), false)
    await auth.updateUser({ orgId: org.id, userId: memberId, status: 'disabled' })
    assert.equal((await router.listTokens(member.router_user_id, member.router_token_id!))[0]!.admin_status, 'disabled')
    assert.equal(await auth.getUserModelCredential(memberId), null)
    await assert.rejects(billing.setMemberStatus({ userId: admin.id, orgId: org.id }, memberId, 'enabled', 'inactive-enable'))
    await auth.updateUser({ orgId: org.id, userId: memberId, status: 'active' })
    assert.equal(await auth.getUserModelCredential(memberId), null, 'reactivating identity cannot silently undo a Key suspension')
    await billing.setMemberStatus({ userId: admin.id, orgId: org.id }, memberId, 'enabled', 'active-enable')
    assert.ok(await auth.getUserModelCredential(memberId))
  } finally { auth.destroy(); sqlite.close() }
})
