import type { DatabaseSync } from 'node:sqlite'

export interface TransactionContext {
  depth: number
  savepoint?: string
}

interface ActiveTransaction {
  depth: number
  nextSavepoint: number
}

const activeTransactions = new WeakMap<DatabaseSync, ActiveTransaction>()
const busySleepBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
const BEGIN_BUSY_TIMEOUT_MS = 5_000
const BEGIN_BUSY_RETRY_MS = 10

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

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const sqliteError = error as Error & { errcode?: number; errstr?: string }
  return sqliteError.errcode === 5
    || sqliteError.errstr === 'database is locked'
    || /database is (?:locked|busy)/i.test(error.message)
}

function beginImmediateWithBoundedWait(db: DatabaseSync): void {
  const deadline = Date.now() + BEGIN_BUSY_TIMEOUT_MS
  while (true) {
    try {
      db.exec('BEGIN IMMEDIATE')
      return
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error
      Atomics.wait(busySleepBuffer, 0, 0, BEGIN_BUSY_RETRY_MS)
    }
  }
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
    beginImmediateWithBoundedWait(db)
  } else {
    db.exec(`SAVEPOINT ${savepoint}`)
  }
  if (!existing) activeTransactions.set(db, state)
  state.depth += 1

  try {
    const result = callback({ depth: state.depth, savepoint })
    if (isPromiseLike(result)) throw new AsyncTransactionCallbackError()
    if (ownsOuterTransaction) db.exec('COMMIT')
    else db.exec(`RELEASE SAVEPOINT ${savepoint}`)
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
