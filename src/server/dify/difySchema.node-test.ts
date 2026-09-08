import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { ensureDifySchema } from './difySchema.js'

describe('统一 Dify Provider schema', () => {
  test('is idempotent and contains resources, operations, and migration checkpoints only', () => {
    const db = new DatabaseSync(':memory:')
    ensureDifySchema(db)
    ensureDifySchema(db)

    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dify_%' ORDER BY name`).all() as Array<{ name: string }>)
      .map(row => row.name)
    assert.deepEqual(tables, ['dify_migration_checkpoints', 'dify_provider_operations', 'dify_provider_resources'])
    for (const table of tables) {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
      assert.equal(columns.some(name => /(^|_)api_key$|secret_value|password/.test(name)), false)
    }
    db.close()
  })

  test('enforces organization-scoped external resources and operation states', () => {
    const db = new DatabaseSync(':memory:')
    ensureDifySchema(db)
    const insert = db.prepare(`
      INSERT INTO dify_provider_resources (
        id, org_id, connection_id, resource_type, external_id, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'dataset', ?, '{}', 1, 1)
    `)
    insert.run('one', 'org-a', 'connection-a', 'dataset-1')
    assert.throws(() => insert.run('two', 'org-a', 'connection-a', 'dataset-1'), /UNIQUE constraint failed/)
    assert.throws(() => db.prepare(`
      INSERT INTO dify_provider_operations (
        id, org_id, operation_type, aggregate_id, idempotency_key, status,
        request_json, result_json, context_source, created_at, updated_at
      ) VALUES ('op', 'org-a', 'create_app', 'agent-a', 'key', 'INVALID', '{}', NULL, 'online', 1, 1)
    `).run(), /CHECK constraint failed/)
    db.close()
  })
})
