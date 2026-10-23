import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createInventoryApi } from '../lib/api/agent-inventory'

test('usage is GET-only, separates evaluation from run and rejects a stale organization response', async () => {
  const controller = new AbortController(), paths: string[] = []
  let abort = false
  const api = createInventoryApi({ get: async <T>(path: string): Promise<T> => {
    paths.push(path); if (abort) controller.abort(); return { success: true, data: { kind: 'AgentUsageReport' } } as T
  }, post: async () => { throw new Error('report must not mutate') } }, () => controller.signal)
  await api.usage({ from: 100000, to: 200000, mode: 'run' })
  await api.usage({ from: 100000, to: 200000, mode: 'evaluation' })
  assert.deepEqual(paths, ['/api/v1/agent-inventory/usage?from=100000&to=200000&mode=run', '/api/v1/agent-inventory/usage?from=100000&to=200000&mode=evaluation'])
  abort = true
  await assert.rejects(api.usage({ from: 100000, to: 200000, mode: 'run' }), e => e instanceof Error && e.name === 'AbortError')
})
