/**
 * DB driver abstraction (HA PostgreSQL support).
 *
 * The stores historically hold a `node:sqlite DatabaseSync` directly and are
 * fully synchronous. For cross-host deployments the shared DB must be
 * PostgreSQL, whose client is inherently async. This module defines the
 * async driver seam both backends implement:
 *
 *   - SqliteDriver wraps DatabaseSync with async signatures (zero behaviour
 *     change; single-instance deployments keep their current path).
 *   - PgDriver pools node-postgres connections, converts SQLite-style `?`
 *     placeholders to `$n`, and propagates an exclusive-client transaction
 *     context via AsyncLocalStorage so plain run/get/all calls inside
 *     `transaction(fn)` stay on the SAME connection (the manual
 *     BEGIN/COMMIT in authCenter/db.ts relies on this once migrated).
 *
 * SQL texts stay in the store classes; only dialect corners live here
 * (placeholder numbering) and in pg_schema.ts (DDL).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { DatabaseSync } from 'node:sqlite'

export type SqlParam = string | number | bigint | null | Uint8Array
export type SqlRow = Record<string, unknown>

/**
 * Cross-dialect unique-constraint violation test (SQLite raises an error whose
 * message contains "UNIQUE constraint failed"; PostgreSQL raises SQLSTATE
 * 23505 with "duplicate key value violates unique constraint"). Used by call
 * sites that translate a conflict into a domain result or a retry (e.g. the
 * corp-app inbound seq race, which relies on the unique index under PG READ
 * COMMITTED where the single-statement increment still races).
 */
export function isUniqueViolation(err: unknown): boolean {
  if (err != null && typeof err === 'object') {
    const code = (err as { code?: unknown }).code
    if (code === '23505') return true
  }
  return /UNIQUE|unique constraint/i.test(String(err))
}

export interface DbDriver {
  readonly kind: 'sqlite' | 'postgres'
  /** SELECT single row (or undefined). */
  get<T extends SqlRow = SqlRow>(sql: string, params?: SqlParam[]): Promise<T | undefined>
  /** SELECT all rows. */
  all<T extends SqlRow = SqlRow>(sql: string, params?: SqlParam[]): Promise<T[]>
  /** INSERT/UPDATE/DELETE; returns affected row count. */
  run(sql: string, params?: SqlParam[]): Promise<number>
  /** Run DDL / raw statements (no result). */
  exec(sql: string): Promise<void>
  /**
   * Transaction with context propagation: statements issued by `fn` through
   * this driver (plain run/get/all — no API change at call sites) route to
   * one exclusive client/connection for the whole body, committed on return
   * and rolled back on throw.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>
  /**
   * Cross-instance mutual exclusion, tx-scoped on PG: run `fn` while holding
   * an exclusive advisory lock on `lockKey`; resolve null when another holder
   * already has the lock (caller should skip, not queue). PostgreSQL wraps
   * `fn` in a transaction with pg_try_advisory_xact_lock(hashtext(key)) —
   * statements issued by `fn` through this driver stay on the locked
   * transaction's connection (ALS propagation), and the lock releases with
   * the transaction. The sqlite implementation is a no-op passthrough:
   * single-instance deployments have no second process to exclude, and
   * in-process re-entrancy is already guarded by caller-side state.
   */
  tryRunExclusive<T>(lockKey: string, fn: () => Promise<T>): Promise<T | null>
  /**
   * Like tryRunExclusive but SESSION-scoped on PG (not tx-scoped). The advisory
   * lock is held on a dedicated connection while `fn` runs on the pool with each
   * statement autocommitting — use this for long `fn` bodies (network I/O + many
   * writes) that must NOT be wrapped in one giant transaction: a tx-scoped lock
   * there pins a pool connection for minutes, is killed by
   * idle_in_transaction_session_timeout, and hides its writes until commit.
   * Resolves null when another holder has the lock. Sqlite is the same no-op
   * passthrough as tryRunExclusive (single process — no second process to
   * exclude).
   */
  tryRunExclusiveSession<T>(lockKey: string, fn: () => Promise<T>): Promise<T | null>
  close(): Promise<void>
}

