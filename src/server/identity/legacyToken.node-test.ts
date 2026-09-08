import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { IdentityRepository } from './identityRepository.js'
import {
  LegacyRefreshTokenService,
  issueLegacyJwt,
  resolveLegacyPrincipal,
  verifyLegacyJwt,
  type LegacyKeyValueStore,
} from './legacyToken.js'

class MemoryLegacyTokenStore implements LegacyKeyValueStore {
  readonly values = new Map<string, string>()

  async setex(key: string, _seconds: number, value: string): Promise<void> {
    this.values.set(key, value)
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
    for (const key of keys) this.values.delete(key)
  }

  async rotate(oldKey: string, newKey: string, _seconds: number, value: string): Promise<boolean> {
    if (!this.values.has(oldKey)) return false
    this.values.set(newKey, value)
    this.values.delete(oldKey)
    return true
  }
}

describe('legacy Sudowork token profile', () => {
  test('issues and validates the old HS256 claim shape', () => {
    const token = issueLegacyJwt({
      secret: 'explicit-production-secret',
      userId: 17,
      phone: '13800000000',
      role: 'USER',
      enterpriseId: 9,
      expiresInSec: 7200,
      nowSeconds: 1_000,
    })
    assert.deepEqual(verifyLegacyJwt(token, 'explicit-production-secret', 1_001), {
      id: 17,
      phone: '13800000000',
      role: 'USER',
      enterprise_id: 9,
      iat: 1_000,
      exp: 8_200,
    })
    assert.equal(verifyLegacyJwt(`${token}x`, 'explicit-production-secret', 1_001), null)
    assert.equal(verifyLegacyJwt(token, 'explicit-production-secret', 8_200), null)
  })

  test('maps old numeric claims to one Moss principal and rejects cross-org aliases', () => {
    const db = new DatabaseSync(':memory:')
    const authDb = new AuthCenterDb(db)
    const repository = new IdentityRepository(db)
    authDb.createOrganization('org-a', 'Org A', 1)
    authDb.createOrganization('org-b', 'Org B', 1)
    authDb.createUser({
      id: 'user-a', orgId: 'org-a', email: 'a@example.test', name: 'a', displayName: null,
      departmentId: null, role: 'user', status: 'active', localAuth: true, tokenLimit: null,
      createdAt: 1, passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null,
    })
    repository.assignNumericAlias({ namespace: 'enterprise', legacyId: 9, resourceId: 'org-a', orgId: 'org-a' })
    repository.assignNumericAlias({ namespace: 'user', legacyId: 17, resourceId: 'user-a', orgId: 'org-a' })
    const token = issueLegacyJwt({
      secret: 'explicit-production-secret', userId: 17, phone: '13800000000',
      role: 'USER', enterpriseId: 9, expiresInSec: 7200,
    })
    assert.deepEqual(resolveLegacyPrincipal(token, 'explicit-production-secret', repository, authDb), {
      userId: 'user-a', orgId: 'org-a', role: 'user', legacyUserId: 17, legacyEnterpriseId: 9,
    })

    repository.assignNumericAlias({ namespace: 'enterprise', legacyId: 10, resourceId: 'org-b', orgId: 'org-b' })
    const crossOrg = issueLegacyJwt({
      secret: 'explicit-production-secret', userId: 17, phone: '13800000000',
      role: 'USER', enterpriseId: 10, expiresInSec: 7200,
    })
    assert.equal(resolveLegacyPrincipal(crossOrg, 'explicit-production-secret', repository, authDb), null)
    db.close()
  })

  test('keeps the old Redis key and device semantics during rolling refresh', async () => {
    const store = new MemoryLegacyTokenStore()
    const service = new LegacyRefreshTokenService(store, () => 'next-token')
    await store.setex(
      'refresh_token:17:laptop:old-token',
      30 * 24 * 60 * 60,
      JSON.stringify({ phone: '13800000000', role: 'USER', enterprise_id: 9 }),
    )
    const refreshed = await service.rotate('old-token', 'laptop')
    assert.deepEqual(refreshed, {
      token: 'next-token', userId: 17, deviceId: 'laptop',
      claims: { phone: '13800000000', role: 'USER', enterprise_id: 9 },
    })
    assert.equal(store.values.has('refresh_token:17:laptop:old-token'), false)
    assert.equal(store.values.has('refresh_token:17:laptop:next-token'), true)
    assert.equal(await service.rotate('old-token', 'other-device'), null)
  })
})
