import { assertAssetOpen, assetControlRevision } from './assetControlStore.js'
import { projectHostedTaskEvidence } from './hostedTaskEvidence.js'
import type { HostedAgent } from '../../../contracts/task/v1alpha1/contract.js'
import { randomUUID } from 'node:crypto'
import type { CatalogAgent, CatalogRepository } from '../catalog/catalogRepository.js'
import type { ExternalActor } from '../externalProviders/store.js'
import { digest } from '../externalProviders/store.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import type { HostedArtifact, Resolution } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { HostedTaskCoordinator } from './hostedTaskCoordinator.js'
import type { HostedReleases } from './hostedReleases.js'
import type { ProductRegistryClient } from './registryClient.js'
import { canonicalTaskJson, catalogPrincipal, parseTaskSubmission, TASK_API } from './taskContract.js'
import { registryEvidence } from './registryReleases.js'

function fail(code: string, status = 409): never { throw new ExternalProviderError(status, code) }
export class HostedTaskService {
  readonly store
  private maintenance?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  startMaintenance() {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.maintenance) return
      this.maintenance = this.resumeAccepted().catch(() => {}).finally(() => { this.maintenance = undefined })
    }, 5000)
    this.timer.unref()
  }
  async close() { if (this.timer) clearInterval(this.timer); await this.maintenance }
  constructor(readonly coordinator: HostedTaskCoordinator, private readonly options: {
    catalog: CatalogRepository; registry: ProductRegistryClient; releases: HostedReleases
    activeMember: (actor: ExternalActor) => Promise<boolean>
  }) { this.store = coordinator.store }
  async authorize(actor: ExternalActor) {
    if (!await this.options.activeMember(actor)) fail('USER_NOT_ACTIVE', 403)
  }
  async executable(actor: ExternalActor, id: string) {
    await this.authorize(actor)
    const item = await this.options.catalog.getAgent(id, actor.orgId)
    if (!item || item.providerBinding?.executionMode !== 'internal_hosted' || !item.enabled || item.status !== 'approved'
      || !item.visibleTo?.user_ids?.includes(actor.userId) || typeof item.providerBinding.assetId !== 'string') fail('AGENT_NOT_FOUND', 404)
    await this.store.ready
    const controlRevision = await assetControlRevision(this.store.db, actor.orgId, item.providerBinding.assetId)
    await assertAssetOpen(this.store.db, actor.orgId, item.providerBinding.assetId)
    const expected = await this.options.releases.catalogFor(actor, item.providerBinding.assetId)
    if (!expected || expected.id !== id) fail('HOSTED_CATALOG_IDENTITY_CONFLICT')
    const asset = await this.options.registry.inventoryGet(actor.orgId, item.providerBinding.assetId)
    if (asset.status !== 'approved' || !['L2', 'L3'].includes(asset.actual_level) || asset.metadata.hosting !== 'internal_hosted'
      || !asset.metadata.owner_user_id || !await this.options.activeMember({ orgId: actor.orgId, userId: asset.metadata.owner_user_id })) fail('HOSTED_ASSET_NOT_ADMITTED')
    return { item, asset, controlRevision }
  }
  private async select(actor: ExternalActor, id: string, version?: string, channel?: string) {
    const { item, asset, controlRevision } = await this.executable(actor, id)
    const release = await this.options.registry.resolve(actor.orgId, this.options.registry.principal(actor.orgId, id), { version, channel })
    const artifact = await this.options.releases.artifactFor(actor, item, release.version)
    if (artifact.metadata_digest !== asset.metadata_digest) fail('HOSTED_RELEASE_ARTIFACT_MISMATCH')
    return { item, asset, release, artifact, controlRevision }
  }
  async create(actor: ExternalActor, value: unknown) {
    await this.authorize(actor)
    const input = parseTaskSubmission(value), prior = await this.store.existing(actor, input)
    if (prior) return prior
    let selected: Awaited<ReturnType<HostedTaskService['select']>> | undefined, runtimeId: string | undefined
    let code = 'ALLOWED'
    try {
      let version = input.agent.requested_version
      if (input.session_id) {
        const history = await this.store.history(actor, input.session_id)
        const first = history.find(task => !!task.attempt_id)
        if (first && !version && !input.agent.requested_channel) {
          const r = (await this.store.record(actor, first.id)).resolution
          if (r.status === 'accepted') version = r.agent.version
        }
      }
      selected = await this.select(actor, input.agent.catalog_id, version, input.agent.requested_channel)
      if (input.data_classification !== 'synthetic') fail('DATA_DOMAIN_FORBIDDEN')
      if (input.input.resource_refs.length || input.workspace_refs.length || Object.keys(input.input.parameters ?? {}).length
        || input.output_contract || input.constraints.max_cost_units !== undefined
        || (input.constraints.max_attempts !== undefined && input.constraints.max_attempts !== 1)
        || !['auto', 'private', 'cloud'].includes(input.requested_mode)
        || input.required_capabilities.some(c => !['idempotency', 'version_pin'].includes(c))) fail('HOSTED_TASK_PROFILE_UNSUPPORTED')
      const remaining = Math.min(input.constraints.timeout_ms ?? 270000, input.constraints.deadline ? Date.parse(input.constraints.deadline) - Date.now() : Infinity)
      if (remaining < 35000) fail('DISPATCH_BUDGET_TOO_SHORT')
      runtimeId = await this.coordinator.runtimeIdentity()
    } catch (error) {
      if (!(error instanceof ExternalProviderError)) throw error
      code = error.code
    }
    const policy = { profile: 'hosted-synthetic-text/v1', organization: actor.orgId, catalog_id: input.agent.catalog_id,
      catalog_updated_at: selected?.item.updatedAt ?? null, metadata_digest: selected?.asset.metadata_digest ?? null,
      artifact_id: selected?.artifact.id ?? null, spec_digest: selected?.artifact.spec_digest ?? null, runtime_authority_id: runtimeId ?? null }
    const task = await this.store.create(actor, input, { assetId: selected?.asset.id ?? 'unresolved', ...(code === 'ALLOWED' ? { controlRevision: selected?.controlRevision } : {}), policySnapshot: policy,
      principal: selected?.release.version.manifest.principal ?? catalogPrincipal(input.agent.catalog_id), timeoutMs: 270000,
      resolution: task => {
        const base = { api_version: TASK_API, kind: 'TaskExecutionResolution' as const, resolution_id: randomUUID(), task_id: task.id,
          reason_code: code, reason: code === 'ALLOWED' ? '已核验托管制品、版本、授权及合成数据范围。' : '当前权限、版本、托管环境或输入范围不允许执行。',
          policy_version: policy.profile, policy_snapshot_digest: digest(canonicalTaskJson(policy)), decided_at: new Date(task.created_at).toISOString() }
        if (code !== 'ALLOWED' || !selected || !runtimeId) return { ...base, status: 'rejected' }
        const { release, artifact, asset } = selected
        return { ...base, status: 'accepted', attempt_id: task.attempt_id!, execution_mode: 'internal_hosted', resolved_runtime: 'hosted_artifact',
          runtime_authority_id: runtimeId, resolution_mode: 'default', governance_org_id: actor.orgId, catalog_id: input.agent.catalog_id,
          asset_id: asset.id, artifact_id: artifact.id, metadata_digest: artifact.metadata_digest,
          agent: { principal: release.version.manifest.principal, version: release.version.manifest.version,
            source_digest: artifact.image.source_digest, version_evidence: 'immutable_hosted_artifact', release_digest: artifact.spec_digest,
            registry: registryEvidence(release.version), ...(release.channel ? { resolved_from_channel: release.channel.name, channel_revision: release.channel.revision } : {}) },
          artifact: { spec_digest: artifact.spec_digest, image_id: artifact.image.image_id, dependency_lock_digest: artifact.image.dependency_lock_digest, profile: artifact.image.profile },
          limits: { timeout_ms: 270000, max_model_calls: artifact.image.profile === 'dify-0.6.0-linear-text-v1' ? 1 : 8 } }
      } })
    if (task.status === 'accepted') await this.dispatch(actor, task.id)
    return this.store.get(actor, task.id)
  }
  async dispatch(actor: ExternalActor, taskId: string) {
    const task = await this.store.get(actor, taskId)
    try { await this.coordinator.start(actor, taskId, async () => {
      const record = await this.store.record(actor, taskId)
      if (record.resolution.status !== 'accepted') fail('HOSTED_TASK_ADMISSION_INVALID')
      await this.select(actor, task.catalog_id, record.resolution.agent.version)
    }) } catch (error) {
      if (!(error instanceof ExternalProviderError)) throw error
      if ([400, 401, 403, 404, 409].includes(error.status)) await this.store.failUndispatched(actor, taskId, error.code)
      // Capacity and transient infrastructure outages leave an unstarted durable task queued.
    }
  }
  async resumeAccepted() {
    await this.store.recoverExpired()
    for (const entry of await this.store.pending(8)) {
      try { await this.dispatch(entry.actor, entry.task.id) }
      catch (error) { if (!(error instanceof ExternalProviderError)) throw error }
    }
  }
  /** Called only by the persisted, organization-admin-authorized suspension operation. */
  async suspendAsset(operator: ExternalActor, assetId: string) {
    let pending = 0, tasks = 0
    for (const entry of await this.store.forAsset(operator.orgId, assetId)) {
      tasks++
      try {
        let task = entry.task
        if (['accepted', 'dispatching', 'running'].includes(task.status)) {
          await this.store.auditManagement(operator, entry.actor, task.id, 'suspend')
          task = await this.coordinator.cancel(entry.actor, task.id)
        }
        if (task.status === 'unknown' && task.cleanup !== 'confirmed') task = await this.coordinator.reconcile(entry.actor, task.id)
        if (['accepted', 'dispatching', 'running'].includes(task.status) || ['pending', 'unknown'].includes(task.cleanup)) pending++
      } catch { pending++ }
    }
    return { tasks, pending }
  }
  async evidence(actor: ExternalActor, id: string, cursor = 0) {
    await this.authorize(actor)
    const task = await this.store.get(actor, id)
    const [record, calls, trace] = await Promise.all([
      this.store.record(actor, id), this.coordinator.evidenceCalls(actor, id), this.store.tracePage(actor, id, cursor, task.sequence),
    ])
    return projectHostedTaskEvidence(actor, task, record, calls, trace)
  }
  private describe(item: CatalogAgent, release: Resolution, artifact: HostedArtifact): HostedAgent {
    return { api_version: TASK_API, kind: 'HostedAgent', id: item.id, name: item.name, description: item.description,
      execution_mode: 'internal_hosted', asset_id: artifact.asset_id, version: release.version.manifest.version,
      spec_digest: artifact.spec_digest, source_platform: item.sourceProvider, data_scope: 'synthetic', conversation_mode: 'independent_turns' }
  }
  async list(actor: ExternalActor, cursor = '') {
    await this.authorize(actor)
    const page = await this.options.catalog.listAgents({ orgId: actor.orgId, status: 'approved', mode: 'cloud', cursor, limit: 100 })
    const items: ReturnType<HostedTaskService['describe']>[] = []
    for (const item of page.items) {
      if (item.providerBinding?.executionMode !== 'internal_hosted') continue
      try { const selected = await this.select(actor, item.id); items.push(this.describe(item, selected.release, selected.artifact)) }
      catch (error) { if (!(error instanceof ExternalProviderError) || ![403, 404, 409].includes(error.status)) throw error }
    }
    return { items, next_cursor: page.nextCursor }
  }
  async versions(actor: ExternalActor, id: string, after = '') {
    const { item } = await this.executable(actor, id)
    const page = await this.options.registry.versions(actor.orgId, this.options.registry.principal(actor.orgId, id), after)
    const items: { version: string; spec_digest: string; source_digest: string; approval_expires_at: number }[] = []
    for (const row of page.items) {
      if (row.decision?.decision !== 'approved' || (row.decision.expires_at ?? 0) <= Date.now()) continue
      const selected = await this.select(actor, item.id, row.version.manifest.version)
      items.push({ version: row.version.manifest.version, spec_digest: selected.artifact.spec_digest, source_digest: selected.artifact.image.source_digest, approval_expires_at: row.decision.expires_at! })
    }
    return { items, channels: page.channels, next_cursor: page.next_cursor }
  }
}
