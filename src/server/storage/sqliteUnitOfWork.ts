import type { DatabaseSync } from 'node:sqlite'
import { beginImmediateWithBoundedWait } from '../db/driver.js'

export interface TransactionContext {
  depth: number
  savepoint?: string
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
