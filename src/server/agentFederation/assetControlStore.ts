import type { DbDriver } from '../db/driver.js'
import { ExternalProviderError } from '../externalProviders/policy.js'

/** Local dispatch fences only. Registry remains the asset and approval authority. */
export async function initializeAssetControls(db: DbDriver) {
  await db.transaction(async () => {
    if (db.kind === 'postgres') await db.get("SELECT pg_advisory_xact_lock(hashtextextended('moss-asset-controls-schema-v1', 0))")
    await db.exec(`CREATE TABLE IF NOT EXISTS agent_asset_gates (
    org_id TEXT NOT NULL, asset_id TEXT NOT NULL, catalog_id TEXT,
    operation_id TEXT, generation BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(org_id, asset_id)
  ); CREATE INDEX IF NOT EXISTS agent_asset_gates_catalog ON agent_asset_gates(org_id, catalog_id);
  CREATE TABLE IF NOT EXISTS agent_asset_suspensions (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, asset_id TEXT NOT NULL,
    request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, command_json TEXT NOT NULL,
    result_json TEXT, document TEXT NOT NULL, status TEXT NOT NULL,
    lease_token TEXT, lease_until BIGINT NOT NULL DEFAULT 0,
    UNIQUE(org_id, request_id)
  );`)
  })
}

/** Must be called inside the transaction that reserves a model call. */
export async function lockAssetGate(db: DbDriver, orgId: string, assetId: string) {
  await db.run('INSERT INTO agent_asset_gates(org_id, asset_id) VALUES (?, ?) ON CONFLICT(org_id, asset_id) DO NOTHING', [orgId, assetId])
  await db.run('UPDATE agent_asset_gates SET asset_id = asset_id WHERE org_id = ? AND asset_id = ?', [orgId, assetId])
  await assertAssetOpen(db, orgId, assetId)
}

export async function assertAssetOpen(db: DbDriver, orgId: string, assetId?: string, catalogId?: string) {
  const row = await db.get(`SELECT operation_id FROM agent_asset_gates WHERE org_id = ?
    AND ${assetId ? 'asset_id' : 'catalog_id'} = ? AND operation_id IS NOT NULL LIMIT 1`, [orgId, assetId ?? catalogId ?? ''])
  if (row) throw new ExternalProviderError(409, 'AGENT_SUSPENSION_ACTIVE')
}

export async function assetControlRevision(db: DbDriver, orgId: string, assetId: string): Promise<number> {
  const row = await db.get('SELECT generation FROM agent_asset_gates WHERE org_id = ? AND asset_id = ?', [orgId, assetId])
  return Number(row?.generation ?? 0)
}
