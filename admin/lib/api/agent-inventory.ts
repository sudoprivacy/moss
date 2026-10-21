import { dcClient } from './client'
import type {
  AssetHistory,
  InventoryWire,
  AssetMetadata,
} from '../../../contracts/agent-registry/v1alpha1/contract.gen'
import type {
  InventoryAssetView as AssetRecord,
  InventoryPageView as AssetPage,
} from '../../../src/server/agentFederation/inventoryViews'
export type { AssetRecord, AssetMetadata, AssetHistory }
type PublicCommand<T> = T extends { kind: 'SaveAsset' | 'SubmitAsset' | 'ReviewAsset' | 'SuspendAsset' | 'MergeAsset' }
  ? Omit<T, 'api_version' | 'initiated_by'>
  : never
export type InventoryInput =
  | PublicCommand<InventoryWire>
  | { kind: 'LinkAsset'; asset_id: string; request_id: string; expected_revision: number; catalog_id: string }
export interface InventoryAccess {
  can_manage: boolean
  configured: boolean
  user_id: string
  department_id: string | null
  can_own: boolean
}
export interface InventoryMember {
  id: string
  name: string
  department_id: string | null
}
interface Client {
  get<T>(path: string, options?: Partial<RequestInit>): Promise<T>
  post<T>(path: string, body?: unknown, options?: Partial<RequestInit>): Promise<T>
}
export function createInventoryApi(client: Client = dcClient, signal?: () => AbortSignal) {
  const base = '/api/v1/agent-inventory'
  async function call<T>(path: string, body?: unknown): Promise<T> {
    const requestSignal = signal?.()
    const result =
      body === undefined
        ? await client.get<{ success: boolean; data: T }>(base + path, { signal: requestSignal })
        : await client.post<{ success: boolean; data: T }>(base + path, body, { signal: requestSignal })
    requestSignal?.throwIfAborted()
    if (!result.success || result.data === undefined) throw new Error('AGENT_INVENTORY_UNAVAILABLE')
    return result.data
  }
  return {
    access: () => call<InventoryAccess>('/access'),
    list: (after = '') => call<AssetPage>(`/assets?after=${encodeURIComponent(after)}`),
    get: (id: string) => call<AssetRecord>(`/assets/${encodeURIComponent(id)}`),
    history: (id: string, after = 0) => call<AssetHistory>(`/assets/${encodeURIComponent(id)}/history?after=${after}`),
    members: (q = '', after = '') =>
      call<{ items: InventoryMember[]; next_cursor: string | null }>(
        `/members?q=${encodeURIComponent(q)}&after=${encodeURIComponent(after)}`,
      ),
    command: (body: InventoryInput) => call<AssetRecord>('/commands', body),
  }
}

/** JSON preserves references and missing cost data without spreadsheet formula execution. */
export async function exportInventory(api: Pick<ReturnType<typeof createInventoryApi>, 'list'>, signal: AbortSignal) {
  const items: AssetRecord[] = [],
    visited = new Set<string>()
  let after = ''
  do {
    signal.throwIfAborted()
    const page = await api.list(after)
    signal.throwIfAborted()
    for (const row of page.items) {
      if (visited.has(row.id) || row.id <= after) throw new Error('INVALID_ASSET_CURSOR')
      visited.add(row.id)
      items.push(row)
    }
    if (items.length > 10000) throw new Error('INVENTORY_EXPORT_LIMIT')
    if (!page.next_cursor) break
    if (page.next_cursor <= after || page.next_cursor !== page.items.at(-1)?.id) throw new Error('INVALID_ASSET_CURSOR')
    after = page.next_cursor
  } while (true)
  return JSON.stringify(
    { exported_at: new Date().toISOString(), consistency: 'per_record_revision', cost_source: 'router', items },
    null,
    2,
  )
}
