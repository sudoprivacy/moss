import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { AuthCenterDb } from './db.js'
import { forPostgresDirectConnectStore } from '../db.js'
import { PgDriver, type PgPoolLike } from '../db/driver.js'
import { applyPgSchema } from '../db/pg_schema.js'

void test('PostgreSQL avatar migration upgrades existing databases and persists account-isolated profiles',
  { skip: !process.env.MOSS_PG_TEST_URL }, async t => {
    const schema = `profile_avatar_${randomUUID().replaceAll('-', '')}`
    const config = { connectionString: process.env.MOSS_PG_TEST_URL }
    const admin = new Pool(config)
    await admin.query(`CREATE SCHEMA ${schema}`)
    const driver = new PgDriver(new Pool({ ...config, options: `-c search_path=${schema}` }) as unknown as PgPoolLike)
    const peer = new PgDriver(new Pool({ ...config, options: `-c search_path=${schema}` }) as unknown as PgPoolLike)
    t.after(async () => {
      await driver.close(); await peer.close()
      await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
    })
    await applyPgSchema(driver)
    // Recreate an already-deployed v13 database: initial migrations must not be replayed.
    await driver.exec('DROP TABLE user_profile_avatars; DELETE FROM _migrations WHERE version = 14')
    await applyPgSchema(driver)
    const first = new AuthCenterDb(forPostgresDirectConnectStore(driver))
    const second = new AuthCenterDb(forPostgresDirectConnectStore(peer))
    await driver.run("INSERT INTO organizations (id, name, created_at) VALUES ('org', 'Company', 1)")
    for (const id of ['a', 'b']) await driver.run('INSERT INTO users (id, org_id, email, name, created_at) VALUES (?, ?, ?, ?, ?)', [id, 'org', `${id}@example.test`, id, 1])
    await first.setUserAvatar('a', 'data:image/webp;base64,first')
    assert.equal(await second.getUserAvatar('a'), 'data:image/webp;base64,first')
    assert.equal(await second.getUserAvatar('b'), null)
    await applyPgSchema(peer)
    assert.equal(await second.getUserAvatar('a'), 'data:image/webp;base64,first')
    await second.setUserAvatar('a', 'data:image/webp;base64,updated')
    assert.equal(await first.getUserAvatar('a'), 'data:image/webp;base64,updated')
    await first.setUserAvatar('a', null)
    assert.equal(await second.getUserAvatar('a'), null)
  })