// ==================== SQLite ====================

export class SqliteDriver implements DbDriver {
  readonly kind = 'sqlite' as const
  private readonly txStorage = new AsyncLocalStorage<{ db: DatabaseSync }>()

  constructor(private readonly db: DatabaseSync) {}

  async get<T extends SqlRow = SqlRow>(sql: string, params?: SqlParam[]): Promise<T | undefined> {
    const db = this.txStorage.getStore()?.db ?? this.db
    return db.prepare(sql).get(...(params ?? [])) as T | undefined
  }

  async all<T extends SqlRow = SqlRow>(sql: string, params?: SqlParam[]): Promise<T[]> {
    const db = this.txStorage.getStore()?.db ?? this.db
    return db.prepare(sql).all(...(params ?? [])) as T[]
  }

  async run(sql: string, params?: SqlParam[]): Promise<number> {
    const db = this.txStorage.getStore()?.db ?? this.db
    const res = db.prepare(sql).run(...(params ?? []))
    return Number(res.changes)
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql)
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.txStorage.getStore()
    if (current) return fn() // nested: join the outer transaction
    this.db.exec('BEGIN TRANSACTION')
    try {
      const result = await this.txStorage.run({ db: this.db }, fn)
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
  }

  async tryRunExclusive<T>(lockKey: string, fn: () => Promise<T>): Promise<T | null> {
    void lockKey
    return fn()
  }

  async tryRunExclusiveSession<T>(lockKey: string, fn: () => Promise<T>): Promise<T | null> {
    void lockKey
    return fn()
  }

  async close(): Promise<void> {
    this.db.close()
  }
}

// ==================== PostgreSQL ====================

export interface PgPoolLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: SqlRow[]; rowCount: number | null }>
  connect: () => Promise<{
    query: (sql: string, params?: unknown[]) => Promise<{ rows: SqlRow[]; rowCount: number | null }>
    release: () => void
    // node-postgres PoolClient.destroy: forcibly closes the connection (and any
    // session-level lock it holds) instead of returning it to the pool. Used
    // when an advisory unlock fails so a lock never rides a pooled connection.
    destroy?: () => void
  }>
  on: (event: string, listener: (err: Error) => void) => void
  end: () => Promise<void>
}

interface PgClientLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: SqlRow[]; rowCount: number | null }>
  release: () => void
  destroy?: () => void
}

export class PgDriver implements DbDriver {
  readonly kind = 'postgres' as const
  private readonly txStorage = new AsyncLocalStorage<{ client: PgClientLike }>()

  constructor(
    private readonly pool: PgPoolLike,
    private readonly onError?: (err: Error) => void,
  ) {
    if (onError) pool.on('error', onError)
  }

  /**
   * SQLite-style `?` placeholders → PG `$n`. Scans with quote-state awareness
   * so a `?` inside a string/identifier literal is never rewritten.
   */
  static convertPlaceholders(sql: string): string {
    let out = ''
    let index = 1
    let quote: '"' | "'" | null = null
    for (let i = 0; i < sql.length; i += 1) {
      const ch = sql[i] as string
      if (quote) {
        out += ch
        if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"') {
        quote = ch
        out += ch
        continue
      }
      if (ch === '?') {
        out += `$${index}`
        index += 1
        continue
      }
      out += ch
    }
    return out
  }

