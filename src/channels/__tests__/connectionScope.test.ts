/**
 * 多连接隔离单元测试 / Connection-scoping unit tests
 *
 * A channel type may have several connections (e.g. two WeCom bots). These cover the two
 * properties that keeps safe:
 * - an existing single-connection install is untouched by the upgrade (a type's FIRST
 *   connection keeps the bare platform as its scope, so old rows still resolve);
 * - two bots never share an authorization or a conversation.
 */

import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  pluginScope,
  scopedChatId,
  pluginTypeFromId,
  defaultPluginId,
  generatePluginId,
} from '../types.js'

describe('scope helpers', () => {
  it("treats a type's first connection as the bare platform, so legacy rows still resolve", () => {
    expect(pluginScope('wecom_default', 'wecom')).toBe('wecom')
    expect(pluginScope('wecom', 'wecom')).toBe('wecom')
    expect(pluginScope(undefined, 'wecom')).toBe('wecom')
    expect(scopedChatId('wecom_default', 'wecom', 'user:zhang')).toBe('user:zhang')
  })

  it('gives every additional connection its own scope', () => {
    expect(pluginScope('wecom_a1b2c3d4', 'wecom')).toBe('wecom_a1b2c3d4')
    expect(scopedChatId('wecom_a1b2c3d4', 'wecom', 'user:zhang')).toBe('wecom_a1b2c3d4#user:zhang')
  })

  it('never lets two bots share a chat key for the same person', () => {
    // A DM's chatId is derived from the platform user, so both bots see the same raw id.
    const botA = scopedChatId('wecom_default', 'wecom', 'user:zhang')
    const botB = scopedChatId('wecom_a1b2c3d4', 'wecom', 'user:zhang')
    expect(botA).not.toBe(botB)
  })

  it('round-trips the type out of a plugin id', () => {
    expect(pluginTypeFromId('wecom_a1b2c3d4')).toBe('wecom')
    expect(pluginTypeFromId('wecom_default')).toBe('wecom')
    expect(pluginTypeFromId('telegram')).toBe('telegram')
    expect(pluginTypeFromId('ext-feishu')).toBe('ext-feishu')
    expect(pluginTypeFromId(defaultPluginId('lark'))).toBe('lark')
    expect(pluginTypeFromId(generatePluginId('dingtalk'))).toBe('dingtalk')
  })

  it('generates distinct ids so a deleted connection is never reused', () => {
    expect(generatePluginId('wecom')).not.toBe(generatePluginId('wecom'))
  })
})

/** Rebuild the pre-migration schema so the migration runs against a realistic old database. */
function seedLegacyDb(): Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE channel_users (
      id TEXT PRIMARY KEY, platform_user_id TEXT NOT NULL, platform_type TEXT NOT NULL,
      display_name TEXT, authorized_at INTEGER NOT NULL, last_active INTEGER,
      session_id TEXT, org_id TEXT, user_id TEXT,
      UNIQUE(platform_user_id, platform_type, user_id)
    );
    CREATE TABLE channel_pairing_requests (
      code TEXT PRIMARY KEY, platform_user_id TEXT NOT NULL, platform_type TEXT NOT NULL,
      display_name TEXT, requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      status TEXT NOT NULL, user_id TEXT
    );
  `)
  db.exec(`INSERT INTO channel_users VALUES ('cu1','zhang','wecom','Zhang',100,NULL,NULL,'org1','u1')`)
  db.exec(`INSERT INTO channel_pairing_requests VALUES ('123456','li','lark','Li',1,999,'pending','u1')`)
  return db
}

/** The same statements db.ts runs on startup. */
function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE channel_users_new (
      id TEXT PRIMARY KEY, platform_user_id TEXT NOT NULL, platform_type TEXT NOT NULL,
      plugin_scope TEXT NOT NULL DEFAULT '', display_name TEXT, authorized_at INTEGER NOT NULL,
      last_active INTEGER, session_id TEXT, org_id TEXT, user_id TEXT,
      UNIQUE(platform_user_id, plugin_scope, user_id)
    );
    INSERT OR IGNORE INTO channel_users_new
      (id, platform_user_id, platform_type, plugin_scope, display_name, authorized_at, last_active, session_id, org_id, user_id)
      SELECT id, platform_user_id, platform_type, platform_type, display_name, authorized_at, last_active, session_id, org_id, user_id
        FROM channel_users;
    DROP TABLE channel_users;
    ALTER TABLE channel_users_new RENAME TO channel_users;
  `)
  db.exec(`ALTER TABLE channel_pairing_requests ADD COLUMN plugin_scope TEXT`)
  db.exec(`UPDATE channel_pairing_requests SET plugin_scope = platform_type WHERE plugin_scope IS NULL`)
}

describe('channel_users plugin_scope migration', () => {
  it('preserves existing rows and backfills the scope from the platform', () => {
    const db = seedLegacyDb()
    migrate(db)

    const user = db.query(`SELECT * FROM channel_users WHERE id='cu1'`).get() as Record<string, unknown>
    expect(user.plugin_scope).toBe('wecom')
    expect(user.display_name).toBe('Zhang')
    expect(user.authorized_at).toBe(100)

    const pairing = db.query(`SELECT * FROM channel_pairing_requests WHERE code='123456'`).get() as Record<string, unknown>
    expect(pairing.plugin_scope).toBe('lark')
  })

  it('keeps a pre-upgrade authorization resolvable under the bare platform', () => {
    const db = seedLegacyDb()
    migrate(db)
    const found = db
      .query(`SELECT * FROM channel_users WHERE platform_user_id=? AND plugin_scope=? AND user_id=?`)
      .get('zhang', 'wecom', 'u1')
    expect(found).toBeTruthy()
  })

  it('lets two bots of one type authorize the same person independently', () => {
    const db = seedLegacyDb()
    migrate(db)
    db.exec(`INSERT INTO channel_users (id,platform_user_id,platform_type,plugin_scope,authorized_at,user_id)
             VALUES ('cu2','zhang','wecom','wecom_a1b2c3d4',200,'u1')`)

    const rows = db
      .query(`SELECT * FROM channel_users WHERE platform_user_id='zhang' ORDER BY authorized_at`)
      .all() as Array<Record<string, unknown>>
    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.plugin_scope)).toEqual(['wecom', 'wecom_a1b2c3d4'])
  })

  it('still rejects a duplicate authorization on the same connection', () => {
    const db = seedLegacyDb()
    migrate(db)
    expect(() =>
      db.exec(`INSERT INTO channel_users (id,platform_user_id,platform_type,plugin_scope,authorized_at,user_id)
               VALUES ('dup','zhang','wecom','wecom',300,'u1')`),
    ).toThrow()
  })
})
