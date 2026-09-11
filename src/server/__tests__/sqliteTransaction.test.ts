// Runs under Node: `tsx --test`. Covers SqliteDriver transaction serialization
// (batch 8): on the single shared handle, concurrent top-level transactions
// must not collide with a double BEGIN, and ordinary statements must not
// interleave into an open transaction.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { SqliteDriver } from '../db/driver.js'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function freshDriver(): Promise<SqliteDriver> {
  const db = new DatabaseSync(':memory:')
  const driver = new SqliteDriver(db)
  await driver.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v INTEGER NOT NULL)')
  return driver
}

function values(rows: unknown[]): number[] {
  return rows.map(r => (r as { v: number }).v)
}

describe('SqliteDriver transaction serialization', () => {
  it('two concurrent top-level transactions do not collide with double BEGIN', async () => {
    const driver = await freshDriver()
    const txA = driver.transaction(async () => {
      await driver.run('INSERT INTO t (v) VALUES (1)')
      await delay(20) // hold the transaction open across a tick
      await driver.run('INSERT INTO t (v) VALUES (2)')
      return 'A'
    })
    const txB = driver.transaction(async () => {
      await driver.run('INSERT INTO t (v) VALUES (3)')
      return 'B'
    })
    // Must NOT throw "cannot start a transaction within a transaction".
    const results = await Promise.all([txA, txB])
    assert.deepEqual([...results].sort(), ['A', 'B'])
    assert.deepEqual(values(await driver.all('SELECT v FROM t ORDER BY v')), [1, 2, 3])
  })

  it('a rolled-back transaction leaves no rows; a concurrent committed one is unaffected', async () => {
    const driver = await freshDriver()
    const txA = driver
      .transaction(async () => {
        await driver.run('INSERT INTO t (v) VALUES (100)')
        await delay(20)
        throw new Error('boom') // force ROLLBACK
      })
      .catch(e => e as Error)
    const txB = driver.transaction(async () => {
      await driver.run('INSERT INTO t (v) VALUES (200)')
      return 'B'
    })
    const [aResult, bResult] = await Promise.all([txA, txB])
    assert.ok(aResult instanceof Error, 'A must reject and roll back')
    assert.equal(bResult, 'B')
    // A's 100 rolled back atomically; B's 200 committed. Serialized, so no
    // interleaving corruption either way round.
    assert.deepEqual(values(await driver.all('SELECT v FROM t ORDER BY v')), [200])
  })

  it('a non-transactional write does not fall inside an open transaction', async () => {
    const driver = await freshDriver()
    const txA = driver
      .transaction(async () => {
        await driver.run('INSERT INTO t (v) VALUES (1)')
        await delay(30)
        throw new Error('rollback A') // rolls back its own 1
      })
      .catch(() => {})
    // Ordinary write issued while A holds the transaction: it must queue until
    // A finishes, not land inside A's transaction (or A's ROLLBACK would drop
    // it too, leaving the table empty).
    const plainWrite = driver.run('INSERT INTO t (v) VALUES (999)')
    await Promise.all([txA, plainWrite])
    assert.deepEqual(values(await driver.all('SELECT v FROM t')), [999])
  })
})
