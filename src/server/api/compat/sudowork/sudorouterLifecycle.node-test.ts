import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { AuthCenterDb } from '../../../authCenter/db.js'
import { BillingRepository } from '../../../billing/billingRepository.js'
import { ensureBillingSchema } from '../../../billing/billingSchema.js'
import { SudorouterAccountService } from '../../../billing/sudorouterAccountService.js'
import { SudorouterAdapter } from '../../../billing/sudorouterAdapter.js'
import { WalletService } from '../../../billing/walletService.js'
import { IdentityRepository } from '../../../identity/identityRepository.js'
import type { LegacyKeyValueStore } from '../../../identity/legacyToken.js'
import { SudoworkIdentityService } from './identityService.js'
import { SudoworkLegacyUsageService } from './legacyUsageService.js'
import { SudoworkUserProjectionService } from './userProjectionService.js'

class MemoryTokens implements LegacyKeyValueStore {
  values = new Map<string, string>()
  async setex(key: string, _seconds: number, value: string) { this.values.set(key, value) }
  async get(key: string) { return this.values.get(key) ?? null }
  async del(...keys: string[]) { keys.forEach(key => this.values.delete(key)) }
  async keys() { return [] }
  async rotate(oldKey: string, newKey: string, _seconds: number, value: string) {
    if (!this.values.has(oldKey)) return false
    this.values.delete(oldKey)
    this.values.set(newKey, value)
    return true
  }
}

test('邀请码注册到 Sudorouter 登录凭据与模型用量完整闭环', async () => {
  let created = false
  let quota = 0
  const router = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const json = (value: unknown) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(value))
    }
    if (request.method === 'GET' && url.pathname === '/api/user/search') {
      json({ success: true, data: { items: created ? [{ id: 91, username: 'new-user', quota, used_quota: 1_000, status: 1 }] : [] } })
    } else if (request.method === 'POST' && url.pathname === '/api/user/') {
      created = true
      json({ success: true, data: { id: 91, username: 'new-user', quota: 0, used_quota: 0 } })
    } else if (request.method === 'PUT' && url.pathname === '/api/user/quota') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      quota += Number((JSON.parse(Buffer.concat(chunks).toString()) as { quota: number }).quota)
      json({ success: true })
    } else if (request.method === 'POST' && url.pathname === '/api/token/') {
      json({ success: true, data: { key: 'router-token' } })
    } else if (request.method === 'GET' && url.pathname === '/api/user/91') {
      json({ success: true, data: { id: 91, quota, used_quota: 1_000 } })
    } else if (request.method === 'GET' && url.pathname === '/api/log/query') {
      json({ success: true, data: { count: 1, data: [{
        id: 8, created_at: Math.floor(Date.now() / 1000), type: 2, model_name: 'model-a',
        cost: 500, prompt_tokens: 30, completion_tokens: 20,
      }] } })
    } else {
      response.statusCode = 404
      json({ success: false })
    }
  })
  await new Promise<void>(resolve => router.listen(0, '127.0.0.1', resolve))
  const address = router.address()
  assert(address && typeof address === 'object')

  const db = new DatabaseSync(':memory:')
  try {
    const auth = new AuthCenterDb(db)
    const identities = new IdentityRepository(db)
    auth.createOrganization('org-1', '企业一', 1)
    identities.putOrganizationProfile({
      orgId: 'org-1', code: 'ENT-A', loginMethod: 'password', localEnabled: true, cloudEnabled: true,
    })
    identities.assignNumericAlias({ namespace: 'enterprise', legacyId: 3, resourceId: 'org-1', orgId: 'org-1' })
    identities.createInvitation({ id: 'invite-1', orgId: 'org-1', code: 'JOINME', initialCreditUnits: 10 })
    ensureBillingSchema(db)
    const billing = new BillingRepository(db)
    const secretValues = new Map<string, string>()
    const secrets = {
      async putSecret(namespace: string, key: string, value: string) { secretValues.set(`${namespace}:${key}`, value) },
      async getSecret(namespace: string, key: string) {
        const value = secretValues.get(`${namespace}:${key}`)
        return value ? { value, status: 'enabled', version: 1 } : null
      },
    }
    const baseUrl = `http://127.0.0.1:${address.port}`
    const adapter = new SudorouterAdapter({
      baseUrl, apiToken: 'admin-token', adminUserId: '76',
    })
    const accountService = new SudorouterAccountService(db, billing, adapter, secrets)
    const identity = new SudoworkIdentityService({
      authDb: auth, identities, tokenStore: new MemoryTokens(), legacyJwtSecret: 'legacy-secret',
      accountProvisioner: accountService, refreshTokenFactory: () => 'refresh-token',
    })
    const session = await identity.registerByPassword({
      phone: 'new-user', nickname: '新用户', password: 'StrongPass123', invitationCode: 'JOINME',
      idempotencyKey: 'register:new-user',
    })
    const projection = await new SudoworkUserProjectionService({
      identities, billing, secrets, quotaReader: adapter,
      listModels: async () => [{ id: 'model-a' }],
      getRuntimeConfig: () => ({ modelServiceUrl: `${baseUrl}/v1`, scodeAutoModel: 'model-a' }),
    }).project(session.user)
    assert.equal(projection.sudorouterKey, 'sk-router-token')
    assert.deepEqual(projection.models, ['model-a'])
    assert.deepEqual(
      { total: projection.totalPoints, used: projection.usedPoints, remaining: projection.remainingPoints },
      { total: 12, used: 2, remaining: 10 },
    )
    const usage = new SudoworkLegacyUsageService({
      db, auth, identities, repository: billing,
      wallet: new WalletService(db, billing), listModels: async () => [{ id: 'model-a' }], sudorouter: adapter,
    })
    const canonical = identities.resolveNumericAliasGlobal('user', session.user.id)!
    const dashboard = await usage.getDashboard({ userId: canonical.resourceId, orgId: canonical.orgId, role: 'user' }) as any
    assert.deepEqual(dashboard.usage_today, { tokens: 50, cost_points: 1, requests: 1 })
  } finally {
    db.close()
    await new Promise<void>((resolve, reject) => router.close(error => error ? reject(error) : resolve()))
  }
})
