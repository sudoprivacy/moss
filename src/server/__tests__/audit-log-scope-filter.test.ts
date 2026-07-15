import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'

// The credential audit log is also narrowed by the *scope* of the config item
// each action touched: a full admin sees every scope, a dept_admin sees
// department + user rows, a normal user only user-scope rows. db.queryAuditLog
// builds this with a `config_item_id IN (SELECT id FROM config_items WHERE
// scope IN (...))` clause (fail-closed `1 = 0` for an empty set). Rows whose
// config_item_id is null or points at an out-of-scope item must be excluded so
// a non-admin never sees audit entries for credentials outside their scope.
// DirectConnectStore can't load under bun:test (node:sqlite), so — like the
// actor-filter test — we replicate the tables and exercise the exact filter.

type Row = { id: string; config_item_id: number | null }

function makeDb(): Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE config_items (
      id INTEGER PRIMARY KEY,
      scope TEXT NOT NULL
    );
    CREATE TABLE secret_audit_log (
      id TEXT PRIMARY KEY,
      config_item_id INTEGER,
      org_id TEXT,
      created_at INTEGER NOT NULL
    );
  `)
  const insertItem = db.prepare('INSERT INTO config_items (id, scope) VALUES (?, ?)')
  for (const [id, scope] of [
    [1, 'system'],
    [2, 'department'],
    [3, 'user'],
  ] as const) {
    insertItem.run(id, scope)
  }
  const insertLog = db.prepare(
    'INSERT INTO secret_audit_log (id, config_item_id, org_id, created_at) VALUES (?, ?, ?, ?)',
  )
  let t = 1
  for (const [id, itemId] of [
    ['sys', 1], // system scope
    ['dept', 2], // department scope
    ['usr', 3], // user scope
    ['orphan', null], // no config item (unresolvable)
  ] as const) {
    insertLog.run(id, itemId, 'org1', t++)
  }
  return db
}

// Mirror of the scope WHERE-clause construction added to db.queryAuditLog.
function queryScopeFiltered(db: Database, orgId: string, scopes?: string[]): Row[] {
  const conditions: string[] = ['(org_id = ? OR org_id IS NULL)']
  const params: unknown[] = [orgId]
  if (scopes) {
    if (scopes.length === 0) {
      conditions.push('1 = 0')
    } else {
      conditions.push(
        `config_item_id IN (SELECT id FROM config_items WHERE scope IN (${scopes.map(() => '?').join(', ')}))`,
      )
      params.push(...scopes)
    }
  }
  return db
    .prepare(`SELECT id, config_item_id FROM secret_audit_log WHERE ${conditions.join(' AND ')} ORDER BY created_at`)
    .all(...params) as Row[]
}

describe('audit log scope filtering', () => {
  let db: Database
  beforeEach(() => { db = makeDb() })

  it('no restriction (admin) returns every row incl. the orphan', () => {
    const rows = queryScopeFiltered(db, 'org1', undefined)
    expect(rows.map(r => r.id)).toEqual(['sys', 'dept', 'usr', 'orphan'])
  })

  it('dept_admin sees department + user rows only, never system or orphan', () => {
    const rows = queryScopeFiltered(db, 'org1', ['department', 'user'])
    expect(rows.map(r => r.id)).toEqual(['dept', 'usr'])
  })

  it('normal user sees only user-scope rows', () => {
    const rows = queryScopeFiltered(db, 'org1', ['user'])
    expect(rows.map(r => r.id)).toEqual(['usr'])
  })

  it('null config_item_id rows are excluded from any scoped query (fail-closed)', () => {
    const rows = queryScopeFiltered(db, 'org1', ['system', 'department', 'user'])
    expect(rows.map(r => r.id)).toEqual(['sys', 'dept', 'usr'])
    expect(rows.every(r => r.config_item_id !== null)).toBe(true)
  })

  it('empty scope set is fail-closed: zero rows, never the whole org', () => {
    const rows = queryScopeFiltered(db, 'org1', [])
    expect(rows).toHaveLength(0)
  })
})
