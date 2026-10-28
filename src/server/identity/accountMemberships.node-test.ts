import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SqliteDriver } from '../db/driver.js'
import { ACCOUNT_MEMBERSHIP_BACKFILL, ACCOUNT_MEMBERSHIP_SCHEMA, AccountMemberships } from './accountMemberships.js'

let db: DatabaseSync
let accounts: AccountMemberships
const original = { id: 'ethan-opc', orgId: 'opc', phone: '13900000001', createdAt: 1 }
const company = { id: 'ethan-company', orgId: 'company', createdAt: 2 }

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE users (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
      status TEXT NOT NULL DEFAULT 'active', role TEXT, model_key TEXT, password_hash TEXT,
      phone TEXT UNIQUE, created_at BIGINT NOT NULL DEFAULT 1);
    INSERT INTO organizations VALUES ('opc'), ('company'), ('unrelated');
    INSERT INTO users VALUES ('ethan-opc', 'opc', 'active', 'admin', 'opc-key', 'opc-password', '13900000001', 1);
    INSERT INTO users VALUES ('ethan-company', 'company', 'active', 'user', 'company-key', NULL, NULL, 2);
    ${ACCOUNT_MEMBERSHIP_SCHEMA}`)
  accounts = new AccountMemberships(new SqliteDriver(db))
})
afterEach(() => db.close())

void test('expanding the same human into another company preserves both identities and credentials', async () => {
  const before = db.prepare('SELECT * FROM users WHERE id = ?').get(original.id)
  const first = await accounts.ensureExisting(original)
  await accounts.attach(first.accountId, company)
  assert.deepEqual((await accounts.listActive(first.accountId)).map(member => member.orgId), ['opc', 'company'])
  assert.deepEqual(db.prepare('SELECT * FROM users WHERE id = ?').get(original.id), before)
  assert.equal((await accounts.inOrganization(first.accountId, 'company'))?.userId, company.id)
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(company.id)?.password_hash, null)
})

void test('initialization and repeated linking are idempotent', async () => {
  const first = await accounts.ensureExisting(original)
  assert.deepEqual(await accounts.ensureExisting(original), first)
  assert.deepEqual(await accounts.attach(first.accountId, original), first)
  db.exec(ACCOUNT_MEMBERSHIP_SCHEMA)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_accounts').get()?.n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_account_memberships').get()?.n, 1)
})

void test('a member cannot be relinked to another human account', async () => {
  const first = await accounts.ensureExisting(original)
  const second = await accounts.ensureExisting(company)
  await assert.rejects(accounts.attach(first.accountId, company), /identity is immutable/)
  assert.equal((await accounts.forUser(company.id))?.accountId, second.accountId)
})

void test('an account has at most one member identity in each company', async () => {
  await accounts.ensureExisting(original)
  db.prepare('INSERT INTO users (id, org_id) VALUES (?, ?)').run('duplicate-opc', 'opc')
  await assert.rejects(accounts.attach(original.id, { id: 'duplicate-opc', orgId: 'opc', createdAt: 3 }), /UNIQUE/)
  assert.equal(await accounts.forUser('duplicate-opc'), null)
})

void test('membership organization must match its authoritative user record', async () => {
  await accounts.ensureExisting(original)
  await assert.rejects(accounts.attach(original.id, { ...company, orgId: 'unrelated' }), /FOREIGN KEY/)
  assert.equal(await accounts.forUser(company.id), null)
})

void test('revocation or removing one membership retains the other company and phone login identity', async () => {
  await accounts.ensureExisting(original)
  await accounts.attach(original.id, company)
  db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(original.id)
  assert.deepEqual((await accounts.listActive(original.id)).map(member => member.userId), [company.id])
  db.prepare('DELETE FROM users WHERE id = ?').run(original.id)
  assert.equal((await accounts.findAccountByPhone(original.phone))?.id, original.id)
  assert.deepEqual((await accounts.listActive(original.id)).map(member => member.userId), [company.id])
})

void test('a disabled human account cannot add or use enterprise memberships', async () => {
  await accounts.ensureExisting(original)
  db.prepare("UPDATE human_accounts SET status = 'disabled' WHERE id = ?").run(original.id)
  await assert.rejects(accounts.attach(original.id, company), /unavailable/)
  assert.deepEqual(await accounts.listActive(original.id), [])
})

void test('legacy backfill and restart preserve user records, credentials and explicit memberships', async () => {
  const before = db.prepare('SELECT * FROM users ORDER BY id').all()
  db.exec(ACCOUNT_MEMBERSHIP_BACKFILL)
  assert.equal((await accounts.findAccountByPhone(original.phone))?.id, original.id)
  assert.equal((await accounts.forUser(company.id))?.accountId, company.id)
  assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all(), before)
  const snapshot = db.prepare('SELECT * FROM human_account_memberships ORDER BY user_id').all()
  db.exec(ACCOUNT_MEMBERSHIP_SCHEMA + ACCOUNT_MEMBERSHIP_BACKFILL)
  assert.deepEqual(db.prepare('SELECT * FROM human_account_memberships ORDER BY user_id').all(), snapshot)
  assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all(), before)
})

void test('restart does not split a newly added company member into another human account', async () => {
  await accounts.ensureExisting(original)
  await accounts.attach(original.id, company)
  db.exec(ACCOUNT_MEMBERSHIP_SCHEMA + ACCOUNT_MEMBERSHIP_BACKFILL)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_accounts').get()?.n, 1)
  assert.equal((await accounts.forUser(company.id))?.accountId, original.id)
})

void test('a legacy migration may supply the verified phone after account backfill without changing its account id', async () => {
  await accounts.ensureExisting({ ...original, phone: null })
  assert.equal((await accounts.getAccount(original.id))?.phone, null)
  await accounts.ensureExisting(original)
  assert.equal((await accounts.findAccountByPhone(original.phone))?.id, original.id)
  assert.equal((await accounts.forUser(original.id))?.accountId, original.id)
})
