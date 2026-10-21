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
