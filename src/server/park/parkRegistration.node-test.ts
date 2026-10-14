import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { createCatalogTestRepository, createIdentityTestRepository } from '../testing/compatibilityRepositories.js'
import { ensureIdentitySchema } from '../identity/identityRepository.js'
import { SqliteDriver } from '../db/driver.js'
import { DirectConnectStore } from '../db.js'
import { ensureParkSchema } from './parkSchema.js'
import { ParkRegistrationService } from './parkRegistrationService.js'
import { ParkRepository } from './parkRepository.js'
import { ParkApiError } from './parkAuthorization.js'
import { AuthService } from '../auth/service.js'

/**
 * 注册链路测试（计划 5.3 parkRegistration）：
 * prospect 创建 / 邀请码绑定对应园区 / 默认园区 / 手机号重复。
 * AuthService 以桩替身注入（注册服务只依赖 phoneAuth.verifyCode /
 * findUserByPhone / createOrganization / createUser 四个接缝）。
 */

function stubAuthService(db: DatabaseSync, overrides: {
  existingPhone?: string | null
  codeValid?: boolean
  failCreateUser?: boolean
} = {}): AuthService {
  let orgSeq = 0
  let userSeq = 0
  return {
    phoneAuth: {
      verifyCode: async () => overrides.codeValid ?? true,
    },
    findUserByPhone: async (phone: string) =>
      overrides.existingPhone === phone
        ? ({ id: 'u-existing', orgId: 'some-org' } as never)
        : null,
    createOrganization: async (input: { name: string }) => {
      orgSeq += 1
      const id = `ent-org-${orgSeq}`
      db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)').run(id, input.name, Date.now())
      return { organization: { id, name: input.name, userCount: 0, departmentCount: 0 } }
    },
    createUser: async (input: { orgId: string; phone?: string; name: string }) => {
      if (overrides.failCreateUser) throw new Error('createUser failed')
      userSeq += 1
      const id = `u-${userSeq}`
      db.prepare(`
        INSERT INTO users (id, org_id, email, name, role, status, local_auth, created_at)
        VALUES (?, ?, ?, ?, 'user', 'active', 1, ?)
      `).run(id, input.orgId, `${id}@test`, input.name, Date.now())
      return { user: { id, name: input.name, orgId: input.orgId } }
    },
    putOrganizationClientPolicy: async (_orgId: string, patch: Record<string, unknown>) => patch,
  } as unknown as AuthService
}

async function setup(): Promise<{ db: DatabaseSync; teardown: () => Promise<void> }> {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=OFF')
  new AuthCenterDb(db)
  ensureIdentitySchema(db)
  createCatalogTestRepository(db)
  ensureParkSchema(db)
  return { db, teardown: () => Promise.resolve(db.close()) }
}

