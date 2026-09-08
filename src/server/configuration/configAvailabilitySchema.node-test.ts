import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { ensureConfigAvailabilitySchema } from './configAvailabilitySchema.js'

describe('统一配置项组织可用范围', () => {
  test('幂等升级并保留现有组织项与全局用户项语义', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE config_items (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, org_id TEXT);
      INSERT INTO config_items VALUES (1, 'system', 'org-a'), (2, 'user', NULL);
    `)
    ensureConfigAvailabilitySchema(db)
    ensureConfigAvailabilitySchema(db)
    assert.deepEqual(db.prepare('SELECT id, availability FROM config_items ORDER BY id').all().map(row => ({ ...row })), [
      { id: 1, availability: 'organization' },
      { id: 2, availability: 'all' },
    ])
    db.prepare('INSERT INTO config_item_org_assignments (config_item_id, org_id, created_at) VALUES (?, ?, ?)')
      .run(1, 'org-b', 1)
    assert.throws(() => db.prepare(
      'INSERT INTO config_item_org_assignments (config_item_id, org_id, created_at) VALUES (?, ?, ?)',
    ).run(1, 'org-b', 2), /UNIQUE/)
    db.close()
  })
})
