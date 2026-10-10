import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DirectConnectStore } from './db.js'

for (const fixture of [
  { name: 'single instance success', claimedBy: undefined, ownerInstanceId: undefined, initialStatus: 'running', expectedStatuses: ['running'], targetStatus: 'succeeded', isAccepted: true },
  { name: 'owner success', claimedBy: 'owner', ownerInstanceId: 'owner', initialStatus: 'running', expectedStatuses: ['running'], targetStatus: 'succeeded', isAccepted: true },
  { name: 'foreign owner rejection', claimedBy: 'peer', ownerInstanceId: 'owner', initialStatus: 'running', expectedStatuses: ['running'], targetStatus: 'succeeded', isAccepted: false },
  { name: 'cancelled job cannot succeed', claimedBy: 'owner', ownerInstanceId: 'owner', initialStatus: 'cancelled', expectedStatuses: ['running'], targetStatus: 'succeeded', isAccepted: false },
  { name: 'failed job cannot succeed', claimedBy: 'owner', ownerInstanceId: 'owner', initialStatus: 'failed', expectedStatuses: ['running'], targetStatus: 'succeeded', isAccepted: false },
  { name: 'reaper can fail a peer job', claimedBy: 'peer', ownerInstanceId: undefined, initialStatus: 'running', expectedStatuses: ['running'], targetStatus: 'failed', isAccepted: true },
  { name: 'queued job cancellation', claimedBy: undefined, ownerInstanceId: undefined, initialStatus: 'queued', expectedStatuses: ['queued', 'running'], targetStatus: 'cancelled', isAccepted: true },
  { name: 'running job cancellation', claimedBy: 'peer', ownerInstanceId: undefined, initialStatus: 'running', expectedStatuses: ['queued', 'running'], targetStatus: 'cancelled', isAccepted: true },
] as const) {
  void test(`Wiki terminal update fencing: ${fixture.name}`, async () => {
    const store = new DirectConnectStore(':memory:')
    const jobId = 'qa-wiki-job'
    try {
      await store.createWiki({ id: 'qa-wiki', org_id: 'qa-org', name: 'QA', storage_path: '/tmp/qa-wiki', created_by: 'qa-user' })
      await store.createWikiBuildJob({ id: jobId, wiki_id: 'qa-wiki', triggered_by: 'qa-user' })
      if (fixture.initialStatus !== 'queued') {
        await store.claimQueuedWikiBuildJobs(1, fixture.claimedBy, Date.now())
        if (fixture.initialStatus !== 'running') {
          await store.updateWikiBuildJob(jobId, { status: fixture.initialStatus })
        }
      }
      await store.updateWikiBuildJob(jobId, { status: fixture.targetStatus, progress: 100, current_step: 'terminal', finished_at: 123 }, {
        expectedStatuses: [...fixture.expectedStatuses], ownerInstanceId: fixture.ownerInstanceId,
      })
      const row = await store.getWikiBuildJob(jobId)
      assert.ok(row)
      assert.equal(row.status, fixture.isAccepted ? fixture.targetStatus : fixture.initialStatus)
      assert.equal(row.progress, fixture.isAccepted ? 100 : 0)
      assert.equal(row.current_step, fixture.isAccepted ? 'terminal' : null)
      assert.equal(row.finished_at, fixture.isAccepted ? 123 : null)
    } finally {
      store.requireSqliteDb().close()
    }
  })
}
