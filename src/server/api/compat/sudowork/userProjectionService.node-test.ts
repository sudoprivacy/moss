import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../../../authCenter/db.js'
import { BillingRepository } from '../../../billing/billingRepository.js'
import { ensureBillingSchema } from '../../../billing/billingSchema.js'
import type { SudorouterPort } from '../../../billing/sudorouterAdapter.js'
import { IdentityRepository } from '../../../identity/identityRepository.js'
import {
  SudoworkUserProjectionError,
  SudoworkUserProjectionService,
} from './userProjectionService.js'

function setup(
  tokenSecretRef: string | null = 'nexus://moss:sudorouter-users/user-1',
  quotaReader?: Pick<SudorouterPort, 'getUser'>,
) {
  const db = new DatabaseSync(':memory:')
  const auth = new AuthCenterDb(db)
  const identities = new IdentityRepository(db)
  auth.createOrganization('org-1', '企业一', 1)
  auth.createUser({
    id: 'user-1', orgId: 'org-1', email: 'user@example.test', name: '13800000000',
    displayName: '测试用户', departmentId: null, role: 'user', status: 'active', localAuth: true,
    tokenLimit: null, createdAt: 1, passwordHash: null, passwordUpdatedAt: null,
    lastLoginAt: null, extUserId: null,
  })
  identities.putOrganizationProfile({
    orgId: 'org-1', code: 'ENT-A', loginMethod: 'password', localEnabled: true, cloudEnabled: true,
  })
  identities.assignNumericAlias({ namespace: 'enterprise', legacyId: 3, resourceId: 'org-1', orgId: 'org-1' })
  identities.assignNumericAlias({ namespace: 'user', legacyId: 17, resourceId: 'user-1', orgId: 'org-1' })
  identities.createWallet('user', 'user-1', 75)
  ensureBillingSchema(db)
  const billing = new BillingRepository(db)
  billing.upsertExternalAccount({
    provider: 'sudorouter', ownerType: 'user', ownerId: 'user-1', externalAccountId: '71',
    quotaUnits: 37_500, usedQuotaUnits: 12_500, tokenSecretRef, updatedAt: 1,
  })
  billing.insertUsageRecord({
    id: 'usage-1', userId: 'user-1', orgId: 'org-1', model: 'model-a', inputTokens: 100,
    outputTokens: 50, costUnits: 25, balanceAfterUnits: 75,
    idempotencyKey: 'usage-1', createdAt: 2,
  })
  billing.insertLedgerEntry({
    id: 'bonus-1', ownerType: 'user', ownerId: 'user-1', deltaUnits: 10,
    balanceBeforeUnits: 65, balanceAfterUnits: 75, entryType: 'BONUS', sourceType: 'admin',
    sourceId: 'bonus-1', idempotencyKey: 'bonus-1', contextSource: 'online', createdAt: 3,
  })
  const service = new SudoworkUserProjectionService({
    identities,
    billing,
    secrets: {
      async getSecret(namespace, key, subject) {
        assert.equal(namespace, 'moss:sudorouter-users')
        assert.equal(key, 'user-1')
        assert.equal(subject, 'org:org-1')
        return { value: 'router-token', status: 'enabled', version: 1 }
      },
    },
    listModels: async () => [{ id: 'model-a' }, { id: 'model-b' }],
    getRuntimeConfig: () => ({
      modelServiceUrl: 'https://router.test/v1/',
      scodeAutoModel: 'model-a',
    }),
    quotaReader,
  })
  return { db, service, billing }
}

const user = {
  id: 17, phone: '13800000000', nickname: '测试用户', role: 'USER' as const,
  status: 1 as const, enterpriseId: 3, enterpriseCode: 'ENT-A',
}

describe('SudoworkUserProjectionService', () => {
  test('从统一账户、Nexus、钱包、用量和模型配置构造旧登录投影', async () => {
    const { db, service } = setup()
    assert.deepEqual(await service.project(user), {
      sudorouterKey: 'sk-router-token',
      modelServiceUrl: 'https://router.test/v1',
      models: ['model-a', 'model-b'],
      scodeAutoModel: 'model-a',
      totalPoints: 100,
      usedPoints: 25,
      remainingPoints: 75,
      bonusPoints: 10,
      quota: 37_500,
      usedQuota: 12_500,
    })
    db.close()
  })

  test('缺少 Token 引用时返回明确错误而不是空凭据', async () => {
    const { db, service } = setup(null)
    await assert.rejects(service.project(user), (error: unknown) => (
      error instanceof SudoworkUserProjectionError
      && error.statusCode === 500
      && error.message === 'Sudorouter 用户 Token 不存在'
    ))
    db.close()
  })

  test('登录时优先使用 Sudorouter 实时额度并刷新本地快照', async () => {
    const { db, service, billing } = setup(undefined, {
      async getUser(externalUserId) {
        return { externalUserId, quotaUnits: 4_000, usedQuotaUnits: 1_000 }
      },
    })
    const projection = await service.project(user)
    assert.deepEqual({
      total: projection.totalPoints, used: projection.usedPoints, remaining: projection.remainingPoints,
      quota: projection.quota, usedQuota: projection.usedQuota,
    }, { total: 10, used: 2, remaining: 8, quota: 4_000, usedQuota: 1_000 })
    assert.equal(billing.getExternalAccount('sudorouter', 'user', 'user-1')?.quotaUnits, 4_000)
    db.close()
  })
})
