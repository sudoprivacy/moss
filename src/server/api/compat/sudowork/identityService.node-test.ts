import assert from 'node:assert/strict'
import { hashSync } from 'bcryptjs'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb, type AuthCenterUser } from '../../../authCenter/db.js'
import { IdentityRepository } from '../../../identity/identityRepository.js'
import type { IdentityActor } from '../../../identity/organizationIdentityService.js'
import { verifyLegacyJwt, type LegacyKeyValueStore } from '../../../identity/legacyToken.js'
import type { EnsureSudorouterAccountInput } from '../../../billing/sudorouterAccountService.js'
import {
  SudoworkIdentityError,
  SudoworkIdentityService,
} from './identityService.js'

class MemoryTokenStore implements LegacyKeyValueStore {
  readonly values = new Map<string, string>()
  readonly ttls = new Map<string, number>()

  async setex(key: string, seconds: number, value: string): Promise<void> {
    this.values.set(key, value)
    this.ttls.set(key, seconds)
  }

  async keys(pattern: string): Promise<string[]> {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
    const matcher = new RegExp(`^${escaped}$`)
    return [...this.values.keys()].filter((key) => matcher.test(key))
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) {
      this.values.delete(key)
      this.ttls.delete(key)
    }
  }

  async rotate(oldKey: string, newKey: string, seconds: number, value: string): Promise<boolean> {
    if (!this.values.has(oldKey)) return false
    await this.del(oldKey)
    await this.setex(newKey, seconds, value)
    return true
  }
}

class RecordingAccountProvisioner {
  calls: Array<{ input: EnsureSudorouterAccountInput; key: string }> = []
  failuresRemaining = 0
  async ensureAccount(input: EnsureSudorouterAccountInput, context: { idempotencyKey: string }) {
    this.calls.push({ input, key: context.idempotencyKey })
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      throw new Error('temporary provider failure')
    }
    return {
      externalUserId: '91', token: 'sk-user-91',
      tokenSecretRef: `nexus://moss:sudorouter-users/${input.ownerId}`,
      quotaUnits: input.initialQuotaUnits, usedQuotaUnits: 0,
    }
  }
}

function setup(
  status: AuthCenterUser['status'] = 'active',
  role = 'user',
  nativeActorResolver?: (token: string) => IdentityActor | null,
) {
  const db = new DatabaseSync(':memory:')
  const authDb = new AuthCenterDb(db)
  const identities = new IdentityRepository(db)
  const tokens = new MemoryTokenStore()
  const accounts = new RecordingAccountProvisioner()
  authDb.createOrganization('org-a', '企业 A', 1)
  identities.putOrganizationProfile({
    orgId: 'org-a',
    code: 'ENT-A',
    loginMethod: 'password',
    localEnabled: true,
    cloudEnabled: true,
  })
  identities.assignNumericAlias({
    namespace: 'enterprise', legacyId: 9, resourceId: 'org-a', orgId: 'org-a',
  })
  const legacyHash = hashSync('StrongPass123', 4)
  authDb.createUser({
    id: 'user-a', orgId: 'org-a', email: 'user-a@users.internal.moss', name: 'legacy-account',
    displayName: '旧用户', departmentId: null, role, status, localAuth: true,
    tokenLimit: null, createdAt: 1, passwordHash: legacyHash, passwordUpdatedAt: null,
    lastLoginAt: null, extUserId: null,
  })
  identities.createAuthIdentity({
    id: 'phone-a', orgId: 'org-a', userId: 'user-a', provider: 'phone', issuer: 'sudowork',
    normalizedSubject: '13800000000', metadata: {},
  })
  identities.assignNumericAlias({
    namespace: 'user', legacyId: 17, resourceId: 'user-a', orgId: 'org-a',
  })
  const service = new SudoworkIdentityService({
    authDb,
    identities,
    tokenStore: tokens,
    legacyJwtSecret: 'legacy-production-secret',
    nativeActorResolver,
    refreshTokenFactory: () => 'refresh-one',
    registrationTokenFactory: () => 'register-one',
    accountProvisioner: accounts,
  })
  return { db, authDb, tokens, accounts, service, legacyHash }
}

