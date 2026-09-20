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

const SQLITE_BEGIN_BUSY_TIMEOUT_MS = 5_000
const SQLITE_BEGIN_BUSY_RETRY_MS = 10
const sqliteBusySleepBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const sqliteError = error as Error & { errcode?: number; errstr?: string }
  return sqliteError.errcode === 5
    || sqliteError.errstr === 'database is locked'
    || /database is (?:locked|busy)/i.test(error.message)
}

export function beginImmediateWithBoundedWait(db: DatabaseSync): void {
  const deadline = Date.now() + SQLITE_BEGIN_BUSY_TIMEOUT_MS
  while (true) {
    try {
      db.exec('BEGIN IMMEDIATE')
      return
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error
      Atomics.wait(sqliteBusySleepBuffer, 0, 0, SQLITE_BEGIN_BUSY_RETRY_MS)
    }
  }
}

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
  // C-8: exact SQLite-native message prefix instead of a loose substring
  // regex — "/UNIQUE|unique constraint/i" matched any error text that merely
  // contained the word (e.g. a constraint name in an unrelated failure),
  // silently converting real errors into "duplicate" domain results.
  return String(err).includes('UNIQUE constraint failed')
}

/**
 * C-7: escape a user-supplied LIKE/ILIKE search term so its literal `%`, `_`
 * and `\` characters match themselves. Pair with `ESCAPE '\'` on the
 * operator. Both dialects honour ESCAPE (SQLite's LIKE has no default
 * escape character, PG's ILIKE defaults to backslash — without the clause
 * the two backends disagree on backslash-containing terms).
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, ch => `\\${ch}`)
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
  private readonly txStorage = new AsyncLocalStorage<{ db: DatabaseSync; nextSavepoint: number }>()
  /** In-flight top-level transaction, or null. Ordinary (non-tx) statements
   *  wait for it to clear: on the single shared handle they would otherwise
   *  interleave INTO the open transaction. Mirrors PgDriver's per-tx
   *  exclusive client. */
  private activeTx: Promise<unknown> | null = null

  constructor(private readonly db: DatabaseSync) {}

  private async waitOutTx(): Promise<void> {
    // while, not a single await: back-to-back transactions can start a new one
    // by the time this wakes, so re-check until the field is actually clear.
    // C-2: bounded — a statement issued OUTSIDE the tx context (empty ALS)
    // that the transaction body itself awaits would otherwise loop forever
    // (the txn can only settle after the statement returns, the statement
    // only returns after the txn settles). No production call site does that
    // today (all four are straight await chains), so this is a fence, not a
    // fix: fail loudly after 30s instead of wedging the process silently.
    const deadline = Date.now() + 30_000
    while (this.activeTx !== null) {
      if (Date.now() > deadline) {
        throw new Error(
          'SqliteDriver: timed out waiting for the active transaction to settle ' +
            '(possible deadlock: a transaction-context statement is awaiting a ' +
            'statement issued outside the transaction)',
        )
      }
      await this.activeTx.catch(() => {})
    }
  }

  async get<T extends SqlRow = SqlRow>(sql: string, params?: SqlParam[]): Promise<T | undefined> {
    if (!this.txStorage.getStore()) await this.waitOutTx()
    const db = this.txStorage.getStore()?.db ?? this.db
    return db.prepare(sql).get(...(params ?? [])) as T | undefined
  }

  async all<T extends SqlRow = SqlRow>(sql: string, params?: SqlParam[]): Promise<T[]> {
    if (!this.txStorage.getStore()) await this.waitOutTx()
    const db = this.txStorage.getStore()?.db ?? this.db
    return db.prepare(sql).all(...(params ?? [])) as T[]
  }

  async run(sql: string, params?: SqlParam[]): Promise<number> {
    if (!this.txStorage.getStore()) await this.waitOutTx()
    const db = this.txStorage.getStore()?.db ?? this.db
    const res = db.prepare(sql).run(...(params ?? []))
    return Number(res.changes)
  }

  async exec(sql: string): Promise<void> {
    if (!this.txStorage.getStore()) await this.waitOutTx()
    this.db.exec(sql)
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.txStorage.getStore()
    if (current) {
      const savepoint = `moss_driver_${current.nextSavepoint++}`
      current.db.exec(`SAVEPOINT ${savepoint}`)
      try {
        const result = await fn()
        current.db.exec(`RELEASE SAVEPOINT ${savepoint}`)
        return result
      } catch (error) {
        if (current.db.isTransaction) {
          current.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
          current.db.exec(`RELEASE SAVEPOINT ${savepoint}`)
        }
        throw error
      }
    }
    if (this.activeTx !== null) await this.waitOutTx() // serialize concurrent top-level txns
    const run = (async () => {
      beginImmediateWithBoundedWait(this.db)
      try {
        const result = await this.txStorage.run({ db: this.db, nextSavepoint: 1 }, fn)
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        try { this.db.exec('ROLLBACK') } catch { /* already rolled back */ }
        throw error
      }
    })()
    this.activeTx = run
    try {
      return await run
    } finally {
      this.activeTx = null
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
    // L-7: wait out any in-flight transaction first — closing the single
    // handle underneath it throws synchronously and leaves activeTx set,
    // wedging every later driver call in waitOutTx's 30s fence.
    await this.activeTx?.catch(() => {})
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
    // DDL / multi-statement: PG's simple query protocol allows multiple
    // statements per string. C-3/C-10: inside a transaction context, exec
    // JOINS that transaction (same exclusive client) — aligning with
    // SqliteDriver.exec's semantics and, critically, keeping
    // applyPgSchema's DDL on the advisory-locked client instead of leaving
    // the lock-holding transaction idle-in-transaction (killable by
    // idle_in_transaction_session_timeout) while DDL runs elsewhere; the
    // DDL + _migrations INSERT now commit or roll back atomically.
    const ctx = this.txStorage.getStore()
    if (ctx) {
      await ctx.client.query(sql)
      return
    }
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
    // C-9: hashtextextended (64-bit) over hashtext (32-bit) widens the advisory
    // key space; acquire and release must hash identically, so all three
    // sites below move together.
    return this.transaction(async () => {
      const res = await this.get<{ ok: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0)) AS ok',
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
      const res = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [lockKey])
      const ok = (res.rows[0] as { ok?: boolean } | undefined)?.ok === true
      if (!ok) return null
      locked = true
      return await fn()
    } finally {
      if (locked) {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
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
