import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createServer } from 'node:http'
import { SudographReviewComments } from '@sudowork/sudograph-runtime'
import { DirectConnectStore } from '../db.js'
import { PgDriver, type DbDriver } from '../db/driver.js'
import { applyPgSchema } from '../db/pg_schema.js'
import { OntologyReviewStore } from './reviewStore.js'

async function contract(t: TestContext, drivers: DbDriver[], reopen: () => Promise<void>, isConcurrent: boolean) {
  const value = { id: 'subscription', workspaceId: 'project', conversationId: 'conversation', account: 'account', shareId: 'share' }
  const foreign = { ...value, workspaceId: 'foreign-project' }
  const create = (org = 'org', index = 0) => new OntologyReviewStore(drivers[index], org)
  const packet = (id: string) => ({ id, subscription: value, messageId: 'message-' + id,
    event: { id: 'event-' + id, share_id: value.shareId, comment_id: 'comment', parent_id: null,
      event_type: 'comment.created', actor_role: 'owner' } })

  await t.test('settings and immutable subscriptions are organization scoped', async () => {
    await create().setHostValue('review-installation', 'installation-a')
    await create('foreign').setHostValue('review-installation', 'installation-b')
    assert.equal(await create().getHostValue('review-installation'), 'installation-a')
    assert.equal(await create('foreign').getHostValue('review-installation'), 'installation-b')
    await create().subscribeReview(value)
    await create().subscribeReview(value)
    await create('foreign').subscribeReview(foreign)
    await assert.rejects(create().subscribeReview({ ...value, conversationId: 'retargeted' }), /cannot be rebound/)
    await assert.rejects(create().subscribeReview({ ...value, id: 'another-id' }), /cannot be rebound or duplicated/)
    assert.deepEqual(await create().reviewSubscriptions(value.workspaceId, value.shareId), [value])
    assert.deepEqual(await create('foreign').reviewSubscriptions(value.workspaceId, value.shareId), [])
  })

  await t.test('the entire event batch commits before returning and duplicate events retain their identity', async () => {
    const first = packet('first')
    await assert.rejects(create().acceptReviewEvents([first, { ...packet('foreign'), subscription: foreign }]), /subscription is unavailable/)
    assert.deepEqual(await create().reviewInbox(value.account), [], 'a failed batch cannot acknowledge a partial inbox')
    await create().acceptReviewEvents([first])
    await create().acceptReviewEvents([first])
    assert.equal((await create().reviewInbox(value.account)).length, 1)
    await assert.rejects(create().acceptReviewEvents([{ ...first, messageId: 'rebound' }]), /cannot be rebound/)
    await assert.rejects(create().acceptReviewEvents([{ ...first, id: 'duplicate-id' }]), /cannot be rebound/)
    assert.deepEqual(await create().reviewDeliverySummary(value.account, value.workspaceId, value.conversationId), { pending: 1 })
  })

  let winner = '', loser = ''
  const digest = 'a'.repeat(64)
  await t.test('independent delivery attempts claim one human input and retain recoverable outcomes', async () => {
    await create().acceptReviewEvents([packet('second')])
    const claims = await Promise.all([create().claimReviewInput('first', digest), create('org', isConcurrent ? 1 : 0).claimReviewInput('second', digest)])
    assert.equal(claims.filter(Boolean).length, 1)
    winner = claims[0] ? 'first' : 'second'
    loser = claims[0] ? 'second' : 'first'
    assert.equal(await create().claimReviewInput(winner, digest), true)
    assert.equal(await create().claimReviewInput(loser, digest), false)
    await create().finishReviewEvent(winner, 'error', 'DELIVERY_UNAVAILABLE')
    assert.deepEqual(await create().reviewDeliverySummary(value.account, value.workspaceId, value.conversationId), { failed: 1, ignored: 1 })
    await create().finishReviewEvent(winner, 'delivered')
    assert.deepEqual(await create().reviewInbox(value.account), [])
  })

  await t.test('reopening retains receipt, claims and deduplication without requeueing completed work', async () => {
    await reopen()
    assert.equal(await create().getHostValue('review-installation'), 'installation-a')
    assert.equal(await create().claimReviewInput(winner, digest), true)
    assert.equal(await create().claimReviewInput(loser, digest), false)
    await create().acceptReviewEvents([packet('first'), packet('second')])
    assert.deepEqual(await create().reviewDeliverySummary(value.account, value.workspaceId, value.conversationId), { delivered: 1, ignored: 1 })
    assert.deepEqual(await create().reviewInbox(value.account), [])
    await assert.rejects(create('foreign').finishReviewEvent(winner, 'running'), /unavailable/)
    await assert.rejects(create('foreign').claimReviewInput(winner, digest), /unavailable/)
    assert.deepEqual(await create('foreign').reviewDeliverySummary(value.account, value.workspaceId, value.conversationId), {})
  })

  await t.test('the installed shared provider waits for this durable inbox before acknowledging HTTP events', async child => {
    const database = create('provider-org')
    const settings = { viewer_scope: 'owner_and_collaborators', allow_comments: true, is_public: false }
    let acknowledgements = 0, deliveries = 0, serverError: unknown
    let complete!: () => void
    const completed = new Promise<void>(resolve => { complete = resolve })
    const http = createServer((req, res) => {
      void (async () => {
        assert.equal(req.headers['x-api-key'], 'fixture-provider-key')
        const route = new URL(req.url!, 'http://fixture.invalid').pathname
        let body: unknown = {}
        if (route === '/api/v1/me') body = { id: 'provider-owner' }
        else if (route === '/api/v1/pages') body = { share_id: 'provider-share', settings }
        else if (route.endsWith('/poll')) body = { events: [{ id: 'provider-event', share_id: 'provider-share',
          comment_id: 'provider-thread', parent_id: null, event_type: 'comment.created', actor_role: 'owner' }], lease_token: 'fixture-lease' }
        else if (route.endsWith('/ack')) {
          assert.equal((await database.reviewInbox('provider-account')).length, 1, 'provider ACK must follow the committed inbox')
          acknowledgements++
        } else if (route === '/api/v1/shares/provider-share/comments' && req.method === 'GET') {
          body = [{ id: 'provider-thread', content: 'Please review this definition.', quote: 'Source field',
            highlighter_data: { review_binding: { project: 'provider-project', conversation: 'provider-conversation' } } }]
        } else if (route === '/api/v1/shares/provider-share/comments' && req.method === 'POST') {
          assert.equal(acknowledgements, 1)
          assert.ok(req.headers['idempotency-key'])
          body = { id: 'provider-reply' }
        } else if (route !== '/api/v1/shares/provider-share/comments/changes' && !route.startsWith('/api/v1/agent-consumers/')) {
          throw new Error('Unexpected fixture request: ' + route)
        }
        req.resume()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      })().catch(error => { serverError = error; res.writeHead(500); res.end('{}') })
    })
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    assert.ok(address && typeof address !== 'string')
    const comments = new SudographReviewComments({ database, baseUrl: `http://127.0.0.1:${address.port}`,
      currentAccount: () => 'provider-account', getKey: async () => 'fixture-provider-key', setKey: async () => {},
      authorize: async binding => {
        assert.equal(binding.workspaceId, 'provider-project')
        assert.equal(binding.conversationId, 'provider-conversation')
      },
      head: async () => ({ revision: 'a'.repeat(64), context_digest: 'b'.repeat(64) }),
      messageExists: async () => false,
      deliver: async (input, hooks) => {
        deliveries++
        assert.equal(acknowledgements, 1)
        assert.equal(input.conversationId, 'provider-conversation')
        assert.equal(JSON.parse(input.agentContent).message, 'Please review this definition.')
        await hooks.onStarted()
        await hooks.onCompleted('Reviewed through the existing conversation port.')
        complete()
        return { success: true }
      },
    })
    child.after(async () => { comments.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())) })
    await comments.prepare('provider-project', 'provider-conversation')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([completed, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(serverError ?? new Error('Shared provider delivery did not complete')), 15000)
      })])
    } finally { clearTimeout(timer) }
    assert.equal(serverError, undefined)
    assert.equal(deliveries, 1)
    assert.equal(acknowledgements, 1)
    assert.deepEqual(await comments.status('provider-project', 'provider-conversation'), { delivered: 1 })
    assert.deepEqual(await database.getHostValue('review-result:' + (await drivers[0].get(
      "SELECT id FROM ontology_review_inbox WHERE org_id='provider-org'"))!.id),
    { text: 'Reviewed through the existing conversation port.' })
  })
}

