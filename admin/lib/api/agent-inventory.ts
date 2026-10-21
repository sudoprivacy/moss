import type { HostedUnknownPage } from '../../../src/server/agentFederation/inventoryViews'
export type { HostedUnknownPage }
import { dcClient } from './client'
import type { DiscoverySource, DiscoveryResult } from '../../../src/server/agentFederation/inventoryViews'
import type {
  VersionsPage,
  CreateMigrationPolicy,
  MigrationPolicy,
  MigrationPolicyPage,
  MigrationComparison,
  HostedEvaluationRun,
  HostedEvaluationPage,
  HostedEvaluationCasePage,
  StartHostedEvaluation,
  AssetHistory,
  InventoryWire,
  AssetMetadata,
  HostedArtifact,
  HostedArtifactPage,
  HostedImage,
  DifyTextPlan,
  EvaluationDataset,
  EvaluationDatasetInput,
  EvaluationDatasetPage,
} from '../../../contracts/agent-registry/v1alpha1/contract.gen'
import type {
  InventoryAssetView as AssetRecord,
  InventoryPageView as AssetPage,
} from '../../../src/server/agentFederation/inventoryViews'
export type { AssetRecord, AssetMetadata, AssetHistory, HostedArtifact, HostedImage, DifyTextPlan, EvaluationDataset, EvaluationDatasetInput }
type PublicCommand<T> = T extends { kind: 'SaveAsset' | 'SubmitAsset' | 'ReviewAsset' | 'SuspendAsset' | 'MergeAsset' }
  ? Omit<T, 'api_version' | 'initiated_by'>
  : never
export type InventoryInput =
  | PublicCommand<InventoryWire>
  | { kind: 'LinkAsset'; asset_id: string; request_id: string; expected_revision: number; catalog_id: string }
  | { kind: 'ClaimAsset'; asset_id: string; request_id: string; expected_revision: number }
export interface DiscoveredAsset {
  id: string
  revision: number
  name: string
  platform: string
  external_domain: boolean
}
export type { DiscoverySource, DiscoveryResult }
export interface InventoryAccess {
  can_manage: boolean
  hosted_tasks_available?: boolean
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
export interface HostedReleaseView {
  linked: boolean
  catalog: { id: string; enabled: boolean; status: string; visible_to: { user_ids?: string[] } | null } | null
  registry: VersionsPage | null
}
export type HostedReleaseAction =
  | { action: 'enroll' }
  | { action: 'publish'; artifact_id: string; version: string }
  | { action: 'decide'; version: string; decision: 'approved' | 'revoked'; reason: string; expires_at?: number }
  | { action: 'channel'; version: string; channel: 'stable' | 'canary'; revision: number; reason: string }
  | { action: 'visibility'; enabled: boolean; user_ids: string[] }
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
    hostedUnknown: (after = '') => call<HostedUnknownPage>(`/hosted/tasks/unknown${after ? `?after=${encodeURIComponent(after)}` : ''}`),
    hostedTaskAction: (id: string, action: 'reconcile' | 'close', note?: string) => call<{ task_id: string; status: 'unknown'; cleanup: string }>(`/hosted/tasks/${encodeURIComponent(id)}/${action}`, action === 'close' ? { note } : {}),
    access: () => call<InventoryAccess>('/access'),
    list: (after = '') => call<AssetPage>(`/assets?after=${encodeURIComponent(after)}`),
    get: (id: string) => call<AssetRecord>(`/assets/${encodeURIComponent(id)}`),
    history: (id: string, after = 0) => call<AssetHistory>(`/assets/${encodeURIComponent(id)}/history?after=${after}`),
    members: (q = '', after = '') =>
      call<{ items: InventoryMember[]; next_cursor: string | null }>(
        `/members?q=${encodeURIComponent(q)}&after=${encodeURIComponent(after)}`,
      ),
    command: (body: InventoryInput) => call<AssetRecord>('/commands', body),
    discovered: (after = '') =>
      call<{ items: DiscoveredAsset[]; next_cursor: string | null }>(`/discovered?after=${encodeURIComponent(after)}`),
    sources: () =>
      call<{ items: DiscoverySource[]; allowed_origins: string[]; credentials_available: boolean }>('/sources'),
    createSource: (body: Omit<DiscoverySource, 'id' | 'enabled'> & { api_key: string; csrf_token?: string }) =>
      call<DiscoverySource>('/sources', body),
    disableSource: (id: string) => call<{ disabled: boolean }>(`/sources/${encodeURIComponent(id)}/disable`, {}),
    discover: (source_id: string) => call<DiscoveryResult>('/discover', { source_id }),
    hostedReleases: (assetId: string, after = '') => call<HostedReleaseView>(`/assets/${encodeURIComponent(assetId)}/releases?after=${encodeURIComponent(after)}`),
    hostedReleaseAction: (assetId: string, body: HostedReleaseAction) => call<unknown>(`/assets/${encodeURIComponent(assetId)}/releases`, body),
    hostedList: (assetId: string, after = '') => call<HostedArtifactPage>(`/assets/${encodeURIComponent(assetId)}/artifacts?after=${encodeURIComponent(after)}`),
    datasetList: (assetId: string, after = '') => call<EvaluationDatasetPage>(`/assets/${encodeURIComponent(assetId)}/datasets?after=${encodeURIComponent(after)}`),
    evaluationList: (assetId: string, after = '') => call<HostedEvaluationPage>(`/assets/${encodeURIComponent(assetId)}/evaluations?after=${encodeURIComponent(after)}`),
    evaluationGet: (runId: string) => call<HostedEvaluationRun>(`/hosted/evaluations/${encodeURIComponent(runId)}`),
    evaluationCases: (runId: string, after = '') => call<HostedEvaluationCasePage>(`/hosted/evaluations/${encodeURIComponent(runId)}/cases?after=${encodeURIComponent(after)}`),
    evaluationStart: (body: Omit<StartHostedEvaluation, 'api_version' | 'kind' | 'initiated_by' | 'source_runtime'>) => call<HostedEvaluationRun>('/hosted/evaluations', body),
    migrationPolicies: (assetId: string, after = '') => call<MigrationPolicyPage>(`/assets/${encodeURIComponent(assetId)}/migration-policies?after=${encodeURIComponent(after)}`),
    migrationPolicyCreate: (body: Omit<CreateMigrationPolicy, 'initiated_by'>) => call<MigrationPolicy>('/hosted/migration/policies', body),
    migrationCompare: (runId: string) => call<MigrationComparison>(`/hosted/evaluations/${encodeURIComponent(runId)}/compare`, {}),
    migrationComparison: (id: string) => call<MigrationComparison>(`/hosted/migration/comparisons/${encodeURIComponent(id)}`),
    evaluationAction: (runId: string, action: 'resume' | 'stop' | 'reconcile') => call<HostedEvaluationRun>(`/hosted/evaluations/${encodeURIComponent(runId)}/${action}`, {}),
    datasetRegister: (body: { request_id: string; asset_id: string; metadata_digest: string; dataset: EvaluationDatasetInput }) => call<EvaluationDataset>('/hosted/datasets', body),
    hostedInspect: (source: string) => call<DifyTextPlan>('/hosted/dify/inspect', { source }),
    hostedRegister: (body: { request_id: string; asset_id: string; metadata_digest: string; image: HostedImage; dify_source: string | null }) => call<HostedArtifact>('/hosted/artifacts', body),
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
