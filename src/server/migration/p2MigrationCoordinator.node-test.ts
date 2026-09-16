import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { P2MigrationCoordinator, P2MigrationPreflightError } from './p2MigrationCoordinator.js'

describe('P2 统一迁移编排', () => {
  test('任一领域预检阻塞时不执行任何写入', async () => {
    const calls: string[] = []
    const coordinator = new P2MigrationCoordinator({
      catalog: {
        async plan() { calls.push('catalog.plan'); return { status: 'ready' } },
        async execute() { calls.push('catalog.execute'); return { imported: 1 } },
      },
      managedImages: {
        async plan() { calls.push('images.plan'); return { status: 'ready' } },
        async execute() { calls.push('images.execute'); return { imported: 1 } },
      },
      configuration: {
        plan() { calls.push('configuration.plan'); return { status: 'blocked', conflicts: ['name'] } },
        execute() { calls.push('configuration.execute'); return { imported: 1 } },
      },
      systemConfiguration: {
        async plan() { calls.push('system.plan'); return { status: 'ready' } },
        async execute() { calls.push('system.execute'); return { imported: true } },
      },
    })

    const report = await coordinator.plan()
    assert.equal(report.status, 'blocked')
    await assert.rejects(coordinator.execute('run'), P2MigrationPreflightError)
    assert.deepEqual(calls.filter(call => call.endsWith('.execute')), [])
  })

  test('全部预检通过后按可恢复顺序执行并返回分域报告', async () => {
    const calls: string[] = []
    const coordinator = new P2MigrationCoordinator({
      catalog: {
        async plan() { calls.push('catalog.plan'); return { status: 'ready' } },
        async execute(runId) { calls.push(`catalog.execute:${runId}`); return { imported: 2 } },
      },
      managedImages: {
        async plan() { calls.push('images.plan'); return { status: 'ready' } },
        async execute() { calls.push('images.execute'); return { imported: 2 } },
      },
      configuration: {
        plan() { calls.push('configuration.plan'); return { status: 'ready' } },
        execute(runId) { calls.push(`configuration.execute:${runId}`); return { imported: 1 } },
      },
      systemConfiguration: {
        async plan() { calls.push('system.plan'); return { status: 'ready' } },
        async execute(runId) { calls.push(`system.execute:${runId}`); return { imported: true } },
      },
    })

    const result = await coordinator.execute('cutover-1')
    assert.deepEqual(calls, [
      'catalog.plan', 'images.plan', 'configuration.plan', 'system.plan',
      'catalog.execute:cutover-1', 'images.execute', 'configuration.execute:cutover-1', 'system.execute:cutover-1',
    ])
    assert.deepEqual(result, {
      migrationRunId: 'cutover-1',
      catalog: { imported: 2 },
      managedImages: { imported: 2 },
      configuration: { imported: 1 },
      systemConfiguration: { imported: true },
    })
  })
})
