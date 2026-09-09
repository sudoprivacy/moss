import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../../../authCenter/db.js'
import { BillingRepository } from '../../../billing/billingRepository.js'
import { ensureBillingSchema } from '../../../billing/billingSchema.js'
import { WalletService } from '../../../billing/walletService.js'
import { IdentityRepository } from '../../../identity/identityRepository.js'
import { SudoworkLegacyUsageService } from './legacyUsageService.js'

function setup(initialBalance = 10) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const auth = new AuthCenterDb(db)
  const identities = new IdentityRepository(db)
  auth.createOrganization('org-1', '企业一', 1)
  auth.createOrganization('org-2', '企业二', 1)
  for (const [id, orgId, role] of [
    ['user-1', 'org-1', 'user'],
    ['admin-1', 'org-1', 'admin'],
    ['admin-2', 'org-2', 'admin'],
    ['root-1', 'org-1', 'super_admin'],
  ] as const) {
    auth.createUser({
      id, orgId, email: `${id}@example.test`, name: id, displayName: id,
      departmentId: null, role, status: 'active', localAuth: true, tokenLimit: null,
      createdAt: 1, passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null,
    })
    identities.createWallet('user', id, id === 'user-1' ? initialBalance : 0)
  }
  identities.assignNumericAlias({ namespace: 'user', legacyId: 17, resourceId: 'user-1', orgId: 'org-1' })
  ensureBillingSchema(db)
  const repository = new BillingRepository(db)
  let now = Date.parse('2026-09-07T10:00:00Z')
  const service = new SudoworkLegacyUsageService({
    db,
    auth,
    identities,
    repository,
    wallet: new WalletService(db, repository, () => now),
    listModels: async () => [{ id: 'model-1', name: '模型一' }],
    clock: () => now,
  })
  return { db, repository, service, setNow(value: number) { now = value } }
}

const userActor = { userId: 'user-1', orgId: 'org-1', role: 'user' } as const

describe('SudoworkLegacyUsageService', () => {
  test('模型列表来自 Moss 统一模型源而不是兼容层硬编码', async () => {
    const { db, service } = setup()
    assert.deepEqual(await service.listModels(), [{ label: '模型一', value: 'model-1' }])
    db.close()
  })

  test('用量上报按百分之一积分精确扣费且相同幂等键只记一次', async () => {
    const { db, repository, service } = setup()
    const input = {
      actor: userActor, inputTokens: 1, outputTokens: 0, model: 'model-1', idempotencyKey: 'usage-1',
    }

    assert.deepEqual(await service.reportUsage(input), { success: true, deducted: 0.01, newBalance: 9.99 })
    assert.deepEqual(await service.reportUsage(input), { success: true, deducted: 0.01, newBalance: 9.99 })
    assert.equal(repository.getWallet('user', 'user-1')?.balanceUnits, 9.99)
    assert.equal(repository.listUsageRecords({ userId: 'user-1', limit: 20, offset: 0 }).total, 1)
    db.close()
  })

  test('余额不足不写用量记录', async () => {
    const { db, repository, service } = setup(0)
    await assert.rejects(
      service.reportUsage({ actor: userActor, inputTokens: 1, outputTokens: 0, idempotencyKey: 'usage-low' }),
      /积分不足/,
    )
    assert.equal(repository.listUsageRecords({ userId: 'user-1', limit: 20, offset: 0 }).total, 0)
    db.close()
  })

  test('仪表盘、流水和模型统计来自同一用量与钱包记录', async () => {
    const { db, service, setNow } = setup()
    await service.reportUsage({ actor: userActor, inputTokens: 600, outputTokens: 400, model: 'model-1', idempotencyKey: 'usage-a' })
    setNow(Date.parse('2026-09-07T11:00:00Z'))
    await service.reportUsage({ actor: userActor, inputTokens: 200, outputTokens: 300, model: 'model-2', idempotencyKey: 'usage-b' })

    const dashboard = await service.getDashboard(userActor) as any
    assert.deepEqual(dashboard.points, { total: 10, used: 1.5, remaining: 8.5, bonus: 0 })
    assert.deepEqual(dashboard.usage_today, { tokens: 1500, cost_points: 1.5, requests: 2 })
    assert.equal(dashboard.ledger.total, 2)

    const ledger = await service.listLedger({ actor: userActor })
    assert.equal(ledger.total, 2)
    assert.equal(ledger.data[0]?.amount, -0.5)
    const stats = await service.getModelUsageStats({
      actor: userActor, startDate: '2026-09-07', endDate: '2026-09-07',
    }) as any[]
    assert.deepEqual(stats.map(item => [item.model, item.total_tokens, item.cost]), [
      ['model-1', 1000, 1],
      ['model-2', 500, 0.5],
    ])
    db.close()
  })

  test('企业管理员不能读取其他组织用户流水，超级管理员可以', async () => {
    const { db, service } = setup()
    await service.reportUsage({ actor: userActor, inputTokens: 1000, outputTokens: 0, idempotencyKey: 'usage-org' })
    await assert.rejects(
      Promise.resolve().then(() => service.listAdminUserLedger({
        actor: { userId: 'admin-2', orgId: 'org-2', role: 'admin' }, legacyUserId: 17, limit: 20,
      })),
      /无权操作该用户/,
    )
    assert.equal((await service.listAdminUserLedger({
      actor: { userId: 'root-1', orgId: 'org-1', role: 'super_admin' }, legacyUserId: 17, limit: 20,
    })).length, 1)
    await assert.rejects(
      Promise.resolve().then(() => service.listAdminUserLedger({
        actor: {
          userId: 'root-1', orgId: 'org-2', role: 'super_admin', organizationScoped: true,
        },
        legacyUserId: 17,
        limit: 20,
      })),
      /无权操作该用户/,
    )
    db.close()
  })
})
