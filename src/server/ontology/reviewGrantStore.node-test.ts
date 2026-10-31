import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { ISudographReviewGrant } from '@sudowork/sudograph-runtime'
import { DirectConnectStore, forPostgresDirectConnectStore } from '../db.js'
import { PgDriver, type DbDriver } from '../db/driver.js'
import { applyPgSchema } from '../db/pg_schema.js'
import type { OntologySessionBinding } from './projectRegistry.js'
import { OntologyReviewGrantStore, reviewAuthorizationRef } from './reviewGrantStore.js'

async function contract(t: TestContext, stores: DirectConnectStore[], reopen: () => Promise<void>) {
  let now = Date.now()
  const create = (index = 0) => new OntologyReviewGrantStore(stores[index].driver, stores[index].ontologyProjects, () => now)
  const bind = async (sessionId: string, userId = 'alice', orgId = 'grant-org') => {
    await stores[0].createSession({ sessionId, userId, orgId, transcriptSessionId: sessionId, transcriptPath: '/fixture/' + sessionId,
      role: 'member', scopes: [], cwd: '/fixture', runtime: { type: 'cohost', engine: 'scode' }, status: 'active', desiredState: 'active' })
    const project = await stores[0].ontologyProjects.register({ orgId, authorityRef: 'grant-authority', workerRef: 'worker', modelRef: 'model', sourceRefs: ['source'] })
    return stores[0].ontologyProjects.bind({ sessionId, userId, orgId, projectId: project.projectId }, { authorize: async () => {} })
  }
  const alice = await bind('grant-alice')
  const bob = await bind('grant-bob', 'bob')
  const foreign = await bind('grant-foreign', 'alice', 'foreign-org')
  const limited = await bind('grant-capacity', 'capacity-owner')
  const value = (binding: OntologySessionBinding, id: string): ISudographReviewGrant => ({
    workspaceId: binding.projectId, conversationId: binding.sessionId, authorizationRef: reviewAuthorizationRef(binding),
    prefix: `/review/${id}`, cookieName: `sudograph_review_${id}`, credentialHash: 'a'.repeat(64), expiresAt: now + 20 * 60_000,
  })
  const id = randomUUID().replaceAll('-', '')
  const original = value(alice, id)

  await t.test('only current durable ownership can create hash-only grants', async () => {
    await create().create(id, original)
    assert.deepEqual(await create(1).get(id), { ...original, shareId: null })
    await assert.rejects(create(1).create(id, original))
    for (const change of [{ authorizationRef: 'sha256:' + 'b'.repeat(64) }, { workspaceId: foreign.projectId },
      { cookieName: 'foreign-cookie' }, { expiresAt: now - 1 }, { expiresAt: now + 31 * 60_000 },
      { credential: 'raw-secret-must-not-be-stored' }]) {
      const next = randomUUID().replaceAll('-', '')
      await assert.rejects(create().create(next, { ...value(alice, next), ...change }))
    }
    const rows = await stores[0].driver.all('SELECT * FROM ontology_review_grants')
    assert.equal(rows.length, 1)
    assert.ok(!JSON.stringify(rows).includes('raw-secret'))
    assert.equal(rows[0].org_id, alice.orgId)
    assert.equal(rows[0].user_id, alice.userId)
  })

  await t.test('independent controllers update only metadata and persist it across reopening', async () => {
    assert.equal(await create().update(id, original, { shareId: 'private-share' }), true)
    assert.equal(await create(1).update(id, original, { revision: 'canonical-revision' }), true)
    assert.equal(await create().update(id, { ...original, credentialHash: 'b'.repeat(64) }, { shareId: 'foreign' }), false)
    assert.equal(await create().update(id, { ...original, authorizationRef: 'sha256:' + 'b'.repeat(64) }, {}), false)
    await assert.rejects(create().update(id, original, { authorizationRef: 'foreign' } as never))
    await reopen()
    assert.deepEqual(await create().get(id), { ...original, shareId: 'private-share', revision: 'canonical-revision' })
    await create(1).delete(id)
    assert.equal(await create().get(id), undefined)
    assert.equal(await create().update(id, original, { revision: 'late-write' }), false)
    assert.equal(await create().get('../../foreign'), undefined)
  })

  await t.test('the capacity boundary is atomic across controllers and isolated by owner and organization', async () => {
    const template = value(limited, '0'.repeat(32))
    await stores[0].driver.transaction(async () => {
      for (let slot = 0; slot < 127; slot++) {
        const key = slot.toString(16).padStart(32, '0')
        await stores[0].driver.run(`INSERT INTO ontology_review_grants
          (id,org_id,user_id,slot,workspace_id,conversation_id,authorization_ref,prefix,cookie_name,credential_hash,expires_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [key, limited.orgId, limited.userId, slot, template.workspaceId, template.conversationId, template.authorizationRef!,
          `/review/${key}`, `sudograph_review_${key}`, template.credentialHash, template.expiresAt])
      }
    })
    const candidates = [randomUUID().replaceAll('-', ''), randomUUID().replaceAll('-', '')]
    const results = await Promise.allSettled(candidates.map((key, index) => create(index).create(key, value(limited, key))))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    assert.equal(Number((await stores[0].driver.get('SELECT count(*) AS n FROM ontology_review_grants WHERE user_id=?', [limited.userId]))?.n), 128)
    for (const binding of [alice, bob, foreign]) {
      const key = randomUUID().replaceAll('-', '')
      await create().create(key, value(binding, key))
      assert.equal((await create(1).get(key))?.authorizationRef, reviewAuthorizationRef(binding))
    }
    now += 31 * 60_000
    assert.equal(await create().get(candidates[0]), undefined)
    assert.equal(await create(1).get(candidates[1]), undefined)
    const fresh = randomUUID().replaceAll('-', '')
    await create().create(fresh, value(limited, fresh))
    assert.equal(Number((await stores[0].driver.get('SELECT count(*) AS n FROM ontology_review_grants WHERE user_id=?', [limited.userId]))?.n), 1)
  })

  await t.test('ownership generations invalidate old references without depending on model revisions', async () => {
    const oldRef = reviewAuthorizationRef(alice)
    await stores[0].ontologyProjects.setEnabled(alice.orgId, alice.projectId, false)
    await assert.rejects(stores[1].ontologyProjects.resolveSession(alice.sessionId))
    await stores[0].ontologyProjects.setEnabled(alice.orgId, alice.projectId, true)
    const current = (await stores[1].ontologyProjects.resolveSession(alice.sessionId))!
    assert.notEqual(reviewAuthorizationRef(current), oldRef)
    const key = randomUUID().replaceAll('-', '')
    await assert.rejects(create().create(key, value(alice, key)))
    await create().create(key, value(current, key))
    await stores[0].driver.run('UPDATE sessions SET user_id=? WHERE session_id=?', ['different-owner', alice.sessionId])
    const other = randomUUID().replaceAll('-', '')
    await assert.rejects(create().create(other, value(current, other)))
    await stores[0].driver.run('DELETE FROM ontology_session_bindings WHERE session_id=?', [alice.sessionId])
    assert.equal(await create(1).get(key), undefined, 'removing the durable binding also revokes its ephemeral grants')
  })
}

void test('SQLite production initialization persists shared browser grants', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-review-grants-'))
  const path = join(root, 'host.db')
  const stores = [new DirectConnectStore(path)]
  stores.push(stores[0])
  t.after(async () => { await stores[0].driver.close(); await rm(root, { recursive: true, force: true }) })
  await contract(t, stores, async () => { await stores[0].driver.close(); stores[0] = new DirectConnectStore(path); stores[1] = stores[0] })
})

void test('PostgreSQL production migration coordinates independent browser grant controllers', { skip: !process.env.MOSS_PG_TEST_URL }, async t => {
  const pg = await import('pg')
  const connectionString = process.env.MOSS_PG_TEST_URL!
  const schema = 'review_grants_' + randomUUID().replaceAll('-', '')
  const admin = new pg.default.Pool({ connectionString })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const make = () => new PgDriver(new pg.default.Pool({ connectionString, options: `-c search_path=${schema}` }) as never)
  const drivers: DbDriver[] = [make(), make()]
  const stores = drivers.map(forPostgresDirectConnectStore)
  t.after(async () => { await Promise.all(drivers.map(driver => driver.close())); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() })
  for (const driver of drivers) await applyPgSchema(driver)
  await contract(t, stores, async () => { await drivers[0].close(); drivers[0] = make(); stores[0] = forPostgresDirectConnectStore(drivers[0]) })
})
