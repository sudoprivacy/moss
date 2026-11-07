import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { SudographReviewHost, type ISudographReviewGrant, type ShareoneReviewAssets } from '@sudowork/sudograph-runtime'
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

  await t.test('active leases renew monotonically across controllers without invalidating concurrent metadata', async () => {
    const key = randomUUID().replaceAll('-', '')
    const initial = value(alice, key)
    await create().create(key, initial)
    now += 10 * 60_000
    const deadlines = [now + 30 * 60_000, now + 20 * 60_000]
    assert.deepEqual(await Promise.all(deadlines.map((deadline, index) => create(index).renew(key, initial, deadline))), [true, true])
    assert.equal(await create(1).update(key, initial, { shareId: 'same-private-share', revision: 'same-model' }), true)
    await reopen()
    now += 15 * 60_000
    assert.ok(now > initial.expiresAt, 'the same lease outlives its initial deadline')
    const renewed = { ...initial, expiresAt: Math.max(...deadlines), shareId: 'same-private-share', revision: 'same-model' }
    assert.deepEqual(await create(1).get(key), renewed)
    for (const deadline of [now - 1, now + 31 * 60_000, Number.NaN, now + 0.5]) {
      assert.equal(await create().renew(key, initial, deadline), false)
    }
    for (const change of [{ credentialHash: 'b'.repeat(64) }, { conversationId: bob.sessionId },
      { authorizationRef: 'sha256:' + 'b'.repeat(64) }, { cookieName: 'foreign-cookie' }]) {
      assert.equal(await create().renew(key, { ...initial, ...change }, now + 30 * 60_000), false)
    }
    assert.deepEqual(await create().get(key), renewed)
    now += 31 * 60_000
    assert.equal(await create().get(key), undefined)
    assert.equal(await create().renew(key, initial, now + 30 * 60_000), false)
    assert.equal(await create().update(key, initial, { revision: 'resurrected' }), false)
    assert.equal(Number((await stores[0].driver.get('SELECT expires_at FROM ontology_review_grants WHERE id=?', [key]))?.expires_at), renewed.expiresAt)
  })

  await t.test('a policy change during renewal rolls back the extension and storage faults stay visible', async () => {
    const key = randomUUID().replaceAll('-', '')
    const initial = value(alice, key)
    await create().create(key, initial)
    let reads = 0
    const changed = new OntologyReviewGrantStore(stores[0].driver, { resolveSession: async sessionId => {
      const binding = await stores[0].ontologyProjects.resolveSession(sessionId)
      return ++reads === 1 || !binding ? binding : { ...binding, userId: 'replacement-owner' }
    } }, () => now)
    assert.equal(await changed.renew(key, initial, now + 30 * 60_000), false)
    assert.deepEqual(await create().get(key), { ...initial, shareId: null })
    const failure = new Error('fixture database outage')
    const unavailable = new OntologyReviewGrantStore(stores[0].driver, { resolveSession: async () => { throw failure } }, () => now)
    await assert.rejects(unavailable.renew(key, initial, now + 30 * 60_000), error => error === failure)
    assert.deepEqual(await create().get(key), { ...initial, shareId: null })
    await create().delete(key)
  })

  await t.test('the installed SDK renews durable leases across HTTP host and database replacement', async () => {
    const hosts: SudographReviewHost[] = []
    let current: SudographReviewHost | undefined
    const server = createServer((request, response) => {
      if (!current) { response.writeHead(503).end(); return }
      void current.handleRequest(request, response).then(handled => { if (!handled) response.writeHead(404).end() })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    let preparations = 0
    const make = (index: number) => {
      const host = new SudographReviewHost({
        now: () => now,
        embedded: { origin, grants: create(index) },
        authorize: async binding => {
          const durable = await stores[index].ontologyProjects.resolveSession(binding.conversationId)
          if (!durable || durable.projectId !== binding.workspaceId || durable.userId !== alice.userId) throw new Error('Review owner changed')
          return reviewAuthorizationRef(durable)
        },
        read: async (_workspace, request) => request.operation === 'document'
          ? { html: '<html>Canonical model</html>', revision: 'revision-a' }
          : { revision: 'revision-a' },
        comments: {
          assets: {} as ShareoneReviewAssets,
          prepare: async () => { preparations++; return { shareId: 'private-share' } },
          proxy: async binding => ({ status: 200, body: { shareId: (binding as ISudographReviewGrant).shareId, revision: binding.revision } }),
          status: () => ({ delivered: 1 }),
        },
      })
      hosts.push(host)
      return host
    }
    try {
      current = make(0)
      const launch = await current.createSession({ workspaceId: alice.projectId, conversationId: alice.sessionId, authorizationRef: reviewAuthorizationRef(alice) })
      const key = new URL(launch.url).pathname.split('/')[2]
      const headers = { Cookie: `${launch.cookie.name}=${launch.cookie.value}` }
      const originalGrant = await create(1).get(key)
      assert.ok(originalGrant)
      assert.deepEqual(await (await fetch(launch.url + 'connection', { headers })).json(), { state: 'ready', share_id: 'private-share' })
      const document = await fetch(launch.url + 'content', { headers })
      assert.equal(document.status, 200)
      assert.equal(await document.text(), '<html>Canonical model</html>')
      now += 20 * 60_000
      const renewed = await fetch(launch.url + 'delivery', { headers })
      assert.equal(renewed.status, 200)
      assert.deepEqual(await renewed.json(), { delivered: 1 })
      assert.match(renewed.headers.get('set-cookie')!, /Max-Age=1800;/)
      assert.equal(await create(1).update(key, originalGrant, { revision: 'revision-a' }), true, 'a concurrent metadata writer may retain the initial deadline')
      await current.close()
      await reopen()
      current = make(1)
      now += 20 * 60_000
      assert.ok(now > originalGrant.expiresAt, 'the unchanged browser credential outlives the original lease')
      const restored = await fetch(launch.url + 'api/v1/threads', { headers })
      assert.equal(restored.status, 200)
      assert.deepEqual(await restored.json(), { shareId: 'private-share', revision: 'revision-a' })
      assert.match(restored.headers.get('set-cookie')!, /Max-Age=1800;/)
      assert.equal(preparations, 1, 'host replacement reuses the original private share')
      const persisted = await create().get(key)
      assert.equal(persisted?.expiresAt, now + 30 * 60_000)
      assert.equal(persisted?.credentialHash, originalGrant.credentialHash)
      now += 31 * 60_000
      const expired = await fetch(launch.url + 'delivery', { headers })
      assert.equal(expired.status, 403)
      assert.equal(expired.headers.get('set-cookie'), null)
      await expired.text()
      const fresh = await current.createSession({ workspaceId: alice.projectId, conversationId: alice.sessionId, authorizationRef: reviewAuthorizationRef(alice) })
      await create().delete(new URL(fresh.url).pathname.split('/')[2])
      const revoked = await fetch(fresh.url + 'delivery', { headers: { Cookie: `${fresh.cookie.name}=${fresh.cookie.value}` } })
      assert.equal(revoked.status, 403)
      assert.equal(revoked.headers.get('set-cookie'), null)
      await revoked.text()
    } finally {
      await Promise.all(hosts.map(host => host.close()))
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
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
    const disabledKey = randomUUID().replaceAll('-', '')
    const disabledGrant = value(alice, disabledKey)
    await create().create(disabledKey, disabledGrant)
    await stores[0].ontologyProjects.setEnabled(alice.orgId, alice.projectId, false)
    await assert.rejects(stores[1].ontologyProjects.resolveSession(alice.sessionId))
    assert.equal(await create().renew(disabledKey, disabledGrant, now + 30 * 60_000), false)
    assert.equal((await create().get(disabledKey))?.expiresAt, disabledGrant.expiresAt)
    await stores[0].ontologyProjects.setEnabled(alice.orgId, alice.projectId, true)
    const current = (await stores[1].ontologyProjects.resolveSession(alice.sessionId))!
    assert.notEqual(reviewAuthorizationRef(current), oldRef)
    assert.equal(await create().renew(disabledKey, disabledGrant, now + 30 * 60_000), false)
    const key = randomUUID().replaceAll('-', '')
    await assert.rejects(create().create(key, value(alice, key)))
    await create().create(key, value(current, key))
    await stores[0].driver.run('UPDATE sessions SET user_id=? WHERE session_id=?', ['different-owner', alice.sessionId])
    assert.equal(await create().renew(key, value(current, key), now + 30 * 60_000), false)
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