void test('SQLite production initialization and reopened review delivery store', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-review-store-'))
  const path = join(root, 'host.db')
  const drivers: DbDriver[] = [new DirectConnectStore(path).driver]
  t.after(async () => { await drivers[0].close(); await rm(root, { recursive: true, force: true }) })
  await contract(t, drivers, async () => { await drivers[0].close(); drivers[0] = new DirectConnectStore(path).driver }, false)
})

void test('PostgreSQL production migration and independent review store controllers', { skip: !process.env.MOSS_PG_TEST_URL }, async t => {
  const pg = await import('pg')
  const connectionString = process.env.MOSS_PG_TEST_URL!
  const schema = 'review_store_' + randomUUID().replaceAll('-', '')
  const admin = new pg.default.Pool({ connectionString })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const make = () => new PgDriver(new pg.default.Pool({ connectionString, options: `-c search_path=${schema}` }) as never)
  const drivers: DbDriver[] = [make(), make()]
  t.after(async () => {
    await Promise.all(drivers.map(driver => driver.close()))
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  })
  await Promise.all(drivers.map(driver => applyPgSchema(driver)))
  assert.equal(Number((await drivers[0].get('SELECT max(version) AS version FROM _migrations'))?.version), 26)
  await contract(t, drivers, async () => { await drivers[0].close(); drivers[0] = make() }, true)
})