describe('Sudowork unified identity service', () => {
  test('logs in an active migrated user with the legacy token and refresh-token contract', async () => {
    const { db, authDb, tokens, service, legacyHash } = setup()

    const session = await service.loginByPassword({
      phone: '13800000000', password: 'StrongPass123', deviceId: 'desktop-a', nowSeconds: 1_000,
    })

    assert.deepEqual(session.user, {
      id: 17,
      phone: '13800000000',
      nickname: '旧用户',
      role: 'USER',
      status: 1,
      enterpriseId: 9,
      enterpriseCode: 'ENT-A',
    })
    assert.equal(session.refreshToken, 'refresh-one')
    assert.equal(session.expiresIn, 7_200)
    assert.deepEqual(verifyLegacyJwt(session.accessToken, 'legacy-production-secret', 1_001), {
      id: 17, phone: '13800000000', role: 'USER', enterprise_id: 9, iat: 1_000, exp: 8_200,
    })
    assert.deepEqual(verifyLegacyJwt(session.legacyToken, 'legacy-production-secret', 1_001), {
      id: 17, phone: '13800000000', role: 'USER', enterprise_id: 9,
      iat: 1_000, exp: 2_593_000,
    })
    assert.equal(tokens.ttls.get('refresh_token:17:desktop-a:refresh-one'), 30 * 24 * 60 * 60)
    assert.deepEqual(
      JSON.parse(tokens.values.get('refresh_token:17:desktop-a:refresh-one') ?? ''),
      { phone: '13800000000', role: 'USER', enterprise_id: 9 },
    )
    const updated = authDb.getUserById('user-a')
    assert.notEqual(updated?.passwordHash, legacyHash)
    assert.match(updated?.passwordHash ?? '', /^scrypt\$/)
    assert(updated?.lastLoginAt)
    db.close()
  })

  test('uses the legacy generic credential error and disabled-state response', async () => {
    const wrong = setup()
    await assert.rejects(
      wrong.service.loginByPassword({ phone: '13800000000', password: 'wrong', deviceId: 'default' }),
      (error: unknown) => error instanceof SudoworkIdentityError
        && error.statusCode === 401
        && error.message === '账号或密码错误',
    )
    assert.equal(wrong.authDb.getUserById('user-a')?.passwordHash, wrong.legacyHash)
    wrong.db.close()

    for (const status of ['pending', 'locked', 'disabled'] as const) {
      const current = setup(status)
      await assert.rejects(
        current.service.loginByPassword({
          phone: '13800000000', password: 'StrongPass123', deviceId: 'default',
        }),
        (error: unknown) => error instanceof SudoworkIdentityError
          && error.statusCode === 403
          && error.message === '该账户已被禁用，请联系管理员',
      )
      current.db.close()
    }
  })

  test('rotates an existing legacy refresh token and rejects a wrong device', async () => {
    const { db, tokens, service } = setup()
    await tokens.setex(
      'refresh_token:17:desktop-a:refresh-old',
      30 * 24 * 60 * 60,
      JSON.stringify({ phone: '13800000000', role: 'USER', enterprise_id: 9 }),
    )

    const refreshed = await service.refresh({
      refreshToken: 'refresh-old', deviceId: 'desktop-a', nowSeconds: 2_000,
    })
    assert.equal(refreshed.refreshToken, 'refresh-one')
    assert.deepEqual(verifyLegacyJwt(refreshed.accessToken, 'legacy-production-secret', 2_001), {
      id: 17, phone: '13800000000', role: 'USER', enterprise_id: 9, iat: 2_000, exp: 9_200,
    })
    assert.equal(tokens.values.has('refresh_token:17:desktop-a:refresh-old'), false)

    await assert.rejects(
      service.refresh({ refreshToken: 'refresh-one', deviceId: 'other-device' }),
      (error: unknown) => error instanceof SudoworkIdentityError
        && error.statusCode === 401
        && error.message === 'refresh_token 无效或已过期',
    )
    db.close()
  })

  test('resolves a legacy access token to the unified profile and revokes sessions', async () => {
    const { db, tokens, service } = setup()
    const session = await service.loginByPassword({
      phone: '13800000000', password: 'StrongPass123', deviceId: 'desktop-a', nowSeconds: 1_000,
    })
    await tokens.setex(
      'refresh_token:17:desktop-b:refresh-two',
      30 * 24 * 60 * 60,
      JSON.stringify({ phone: '13800000000', role: 'USER', enterprise_id: 9 }),
    )

    assert.deepEqual(service.getProfile(session.accessToken, 1_001), session.user)
    assert.equal(service.getProfile(`${session.accessToken}x`, 1_001), null)

    await service.logout({ refreshToken: 'refresh-one', deviceId: 'desktop-a' })
    assert.equal(tokens.values.has('refresh_token:17:desktop-a:refresh-one'), false)
    assert.equal(tokens.values.has('refresh_token:17:desktop-b:refresh-two'), true)

    await service.logout({ accessToken: session.accessToken, all: true, nowSeconds: 1_001 })
    assert.equal(tokens.values.has('refresh_token:17:desktop-b:refresh-two'), false)
    db.close()
  })

  test('registers a new password user through the unified command and consumes the invitation', async () => {
    const { db, authDb, tokens, accounts, service } = setup()
    const identities = new IdentityRepository(db)
    identities.createInvitation({
      id: 'invite-b', orgId: 'org-a', code: 'INVITE-B', initialCreditUnits: 42,
    })

    const session = await service.registerByPassword({
      phone: 'new-user',
      password: 'StrongPass456',
      nickname: '新用户',
      invitationCode: 'INVITE-B',
      deviceId: 'desktop-b',
      idempotencyKey: 'registration:new-user',
    })

    const identity = identities.findAuthIdentity('phone', 'sudowork', 'new-user')
    assert(identity)
    const created = authDb.getUserById(identity.userId)
    assert.equal(created?.name, 'new-user')
    assert.equal(created?.displayName, '新用户')
    assert.equal(created?.orgId, 'org-a')
    assert.equal(identities.getInvitationByCode('INVITE-B')?.status, 'used')
    assert.equal(identities.getWallet('user', identity.userId)?.balanceUnits, 42)
    assert.equal(session.user.id, identities.getNumericAlias('user', identity.userId))
    assert.equal(tokens.values.has(`refresh_token:${session.user.id}:desktop-b:refresh-one`), true)
    assert.equal(accounts.calls.length, 1)
    assert.deepEqual(accounts.calls[0]?.input, {
      ownerId: identity.userId, orgId: 'org-a', username: 'new-user',
      displayName: '新用户', initialQuotaUnits: 21_000,
    })
    assert.equal(accounts.calls[0]?.key, 'sudorouter:registration:new-user')
    db.close()
  })

  test('邀请码注册开户失败后复用同一 pending 用户恢复', async () => {
    const { db, authDb, accounts, service } = setup()
    const identities = new IdentityRepository(db)
    identities.createInvitation({
      id: 'invite-retry', orgId: 'org-a', code: 'INVITE-RETRY', initialCreditUnits: 42,
    })
    accounts.failuresRemaining = 1
    const input = {
      phone: 'retry-user', password: 'StrongPass456', nickname: '恢复用户',
      invitationCode: 'INVITE-RETRY', deviceId: 'desktop-b', idempotencyKey: 'registration:retry-user',
    }

    await assert.rejects(service.registerByPassword(input), /Sudorouter 用户初始化失败/)
    const pendingIdentity = identities.findAuthIdentity('phone', 'sudowork', 'retry-user')
    assert(pendingIdentity)
    assert.equal(authDb.getUserById(pendingIdentity.userId)?.status, 'pending')
    assert.equal(identities.getInvitationByCode('INVITE-RETRY')?.status, 'used')

    const recovered = await service.registerByPassword(input)
    assert.equal(recovered.user.status, 1)
    assert.equal(authDb.listUsersByOrg('org-a').filter(item => item.name === 'retry-user').length, 1)
    assert.equal(accounts.calls.length, 2)
    db.close()
  })

  test('preserves password registration validation messages', async () => {
    const { db, service } = setup()
    await assert.rejects(
      service.registerByPassword({
        phone: 'new-user', password: 'weak', nickname: '新用户',
        invitationCode: 'missing', deviceId: 'default',
      }),
      (error: unknown) => error instanceof SudoworkIdentityError
        && error.statusCode === 400
        && error.message === '密码长度不能少于 8 位',
    )
    await assert.rejects(
      service.registerByPassword({
        phone: 'new-user', password: 'StrongPass456', nickname: '新用户',
        invitationCode: 'missing', deviceId: 'default',
      }),
      (error: unknown) => error instanceof SudoworkIdentityError
        && error.statusCode === 400
        && error.message === '邀请码不存在',
    )
    db.close()
  })

  test('keeps the two-stage verified-phone registration protocol on unified users', async () => {
    const { db, authDb, tokens, accounts, service } = setup()
    const identities = new IdentityRepository(db)
    identities.createInvitation({
      id: 'invite-phone', orgId: 'org-a', code: 'PHONE-INVITE', initialCreditUnits: 7,
    })

    const unknown = await service.loginByVerifiedPhone({
      phone: '13900000000', deviceId: 'phone-a',
    })
    assert.deepEqual(unknown, {
      needRegistration: true,
      registerToken: 'register-one',
      phone: '13900000000',
    })
    assert(tokens.values.has('register_token:register-one'))

    const registered = await service.registerByVerifiedPhone({
      registerToken: 'register-one',
      nickname: '手机用户',
      invitationCode: 'PHONE-INVITE',
      deviceId: 'phone-a',
      idempotencyKey: 'phone-registration:13900000000',
    })
    const identity = identities.findAuthIdentity('phone', 'sudowork', '13900000000')
    assert(identity)
    assert.equal(authDb.getUserById(identity.userId)?.localAuth, false)
    assert.equal(registered.needRegistration, false)
    assert.equal(registered.session.user.phone, '13900000000')
    assert.equal(tokens.values.has('register_token:register-one'), false)
    assert.equal(accounts.calls.length, 1)
    assert.equal(accounts.calls[0]?.input.initialQuotaUnits, 3_500)
    db.close()
  })

  test('uses unified users for legacy admin login and password changes', async () => {
    const regular = setup('active', 'user')
    await assert.rejects(
      regular.service.loginAdminByPassword({
        phone: '13800000000', password: 'StrongPass123', deviceId: 'admin-a',
      }),
      (error: unknown) => error instanceof SudoworkIdentityError
        && error.statusCode === 404 && error.message === '账号不存在',
    )
    regular.db.close()

    const admin = setup('active', 'admin')
    await assert.rejects(
      admin.service.loginAdminByPassword({
        phone: '13800000000', password: 'wrong', deviceId: 'admin-a',
      }),
      (error: unknown) => error instanceof SudoworkIdentityError
        && error.statusCode === 401 && error.message === '密码错误',
    )
    const session = await admin.service.loginAdminByPassword({
      phone: '13800000000', password: 'StrongPass123', deviceId: 'admin-a',
    })
    assert.equal(session.user.role, 'ENTERPRISE_ADMIN')
    assert.deepEqual(admin.service.getActor(session.accessToken), {
      userId: 'user-a', orgId: 'org-a', role: 'admin',
    })

    await admin.service.changePassword({
      accessToken: session.accessToken,
      oldPassword: 'StrongPass123',
      newPassword: 'AnotherPass456',
      oldPasswordError: '旧密码错误',
    })
    await assert.rejects(
      admin.service.loginAdminByPassword({
        phone: '13800000000', password: 'StrongPass123', deviceId: 'admin-a',
      }),
      (error: unknown) => error instanceof SudoworkIdentityError && error.statusCode === 401,
    )
    const relogin = await admin.service.loginAdminByPassword({
      phone: '13800000000', password: 'AnotherPass456', deviceId: 'admin-a',
    })
    assert.equal(relogin.user.id, 17)
    assert.deepEqual(admin.service.updateProfile(session.accessToken, ' 新昵称 '), {
      ...session.user,
      nickname: '新昵称',
    })
    admin.db.close()
  })

  test('accepts a valid Moss access token without changing legacy JWT behavior', async () => {
    const nativeActor: IdentityActor = {
      userId: 'user-a', orgId: 'org-a', role: 'admin',
    }
    const { db, service } = setup(
      'active',
      'admin',
      token => token === 'moss-access-token' ? nativeActor : null,
    )

    assert.deepEqual(service.getActor('moss-access-token'), nativeActor)
    assert.equal(service.getActor('invalid-token'), null)

    const session = await service.loginAdminByPassword({
      phone: '13800000000', password: 'StrongPass123', deviceId: 'admin-native-test',
    })
    assert.deepEqual(service.getActor(session.accessToken), nativeActor)
    db.close()
  })
})
