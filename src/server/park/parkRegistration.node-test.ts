import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { createCatalogTestRepository } from '../testing/compatibilityRepositories.js'
import { ensureIdentitySchema } from '../identity/identityRepository.js'
import { SqliteDriver } from '../db/driver.js'
import { ensureParkSchema } from './parkSchema.js'
import { ParkRegistrationService } from './parkRegistrationService.js'
import { ParkRepository } from './parkRepository.js'
import { ParkApiError } from './parkAuthorization.js'
import type { AuthService } from '../auth/service.js'

/**
 * 注册链路测试（计划 5.3 parkRegistration）：
 * prospect 创建 / 邀请码绑定对应园区 / 默认园区 / 手机号重复。
 * AuthService 以桩替身注入（注册服务只依赖 phoneAuth.verifyCode /
 * findUserByPhone / createOrganization / createUser 四个接缝）。
 */

function stubAuthService(db: DatabaseSync, overrides: {
  existingPhone?: string | null
  codeValid?: boolean
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
      userSeq += 1
      const id = `u-${userSeq}`
      db.prepare(`
        INSERT INTO users (id, org_id, email, name, role, status, local_auth, created_at)
        VALUES (?, ?, ?, ?, 'user', 'active', 1, ?)
      `).run(id, input.orgId, `${id}@test`, input.name, Date.now())
      return { user: { id, name: input.name, orgId: input.orgId } }
    },
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
    } finally {
      await ctx.teardown()
      await rm(root, { recursive: true, force: true })
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
})
