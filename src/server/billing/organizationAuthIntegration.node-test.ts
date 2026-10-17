import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { AuthCenterDb } from '../authCenter/db.js'
import { AuthService, AuthServiceError } from '../auth/service.js'
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

void test('shared member admission refuses a disabled account and waits for usable credentials before login', { timeout: 30_000 }, async () => {
  const sqlite = new DatabaseSync(':memory:')
  const db = new AuthCenterDb(sqlite)
  createIdentityTestRepository(sqlite, {}, db.driver)
  const auth = new AuthService(db, 3600)
  let releaseToken = () => {}
  let provisioning: ReturnType<AuthService['createProvisionedUser']> | undefined
  try {
    await db.createOrganization('bootstrap', 'Bootstrap', 1)
    await db.setConfig('issuer', 'test'); await db.setConfig('jwt_secret', 'test-secret')
    await auth.initializeCompatibilityRecords()
    Object.assign(auth, { updateOrganizationSystemSettings: async () => ({}) })
    const mock = new RouterMock({ adminToken: 'test' })
    let tokenGate: { entered: () => void; wait: Promise<void> } | undefined
    let loseTokenResponse = false
    const router = new OrganizationRouterAdapter({ baseUrl: 'http://mock', apiToken: 'test', adminUserId: '1', fetch: async (input, init) => {
      if (tokenGate && String(input).endsWith('/api/token/') && init?.method === 'POST') {
        const gate = tokenGate
        tokenGate = undefined
        gate.entered()
        await gate.wait
      }
      const response = await mock.fetch(input, init)
      if (loseTokenResponse && String(input).endsWith('/api/token/') && init?.method === 'POST') {
        loseTokenResponse = false
        throw new Error('The member credential response was lost after the gateway write')
      }
      return response
    } })
    const values = new Map<string, string>()
    const billing = await auth.configureOrganizationBilling(router, {
      putSecret: async (_namespace, key, value) => { values.set(key, value) },
      getSecret: async (_namespace, key) => { const value = values.get(key); return value ? { value, status: 'enabled', version: 1 } : null },
    })
    const org = (await auth.createOrganization({ name: 'Admission', code: 'admission', idempotencyKey: 'admission-org', modelBilling: { initialAmountUsd: '1', defaultMemberLimitUsd: '0.05' } })).organization
    const admin = (await auth.createProvisionedUser({ orgId: org.id, name: 'Admission Admin', role: 'admin', password: 'Password123', idempotencyKey: 'admission-admin' })).user
    const actor = { userId: admin.id, orgId: org.id }
    const input = { orgId: org.id, name: 'Admission Member', role: 'user', password: 'Password123', memberLimitUsd: '0.05', idempotencyKey: 'admission-member' }
    await billing.setAccountStatus(actor, 'disabled', 'admission-pause')
    const before = mock.snapshot()
    await assert.rejects(auth.createProvisionedUser(input), error => error instanceof AuthServiceError && error.statusCode === 409)
    assert.deepEqual(await db.listUsersByName(input.name), [], 'an unavailable model account must not create an identity')
    assert.deepEqual(mock.snapshot(), before, 'rejected member admission performs no gateway writes')
    await billing.setAccountStatus(actor, 'enabled', 'admission-resume')
    let tokenEntered = () => {}
    const entered = new Promise<void>(resolve => { tokenEntered = resolve })
    const wait = new Promise<void>(resolve => { releaseToken = resolve })
    tokenGate = { entered: tokenEntered, wait }
    provisioning = auth.createProvisionedUser(input)
    await Promise.race([entered, provisioning.then(() => { throw new Error('member creation must wait for its model credential') })])
    const pending = (await db.listUsersByName(input.name))[0]!
    assert.equal(pending.status, 'pending')
    await assert.rejects(auth.issueMossTokenFromPassword({ username: input.name, password: input.password }), error => error instanceof AuthServiceError && error.statusCode === 401)
    releaseToken()
    const created = (await provisioning).user
    assert.equal(created.id, pending.id)
    assert.equal(created.status, 'active')
    assert.ok(await auth.getUserModelCredential(created.id))
    assert.ok((await auth.issueMossTokenFromPassword({ username: input.name, password: input.password })).access_token)
    const tokens = mock.snapshot().tokens.length
    const repeated = (await auth.createProvisionedUser(input)).user
    assert.equal(repeated.id, created.id)
    assert.equal(repeated.status, 'active')
    assert.equal(mock.snapshot().tokens.length, tokens, 'idempotent retries retain the original member credential')
    assert.equal((await db.listUsersByName(input.name)).length, 1)
    const interruptedInput = { ...input, name: 'Admission Retry', idempotencyKey: 'admission-retry' }
    loseTokenResponse = true
    await assert.rejects(auth.createProvisionedUser(interruptedInput))
    const interrupted = (await db.listUsersByName(interruptedInput.name))[0]!
    assert.equal(interrupted.status, 'pending')
    await assert.rejects(auth.issueMossTokenFromPassword({ username: interruptedInput.name, password: input.password }), error => error instanceof AuthServiceError && error.statusCode === 401)
    const written = mock.snapshot().tokens.length
    const reviewed = await billing.reconcileMemberToken(actor, interrupted.id, 'admission-review-lost-response')
    assert.equal(reviewed.provisioning_status, 'ready')
    const recovered = (await auth.createProvisionedUser(interruptedInput)).user
    assert.equal(recovered.id, interrupted.id)
    assert.equal(recovered.status, 'active')
    assert.equal(mock.snapshot().tokens.length, written, 'review and retry must retain the credential already written upstream')
    await auth.updateUser({ orgId: org.id, userId: recovered.id, status: 'disabled' })
    await assert.rejects(auth.createProvisionedUser(interruptedInput), error => error instanceof AuthServiceError && error.statusCode === 403)
    assert.equal((await db.getUserById(recovered.id))!.status, 'disabled', 'a cached creation result must not reactivate a disabled member')
  } finally {
    releaseToken()
    await provisioning?.catch(() => {})
    auth.destroy(); sqlite.close()
  }
})
