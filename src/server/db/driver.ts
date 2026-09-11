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
  }>
  on: (event: string, listener: (err: Error) => void) => void
  end: () => Promise<void>
}

interface PgClientLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: SqlRow[]; rowCount: number | null }>
  release: () => void
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

  private route(): { query: PgClientLike['query'] } {
    const ctx = this.txStorage.getStore()
    if (ctx) return { query: (sql, params) => ctx.client.query(sql, params) }
    return { query: (sql, params) => this.pool.query(sql, params) }
  }

  async get<T extends SqlRow = SqlRow>(sql: string, params?: SqlParam[]): Promise<T | undefined> {
    const { query } = this.route()
    const res = await query(PgDriver.convertPlaceholders(sql), params)
    return (res.rows[0] ?? undefined) as T | undefined
  }

  async all<T extends SqlRow = SqlRow>(sql: string, params?: SqlParam[]): Promise<T[]> {
    const { query } = this.route()
    const res = await query(PgDriver.convertPlaceholders(sql), params)
    return res.rows as T[]
  }

  async run(sql: string, params?: SqlParam[]): Promise<number> {
    const { query } = this.route()
    const res = await query(PgDriver.convertPlaceholders(sql), params)
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

  async close(): Promise<void> {
    await this.pool.end()
  }
}
