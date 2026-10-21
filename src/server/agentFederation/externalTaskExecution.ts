import { isDeepStrictEqual } from 'node:util'
import { validateExecutionContext } from './taskExecutionContext.js'
import type { AgentVersionManifest, TaskExecutionContext, TaskGrantProfile } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import type { ExternalTask } from '../../../contracts/external-provider/v1/contract.js'
import type { ExternalActor } from '../externalProviders/store.js'
import type { DbDriver } from '../db/driver.js'
import type { ProductRegistryClient } from './registryClient.js'
import type { ExecutionModelGateway } from './executionModelGateway.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { assetControlRevision, initializeAssetControls, lockAssetGate } from './assetControlStore.js'

interface ExecutionRecord {
  orgId: string; taskId: string; attemptId: string; assetId: string; requestId: string; generation: number
  state: 'issuing' | 'active' | 'cleanup_pending' | 'closed'; grantId?: string; expiresAt: number
}
function fail(code: string): never { throw new ExternalProviderError(409, code) }

/** One external Attempt receives one task grant; raw credentials live only in the executing controller. */
export class ExternalTaskExecution {
  readonly ready: Promise<void>
  readonly origin: string
  constructor(private readonly db: DbDriver,
    private readonly registry: Pick<ProductRegistryClient, 'admittedAsset' | 'executionIssue' | 'executionAuthorize' | 'executionRevokeRequest'>,
    private readonly gateway: Pick<ExecutionModelGateway, 'stopTaskCalls'>,
    origin: string) {
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail('TASK_CONTEXT_ORIGIN_INVALID')
    this.origin = url.origin
    this.ready = initializeAssetControls(db).then(() => db.transaction(async () => {
      if (db.kind === 'postgres') await db.get("SELECT pg_advisory_xact_lock(hashtextextended('moss-external-task-execution-v1', 0))")
      await db.exec(`CREATE TABLE IF NOT EXISTS external_task_execution (
      task_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL, last_cleanup_at BIGINT NOT NULL DEFAULT 0, document TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS external_task_execution_pending ON external_task_execution(state, task_id);`)
    }))
  }
  async prepare(actor: ExternalActor, task: ExternalTask, version: AgentVersionManifest, profile: TaskGrantProfile,
    signal: AbortSignal, fresh: () => Promise<void>): Promise<TaskExecutionContext> {
    await this.ready; await fresh(); signal.throwIfAborted()
    if (!task.attempt_id || !version.registry || task.source_digest !== version.snapshot.source_digest || task.deadline_at <= Date.now()
      || !isDeepStrictEqual(version.snapshot.sourceManifest?.execution_context, profile)) fail('TASK_CONTEXT_RELEASE_REQUIRED')
    const asset = await this.registry.admittedAsset(actor.orgId, version.principal, version.spec_digest)
    if (asset.metadata.hosting !== 'external_hosted' || !asset.metadata.model_paths?.includes(profile.model_resource)
      || profile.tool_resources.some(resource => !asset.metadata.tool_refs?.includes(resource))) fail('TASK_CONTEXT_ASSET_SCOPE_MISMATCH')
    await fresh(); signal.throwIfAborted()
    const record: ExecutionRecord = { orgId: actor.orgId, taskId: task.id, attemptId: task.attempt_id, assetId: asset.id,
      requestId: `external-${task.attempt_id}`, generation: 0, state: 'issuing', expiresAt: task.deadline_at }
    await this.db.transaction(async () => {
      await lockAssetGate(this.db, actor.orgId, asset.id)
      record.generation = await assetControlRevision(this.db, actor.orgId, asset.id)
      const created = await this.db.run('INSERT INTO external_task_execution(task_id,org_id,attempt_id,state,document) VALUES (?,?,?,?,?) ON CONFLICT(task_id) DO NOTHING',
        [task.id, actor.orgId, task.attempt_id!, record.state, JSON.stringify(record)])
      if (!created) fail('TASK_CONTEXT_ALREADY_ISSUED')
    })
    const issued = await this.registry.executionIssue(actor.orgId, { api_version: 'agent-registry.sudo.dev/v1alpha1', kind: 'IssueExecutionGrant',
      request_id: record.requestId, asset_id: asset.id, metadata_digest: asset.metadata_digest, spec_digest: version.spec_digest,
      task_id: task.id, initiated_by: actor.userId, mode: 'run', version: version.version, dataset_digest: null,
      permissions: [{ operation: 'model.invoke', resource: profile.model_resource }, ...profile.tool_resources.map(resource => ({ operation: 'tool.invoke' as const, resource }))],
      ttl_seconds: Math.min(300, Math.max(1, Math.floor((task.deadline_at - Date.now()) / 1000))), max_model_calls: profile.max_model_calls })
    if (!issued.api_key) fail('TASK_CONTEXT_CREDENTIAL_UNAVAILABLE')
    if (issued.grant.expires_at > task.deadline_at) fail('TASK_CONTEXT_DEADLINE_EXCEEDED')
    await fresh(); signal.throwIfAborted()
    await this.db.transaction(async () => {
      await lockAssetGate(this.db, actor.orgId, asset.id)
      if (record.generation !== await assetControlRevision(this.db, actor.orgId, asset.id)) fail('TASK_CONTEXT_GENERATION_CHANGED')
      record.grantId = issued.grant.id; record.expiresAt = issued.grant.expires_at; record.state = 'active'
      const saved = await this.db.run("UPDATE external_task_execution SET state='active', document=? WHERE task_id=? AND org_id=? AND state='issuing'",
        [JSON.stringify(record), task.id, actor.orgId])
      if (!saved) fail('TASK_CONTEXT_CLOSED')
    })
    await this.registry.executionAuthorize(actor.orgId, { grant_id: issued.grant.id, task_id: task.id, spec_digest: version.spec_digest,
      permission: { operation: 'model.invoke', resource: profile.model_resource }, token: issued.api_key })
    await fresh(); signal.throwIfAborted()
    await this.db.transaction(async () => {
      await lockAssetGate(this.db, actor.orgId, asset.id)
      const row = await this.db.get('SELECT state FROM external_task_execution WHERE org_id=? AND task_id=?', [actor.orgId, task.id])
      if (row?.state !== 'active' || record.generation !== await assetControlRevision(this.db, actor.orgId, asset.id)) fail('TASK_CONTEXT_CLOSED')
    })
    return validateExecutionContext({ ...profile, task_id: task.id, attempt_id: task.attempt_id, session_id: task.session_id, org_id: actor.orgId,
      grant_id: issued.grant.id, spec_digest: version.spec_digest, expires_at: issued.grant.expires_at,
      model_gateway: `${this.origin}/api/v1/agent-models/${actor.orgId}/invoke`, tool_gateway: `${this.origin}/api/v1/agent-tools/${actor.orgId}/invoke`, access_token: issued.api_key }, { task_id: task.id, attempt_id: task.attempt_id, session_id: task.session_id, org_id: actor.orgId }, profile)
  }
  async finish(orgId: string, taskId: string): Promise<boolean> {
    await this.ready
    const record = await this.db.transaction(async () => {
      // Persist closure before network I/O; a delayed issuer can no longer activate.
      await this.db.run("UPDATE external_task_execution SET state='cleanup_pending', last_cleanup_at=? WHERE task_id=? AND org_id=? AND state <> 'closed'", [Date.now(), taskId, orgId])
      const row = await this.db.get('SELECT state,document FROM external_task_execution WHERE org_id=? AND task_id=?', [orgId, taskId])
      if (!row || row.state === 'closed') return undefined
      return JSON.parse(String(row.document)) as ExecutionRecord
    })
    if (!record) return true
    let clean = true
    try { if ((await this.registry.executionRevokeRequest(orgId, record.requestId, taskId)).cleanup_pending) clean = false } catch { clean = false }
    // Router cleanup is independent of owner availability. Do not wait for the grant TTL.
    try { if ((await this.gateway.stopTaskCalls(orgId, taskId)).pending) clean = false } catch { clean = false }
    await this.db.transaction(async () => {
      await this.db.run('UPDATE external_task_execution SET document=document WHERE task_id=? AND org_id=?', [taskId, orgId])
      const row = await this.db.get('SELECT state,document FROM external_task_execution WHERE org_id=? AND task_id=?', [orgId, taskId])
      if (!row || row.state === 'closed') return
      const latest = JSON.parse(String(row.document)) as ExecutionRecord
      latest.state = clean ? 'closed' : 'cleanup_pending'
      await this.db.run('UPDATE external_task_execution SET state=?,document=? WHERE task_id=? AND org_id=?', [latest.state, JSON.stringify(latest), taskId, orgId])
    })
    return clean
  }
  /** Restart recovery only closes grants and model tokens; never issues or resends a provider request. */
  async maintain() {
    await this.ready
    const rows = await this.db.all(`SELECT e.task_id,e.org_id FROM external_task_execution e LEFT JOIN external_tasks t ON t.id=e.task_id
      WHERE e.state <> 'closed' AND (e.state='cleanup_pending' OR t.id IS NULL OR t.status NOT IN ('accepted','dispatching','running') OR t.deadline_at <= ?)
      ORDER BY e.last_cleanup_at,e.task_id LIMIT 32`, [Date.now()])
    for (const row of rows) {
      try { await this.finish(String(row.org_id), String(row.task_id)) } catch { /* Keep pending and allow the next task's independent cleanup. */ }
    }
  }
}
