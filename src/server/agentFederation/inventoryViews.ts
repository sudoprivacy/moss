import type {
  AssetRecord,
  AssetPage,
  AssetMetadata,
  DiscoveryEvidence,
} from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'

/** Moss presentation data; identity and governance remain the Nexus owner record. */
export type InventoryAssetView = AssetRecord & {
  owner_display_name: string | null
  department_display_name: string | null
}
export type InventoryPageView = Omit<AssetPage, 'items'> & { items: InventoryAssetView[] }

export type DiscoveryKind = 'dify' | 'router' | 'platform'
export interface DiscoverySource {
  id: string
  name: string
  kind: DiscoveryKind
  origin: string
  scope: string
  external_domain: boolean
  enabled: boolean
}
export interface DiscoveredAgent {
  metadata: AssetMetadata
  observation: DiscoveryEvidence
}
export interface DiscoveryResult {
  source_id: string
  scanned: number
  created: number
  updated: number
  unchanged: number
  complete: boolean
  boundary: string
  error?: string
}

export interface HostedUnknownPage {
  items: { task_id: string; session_id: string; catalog_id: string; asset_id: string; user_id: string; updated_at: number;
    cleanup: 'not_started' | 'pending' | 'confirmed' | 'unknown'; error_code: string | null }[]
  next_cursor: string | null
}
