import { randomUUID } from 'node:crypto'
import type { AssetRecord, InventoryWire } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import type { DbDriver } from '../db/driver.js'
import type { ExternalActor } from '../externalProviders/store.js'
import type { ExternalProviderService } from '../externalProviders/service.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { contentDigest } from './provider/protocol.js'
import type { ProductRegistryClient } from './registryClient.js'
import type { ExecutionModelGateway } from './executionModelGateway.js'
import type { HostedTaskService } from './hostedTaskService.js'
import type { AssetSuspensionView } from './inventoryViews.js'
import { initializeAssetControls } from './assetControlStore.js'

type Suspend = Extract<InventoryWire, { kind: 'SuspendAsset' }>
function fail(code: string, status = 409): never { throw new ExternalProviderError(status, code) }

/** Durable management operation. Every retried action only closes/revokes; never dispatches. */
export class AssetSuspensions {
  readonly ready: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private work?: Promise<void>
  constructor(private readonly db: DbDriver, private readonly registry: ProductRegistryClient, private readonly ports: {
    gateway?: Pick<ExecutionModelGateway, 'suspendAsset'>
    tasks?: Pick<HostedTaskService, 'suspendAsset'>
    external?: ExternalProviderService
  }) { this.ready = initializeAssetControls(db) }
  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (!this.work) this.work = this.maintain().catch(() => {}).finally(() => { this.work = undefined })
    }, 5000)
    this.timer.unref()
  }
  async close() { if (this.timer) clearInterval(this.timer); await this.work }
  async request(actor: ExternalActor, command: Suspend, asset: AssetRecord): Promise<AssetRecord> {
    await this.ready
    if (command.asset_id !== asset.id || command.initiated_by !== actor.userId) fail('INVALID_SUSPENSION')
    const catalogId = asset.principal ? this.registry.catalogId(actor.orgId, asset.principal) : null
    const fingerprint = contentDigest({ actor: { orgId: actor.orgId, userId: actor.userId }, command }), id = randomUUID(), now = Date.now()
    await this.ports.external?.store.ready
    await this.db.transaction(async () => {
      // Same lock order as external admission/dispatch: binding then local gate.
      if (catalogId && this.ports.external) await this.db.run('UPDATE external_pilot_bindings SET document = document WHERE org_id = ? AND id = ?', [actor.orgId, catalogId])
      await this.db.run('INSERT INTO agent_asset_gates(org_id, asset_id) VALUES (?, ?) ON CONFLICT(org_id, asset_id) DO NOTHING', [actor.orgId, asset.id])
      await this.db.run('UPDATE agent_asset_gates SET asset_id = asset_id WHERE org_id = ? AND asset_id = ?', [actor.orgId, asset.id])
      const previous = await this.db.get('SELECT fingerprint FROM agent_asset_suspensions WHERE org_id = ? AND request_id = ?', [actor.orgId, command.request_id])
      if (previous) { if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT'); return }
      const gate = await this.db.get('SELECT operation_id FROM agent_asset_gates WHERE org_id = ? AND asset_id = ?', [actor.orgId, asset.id])
      if (gate?.operation_id) fail('AGENT_SUSPENSION_ACTIVE')
      const report: AssetSuspensionView = { id, asset_id: asset.id, requested_by: actor.userId, requested_at: now, updated_at: now,
        status: 'pending', entry: 'closed_locally', identity: 'pending', model: 'pending', hosted: 'pending',
        grants: 0, model_calls: 0, hosted_tasks: 0, external_tasks: null,
        external_cancellation: 'unsupported', error_code: null }
      await this.db.run(`INSERT INTO agent_asset_suspensions(id, org_id, asset_id, request_id, fingerprint, command_json, document, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`, [id, actor.orgId, asset.id, command.request_id, fingerprint, JSON.stringify(command), JSON.stringify(report)])
      await this.db.run('UPDATE agent_asset_gates SET operation_id = ?, catalog_id = ?, generation = generation + 1 WHERE org_id = ? AND asset_id = ?', [id, catalogId, actor.orgId, asset.id])
    })
    const row = await this.db.get('SELECT id FROM agent_asset_suspensions WHERE org_id = ? AND request_id = ?', [actor.orgId, command.request_id])
    await this.reconcile(actor.orgId, String(row!.id))
    const updated = await this.db.get('SELECT result_json, document FROM agent_asset_suspensions WHERE org_id = ? AND id = ?', [actor.orgId, row!.id as string])
    if (!updated?.result_json) fail((JSON.parse(String(updated?.document)) as AssetSuspensionView).error_code ?? 'AGENT_SUSPENSION_PENDING', 503)
    // Fresh current record, not an old command response after a later restoration.
    return this.registry.inventoryGet(actor.orgId, asset.id)
  }
  async get(orgId: string, assetId: string): Promise<AssetSuspensionView | null> {
    await this.ready
    const row = await this.db.get(`SELECT o.document FROM agent_asset_suspensions o JOIN agent_asset_gates g ON g.org_id = o.org_id AND g.asset_id = o.asset_id
      WHERE o.org_id = ? AND o.asset_id = ? AND o.id = g.operation_id`, [orgId, assetId])
    return row ? JSON.parse(String(row.document)) as AssetSuspensionView : null
  }
  async assertRestorable(orgId: string, assetId: string) {
    const current = await this.get(orgId, assetId)
    if (current && current.status !== 'confirmed') fail('AGENT_SUSPENSION_PENDING')
    return current?.id ?? null
  }
  async restored(orgId: string, assetId: string, operationId: string | null) {
    if (operationId) await this.db.run('UPDATE agent_asset_gates SET operation_id = NULL WHERE org_id = ? AND asset_id = ? AND operation_id = ?', [orgId, assetId, operationId])
  }
  async retry(orgId: string, assetId: string) {
    const current = await this.get(orgId, assetId)
    if (!current) fail('AGENT_SUSPENSION_NOT_FOUND', 404)
    await this.reconcile(orgId, current.id)
    return this.get(orgId, assetId)
  }
  private async hasPersistedWork(orgId: string, assetId: string, kind: 'model' | 'hosted') {
    const table = kind === 'model' ? 'agent_model_calls' : 'tasks'
    const exists = await this.db.get(this.db.kind === 'postgres'
      ? "SELECT 1 AS present FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?"
      : "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", [table])
    if (!exists) return false
    const field = kind === 'model' ? 'assetId' : 'asset_id'
    const extract = this.db.kind === 'postgres' ? `document::jsonb ->> '${field}'` : `json_extract(document, '$.${field}')`
    return !!await this.db.get(`SELECT 1 AS present FROM ${table} WHERE org_id = ? AND (${extract}) = ? LIMIT 1`, [orgId, assetId])
  }
  private async maintain() {
    await this.ready
    const now = Date.now()
    const rows = await this.db.all("SELECT org_id, id FROM agent_asset_suspensions WHERE status = 'pending' AND lease_until < ? ORDER BY lease_until, id LIMIT 8", [now])
    for (const row of rows) await this.reconcile(String(row.org_id), String(row.id))
  }
  private async reconcile(orgId: string, id: string) {
    const lease = randomUUID()
    if (!await this.db.run(`UPDATE agent_asset_suspensions SET lease_token = ?, lease_until = ? WHERE org_id = ? AND id = ? AND lease_until < ? AND status = 'pending'`, [lease, Date.now() + 120000, orgId, id, Date.now()])) return
    const row = await this.db.get('SELECT command_json, result_json, document FROM agent_asset_suspensions WHERE org_id = ? AND id = ?', [orgId, id])
    const command = JSON.parse(String(row!.command_json)) as Suspend, report = JSON.parse(String(row!.document)) as AssetSuspensionView
    const actor = { orgId, userId: report.requested_by }
    const errors: string[] = []
    const attempt = async (action: () => Promise<void>) => {
      try { await action() }
      catch (error) { errors.push(error instanceof ExternalProviderError ? error.code : 'AGENT_SUSPENSION_UNCONFIRMED') }
    }
    try {
      let asset: AssetRecord | undefined
      await attempt(async () => {
        asset = row!.result_json ? JSON.parse(String(row!.result_json)) as AssetRecord : await this.registry.inventoryCommand(orgId, command)
        if (asset.status !== 'suspended' || asset.id !== command.asset_id) fail('AGENT_SUSPENSION_RESPONSE_INVALID', 503)
        if (!row!.result_json) await this.db.run('UPDATE agent_asset_suspensions SET result_json = ? WHERE id = ? AND org_id = ? AND lease_token = ?', [JSON.stringify(asset), id, orgId, lease])
        report.entry = 'confirmed'
      })
      if (!row!.result_json && errors.includes('AGENT_ASSET_REVISION_CONFLICT')) {
        report.status = 'failed'; report.error_code = 'AGENT_ASSET_REVISION_CONFLICT'
        await this.restored(orgId, command.asset_id, id)
        return
      }
      // An unavailable authority must not stop independent model/resource cleanup.
      report.identity = report.model = report.hosted = 'pending'
      await attempt(async () => {
        let after = '', pending = false, grants = 0, complete = false
        for (let i = 0; i < 100; i++) {
          const page = await this.registry.executionList(orgId, command.asset_id, after)
          for (const grant of page.items) {
            grants++
            try { if ((await this.registry.executionRevoke(orgId, grant.id)).cleanup_pending) pending = true } catch { pending = true }
          }
          if (!page.next_cursor) { complete = true; break }
          after = page.next_cursor
        }
        report.grants = grants; report.identity = complete && !pending ? 'confirmed' : 'pending'
      })
      await attempt(async () => {
        if (this.ports.gateway) {
          const result = await this.ports.gateway.suspendAsset(orgId, command.asset_id)
          report.model_calls = result.calls; report.model = result.pending ? 'pending' : 'confirmed'
        } else report.model = await this.hasPersistedWork(orgId, command.asset_id, 'model') ? 'pending' : 'not_configured'
      })
      await attempt(async () => {
        if (this.ports.tasks) {
          const result = await this.ports.tasks.suspendAsset(actor, command.asset_id)
          report.hosted_tasks = result.tasks; report.hosted = result.pending ? 'pending' : 'confirmed'
        } else report.hosted = await this.hasPersistedWork(orgId, command.asset_id, 'hosted') ? 'pending' : 'not_configured'
      })
      await attempt(async () => {
        const gate = await this.db.get('SELECT catalog_id FROM agent_asset_gates WHERE org_id = ? AND asset_id = ?', [orgId, command.asset_id])
        if (gate?.catalog_id && this.ports.external) report.external_tasks = await this.ports.external.suspendCatalog(actor, String(gate.catalog_id))
      })
      report.error_code = errors[0] ?? null
      report.status = errors.length || report.entry !== 'confirmed' || [report.identity, report.model, report.hosted].includes('pending') ? 'pending' : 'confirmed'
    } finally {
      report.updated_at = Date.now()
      await this.db.run('UPDATE agent_asset_suspensions SET document = ?, status = ?, lease_until = 0, lease_token = NULL WHERE org_id = ? AND id = ? AND lease_token = ?', [JSON.stringify(report), report.status, orgId, id, lease])
    }
  }
}