  /**
   * Rewrite bare `LIKE` operators to `ILIKE` outside string/identifier
   * literals. SQLite's LIKE is ASCII-case-insensitive; PG's LIKE is
   * case-sensitive, so a straight port of the SQLite SQL splits behaviour
   * across backends. ILIKE restores the SQLite semantics on PG. The keyword
   * match is case-insensitive (so a lowercase `like` is caught too) and
   * word-bounded (so an identifier like `like_count` is never touched). Every
   * LIKE call site uses `%..%` containment, which does not use a btree index
   * in either operator, so ILIKE introduces no index regression.
   */
  static rewriteLikeToILike(sql: string): string {
    let out = ''
    let quote: '"' | "'" | null = null
    let i = 0
    while (i < sql.length) {
      const ch = sql[i] as string
      if (quote) {
        out += ch
        if (ch === quote) quote = null
        i += 1
        continue
      }
      if (ch === "'" || ch === '"') {
        quote = ch
        out += ch
        i += 1
        continue
      }
      if ((ch === 'l' || ch === 'L') && sql.slice(i, i + 4).toLowerCase() === 'like') {
        const before = i === 0 ? '' : (sql[i - 1] as string)
        const after = sql[i + 4] ?? ''
        if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) {
          out += 'ILIKE'
          i += 4
          continue
        }
      }
      out += ch
      i += 1
    }
    return out
  }

  /** Full SQLite→PG statement rewrite: LIKE→ILIKE then `?`→`$n`. */
  private static prepare(sql: string): string {
    return PgDriver.convertPlaceholders(PgDriver.rewriteLikeToILike(sql))
  }

  private route(): { query: PgClientLike['query'] } {
    const ctx = this.txStorage.getStore()
    if (ctx) return { query: (sql, params) => ctx.client.query(sql, params) }
    return { query: (sql, params) => this.pool.query(sql, params) }
  }

  async get<T extends SqlRow = SqlRow>(sql: string, params?: SqlParam[]): Promise<T | undefined> {
    const { query } = this.route()
    const res = await query(PgDriver.prepare(sql), params)
    return (res.rows[0] ?? undefined) as T | undefined
  }

  async all<T extends SqlRow = SqlRow>(sql: string, params?: SqlParam[]): Promise<T[]> {
    const { query } = this.route()
    const res = await query(PgDriver.prepare(sql), params)
    return res.rows as T[]
  }

  async run(sql: string, params?: SqlParam[]): Promise<number> {
    const { query } = this.route()
    const res = await query(PgDriver.prepare(sql), params)
    return res.rowCount ?? 0
  }

  async exec(sql: string): Promise<void> {
    // DDL / multi-statement: always on a dedicated connection (PG simple
    // query protocol allows multiple statements per string).
    const client = await this.pool.connect()
    try {
      await client.query(sql)
    } finally {
      client.release()
    }
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.txStorage.getStore()
    if (current) return fn() // nested: join the outer transaction
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await this.txStorage.run({ client }, fn)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* connection already broken */ }
      throw error
    } finally {
      client.release()
    }
  }

  async tryRunExclusive<T>(lockKey: string, fn: () => Promise<T>): Promise<T | null> {
    // The lock lives and dies with this transaction, so fn MUST run inside it
    // (its statements join the same connection via the ALS context) — running
    // it after COMMIT would let the next contender in mid-flight.
    return this.transaction(async () => {
      const res = await this.get<{ ok: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtext(?)) AS ok',
        [lockKey],
      )
      if (!res?.ok) return null
      return fn()
    })
  }

  async tryRunExclusiveSession<T>(lockKey: string, fn: () => Promise<T>): Promise<T | null> {
    // Session-scoped advisory lock on a dedicated client. fn runs on the POOL —
    // route() has no ALS tx context here, so each of fn's statements
    // autocommits (no minutes-long transaction, writes visible as they land).
    // The dedicated client only holds the lock; it issues no work statements.
    const client = await this.pool.connect()
    let locked = false
    try {
      const res = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [lockKey])
      const ok = (res.rows[0] as { ok?: boolean } | undefined)?.ok === true
      if (!ok) return null
      locked = true
      return await fn()
    } finally {
      if (locked) {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey])
          client.release()
        } catch {
          // Unlock failed — destroy the connection so the session (and thus the
          // lock) is torn down rather than returned to the pool still locked.
          if (client.destroy) client.destroy()
          else client.release()
        }
      } else {
        client.release()
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
