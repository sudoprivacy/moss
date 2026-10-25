import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { PgDriver, type DbDriver, type PgPoolLike } from './db/driver.js'
import { applyPgSchema } from './db/pg_schema.js'
import { IdentityRepository } from './identity/identityRepository.js'
import { MossAgentAccess } from './mossAgentAccess.js'
import type { AuthContext } from './auth/token.js'
import { createIdentityTestRepository } from './testing/compatibilityRepositories.js'
import { MossImIdentity, verifyMossLarkMessage } from './mossImIdentity.js'
import { ResourceAccessError } from './catalog/resourceError.js'
import { mossImFixture, mossImMessage } from './testing/mossIm.fixture.js'

void test('private proof binds the actual logged-in human once, with no bot-owner or display-name inference', async () => {
  const f = await mossImFixture()
  try {
    assert.equal(await f.service.resolve(f.connection, 'feishu-alice'), null)
    const code = (await f.service.issueChallenge(f.connection, 'feishu-alice'))!
    assert.match(code, /^[A-Za-z0-9_-]{32}$/)
    const row = await f.db.driver.get('SELECT * FROM moss_im_link_challenges')
    assert(!JSON.stringify(row).includes(code), 'plaintext proof must never be persisted')
    await assert.rejects(f.service.bind(f.auth('alice', { authApp: undefined }), code), ResourceAccessError)
    await assert.rejects(f.service.bind(f.auth('foreign'), code), ResourceAccessError)
    await f.service.bind(f.auth('alice'), code)
    const route = (await f.service.resolve(f.connection, 'feishu-alice'))!
    assert.equal(route.userId, 'alice')
    assert.notEqual(route.userId, f.connection.ownerId)
    assert.equal(route.role, 'user')
    assert(!route.scopes.includes('*'))
    await assert.rejects(f.service.bind(f.auth('bob'), code), ResourceAccessError)
    assert.equal(await f.service.issueChallenge(f.connection, 'feishu-alice'), null, 'private challenges are rate-limited')
    const reopened = new MossImIdentity(f.db.driver, createIdentityTestRepository(f.raw, {}, f.db.driver), f.access, () => ['sessions:create', 'sessions:attach'])
    assert.equal((await reopened.resolve(f.connection, 'feishu-alice'))!.agentRef, route.agentRef)
  } finally { f.raw.close() }
})

void test('tenant, bot, connection and unstable message identities cannot dispatch; configuration preserves secrets', async () => {
  const f = await mossImFixture()
  try {
    assert.equal(verifyMossLarkMessage(mossImMessage(), f.connection).senderId, 'feishu-alice')
    const scopedSender = mossImMessage()
    const rawSender = (scopedSender.raw as { event: { sender: { sender_id: { user_id?: string; open_id?: string } } } }).event.sender.sender_id
    rawSender.open_id = 'ou_stable_app_member'
    assert.equal(verifyMossLarkMessage(scopedSender, f.connection).senderId, 'ou_stable_app_member')
    delete rawSender.user_id
    scopedSender.user.id = rawSender.open_id
    assert.equal(verifyMossLarkMessage(scopedSender, f.connection).senderId, 'ou_stable_app_member',
      'optional employee ID visibility does not change the human binding subject')
    for (const change of [
      (m: any) => { m.raw.event.sender.tenant_key = 'foreign' },
      (m: any) => { m.raw.event.sender.sender_type = 'app' },
      (m: any) => { delete m.raw.event.message.message_id },
      (m: any) => { m.id = 'forged' },
      (m: any) => { m.user.id = 'forged' },
    ]) { const message = mossImMessage(); change(message); assert.throws(() => verifyMossLarkMessage(message, f.connection), ResourceAccessError) }
    await assert.rejects(f.service.connection('lark-qa', 'owner', 'cli_wrong'), ResourceAccessError)
    await assert.rejects(f.service.configure(f.auth('alice'), 'lark-qa', 'owner', 'cli_testMoss', 'tenantqa123'), ResourceAccessError)
    const plugin = await f.db.driver.get('SELECT * FROM channel_plugins')
    assert.equal(plugin!.credentials_json, '{"preserve":"private"}')
    assert.equal(JSON.parse(String(plugin!.config_json)).otherSetting, 42)
    const code = (await f.service.issueChallenge(f.connection, 'sender'))!
    await f.service.configure(f.auth('owner'), 'lark-qa', 'owner', 'cli_testMoss', 'tenantqa123')
    assert.equal((await f.service.connection('lark-qa', 'owner'))!.scope, f.connection.scope,
      'an identical configuration retry preserves the existing namespace and proof')
    await f.service.bind(f.auth('alice'), code)
    await f.db.driver.run('UPDATE channel_plugins SET config_json = ?', ['{"identityMode":"owner","mossAppId":"cli_wrong"}'])
    assert.equal((await f.service.connection('lark-qa', 'owner'))!.scope, f.connection.scope,
      'ordinary channel settings cannot downgrade the administrator member configuration')
    assert.equal((await f.service.resolve(f.connection, 'sender'))!.userId, 'alice')
    const stale = (await f.service.issueChallenge(f.connection, 'changed-pins'))!
    await f.service.configure(f.auth('owner'), 'lark-qa', 'owner', 'cli_replacement', 'tenantqa123')
    await assert.rejects(f.service.bind(f.auth('bob'), stale), ResourceAccessError)
  } finally { f.raw.close() }
})

