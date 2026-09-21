import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../../../authCenter/db.js'
import type { SudorouterPort } from '../../../billing/sudorouterAdapter.js'
import { createBillingTestRepository, createIdentityTestRepository } from '../../../testing/compatibilityRepositories.js'
import {
  SudoworkUserProjectionError,
  SudoworkUserProjectionService,
} from './userProjectionService.js'

async function setup(
  tokenSecretRef: string | null = 'nexus://moss:sudorouter-users/user-1',
  quotaReader?: Pick<SudorouterPort, 'getUser'>,
) {
  const db = new DatabaseSync(':memory:')
  const auth = new AuthCenterDb(db)
  const identities = createIdentityTestRepository(db, {}, auth.driver)
  await auth.createOrganization('org-1', '企业一', 1)
  await auth.createUser({
    id: 'user-1', orgId: 'org-1', email: 'user@example.test', name: '13800000000',
    displayName: '测试用户', departmentId: null, role: 'user', status: 'active', localAuth: true,
    tokenLimit: null, createdAt: 1, passwordHash: null, passwordUpdatedAt: null,
    lastLoginAt: null, extUserId: null,
  })
  await identities.putOrganizationProfile({
    orgId: 'org-1', code: 'ENT-A', loginMethod: 'password', localEnabled: true, cloudEnabled: true,
  })
  await identities.assignNumericAlias({ namespace: 'enterprise', legacyId: 3, resourceId: 'org-1', orgId: 'org-1' })
  await identities.assignNumericAlias({ namespace: 'user', legacyId: 17, resourceId: 'user-1', orgId: 'org-1' })
  await identities.createWallet('user', 'user-1', 75)
  const billing = createBillingTestRepository(db, auth.driver)
  await billing.upsertExternalAccount({
    provider: 'sudorouter', ownerType: 'user', ownerId: 'user-1', externalAccountId: '71',
    quotaUnits: 37_500, usedQuotaUnits: 12_500, tokenSecretRef, updatedAt: 1,
  })
  await billing.insertUsageRecord({
    id: 'usage-1', userId: 'user-1', orgId: 'org-1', model: 'model-a', inputTokens: 100,
    outputTokens: 50, costUnits: 25, balanceAfterUnits: 75,
    idempotencyKey: 'usage-1', createdAt: 2,
  })
  await billing.insertLedgerEntry({
    id: 'bonus-1', ownerType: 'user', ownerId: 'user-1', deltaUnits: 10,
    balanceBeforeUnits: 65, balanceAfterUnits: 75, entryType: 'BONUS', sourceType: 'admin',
    sourceId: 'bonus-1', idempotencyKey: 'bonus-1', contextSource: 'online', createdAt: 3,
  })
  const modelOrgIds: Array<string | undefined> = []
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
    listModels: async orgId => {
      modelOrgIds.push(orgId)
      return [{ id: 'model-a' }, { id: 'model-b' }]
    },
    getRuntimeConfig: () => ({
      modelServiceUrl: 'https://router.test/v1/',
      scodeAutoModel: 'model-a',
    }),
    quotaReader,
  })
  return { db, service, billing, modelOrgIds }
}

const user = {
  id: 17, phone: '13800000000', nickname: '测试用户', role: 'USER' as const,
  status: 1 as const, enterpriseId: 3, enterpriseCode: 'ENT-A',
}

void describe('SudoworkUserProjectionService', () => {
  void test('从统一账户、Nexus、钱包、用量和模型配置构造旧登录投影', async () => {
    const { db, service, modelOrgIds } = await setup()
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
    assert.deepEqual(modelOrgIds, ['org-1'])
    db.close()
  })

  void test('缺少 Token 引用时返回明确错误而不是空凭据', async () => {
    const { db, service } = await setup(null)
    await assert.rejects(service.project(user), (error: unknown) => (
      error instanceof SudoworkUserProjectionError
      && error.statusCode === 500
      && error.message === 'Sudorouter 用户 Token 不存在'
    ))
    db.close()
  })

  void test('登录时优先使用 Sudorouter 实时额度并刷新本地快照', async () => {
    const { db, service, billing } = await setup(undefined, {
      async getUser(externalUserId) {
        return { externalUserId, quotaUnits: 4_000, usedQuotaUnits: 1_000 }
      },
    })
    const projection = await service.project(user)
    assert.deepEqual({
      total: projection.totalPoints, used: projection.usedPoints, remaining: projection.remainingPoints,
      quota: projection.quota, usedQuota: projection.usedQuota,
    }, { total: 10, used: 2, remaining: 8, quota: 4_000, usedQuota: 1_000 })
    assert.equal((await billing.getExternalAccount('sudorouter', 'user', 'user-1'))?.quotaUnits, 4_000)
    db.close()
  })
})
