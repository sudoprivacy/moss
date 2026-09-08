import type { DatabaseSync } from 'node:sqlite'

export interface TransactionContext {
  depth: number
  savepoint?: string
}

export interface BusyRetryOptions {
  maxAttempts: number
  delayMs: number
  onRetry?: (error: unknown, nextAttempt: number) => void
}

interface ActiveTransaction {
  depth: number
  nextSavepoint: number
}

const activeTransactions = new WeakMap<DatabaseSync, ActiveTransaction>()

export class AsyncTransactionCallbackError extends Error {
  constructor() {
    super('SQLite UnitOfWork callback must be synchronous and must not return a Promise')
    this.name = 'AsyncTransactionCallbackError'
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  ) && typeof (value as { then?: unknown }).then === 'function'
}

export function runInTransaction<T>(
  db: DatabaseSync,
  callback: (context: TransactionContext) => T,
): T {
  const existing = activeTransactions.get(db)
  const state = existing ?? { depth: 0, nextSavepoint: 1 }
  const ownsOuterTransaction = !existing && !db.isTransaction
  const savepoint = ownsOuterTransaction ? undefined : `moss_uow_${state.nextSavepoint++}`

  if (ownsOuterTransaction) {
    db.exec('BEGIN IMMEDIATE')
  } else {
    db.exec(`SAVEPOINT ${savepoint}`)
  }
  if (!existing) activeTransactions.set(db, state)
  state.depth += 1

  try {
    const result = callback({ depth: state.depth, savepoint })
    if (isPromiseLike(result)) throw new AsyncTransactionCallbackError()

    if (ownsOuterTransaction) {
      db.exec('COMMIT')
    } else {
      db.exec(`RELEASE SAVEPOINT ${savepoint}`)
    }
    return result
  } catch (error) {
    if (ownsOuterTransaction) {
      if (db.isTransaction) db.exec('ROLLBACK')
    } else if (db.isTransaction) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      db.exec(`RELEASE SAVEPOINT ${savepoint}`)
    }
    throw error
  } finally {
    state.depth -= 1
    if (!existing) activeTransactions.delete(db)
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const sqliteError = error as { code?: string; errcode?: number; message?: string }
  return sqliteError.errcode === 5
    || sqliteError.code === 'SQLITE_BUSY'
    || /database is (?:locked|busy)/i.test(sqliteError.message ?? '')
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  Atomics.wait(signal, 0, 0, milliseconds)
}

export function runWithBusyRetry<T>(operation: () => T, options: BusyRetryOptions): T {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive integer')
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    throw new RangeError('delayMs must be a non-negative number')
  }

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return operation()
    } catch (error) {
      if (!isSqliteBusy(error) || attempt === options.maxAttempts) throw error
      options.onRetry?.(error, attempt + 1)
      sleepSync(options.delayMs)
    }
  }
  throw new Error('Unreachable SQLite retry state')
}