void test('persisted per-human pointers survive reopen, compare changes and never follow Web activity; duplicate events stay claimed', async () => {
  const f = await mossImFixture()
  try {
    for (const user of ['alice', 'bob']) await f.service.bind(f.auth(user), (await f.service.issueChallenge(f.connection, `feishu-${user}`))!)
    const alice = (await f.service.resolve(f.connection, 'feishu-alice'))!
    const bob = (await f.service.resolve(f.connection, 'feishu-bob'))!
    await f.service.setPointer(alice, 'same-group', 'alice-session', null)
    await f.service.setPointer(bob, 'same-group', 'bob-session', null)
    assert.notEqual(f.service.conversationKey(alice, 'same-group'), f.service.conversationKey(bob, 'same-group'))
    const reopened = new MossImIdentity(f.db.driver, createIdentityTestRepository(f.raw, {}, f.db.driver), f.access, () => [])
    assert.equal(await reopened.pointer(alice, 'same-group'), 'alice-session')
    assert.equal(await reopened.pointer(bob, 'same-group'), 'bob-session')
    await assert.rejects(reopened.setPointer(alice, 'same-group', 'stale', null), ResourceAccessError)
    await reopened.setPointer(alice, 'same-group', 'new-session', 'alice-session')
    const event = verifyMossLarkMessage(mossImMessage(), f.connection)
    assert.equal(await f.service.claim(f.connection, event), true)
    await f.service.delivery(f.connection, event.messageId, 'dispatching', alice, 'new-session')
    assert.equal(await reopened.claim(f.connection, event), false, 'unknown dispatch is not replayed after restart')
    await f.access.setAccess(f.auth('owner'), 'alice', false)
    await assert.rejects(reopened.assertRoute(alice), ResourceAccessError)
    await f.service.unlink(f.auth('alice'), alice.bindingId)
    assert.equal(await f.service.resolve(f.connection, 'feishu-alice'), null)
    assert.equal(await reopened.pointer(alice, 'same-group'), 'new-session', 'unlink retains durable history and mapping')
  } finally { f.raw.close() }
})

void test('expired proofs, moved members and changed binding identities cannot retain execution authority', async () => {
  const f = await mossImFixture()
  try {
    const expired = (await f.service.issueChallenge(f.connection, 'expired'))!
    await f.db.driver.run('UPDATE moss_im_link_challenges SET expires_at = 1')
    await assert.rejects(f.service.bind(f.auth('alice'), expired), ResourceAccessError)
    await f.service.bind(f.auth('alice'), (await f.service.issueChallenge(f.connection, 'real'))!)
    const route = (await f.service.resolve(f.connection, 'real'))!
    await assert.rejects(f.service.unlink(f.auth('bob'), route.bindingId), ResourceAccessError)
    await f.db.driver.run("UPDATE users SET role = 'admin' WHERE id = 'alice'")
    await assert.rejects(f.service.assertRoute(route), ResourceAccessError)
    await f.db.driver.run("UPDATE users SET org_id = 'org-b' WHERE id = 'alice'")
    await assert.rejects(f.service.resolve(f.connection, 'real'), ResourceAccessError)
  } finally { f.raw.close() }
})

