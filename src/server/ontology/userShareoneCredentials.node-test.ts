import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SecretsApi } from '../api/secrets.js'
import { createUserShareoneCredentials } from './userShareoneCredentials.js'

function fixture() {
  const values = new Map<string, string>()
  const reads: string[] = []
  let isActive = true, isAvailable = true, isRevokedAfterRead = false
  const check = (org: string, user: string, namespace: string) => {
    assert.equal(org, 'org'); assert.equal(user, 'owner'); assert.equal(namespace, 'user:owner:shareone')
  }
  const api: Pick<SecretsApi, 'getUserSecret' | 'putUserSecret' | 'deleteUserSecret'> = {
    getUserSecret: async (org, user, namespace, key) => {
      check(org, user, namespace); reads.push(key)
      if (!isAvailable) throw new Error('Upstream diagnostic must not leak a credential')
      if (isRevokedAfterRead) isActive = false
      const value = values.get(key)
      return value ? { success: true, data: { value, status: 'enabled', version: 1 } }
        : { success: false, error: { code: 'not_found', message: 'Not found' } }
    },
    putUserSecret: async (org, user, namespace, key, value) => {
      check(org, user, namespace); values.set(key, value); return { success: true }
    },
    deleteUserSecret: async (org, user, namespace, key) => {
      check(org, user, namespace); values.delete(key); return { success: true }
    },
  }
  const owner = { orgId: 'org', userId: 'owner' }
  const credentials = createUserShareoneCredentials(api, owner, async () => { if (!isActive) throw new Error('Current owner is inactive') })
  return { credentials, values, reads, owner, deactivate: () => { isActive = false },
    disconnect: () => { isAvailable = false }, revokeAfterRead: () => { isRevokedAfterRead = true } }
}

void test('current ShareOne credentials use the original personal namespace without plaintext caching or owner retargeting', async () => {
  const f = fixture()
  f.values.set('api_key', 'legacy-personal-key')
  assert.equal(await f.credentials.getKey(), 'legacy-personal-key')
  assert.deepEqual(f.reads, ['shareone_key', 'api_key'])
  await f.credentials.setKey('new-personal-key')
  f.owner.userId = 'another-owner'
  assert.equal(await f.credentials.getKey(), 'new-personal-key', 'the trusted owner was captured before the page could mutate a reference')
  f.values.set('shareone_key', 'rotated-in-the-existing-vault')
  assert.equal(await f.credentials.getKey(), 'rotated-in-the-existing-vault')
  await f.credentials.setKey(null)
  assert.equal(f.values.size, 0, 'logout removes compatibility aliases from the same Vault')
  assert.equal(await f.credentials.getKey(), null)
})

void test('credential service failure is explicit and cannot fall back to another key or a cached value', async () => {
  const f = fixture()
  f.values.set('shareone_key', 'existing-personal-key')
  assert.equal(await f.credentials.getKey(), 'existing-personal-key')
  f.disconnect()
  await assert.rejects(f.credentials.getKey(), error => error instanceof Error && error.message === 'Existing ShareOne credentials are temporarily unavailable')
})

void test('revocation during credential retrieval prevents disclosure', async () => {
  const f = fixture()
  f.values.set('shareone_key', 'revoked-owner-key')
  f.revokeAfterRead()
  await assert.rejects(f.credentials.getKey(), /inactive/)
  assert.deepEqual(f.reads, ['shareone_key'])
})

void test('inactive owners cannot read, pair or delete ShareOne credentials', async () => {
  const f = fixture()
  f.deactivate()
  await assert.rejects(f.credentials.getKey(), /inactive/)
  await assert.rejects(f.credentials.setKey('new-key'), /inactive/)
  await assert.rejects(f.credentials.setKey(null), /inactive/)
  assert.deepEqual(f.reads, [])
  assert.equal(f.values.size, 0)
})
