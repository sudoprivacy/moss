import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import pg from 'pg'
import { PgDriver, type PgPoolLike } from '../db/driver.js'
import { applyPgSchema, MIGRATIONS } from '../db/pg_schema.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { forPostgresDirectConnectStore } from '../db.js'
import { IdentityRepository } from './identityRepository.js'
import { UnifiedIdentityService } from './unifiedIdentityService.js'
import { onlineCommandContext } from '../application/commandContext.js'
import { AccountMemberships } from './accountMemberships.js'

void test('PostgreSQL account migration preserves old identities and concurrent membership creation stays unique',
  { skip: !process.env.MOSS_PG_TEST_URL }, async () => {
    const connectionString = process.env.MOSS_PG_TEST_URL!
    const schema = `account_membership_${randomUUID().replaceAll('-', '')}`
    const admin = new pg.Pool({ connectionString, max: 1 })
    await admin.query(`CREATE SCHEMA ${schema}`)
    const drivers = [0, 1].map(() => new PgDriver(new pg.Pool({ connectionString,
      options: `-c search_path=${schema}`, max: 2 }) as unknown as PgPoolLike))
    try {
      const first = drivers[0]
      // Start from the complete previous production schema, then run the real
      // versioned upgrade over existing user/model-credential rows.
      await first.exec('CREATE TABLE _migrations (version BIGINT PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)')
      for (const migration of MIGRATIONS.filter(m => m.name !== 'human-account-memberships')) {
        await first.exec(migration.sql)
        await first.run('INSERT INTO _migrations VALUES (?, ?, ?)', [migration.version, migration.name, 1])
      }
      const auth = new AuthCenterDb(forPostgresDirectConnectStore(first))
      await auth.createOrganization('opc', 'OPC', 1)
      await auth.createOrganization('company', 'Company', 1)
      await auth.createUser({ id: 'human', orgId: 'opc', name: 'original', displayName: 'Human',
        email: 'original@example.test', phone: '13900000001', departmentId: null,
        role: 'admin', status: 'active', localAuth: false, tokenLimit: null, createdAt: 1,
        passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null })
      await auth.setUserModelCredential('human', { sudorouterUserId: 'fixture-id', sudorouterKey: 'fixture-original-key' })
      const original = await first.get('SELECT * FROM users WHERE id = ?', ['human'])
      await Promise.all(drivers.map(applyPgSchema))
      assert.deepEqual(await first.get('SELECT * FROM users WHERE id = ?', ['human']), original)
      const accounts = new AccountMemberships(first)
      assert.equal((await accounts.findAccountByPhone('13900000001'))?.id, 'human')
      const attempts = await Promise.allSettled(drivers.map(async (driver, index) => {
        const identity = new UnifiedIdentityService(new AuthCenterDb(forPostgresDirectConnectStore(driver)), new IdentityRepository(driver))
        return identity.createUser({ orgId: 'company', username: `company-${index}`, accountId: 'human', role: 'user' },
          onlineCommandContext(`membership-${index}`))
      }))
      assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
      assert.equal(attempts.filter(result => result.status === 'rejected').length, 1)
      assert.equal(Number((await first.get('SELECT COUNT(*) AS n FROM users WHERE org_id = ?', ['company']))?.n), 1)
      const company = await accounts.inOrganization('human', 'company')
      assert(company)
      await assert.rejects(first.run('INSERT INTO human_account_memberships VALUES (?, ?, ?, ?)',
        ['human', 'opc', company.userId, 1]))
      await Promise.all(drivers.map(applyPgSchema))
      assert.equal((await accounts.forUser(company.userId))?.accountId, 'human')
      assert.deepEqual(await first.get('SELECT * FROM users WHERE id = ?', ['human']), original)
    } finally {
      await Promise.all(drivers.map(driver => driver.close()))
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
  })