void describe('parkRegistration（prospect 注册链路）', () => {
  void test('默认园区注册：创建 enterprise org + 用户 + prospect 绑定 + 审计', async () => {
    const ctx = await setup()
    const root = await mkdtemp(join(tmpdir(), 'moss-park-reg-'))
    try {
      ctx.db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('park-org', '园区', 1)").run()
      const driver = new SqliteDriver(ctx.db)
      const repo = new ParkRepository(driver)
      await repo.upsertOrgProfile({ mossOrgId: 'park-org', orgType: 'park', displayName: '园区', isDefaultPark: true })

      const service = new ParkRegistrationService(driver, stubAuthService(ctx.db))
      const result = await service.registerEnterprise({
        phone: '13800000001', smsCode: '123456',
        enterpriseName: '星澜智能', contactName: '张三',
      })
      assert.equal(result.park_org_id, 'park-org', '绑定默认园区')

      const profile = await repo.getEnterpriseProfile(result.enterprise_org_id)
      assert.ok(profile, '企业档案已建')
      assert.equal(profile!.enterpriseName, '星澜智能')

      const binding = await repo.getBinding('park-org', result.enterprise_org_id)
      assert.equal(binding?.lifecycle, 'prospect', 'prospect 生命周期')

      const audits = await repo.listAuditEvents({ parkOrgId: 'park-org' })
      assert.ok(audits.some(e => e.action === 'park.register_enterprise'), '注册有审计')
    } finally {
      await ctx.teardown()
      await rm(root, { recursive: true, force: true })
    }
  })

  void test('ParkRateLimiter 固定窗口与注册端点限流（计划 2.6 #1：模块内限流）', async () => {
    const ctx = await setup()
    const root = await mkdtemp(join(tmpdir(), 'moss-park-reg-'))
    try {
      ctx.db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('park-org', '园区', 1)").run()
      const driver = new SqliteDriver(ctx.db)
      const repo = new ParkRepository(driver)
      await repo.upsertOrgProfile({ mossOrgId: 'park-org', orgType: 'park', displayName: '园区', isDefaultPark: true })

      const { ParkRateLimiter } = await import('./parkRateLimit.js')
      const limiter = new ParkRateLimiter(15 * 60_000, 3)
      assert.equal(limiter.check('ip-a'), true)
      assert.equal(limiter.check('ip-a'), true)
      assert.equal(limiter.check('ip-a'), true)
      assert.equal(limiter.check('ip-a'), false, '窗口内超限拒绝')
      assert.equal(limiter.check('ip-b'), true, '不同 key 独立计数')

      const { handleParkEnterpriseRegister } = await import('./parkRoutes.js')
      const authService = stubAuthService(ctx.db)
      const call = (clientIp: string, seq: number) => handleParkEnterpriseRegister(
        { driver, authService, clientIp, rateLimiter: limiter },
        { phone: `1390000000${seq}`, sms_code: '123456', enterprise_name: `限流企业${seq}`, contact_name: '联系人' },
      )
      for (let seq = 0; seq < 3; seq++) {
        const allowed = await call('9.9.9.9', seq)
        assert.equal(allowed?.status, 200, `同 IP 第 ${seq + 1} 次注册放行`)
      }
      const blocked = await call('9.9.9.9', 9)
      assert.equal(blocked?.status, 429, '同 IP 第 4 次 429')
      assert.equal((blocked?.body as { error?: { code?: string } }).error?.code, 'rate_limited')
      const otherIp = await call('8.8.8.8', 8)
      assert.equal(otherIp?.status, 200, '不同 IP 不受影响')
    } finally {
      await ctx.teardown()
      await rm(root, { recursive: true, force: true })
    }
  })

  void test('邀请码注册：绑定邀请所属园区（invitations.org_id）', async () => {
    const ctx = await setup()
    const root = await mkdtemp(join(tmpdir(), 'moss-park-reg-'))
    try {
      for (const orgId of ['park-default', 'park-invite']) {
        ctx.db.prepare("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, 1)").run(orgId, orgId)
      }
      const driver = new SqliteDriver(ctx.db)
      const repo = new ParkRepository(driver)
      await repo.upsertOrgProfile({ mossOrgId: 'park-default', orgType: 'park', displayName: '默认园区', isDefaultPark: true })
      await repo.upsertOrgProfile({ mossOrgId: 'park-invite', orgType: 'park', displayName: '邀请园区' })
      ctx.db.prepare(
        "INSERT INTO invitations (id, org_id, code, status, initial_credit_units, created_at) VALUES ('inv-1', 'park-invite', 'INVITE1', 'pending', 0, 1)",
      ).run()

      const service = new ParkRegistrationService(driver, stubAuthService(ctx.db))
      const result = await service.registerEnterprise({
        phone: '13800000002', smsCode: '123456',
        enterpriseName: '沐芯科技', contactName: '李四',
        inviteToken: 'INVITE1',
      })
      assert.equal(result.park_org_id, 'park-invite', '邀请码园区优先于默认园区')
      const consumed = ctx.db.prepare("SELECT status, used_by_user_id FROM invitations WHERE id = 'inv-1'").get() as { status: string; used_by_user_id: string }
      assert.equal(consumed.status, 'used')
      assert.equal(consumed.used_by_user_id, result.user_id)
      await assert.rejects(
        service.registerEnterprise({ phone: '13800000006', smsCode: '123456', enterpriseName: '重复注册', contactName: '王五', inviteToken: 'INVITE1' }),
        (err: unknown) => err instanceof ParkApiError && err.code === 'invite_invalid',
      )
      assert.equal((ctx.db.prepare("SELECT COUNT(*) AS count FROM organizations WHERE name = '重复注册'").get() as { count: number }).count, 0)
    } finally {
      await ctx.teardown()
      await rm(root, { recursive: true, force: true })
    }
  })

  void test('非园区邀请码被拒；用户创建失败时组织与邀请码状态回滚', async () => {
    const ctx = await setup()
    try {
      for (const orgId of ['park-org', 'ordinary-org']) {
        ctx.db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, 1)').run(orgId, orgId)
      }
      const driver = new SqliteDriver(ctx.db)
      const repo = new ParkRepository(driver)
      await repo.upsertOrgProfile({ mossOrgId: 'park-org', orgType: 'park', displayName: '园区', isDefaultPark: true })
      await repo.upsertOrgProfile({ mossOrgId: 'ordinary-org', orgType: 'enterprise', displayName: '普通组织' })
      ctx.db.prepare("INSERT INTO invitations (id, org_id, code, status, initial_credit_units, created_at) VALUES ('inv-bad', 'ordinary-org', 'NOTPARK', 'pending', 0, 1)").run()
      ctx.db.prepare("INSERT INTO invitations (id, org_id, code, status, initial_credit_units, created_at) VALUES ('inv-good', 'park-org', 'PARKCODE', 'pending', 0, 1)").run()

      const service = new ParkRegistrationService(driver, stubAuthService(ctx.db))
      await assert.rejects(
        service.registerEnterprise({ phone: '13800000007', smsCode: '123456', enterpriseName: '错误邀请企业', contactName: '甲', inviteToken: 'NOTPARK' }),
        (err: unknown) => err instanceof ParkApiError && err.code === 'invite_invalid',
      )
      const failing = new ParkRegistrationService(driver, stubAuthService(ctx.db, { failCreateUser: true }))
      await assert.rejects(
        failing.registerEnterprise({ phone: '13800000008', smsCode: '123456', enterpriseName: '回滚企业', contactName: '乙', inviteToken: 'PARKCODE' }),
        /createUser failed/,
      )
      assert.equal((ctx.db.prepare("SELECT COUNT(*) AS count FROM organizations WHERE name = '回滚企业'").get() as { count: number }).count, 0)
      assert.equal((ctx.db.prepare("SELECT status FROM invitations WHERE id = 'inv-good'").get() as { status: string }).status, 'pending')
    } finally {
      await ctx.teardown()
    }
  })

  void test('验证码错误 → 401；手机号已注册 → 409；无默认园区 → 409', async () => {
    const ctx = await setup()
    const root = await mkdtemp(join(tmpdir(), 'moss-park-reg-'))
    try {
      ctx.db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('park-org', '园区', 1)").run()
      const driver = new SqliteDriver(ctx.db)
      const repo = new ParkRepository(driver)
      await repo.upsertOrgProfile({ mossOrgId: 'park-org', orgType: 'park', displayName: '园区', isDefaultPark: true })

      const badCode = new ParkRegistrationService(driver, stubAuthService(ctx.db, { codeValid: false }))
      await assert.rejects(
        badCode.registerEnterprise({ phone: '13800000003', smsCode: 'wrong', enterpriseName: 'X', contactName: 'Y' }),
        (err: unknown) => err instanceof ParkApiError && err.status === 401,
      )

      const dup = new ParkRegistrationService(driver, stubAuthService(ctx.db, { existingPhone: '13800000004' }))
      await assert.rejects(
        dup.registerEnterprise({ phone: '13800000004', smsCode: '123456', enterpriseName: 'X', contactName: 'Y' }),
        (err: unknown) => err instanceof ParkApiError && err.status === 409 && err.code === 'phone_already_registered',
      )

      // 另一个库无默认园区
      const db2 = new DatabaseSync(':memory:')
      db2.exec('PRAGMA foreign_keys=OFF')
      new AuthCenterDb(db2)
      ensureIdentitySchema(db2)
      createCatalogTestRepository(db2)
      ensureParkSchema(db2)
      const driver2 = new SqliteDriver(db2)
      const noPark = new ParkRegistrationService(driver2, stubAuthService(db2))
      await assert.rejects(
        noPark.registerEnterprise({ phone: '13800000005', smsCode: '123456', enterpriseName: 'X', contactName: 'Y' }),
        (err: unknown) => err instanceof ParkApiError && err.code === 'no_default_park',
      )
      db2.close()
    } finally {
      await ctx.teardown()
      await rm(root, { recursive: true, force: true })
    }
  })

  void test('真实认证服务：注册企业后再次取码，可用同一手机号登录新企业', async () => {
    const store = new DirectConnectStore(':memory:')
    const db = store.db!
    db.exec('PRAGMA foreign_keys=OFF')
    const authDb = new AuthCenterDb(store)
    createIdentityTestRepository(db, {}, store.driver)
    createCatalogTestRepository(db, store.driver)
    ensureParkSchema(db)
    await authDb.setConfig('issuer', 'moss-park-registration-test')
    await authDb.setConfig('jwt_secret', 'park-registration-test-secret')
    const sentCodes: string[] = []
    const authService = new AuthService(authDb, 3600, {
      enabled: true,
      delivery: 'tencent',
      codeTtlSec: 300,
      resendCooldownSec: 0,
      maxSendsPerHour: 5,
      maxVerifyAttempts: 5,
      autoCreateOrg: false,
    }, async (_phone, code) => { sentCodes.push(code) })
    try {
      await authService.initializeCompatibilityRecords()
      await authDb.createOrganization('park-org', '园区', Date.now())
      const driver = store.driver
      const repo = new ParkRepository(driver)
      await repo.upsertOrgProfile({ mossOrgId: 'park-org', orgType: 'park', displayName: '园区', isDefaultPark: true })
      const phone = '13800000009'
      await authService.phoneAuth.sendCode(phone)
      const registered = await new ParkRegistrationService(driver, authService).registerEnterprise({
        phone, smsCode: sentCodes.pop()!, enterpriseName: '登录联调企业', contactName: '联系人',
      })
      await authService.phoneAuth.sendCode(phone)
      assert.equal(await authService.phoneAuth.verifyCode(phone, sentCodes.pop()!), true)
      const session = await authService.issueTokenFromPhone(phone)
      assert.equal(session.user.id, registered.user_id)
      assert.equal(session.organization?.id, registered.enterprise_org_id)
      assert.equal((await repo.getBinding(registered.park_org_id, registered.enterprise_org_id))?.lifecycle, 'prospect')
    } finally {
      authService.destroy()
      await store.close()
    }
  })
})
