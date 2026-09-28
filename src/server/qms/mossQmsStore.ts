import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as delay } from 'node:timers/promises'

import type { DbDriver, SqlParam } from '../db/driver.js'
import { initializeMossQmsSchema, MOSS_QMS_SCHEMA, MOSS_QMS_TABLES, type QmsSqlPort } from './qmsSchema.js'
import type { QmsTransactionalSqlPort } from './telemetryPostgresWriter.js'

/** Qualify only known table identifiers in internal QMS SQL; literals and comments are never changed. */
export function qualifyQmsTables(sql: string, schema = MOSS_QMS_SCHEMA, prefix = ''): string {
  return sql.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\b[A-Za-z_][A-Za-z0-9_]*\b/g,
    (token, offset: number) => {
      if (token.startsWith("'") || token.startsWith('--') || token.startsWith('/*')) return token
      const identifier = token.startsWith('"')
        ? token.slice(1, -1).replaceAll('""', '"')
        : token.toLowerCase()
      if (!MOSS_QMS_TABLES.has(identifier)) return token
      // Already-qualified references are left alone (all SQL is internal, never user supplied).
      if (sql.slice(0, offset).trimEnd().endsWith('.')) return token
      return `"${schema.replaceAll('"', '""')}"."${prefix}${identifier}"`
    },
  )
}

function parameter(value: unknown): SqlParam {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  )
    return value
  return JSON.stringify(value)
}

/** Borrows the existing Moss driver/pool. It neither opens nor closes database connections. */
export class MossQmsStore implements QmsTransactionalSqlPort {
  private readonly context = new AsyncLocalStorage<boolean>()
  private active = 0
  private readonly waiting: Array<() => void> = []
  private schema = MOSS_QMS_SCHEMA
  private prefix = ''

  constructor(
    private readonly driver: DbDriver,
    private readonly concurrency = 2,
  ) {
    if (driver.kind !== 'postgres')
      throw new Error('QMS requires the Moss PostgreSQL backend (MOSS_DATABASE_URL)')
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid QMS database concurrency')
  }

  async start(signal?: AbortSignal) {
    for (let attempt = 0; attempt < 100; attempt++) {
      signal?.throwIfAborted()
      const state = await this.limited(() =>
        this.driver.tryRunExclusive('moss:qms:schema', async () => {
          signal?.throwIfAborted()
          // SET LOCAL expires with this advisory-locked transaction, never leaking into Moss queries.
          await this.driver.exec("SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'")
          const location = await this.driver.get<{
            main_schema: string; has_schema: boolean; can_use_schema: boolean; has_prefixed_tables: boolean; can_create_schema: boolean
          }>(`SELECT current_schema() AS main_schema,
            to_regnamespace('moss_qms') IS NOT NULL AS has_schema,
            CASE WHEN to_regnamespace('moss_qms') IS NULL THEN FALSE
              ELSE has_schema_privilege('moss_qms', 'USAGE') AND has_schema_privilege('moss_qms', 'CREATE') END AS can_use_schema,
            to_regclass(format('%I.%I', current_schema(), 'moss_qms_telemetry_perf_raw')) IS NOT NULL AS has_prefixed_tables,
            has_database_privilege(current_database(), 'CREATE') AS can_create_schema`)
          signal?.throwIfAborted()
          if (!location?.main_schema) throw new Error('Moss PostgreSQL has no writable application schema')
          if (location.has_prefixed_tables || (location.has_schema ? !location.can_use_schema : !location.can_create_schema)) {
            // Existing Moss can create application tables without permission to create schemas.
            this.schema = location.main_schema
            this.prefix = 'moss_qms_'
          } else {
            this.schema = MOSS_QMS_SCHEMA
            this.prefix = ''
            if (!location.has_schema) await this.driver.exec(`CREATE SCHEMA "${MOSS_QMS_SCHEMA}"`)
          }
          const result = await initializeMossQmsSchema(this)
          signal?.throwIfAborted()
          return result
        }),
      )
      if (state) return state
      await delay(100, undefined, { signal })
    }
    throw new Error('QMS schema initialization is busy; retry startup')
  }

  execute(sql: string, parameters: readonly unknown[] = []): Promise<readonly Record<string, unknown>[]> {
    return this.limited(async () => {
      let qualified = qualifyQmsTables(sql, this.schema, this.prefix)
      if (parameters.length === 0 && /^\s*(?:CREATE|ALTER|DROP)\b/i.test(sql)) {
        if (this.prefix) qualified = qualified.replace(/(CREATE(?: UNIQUE)? INDEX(?: IF NOT EXISTS)? )([A-Za-z_][A-Za-z0-9_]*)/g,
          (_match, start: string, name: string) => `${start}"${this.prefix}${name}"`)
        await this.driver.exec(qualified)
        return []
      }
      return this.driver.all(qualified, parameters.map(parameter))
    })
  }

  transaction<T>(operation: (db: QmsSqlPort) => Promise<T>): Promise<T> {
    return this.limited(() => this.driver.transaction(() => operation(this)))
  }

  private async limited<T>(operation: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return operation()
    if (this.active >= this.concurrency) await new Promise<void>((resolve) => this.waiting.push(resolve))
    else this.active++
    try {
      return await this.context.run(true, operation)
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}
