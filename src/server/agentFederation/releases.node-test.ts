import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SqliteDriver } from '../db/driver.js'
import type { Binding } from '../externalProviders/store.js'
import { AgentReleaseStore } from './releases.js'

const actor = { orgId: 'org-1', userId: 'reviewer' }
function candidate(): Binding {
  return { id: 'catalog-1', orgId: actor.orgId, connectionId: 'connection-1', name: 'Original',
    provider_kind: 'dify', endpoint: 'http://127.0.0.1:8089/v1', app_id: 'app-1', workspace_id: 'workspace-1',
    source_digest: `sha256:${'1'.repeat(64)}`, decoder: 'text', sourceManifest: undefined,
    credential_ref: 'nexus://org:org-1:external:catalog-1/app-key', allowed_user_ids: ['reviewer'],
    credentialVersion: 1, parametersDigest: `sha256:${'2'.repeat(64)}`, definitionProfileVersion: 1,
    approved: true, reviewedBy: actor.userId, review_note: 'Reviewed synthetic source', review_expires_at: Date.now() + 86400_000 }
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const db = new SqliteDriver(new DatabaseSync(':memory:')), store = new AgentReleaseStore(db)
  await store.ready; t.after(() => db.close())
  return { db, store }
}
void test('releases preserve identity and immutable source, while governance is recorded separately', async t => {
  const { db, store } = await fixture(t), binding = candidate()
  const version = await store.publish(actor, binding, '1.0.0', 'Approve initial source')
  assert.equal(JSON.stringify(version).includes('credential'), false)
  assert.equal(JSON.stringify(version).includes('allowed_user_ids'), false)
  assert.equal(JSON.stringify(version).includes('review_expires_at'), false)
  const changed = { ...binding, source_digest: `sha256:${'3'.repeat(64)}`, name: 'Renamed display' }
  await assert.rejects(store.publish(actor, changed, '1.0.0', 'Attempt overwrite'), { code: 'IMMUTABLE_VERSION_CONFLICT' })
  const second = await store.publish(actor, changed, '1.1.0', 'Approve new source')
  assert.deepEqual(second.principal, version.principal); assert.notEqual(second.spec_digest, version.spec_digest)
  assert.deepEqual(await store.version(actor, binding.id, '1.0.0'), version)
  const renewed = await store.publish(actor, binding, '1.0.0', 'Renew source approval\nRetain reviewed artifact')
  assert.deepEqual(renewed, version)
  assert((await store.list(actor, binding.id)).items.find(item => item.version === '1.0.0')!.decisions.some(decision => decision.note.includes('\n')))
  assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM agent_version_decisions'))?.total), 3)
  await assert.rejects(store.version({ ...actor, orgId: 'foreign' }, binding.id, '1.0.0'), { code: 'AGENT_PRINCIPAL_NOT_FOUND' })
  await assert.rejects(store.publish(actor, { ...binding, approved: false }, '2.0.0', 'Unapproved'), { code: 'CANDIDATE_APPROVAL_REQUIRED' })
})

void test('channel compare-and-swap and rollback affect only newly resolved tasks', async t => {
  const { store } = await fixture(t), binding = candidate()
  await store.publish(actor, binding, '1.0.0', 'Initial')
  await store.moveChannel(actor, binding.id, 'stable', '1.0.0', 0)
  const originalResolution = await store.resolve(actor, binding.id)
  await store.publish(actor, { ...binding, source_digest: `sha256:${'3'.repeat(64)}` }, '1.1.0', 'Update')
  const outcomes = await Promise.allSettled([
    store.moveChannel(actor, binding.id, 'stable', '1.1.0', 1), store.moveChannel(actor, binding.id, 'stable', '1.0.0', 1),
  ])
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(x => x.status === 'rejected').length, 1)
  assert.equal(originalResolution.manifest.version, '1.0.0')
  assert.equal((await store.resolve(actor, binding.id)).manifest.version, '1.1.0')
  await store.moveChannel(actor, binding.id, 'stable', '1.0.0', 2)
  assert.equal((await store.resolve(actor, binding.id)).manifest.version, '1.0.0')
  await assert.rejects(store.resolve(actor, binding.id, '1.0.0', 'stable'), { code: 'AMBIGUOUS_AGENT_SELECTOR' })
})

void test('revocation disables referencing channels, prevents rollback and cannot be undone by republishing', async t => {
  const { store } = await fixture(t), binding = candidate()
  const original = await store.publish(actor, binding, '1.0.0', 'Initial')
  await store.moveChannel(actor, binding.id, 'stable', '1.0.0', 0)
  await store.revoke(actor, binding.id, '1.0.0', 'Source vulnerability')
  assert.deepEqual(await store.version(actor, binding.id, '1.0.0', false), original)
  await assert.rejects(store.resolve(actor, binding.id), { code: 'AGENT_CHANNEL_DISABLED' })
  await assert.rejects(store.resolve(actor, binding.id, '1.0.0'), { code: 'AGENT_VERSION_REVOKED' })
  await assert.rejects(store.moveChannel(actor, binding.id, 'canary', '1.0.0', 0), { code: 'AGENT_VERSION_REVOKED' })
  await assert.rejects(store.publish(actor, binding, '1.0.0', 'Cannot un-revoke'), { code: 'AGENT_VERSION_REVOKED' })
  assert.equal((await store.list(actor, binding.id)).channels[0].enabled, false)
})

void test('approval expiry rejects selection and source digest corruption is detected', async t => {
  const { db, store } = await fixture(t), binding = candidate()
  await store.publish(actor, binding, '1.0.0', 'Initial')
  await db.run('UPDATE agent_version_decisions SET expires_at = 0')
  await assert.rejects(store.resolve(actor, binding.id, '1.0.0'), { code: 'AGENT_VERSION_APPROVAL_EXPIRED' })
  await db.run('UPDATE agent_versions SET spec_digest = ?', [`sha256:${'0'.repeat(64)}`])
  await assert.rejects(store.version(actor, binding.id, '1.0.0', false), { code: 'AGENT_VERSION_DIGEST_MISMATCH' })
})
