import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { onlineCommandContext } from '../application/commandContext.js'
import { BillingRepository } from './billingRepository.js'
import { ensureBillingSchema } from './billingSchema.js'
import { SudorouterAccountService } from './sudorouterAccountService.js'
import type { SudorouterAccountPort, SudorouterUserAccount } from './sudorouterAdapter.js'

class FakeSudorouter implements SudorouterAccountPort {
  accounts = new Map<string, SudorouterUserAccount>()
  findCalls = 0
  createCalls = 0
  quotaCalls = 0
  tokenCalls = 0

  async findUserByUsername(username: string) {
    this.findCalls += 1
    return [...this.accounts.values()].find(account => account.username === username) ?? null
  }
  async createUser(input: { username: string }) {
    this.createCalls += 1
    const account = {
      externalUserId: String(90 + this.createCalls), username: input.username,
      quotaUnits: 0, usedQuotaUnits: 0,
    }
    this.accounts.set(account.externalUserId, account)
    return account
  }
  async createToken(input: { externalUserId: string }) {
    this.tokenCalls += 1
    return `sk-user-${input.externalUserId}`
  }
  async getUser(externalUserId: string) {
    return this.accounts.get(externalUserId) ?? null
  }
  async changeQuota(input: { externalUserId: string; deltaUnits: number }) {
    this.quotaCalls += 1
    const account = this.accounts.get(input.externalUserId)
    if (!account) return { success: false, error: 'missing' }
    account.quotaUnits += input.deltaUnits
    return { success: true }
  }
}

class FakeSecrets {
  values = new Map<string, string>()
  putCalls = 0
  failNextPut = false
  async putSecret(namespace: string, key: string, value: string) {
    this.putCalls += 1
    if (this.failNextPut) {
      this.failNextPut = false
      throw new Error('nexus unavailable')
    }
    this.values.set(`${namespace}/${key}`, value)
  }
  async getSecret(namespace: string, key: string) {
    const value = this.values.get(`${namespace}/${key}`)
    return value === undefined ? null : { value, status: 'enabled', version: 1 }
  }
}

function setup() {
  const db = new DatabaseSync(':memory:')
  ensureBillingSchema(db)
  const provider = new FakeSudorouter()
  const secrets = new FakeSecrets()
  const repository = new BillingRepository(db)
  const service = new SudorouterAccountService(db, repository, provider, secrets)
  return { db, provider, secrets, repository, service }
}

describe('SudorouterAccountService', () => {
  test('幂等创建账号、初始化额度并把 Token 只写入 Nexus', async () => {
    const context = setup()
    const input = {
      ownerId: 'user-1', orgId: 'org-1', username: '13800000000',
      displayName: '用户一', initialQuotaUnits: 500_000,
    }
    const first = await context.service.ensureAccount(input, onlineCommandContext('register-user-1'))
    const replay = await context.service.ensureAccount(input, onlineCommandContext('register-user-1'))

    assert.deepEqual(first, {
      externalUserId: '91', token: 'sk-user-91', tokenSecretRef: 'nexus://moss:sudorouter-users/user-1',
      quotaUnits: 500_000, usedQuotaUnits: 0,
    })
    assert.deepEqual(replay, first)
    assert.equal(context.provider.createCalls, 1)
    assert.equal(context.provider.quotaCalls, 1)
    assert.equal(context.provider.tokenCalls, 1)
    assert.equal(context.secrets.putCalls, 1)
    assert.deepEqual(context.repository.getExternalAccount('sudorouter', 'user', 'user-1'), {
      provider: 'sudorouter', ownerType: 'user', ownerId: 'user-1', externalAccountId: '91',
      quotaUnits: 500_000, usedQuotaUnits: 0,
      tokenSecretRef: 'nexus://moss:sudorouter-users/user-1',
      updatedAt: context.repository.getExternalAccount('sudorouter', 'user', 'user-1')?.updatedAt,
    })
    const rows = JSON.stringify(context.db.prepare('SELECT * FROM billing_external_accounts').all())
      + JSON.stringify(context.db.prepare('SELECT * FROM billing_sudorouter_provisioning').all())
    assert.equal(rows.includes('sk-user-91'), false)
    context.db.close()
  })

  test('复用精确匹配的外部账号，只补足额度差额', async () => {
    const context = setup()
    context.provider.accounts.set('77', {
      externalUserId: '77', username: 'existing', quotaUnits: 200_000, usedQuotaUnits: 10,
    })
    const result = await context.service.ensureAccount({
      ownerId: 'user-2', orgId: 'org-1', username: 'existing',
      displayName: 'Existing', initialQuotaUnits: 500_000,
    }, onlineCommandContext('register-user-2'))

    assert.equal(result.externalUserId, '77')
    assert.equal(result.quotaUnits, 500_000)
    assert.equal(context.provider.createCalls, 0)
    assert.equal(context.provider.quotaCalls, 1)
    context.db.close()
  })

  test('Nexus 写入失败可用同一幂等键恢复且不重复开户或加额度', async () => {
    const context = setup()
    context.secrets.failNextPut = true
    const input = {
      ownerId: 'user-3', orgId: 'org-1', username: 'recover',
      displayName: 'Recover', initialQuotaUnits: 500_000,
    }
    await assert.rejects(
      context.service.ensureAccount(input, onlineCommandContext('register-user-3')),
      /nexus unavailable/,
    )
    const recovered = await context.service.ensureAccount(input, onlineCommandContext('register-user-3'))

    assert.equal(recovered.externalUserId, '91')
    assert.equal(context.provider.createCalls, 1)
    assert.equal(context.provider.quotaCalls, 1)
    assert.equal(context.repository.getSudorouterProvisioningByKey('register-user-3')?.status, 'COMPLETED')
    context.db.close()
  })

  test('同一幂等键不能绑定不同用户或初始额度', async () => {
    const context = setup()
    await context.service.ensureAccount({
      ownerId: 'user-4', orgId: 'org-1', username: 'same', displayName: 'Same', initialQuotaUnits: 10,
    }, onlineCommandContext('same-key'))
    await assert.rejects(context.service.ensureAccount({
      ownerId: 'user-5', orgId: 'org-1', username: 'other', displayName: 'Other', initialQuotaUnits: 20,
    }, onlineCommandContext('same-key')), /幂等键/)
    context.db.close()
  })
})
