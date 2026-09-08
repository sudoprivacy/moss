import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { PostCutoverChangeLog } from './postCutoverChangeLog.js'
import { ReplayService, ReplayServiceError } from './replayService.js'

describe('ReplayService', () => {
  test('replays internal state once with a stable suppressed replay context', async () => {
    const db = new DatabaseSync(':memory:')
    const log = new PostCutoverChangeLog(db)
    const change = log.append({
      eventId: 'event-1', domain: 'identity', commandType: 'user.lock',
      aggregateType: 'user', aggregateId: 'user-a', payload: { status: 'locked' },
    })
    const contexts: Array<{ source: string; externalEffects: string; originalEventId?: string; idempotencyKey: string }> = []
    const service = new ReplayService({
      log,
      replayHandlers: {
        identity: async (_change, context) => {
          contexts.push(context)
          return { applied: true }
        },
      },
      redeliveryAdapter: { deliver: async () => ({ providerId: 'unused' }) },
      allowedRedeliveryTargets: [],
    })
    try {
      const approval = { approvedBy: 'ops-a', approvedAt: 1_800_000_000_000, reason: '回滚演练' }
      const first = await service.replay(change, approval)
      const repeated = await service.replay(change, approval)
      assert.deepEqual(repeated, first)
      assert.equal(contexts.length, 1)
      assert.equal(contexts[0].source, 'replay')
      assert.equal(contexts[0].externalEffects, 'suppress_external')
      assert.equal(contexts[0].originalEventId, 'event-1')
      assert.equal(contexts[0].idempotencyKey, 'replay:event-1')
    } finally {
      db.close()
    }
  })

  test('redelivers an approved allowlisted effect at most once', async () => {
    const db = new DatabaseSync(':memory:')
    const log = new PostCutoverChangeLog(db)
    let deliveries = 0
    const service = new ReplayService({
      log,
      replayHandlers: {},
      redeliveryAdapter: {
        async deliver(request) {
          deliveries += 1
          return { providerId: `provider-${request.originalIdempotencyKey}` }
        },
      },
      allowedRedeliveryTargets: ['sms:welcome'],
    })
    const request = {
      originalIdempotencyKey: 'welcome:user-17', effectType: 'welcome_sms',
      target: 'sms:welcome', resourceType: 'user', resourceId: 'user-a', payloadRef: 'nexus://redelivery/payload-1',
    }
    const approval = { approvedBy: 'ops-a', approvedAt: 1_800_000_000_000, reason: '客户确认补发' }
    try {
      const first = await service.redeliver(request, approval)
      const replay = await service.redeliver(request, approval)
      assert.equal(first.status, 'succeeded')
      assert.deepEqual(replay, first)
      assert.equal(deliveries, 1)
    } finally {
      db.close()
    }
  })

  test('rejects missing approval, non-allowlisted targets, and idempotency-key reuse with another payload', async () => {
    const db = new DatabaseSync(':memory:')
    const log = new PostCutoverChangeLog(db)
    const service = new ReplayService({
      log,
      replayHandlers: {},
      redeliveryAdapter: { deliver: async () => ({ providerId: 'provider-1' }) },
      allowedRedeliveryTargets: ['webhook:approved'],
    })
    const request = {
      originalIdempotencyKey: 'webhook:event-1', effectType: 'webhook',
      target: 'webhook:approved', resourceType: 'order', resourceId: 'order-a', payloadRef: 'nexus://payload/1',
    }
    try {
      await assert.rejects(
        service.redeliver(request, { approvedBy: '', approvedAt: 0, reason: '' }),
        (error: unknown) => error instanceof ReplayServiceError && error.code === 'APPROVAL_REQUIRED',
      )
      await assert.rejects(
        service.redeliver({ ...request, target: 'webhook:other' }, { approvedBy: 'ops', approvedAt: 1, reason: '批准' }),
        (error: unknown) => error instanceof ReplayServiceError && error.code === 'TARGET_NOT_ALLOWED',
      )
      await service.redeliver(request, { approvedBy: 'ops', approvedAt: 1, reason: '批准' })
      await assert.rejects(
        service.redeliver({ ...request, payloadRef: 'nexus://payload/2' }, { approvedBy: 'ops', approvedAt: 1, reason: '批准' }),
        (error: unknown) => error instanceof ReplayServiceError && error.code === 'REDELIVERY_CONFLICT',
      )
    } finally {
      db.close()
    }
  })
})
