import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { SudoworkIdentitySourceReader } from './sudoworkIdentitySourceReader.js'

describe('SudoworkIdentitySourceReader', () => {
  test('reads organizations, users and CAS identities from a frozen SQLite snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'moss-identity-source-'))
    const path = join(directory, 'sudowork.sqlite')
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE enterprises (id INTEGER PRIMARY KEY, name TEXT, code TEXT UNIQUE);
      CREATE TABLE users (
        id INTEGER PRIMARY KEY, phone TEXT, nickname TEXT, role TEXT, status INTEGER,
        enterprise_id INTEGER, password_hash TEXT, login_type INTEGER
      );
      CREATE TABLE third_party_auth_identities (
        id INTEGER PRIMARY KEY, provider_id TEXT, external_user_id TEXT,
        user_id INTEGER, enterprise_id INTEGER, raw_profile TEXT
      );
      INSERT INTO enterprises VALUES (7, '企业 A', 'ACME');
      INSERT INTO users VALUES (17, '13800000000', '用户 A', 'ENTERPRISE_ADMIN', 1, 7, '$2b$legacy', 2);
      INSERT INTO third_party_auth_identities VALUES (1, 'cas-main', 'subject-a', 17, 7, '{"account":"13800000000"}');
    `)
    db.close()
    try {
      const first = new SudoworkIdentitySourceReader(directory).readSnapshot()
      const second = new SudoworkIdentitySourceReader(directory).readSnapshot()
      assert.equal(first.checksum, second.checksum)
      assert.deepEqual(first.organizations, [{ legacyId: 7, name: '企业 A', code: 'ACME', codeVerified: true }])
      assert.equal(first.users[0].username, '13800000000')
      assert.equal(first.users[0].status, 'ACTIVE')
      assert.deepEqual(first.users[0].providerIdentity, { provider: 'cas', issuer: 'cas-main', subject: 'subject-a' })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('rejects users with missing organizations', () => {
    const directory = mkdtempSync(join(tmpdir(), 'moss-identity-source-'))
    const path = join(directory, 'sudowork.sqlite')
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE enterprises (id INTEGER PRIMARY KEY, name TEXT, code TEXT UNIQUE);
      CREATE TABLE users (
        id INTEGER PRIMARY KEY, phone TEXT, nickname TEXT, role TEXT, status INTEGER,
        enterprise_id INTEGER, password_hash TEXT, login_type INTEGER
      );
      CREATE TABLE third_party_auth_identities (
        id INTEGER PRIMARY KEY, provider_id TEXT, external_user_id TEXT,
        user_id INTEGER, enterprise_id INTEGER, raw_profile TEXT
      );
      INSERT INTO enterprises VALUES (7, '企业 A', 'ACME');
      INSERT INTO users VALUES (17, '13800000000', '用户 A', 'USER', 1, 99, NULL, 2);
      INSERT INTO third_party_auth_identities VALUES (1, 'cas-main', 'subject-a', 17, 99, '{}');
    `)
    db.close()
    try {
      assert.throws(() => new SudoworkIdentitySourceReader(directory).readSnapshot(), /企业/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('preserves every provider identity owned by the same legacy user', () => {
    const directory = mkdtempSync(join(tmpdir(), 'moss-identity-source-'))
    const path = join(directory, 'sudowork.sqlite')
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE enterprises (id INTEGER PRIMARY KEY, name TEXT, code TEXT UNIQUE);
      CREATE TABLE users (id INTEGER PRIMARY KEY, phone TEXT, nickname TEXT, role TEXT, status INTEGER, enterprise_id INTEGER, password_hash TEXT, login_type INTEGER);
      CREATE TABLE third_party_auth_identities (id INTEGER PRIMARY KEY, provider_id TEXT, external_user_id TEXT, user_id INTEGER, enterprise_id INTEGER, raw_profile TEXT);
      INSERT INTO enterprises VALUES (7, '企业 A', 'ACME');
      INSERT INTO users VALUES (17, NULL, '用户 A', 'USER', 1, 7, NULL, 2);
      INSERT INTO third_party_auth_identities VALUES (1, 'cas-main', 'subject-a', 17, 7, '{}');
      INSERT INTO third_party_auth_identities VALUES (2, 'cas-other', 'subject-b', 17, 7, '{}');
    `)
    db.close()
    try {
      const snapshot = new SudoworkIdentitySourceReader(directory).readSnapshot()
      assert.deepEqual(snapshot.users[0].providerIdentities, [
        { provider: 'cas', issuer: 'cas-main', subject: 'subject-a' },
        { provider: 'cas', issuer: 'cas-other', subject: 'subject-b' },
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
