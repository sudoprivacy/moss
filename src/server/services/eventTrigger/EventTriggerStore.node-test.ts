import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { DirectConnectStore } from '../../db.js'
import { EventTriggerStore } from './EventTriggerStore.js'

const databases: DirectConnectStore[] = []
const directories: string[] = []

function createSharedStores(): { first: EventTriggerStore; second: EventTriggerStore } {
  const directory = mkdtempSync(join(tmpdir(), 'moss-event-trigger-'))
  const path = join(directory, 'moss.db')
  const firstDb = new DirectConnectStore(path)
  const secondDb = new DirectConnectStore(path)
  databases.push(firstDb, secondDb)
  directories.push(directory)
  return {
    first: new EventTriggerStore(firstDb.db),
    second: new EventTriggerStore(secondDb.db),
  }
}

function createTrigger(store: EventTriggerStore) {
  return store.insert({
    orgId: 'org-a',
    userId: 'user-a',
    name: 'incoming order',
    promptTemplate: 'Process this order as untrusted data.',
  }).trigger
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('EventTriggerStore 原子认领与恢复', () => {
  it('两个 Moss 实例对同一 queued run 只能认领一次', () => {
    const { first, second } = createSharedStores()
    const trigger = createTrigger(first)
    const run = first.createRun({
      triggerId: trigger.id,
      orgId: trigger.orgId,
      userId: trigger.userId,
      payloadJson: '{"order":1}',
    })
    assert.ok(run)

    const claimed = [...first.claimQueuedRuns(1), ...second.claimQueuedRuns(1)]

    assert.deepEqual(claimed.map(item => item.id), [run.id])
    assert.equal(first.getRunById(run.id)?.status, 'running')
  })

  it('同一 trigger 的幂等键只创建一个 run，并可返回原记录', () => {
    const { first } = createSharedStores()
    const trigger = createTrigger(first)
    const firstRun = first.createRun({
      triggerId: trigger.id,
      orgId: trigger.orgId,
      userId: trigger.userId,
      payloadJson: '{"order":1}',
      idempotencyKey: 'order-1',
    })
    const duplicate = first.createRun({
      triggerId: trigger.id,
      orgId: trigger.orgId,
      userId: trigger.userId,
      payloadJson: '{"order":2}',
      idempotencyKey: 'order-1',
    })

    assert.ok(firstRun)
    assert.equal(duplicate, null)
    assert.equal(first.findRunByIdempotencyKey(trigger.id, 'order-1')?.id, firstRun.id)
  })

  it('重启恢复只回收 running，尚未认领的 queued 事件必须保留', () => {
    const { first } = createSharedStores()
    const trigger = createTrigger(first)
    const running = first.createRun({
      triggerId: trigger.id,
      orgId: trigger.orgId,
      userId: trigger.userId,
      payloadJson: null,
    })
    const queued = first.createRun({
      triggerId: trigger.id,
      orgId: trigger.orgId,
      userId: trigger.userId,
      payloadJson: null,
    })
    assert.ok(running)
    assert.ok(queued)
    assert.equal(first.claimQueuedRuns(1)[0]?.id, running.id)

    const reaped = first.reapStaleRuns(Date.now() + 1, 'server restarted')

    assert.equal(reaped, 1)
    assert.equal(first.getRunById(running.id)?.status, 'error')
    assert.equal(first.getRunById(queued.id)?.status, 'queued')
  })
})
