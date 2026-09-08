import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { QmsScheduler, type QmsLeaseStore } from './qmsScheduler.js'

class MemoryLeases implements QmsLeaseStore {
  readonly leases = new Map<string, { owner: string; until: number }>()
  completions: string[] = []
  failures: string[] = []

  async tryAcquire(taskName: string, ownerId: string, now: number, leaseMs: number): Promise<boolean> {
    const current = this.leases.get(taskName)
    if (current && current.until > now && current.owner !== ownerId) return false
    this.leases.set(taskName, { owner: ownerId, until: now + leaseMs })
    return true
  }

  async complete(taskName: string, ownerId: string): Promise<void> {
    if (this.leases.get(taskName)?.owner === ownerId) this.leases.delete(taskName)
    this.completions.push(`${taskName}:${ownerId}`)
  }

  async fail(taskName: string, ownerId: string, error: string): Promise<void> {
    if (this.leases.get(taskName)?.owner === ownerId) this.leases.delete(taskName)
    this.failures.push(`${taskName}:${ownerId}:${error}`)
  }
}

describe('QmsScheduler', () => {
  it('allows only one instance to execute a due task', async () => {
    const leases = new MemoryLeases()
    let calls = 0
    const task = { name: 'alert-check', intervalMs: 100, leaseMs: 500, run: async () => { calls += 1 } }
    const first = new QmsScheduler({ ownerId: 'one', leases, tasks: [task] })
    const second = new QmsScheduler({ ownerId: 'two', leases, tasks: [task] })

    await Promise.all([first.runDue(1_000), second.runDue(1_000)])

    assert.equal(calls, 1)
    assert.equal(leases.completions.length, 1)
  })

  it('records failure and permits the next due run without overlapping', async () => {
    const leases = new MemoryLeases()
    let calls = 0
    const scheduler = new QmsScheduler({
      ownerId: 'one', leases,
      tasks: [{
        name: 'queue-process', intervalMs: 100, leaseMs: 500,
        run: async () => { calls += 1; if (calls === 1) throw new Error('temporary') },
      }],
    })

    await scheduler.runDue(1_000)
    await scheduler.runDue(1_050)
    await scheduler.runDue(1_101)

    assert.equal(calls, 2)
    assert.equal(leases.failures.length, 1)
    assert.equal(leases.completions.length, 1)
  })

  it('lets another instance take over an expired lease', async () => {
    const leases = new MemoryLeases()
    leases.leases.set('crash-cleanup', { owner: 'dead', until: 999 })
    let calls = 0
    const scheduler = new QmsScheduler({
      ownerId: 'live', leases,
      tasks: [{ name: 'crash-cleanup', intervalMs: 100, leaseMs: 500, run: async () => { calls += 1 } }],
    })

    await scheduler.runDue(1_000)
    assert.equal(calls, 1)
  })

  it('manual run executes only the requested task while keeping lease protection', async () => {
    const leases = new MemoryLeases()
    const calls: string[] = []
    const scheduler = new QmsScheduler({
      ownerId: 'one', leases,
      tasks: [
        { name: 'aggregation', intervalMs: 100, leaseMs: 500, run: async () => { calls.push('aggregation') } },
        { name: 'cleanup', intervalMs: 100, leaseMs: 500, run: async () => { calls.push('cleanup') } },
      ],
    })

    assert.equal(await scheduler.runTask('aggregation', 1_000), true)
    assert.deepEqual(calls, ['aggregation'])
    assert.deepEqual(leases.completions, ['aggregation:one'])
  })
})
