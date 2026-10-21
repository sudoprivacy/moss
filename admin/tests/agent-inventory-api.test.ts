import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createInventoryApi, exportInventory, type AssetRecord } from '../lib/api/agent-inventory'

test('inventory client discards previous-organization responses after cancellation', async () => {
  const controller = new AbortController()
  let respond!: (value: unknown) => void
  let signal: AbortSignal | null | undefined
  const client = {
    get: async <T>(_path: string, init?: Partial<RequestInit>): Promise<T> => {
      signal = init?.signal
      return new Promise(resolve => { respond = value => resolve(value as T) })
    },
    post: async <T>(): Promise<T> => { throw new Error('Unexpected mutation') },
  }
  const request = createInventoryApi(client, () => controller.signal).list()
  controller.abort(); respond({ success: true, data: { items: [{ id: 'old-organization' }] } })
  await assert.rejects(request, error => error instanceof Error && error.name === 'AbortError')
  assert.equal(signal, controller.signal)
})

test('inventory export preserves missing costs and covers every page without duplicate rows', async () => {
  const row = (id: string) => ({ id, revision: 1, cost_status: 'unavailable' } as AssetRecord)
  const pages: string[] = []
  const content = await exportInventory({ list: async after => {
    pages.push(after ?? '')
    return { api_version: 'agent-registry.sudo.dev/v1alpha1', kind: 'AgentAssetPage', items: [row(after ? 'b' : 'a')], next_cursor: after ? null : 'a' }
  } }, new AbortController().signal)
  const parsed = JSON.parse(content)
  assert.deepEqual(pages, ['', 'a'])
  assert.deepEqual(parsed.items.map((item: AssetRecord) => item.id), ['a', 'b'])
  assert.equal(parsed.items[0].cost_status, 'unavailable')
  assert.equal(parsed.consistency, 'per_record_revision')
  const duplicate = { list: async () => ({ api_version: 'agent-registry.sudo.dev/v1alpha1' as const, kind: 'AgentAssetPage' as const, items: [row('a')], next_cursor: 'a' }) }
  await assert.rejects(exportInventory(duplicate, new AbortController().signal), /INVALID_ASSET_CURSOR/)
})

test('hosted management uses scoped endpoints and never submits a task owner override', async () => {
  const calls: { path: string; body?: unknown }[] = []
  const api = createInventoryApi({
    get: async <T>(path: string): Promise<T> => { calls.push({ path }); return { success: true, data: { items: [], next_cursor: null } } as T },
    post: async <T>(path: string, body?: unknown): Promise<T> => { calls.push({ path, body }); return { success: true, data: { task_id: 'task-a', status: 'unknown', cleanup: 'confirmed' } } as T },
  })
  await api.hostedUnknown('task-a')
  await api.hostedTaskAction('task-a', 'reconcile')
  await api.hostedTaskAction('task-a', 'close', 'Reviewed unknown result and cleanup.')
  assert.deepEqual(calls, [
    { path: '/api/v1/agent-inventory/hosted/tasks/unknown?after=task-a' },
    { path: '/api/v1/agent-inventory/hosted/tasks/task-a/reconcile', body: {} },
    { path: '/api/v1/agent-inventory/hosted/tasks/task-a/close', body: { note: 'Reviewed unknown result and cleanup.' } },
  ])
})

test('suspension status reads stay read-only and retry contains no identity override', async () => {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const api = createInventoryApi({
    get: async <T>(path: string): Promise<T> => { calls.push({ method: 'GET', path }); return { success: true, data: null } as T },
    post: async <T>(path: string, body?: unknown): Promise<T> => { calls.push({ method: 'POST', path, body }); return { success: true, data: null } as T },
  })
  await api.suspension('asset:a')
  await api.suspension('asset:a', true)
  assert.deepEqual(calls, [
    { method: 'GET', path: '/api/v1/agent-inventory/assets/asset%3Aa/suspension' },
    { method: 'POST', path: '/api/v1/agent-inventory/assets/asset%3Aa/suspension', body: {} },
  ])
})

test('native candidate reads remain scoped and cancellable across an organization switch', async () => {
  const controller = new AbortController()
  const calls: string[] = []
  let respond!: (value: unknown) => void
  const request = createInventoryApi({
    get: async <T>(path: string, init?: Partial<RequestInit>): Promise<T> => {
      calls.push(path); assert.equal(init?.signal, controller.signal)
      return new Promise(resolve => { respond = value => resolve(value as T) })
    },
    post: async <T>(): Promise<T> => { throw new Error('A read must not register or publish') },
  }, () => controller.signal).nativeList('asset:a', 'cursor:b')
  controller.abort(); respond({ success: true, data: { items: [{ id: 'old-zone' }], next_cursor: null } })
  await assert.rejects(request, error => error instanceof Error && error.name === 'AbortError')
  assert.deepEqual(calls, ['/api/v1/agent-inventory/assets/asset%3Aa/native-conversions?after=cursor%3Ab'])
})