void test('real PostgreSQL pools enforce one-use human proof, pointer CAS and durable event claims',
  { skip: !process.env.MOSS_PG_TEST_URL }, async t => {
    const schema = `moss_im_${randomUUID().replaceAll('-', '')}`
    const config = { connectionString: process.env.MOSS_PG_TEST_URL }
    const admin = new Pool(config)
    await admin.query(`CREATE SCHEMA ${schema}`)
    const drivers = [0, 1].map(() => new PgDriver(new Pool({ ...config, options: `-c search_path=${schema}` }) as unknown as PgPoolLike))
    t.after(async () => { await Promise.all(drivers.map(driver => driver.close())); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() })
    const first = drivers[0]!
    await applyPgSchema(first)
    await first.run('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)', ['org-a', 'QA', 1])
    for (const id of ['owner', 'alice', 'bob']) await first.run(`INSERT INTO users
      (id, org_id, email, name, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, 'org-a', `${id}@example.test`, id, id === 'owner' ? 'admin' : 'user', 'active', 1])
    await first.run(`INSERT INTO channel_plugins
      (id, type, name, enabled, status, user_id, org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['lark-qa', 'lark', 'QA Moss', 1, 'running', 'owner', 'org-a', 1, 1])
    const factory = (driver: DbDriver) => {
      const access = new MossAgentAccess(driver, async id => {
        const row = await driver.get('SELECT id, org_id, role, status FROM users WHERE id = ?', [id])
        return row ? { id: String(row.id), orgId: String(row.org_id), role: String(row.role), status: String(row.status) } : null
      })
      return { access, service: new MossImIdentity(driver, new IdentityRepository(driver), access, () => ['sessions:create', 'sessions:attach']) }
    }
    const a = factory(first), b = factory(drivers[1]!)
    const auth = (id: string) => ({ userId: id, orgId: 'org-a', role: id === 'owner' ? 'admin' : 'user', authApp: 'moss', scopes: ['*'] }) as AuthContext
    for (const id of ['alice', 'bob']) await a.access.setAccess(auth('owner'), id, true)
    await a.service.configure(auth('owner'), 'lark-qa', 'owner', 'cli_testMoss', 'tenantqa123')
    const connection = (await a.service.connection('lark-qa', 'owner', 'cli_testMoss'))!
    await Promise.all([a.service.configure(auth('owner'), 'lark-qa', 'owner', 'cli_testMoss', 'tenantqa123'),
      b.service.configure(auth('owner'), 'lark-qa', 'owner', 'cli_testMoss', 'tenantqa123')])
    assert.equal((await b.service.connection('lark-qa', 'owner'))!.scope, connection.scope,
      'concurrent identical PUTs retain the same authoritative revision')
    const code = (await a.service.issueChallenge(connection, 'feishu-user'))!
    const bindings = await Promise.allSettled([a.service.bind(auth('alice'), code), b.service.bind(auth('bob'), code)])
    assert.equal(bindings.filter(result => result.status === 'fulfilled').length, 1)
    const route = (await b.service.resolve(connection, 'feishu-user'))!
    assert(['alice', 'bob'].includes(route.userId))
    await a.service.setPointer(route, 'same-chat', 'initial', null)
    const moves = await Promise.allSettled([a.service.setPointer(route, 'same-chat', 'next-a', 'initial'), b.service.setPointer(route, 'same-chat', 'next-b', 'initial')])
    assert.equal(moves.filter(result => result.status === 'fulfilled').length, 1)
    const event = { senderId: 'feishu-user', chatId: 'same-chat', messageId: 'once' }
    const claims = await Promise.all([a.service.claim(connection, event), b.service.claim(connection, event)])
    assert.equal(claims.filter(Boolean).length, 1)
    await a.service.delivery(connection, 'once', 'dispatching', route, (await a.service.pointer(route, 'same-chat'))!)
    assert.equal(await b.service.claim(connection, event), false)
    await a.access.setAccess(auth('owner'), route.userId, false)
    await assert.rejects(b.service.assertRoute(route), ResourceAccessError)
  })
