import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'

// The credential audit log is narrowed by "action user": a dept_admin sees only
// actions by users in their department subtree, a normal user only their own.
// db.queryAuditLog builds this with an `actor_id IN (...)` clause (and a
// fail-closed `1 = 0` for an empty set). DirectConnectStore itself can't load
// under bun:test (node:sqlite), so — like the cron-store tests — we replicate
// the audit table in bun:sqlite and exercise the exact filter semantics the
// query builds, guarding against a regression where an empty set degrades to
// "no filter" (which would leak the whole org's log).

type Row = { id: string; actor_id: string; org_id: string | null }

function makeDb(): Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE secret_audit_log (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      org_id TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  const insert = db.prepare(
    'INSERT INTO secret_audit_log (id, actor_id, action, org_id, created_at) VALUES (?, ?, ?, ?, ?)',
  )
  let t = 1
  for (const [id, actor] of [
    ['a', 'u-self'],
    ['b', 'u-child'],
    ['c', 'u-outside'],
    ['d', 'u-self'],
  ] as const) {
    insert.run(id, actor, 'read', 'org1', t++)
  }
  return db
}

// Mirror of the WHERE-clause construction added to db.queryAuditLog.
function queryActorScoped(db: Database, orgId: string, actorIds?: string[]): Row[] {
  const conditions: string[] = ['(org_id = ? OR org_id IS NULL)']
  const params: unknown[] = [orgId]
  if (actorIds) {
    if (actorIds.length === 0) {
      conditions.push('1 = 0')
    } else {
      conditions.push(`actor_id IN (${actorIds.map(() => '?').join(', ')})`)
      params.push(...actorIds)
    }
  }
  return db
    .prepare(`SELECT id, actor_id, org_id FROM secret_audit_log WHERE ${conditions.join(' AND ')} ORDER BY created_at`)
    .all(...params) as Row[]
}

describe('audit log actor scoping', () => {
  let db: Database
  beforeEach(() => { db = makeDb() })

  it('no restriction (admin) returns the whole org', () => {
    const rows = queryActorScoped(db, 'org1', undefined)
    expect(rows.map(r => r.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('subtree set returns only those actors (dept_admin)', () => {
    const rows = queryActorScoped(db, 'org1', ['u-self', 'u-child'])
    expect(rows.map(r => r.id)).toEqual(['a', 'b', 'd'])
    expect(rows.every(r => r.actor_id !== 'u-outside')).toBe(true)
  })

  it('single-self set returns only own actions (normal user)', () => {
    const rows = queryActorScoped(db, 'org1', ['u-self'])
    expect(rows.map(r => r.id)).toEqual(['a', 'd'])
  })

  it('empty set is fail-closed: zero rows, never the whole org', () => {
    const rows = queryActorScoped(db, 'org1', [])
    expect(rows).toHaveLength(0)
  })
})
