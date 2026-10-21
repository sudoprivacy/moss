import type { AssetRecord, AssetPage } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'

/** Moss presentation data; identity and governance remain the Nexus owner record. */
export type InventoryAssetView = AssetRecord & {
  owner_display_name: string | null
  department_display_name: string | null
}
export type InventoryPageView = Omit<AssetPage, 'items'> & { items: InventoryAssetView[] }
