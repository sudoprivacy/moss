import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { DirectConnectStore } from '../../db.js'
import { CronStore } from './CronStore.js'

const stores: DirectConnectStore[] = []
const directories: string[] = []

function createSharedStores(): { first: CronStore; second: CronStore } {
  const directory = mkdtempSync(join(tmpdir(), 'moss-cron-store-'))
  const dbPath = join(directory, 'moss.db')
  const firstDb = new DirectConnectStore(dbPath)
  const secondDb = new DirectConnectStore(dbPath)
  stores.push(firstDb, secondDb)
  directories.push(directory)
  return {
    first: new CronStore(firstDb.db),
    second: new CronStore(secondDb.db),
  }
}

function insertDueJob(store: CronStore, orgId: string, userId: string) {
  const job = store.insert({
    orgId,
    userId,
    name: `${orgId}-job`,
    schedule: { kind: 'every', value: '1h' },
    payloadMessage: 'run',
    conversationMode: 'new',
  })
  store.updateNextRunAt(job.id, 1_000)
  return job
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('CronStore 企业自动化隔离与租约', () => {
  it('两个 Moss 实例竞争同一到期任务时只有一个实例取得租约', () => {
    const { first, second } = createSharedStores()
    const job = insertDueJob(first, 'org-a', 'user-a')
    const now = 2_000
    const nextRunAt = 3_602_000

    const results = [
      first.acquireLease(job.id, now, 100_000, nextRunAt),
      second.acquireLease(job.id, now, 100_000, nextRunAt),
    ]

    assert.equal(results.filter(Boolean).length, 1)
    assert.equal(first.getById(job.id)?.nextRunAt, nextRunAt)
    assert.equal(first.getById(job.id)?.leaseUntil, 100_000)
  })

  it('用户任务列表必须同时按 Organization 和用户归属过滤', () => {
    const { first } = createSharedStores()
    const orgAJob = insertDueJob(first, 'org-a', 'shared-user')
    insertDueJob(first, 'org-b', 'shared-user')

    const visible = first.listByUser('org-a', 'shared-user')

    assert.deepEqual(visible.map(job => job.id), [orgAJob.id])
    assert.ok(visible.every(job => job.orgId === 'org-a'))
  })
})
