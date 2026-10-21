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
