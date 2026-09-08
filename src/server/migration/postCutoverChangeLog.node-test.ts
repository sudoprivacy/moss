import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { PostCutoverChangeLog, PostCutoverChangeLogError } from './postCutoverChangeLog.js'

describe('PostCutoverChangeLog', () => {
  test('appends one immutable sanitized change per original event', () => {
    const db = new DatabaseSync(':memory:')
    const log = new PostCutoverChangeLog(db, { clock: () => 1_800_000_000_000 })
    try {
      const change = {
        eventId: 'event-1', domain: 'billing', commandType: 'wallet.adjust',
        aggregateType: 'user', aggregateId: 'user-a',
        payload: { deltaUnits: 10, paymentRef: 'nexus://payments/order-1' },
      }
      const first = log.append(change)
      const replay = log.append(change)
      assert.deepEqual(replay, first)
      assert.equal(log.list().length, 1)
      assert.throws(
        () => log.append({ ...change, payload: { deltaUnits: 20 } }),
        (error: unknown) => error instanceof PostCutoverChangeLogError && error.code === 'CHANGE_CONFLICT',
      )
    } finally {
      db.close()
    }
  })

  test('rejects secret material instead of persisting it in rollback records', () => {
    const db = new DatabaseSync(':memory:')
    const log = new PostCutoverChangeLog(db)
    try {
      assert.throws(
        () => log.append({
          eventId: 'event-secret', domain: 'configuration', commandType: 'config.update',
          aggregateType: 'organization', aggregateId: 'org-a', payload: { apiKey: 'plaintext-secret' },
        }),
        (error: unknown) => error instanceof PostCutoverChangeLogError && error.code === 'SECRET_MATERIAL',
      )
    } finally {
      db.close()
    }
  })
})
