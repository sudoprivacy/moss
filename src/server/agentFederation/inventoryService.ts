import type { HostedTaskService } from './hostedTaskService.js'
import type { HostedReleases } from './hostedReleases.js'
import type { HostedEvaluationCoordinator } from './hostedEvaluationCoordinator.js'
import type { StartHostedEvaluation, CreateMigrationPolicy } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { AGENT_REGISTRY_API, type AssetRecord } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import type { AuthContext } from '../auth/token.js'
import type { CatalogRepository } from '../catalog/catalogRepository.js'
import { object } from '../externalProviders/administration.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { parseInventoryCommand, type ProductRegistryClient } from './registryClient.js'
import type { InventoryAssetView, InventoryPageView } from './inventoryViews.js'
import { discoveryDigest, discoveryId, discoverySourceKey, type DiscoveryResult } from './inventoryDiscovery.js'
import type { InventorySources } from './inventorySources.js'
import type { RegisterHostedArtifact, RegisterEvaluationDataset } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'

export interface InventoryServiceOptions {
  registry?: ProductRegistryClient
  tasks?: HostedTaskService
  hosted?: HostedEvaluationCoordinator
  releases?: HostedReleases
  sources?: InventorySources
  catalog: Pick<CatalogRepository, 'getAgent'>
  authorize: (actor: AuthContext) => Promise<{ canManage: boolean }>
  member: (orgId: string, userId: string) => Promise<{ id: string; departmentId: string | null } | null>
  members: (
    orgId: string,
    after: string,
    search: string,
  ) => Promise<{ id: string; name: string; department_id: string | null }[]>
  labels: (
    orgId: string,
    userIds: string[],
    departmentIds: string[],
  ) => Promise<{ users: Map<string, string>; departments: Map<string, string> }>
}
function fail(code: string, status = 400): never {
  throw new ExternalProviderError(status, code)
}
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,149}$/.test(value)) fail('INVALID_INVENTORY_ID')
  return value as string
}

/** Authenticated management gateway. Never accepts an end-user's attestation or IAM grant. */
export class AgentInventoryService {
  constructor(private readonly options: InventoryServiceOptions) {}
  private registry(orgId: string): ProductRegistryClient {
    if (!this.options.registry) fail('REGISTRY_NOT_CONFIGURED', 503)
    this.options.registry.scope(orgId)
    return this.options.registry
  }
  async access(actor: AuthContext) {
    const access = await this.options.authorize(actor)
    let configured = false
    try {
      this.registry(actor.orgId)
      configured = true
    } catch (error) {
      if (
        !(error instanceof ExternalProviderError) ||
        !['REGISTRY_NOT_CONFIGURED', 'REGISTRY_ORGANIZATION_UNCONFIGURED'].includes(error.code)
      )
        throw error
    }
    const member = await this.options.member(actor.orgId, actor.userId)
    return {
      can_manage: access.canManage,
      hosted_tasks_available: access.canManage && !!this.options.tasks,
      configured,
      user_id: actor.userId,
      department_id: member?.departmentId ?? null,
      can_own: !!member,
    }
  }
  private async managedTasks(actor: AuthContext) {
    if (!(await this.options.authorize(actor)).canManage) fail('ADMIN_REQUIRED', 403)
    if (!this.options.tasks) fail('HOSTED_TASKS_UNAVAILABLE', 503)
    return this.options.tasks
  }
  async hostedUnknown(actor: AuthContext, after = '') {
    const tasks = await this.managedTasks(actor)
    return tasks.store.unknowns(actor.orgId, after)
  }
  async hostedTaskAction(actor: AuthContext, id: string, action: 'reconcile' | 'close', body: unknown) {
    const tasks = await this.managedTasks(actor)
    const input = object(body, action === 'close' ? ['note'] : [])
    if (action === 'close' && (typeof input.note !== 'string' || input.note.trim().length < 10 || input.note.length > 2000)) fail('INVALID_RECONCILIATION')
    const owner = await tasks.store.managementOwner(actor.orgId, identifier(id))
    const task = await tasks.store.get(owner, id)
    if (task.status !== 'unknown') fail('HOSTED_RECONCILIATION_CONFLICT', 409)
    await tasks.store.auditManagement(actor, owner, id, action)
    const result = action === 'close' ? await tasks.store.closeUnknown(owner, id, input.note as string, actor) : await tasks.coordinator.reconcile(owner, id)
    return { task_id: result.id, status: result.status, cleanup: result.cleanup }
  }
  async members(actor: AuthContext, after = '', search = '') {
    if (!(await this.options.authorize(actor)).canManage) fail('ADMIN_REQUIRED', 403)
    if (after) identifier(after)
    if (search.length > 100) fail('INVALID_INVENTORY_SEARCH')
    const rows = await this.options.members(actor.orgId, after, search)
    return { items: rows.slice(0, 50), next_cursor: rows.length > 50 ? rows[49].id : null }
  }
  private async readable(actor: AuthContext, id: string, canManage: boolean): Promise<AssetRecord> {
    const asset = await this.registry(actor.orgId).inventoryGet(actor.orgId, identifier(id))
    if (!canManage && asset.metadata.owner_user_id !== actor.userId) fail('AGENT_ASSET_NOT_FOUND', 404)
    return asset
  }
  private async present(orgId: string, rows: AssetRecord[]): Promise<InventoryAssetView[]> {
    const labels = await this.options.labels(
      orgId,
      [...new Set(rows.map((row) => row.metadata.owner_user_id).filter((id): id is string => !!id))],
      [...new Set(rows.map((row) => row.metadata.department_id).filter((id): id is string => !!id))],
    )
    return rows.map((row) => ({
      ...row,
      owner_display_name: labels.users.get(row.metadata.owner_user_id ?? '') ?? null,
      department_display_name: labels.departments.get(row.metadata.department_id ?? '') ?? null,
    }))
  }
  async list(actor: AuthContext, after = ''): Promise<InventoryPageView> {
    const { canManage } = await this.options.authorize(actor)
    if (after) identifier(after)
    const page = await this.registry(actor.orgId).inventoryList(
      actor.orgId,
      after,
      canManage ? undefined : actor.userId,
    )
    return { ...page, items: await this.present(actor.orgId, page.items) }
  }
  async get(actor: AuthContext, id: string) {
    const { canManage } = await this.options.authorize(actor)
    return (await this.present(actor.orgId, [await this.readable(actor, id, canManage)]))[0]
  }
  async history(actor: AuthContext, id: string, after = 0) {
    const { canManage } = await this.options.authorize(actor)
    if (!Number.isSafeInteger(after) || after < 0) fail('INVALID_ASSET_CURSOR')
    await this.readable(actor, id, canManage)
    return this.registry(actor.orgId).inventoryHistory(actor.orgId, id, after)
  }
  async hostedList(actor: AuthContext, id: string, after = '') {
    const { canManage } = await this.options.authorize(actor)
    await this.readable(actor, id, canManage)
    if (after) identifier(after)
    return this.registry(actor.orgId).hostedList(actor.orgId, id, after)
  }
  async hostedReleases(actor: AuthContext, assetId: string, after = '') {
    const { canManage } = await this.options.authorize(actor)
    await this.readable(actor, identifier(assetId), canManage)
    if (after) identifier(after)
    if (!this.options.releases) fail('REGISTRY_NOT_CONFIGURED', 503)
    return this.options.releases.list(actor, assetId, after)
  }
  async hostedReleaseAction(actor: AuthContext, assetId: string, body: unknown) {
    if (!(await this.options.authorize(actor)).canManage) fail('ADMIN_REQUIRED', 403)
    await this.readable(actor, identifier(assetId), true)
    const releases = this.options.releases
    if (!releases) fail('REGISTRY_NOT_CONFIGURED', 503)
    const action = body && typeof body === 'object' && 'action' in body ? body.action : undefined
    const closing = body && typeof body === 'object' && ((action === 'visibility' && 'enabled' in body && body.enabled === false)
      || (action === 'decide' && 'decision' in body && body.decision === 'revoked'))
    if (!closing) await this.evaluationManage(actor, assetId)
    if (action === 'enroll') { object(body, ['action']); return releases.enroll(actor, assetId) }
    if (action === 'publish') {
      const input = object(body, ['action', 'artifact_id', 'version'])
      if (typeof input.version !== 'string') fail('INVALID_RELEASE_INPUT')
      return releases.publish(actor, assetId, identifier(input.artifact_id), input.version)
    }
    if (action === 'decide') {
      const input = object(body, ['action', 'version', 'decision', 'reason', 'expires_at'])
      if (typeof input.version !== 'string' || typeof input.reason !== 'string' || !['approved', 'revoked'].includes(String(input.decision))) fail('INVALID_RELEASE_INPUT')
      return releases.decide(actor, assetId, input.version, input.decision as 'approved' | 'revoked', input.reason, input.expires_at as number | undefined)
    }
    if (action === 'channel') {
      const input = object(body, ['action', 'version', 'channel', 'revision', 'reason'])
      if (typeof input.version !== 'string' || typeof input.reason !== 'string') fail('INVALID_RELEASE_INPUT')
      return releases.promote(actor, assetId, input.version, input.channel as 'stable' | 'canary', input.revision as number, input.reason)
    }
    if (action === 'visibility') {
      const input = object(body, ['action', 'enabled', 'user_ids'])
      if (typeof input.enabled !== 'boolean' || !Array.isArray(input.user_ids) || input.user_ids.length > 500) fail('INVALID_RELEASE_INPUT')
      const users = [...new Set(input.user_ids.map(identifier))]
      if (input.enabled && (await Promise.all(users.map(id => this.options.member(actor.orgId, id)))).some(user => !user)) fail('INVALID_MEMBER')
      return releases.visibility(actor, assetId, input.enabled, users)
    }
    fail('INVALID_RELEASE_INPUT')
  }
  async hostedInspect(actor: AuthContext, body: unknown) {
    if (!(await this.options.authorize(actor)).canManage) fail('ADMIN_REQUIRED', 403)
    const input = object(body, ['source'])
    if (typeof input.source !== 'string') fail('DIFY_SOURCE_SIZE')
    return this.registry(actor.orgId).hostedInspectDify(actor.orgId, input.source)
  }
  async hostedRegister(actor: AuthContext, body: unknown) {
    if (!(await this.options.authorize(actor)).canManage) fail('ADMIN_REQUIRED', 403)
    const input = object(body, ['request_id', 'asset_id', 'metadata_digest', 'image', 'dify_source'])
    const asset = await this.readable(actor, identifier(input.asset_id), true)
    if (asset.metadata_digest !== input.metadata_digest) fail('HOSTED_ASSET_NOT_ADMITTED', 409)
    if (!asset.metadata.owner_user_id || !(await this.options.member(actor.orgId, asset.metadata.owner_user_id))) fail('INVALID_MEMBER', 409)
    return this.registry(actor.orgId).hostedRegister(actor.orgId, {
      ...input, api_version: AGENT_REGISTRY_API, kind: 'RegisterHostedArtifact', initiated_by: actor.userId,
    } as RegisterHostedArtifact)
  }
  async datasetList(actor: AuthContext, id: string, after = '') {
    const { canManage } = await this.options.authorize(actor)
    await this.readable(actor, id, canManage)
    if (after) identifier(after)
    return this.registry(actor.orgId).evaluationDatasetList(actor.orgId, id, after)
  }
  async datasetRegister(actor: AuthContext, body: unknown) {
    if (!(await this.options.authorize(actor)).canManage) fail('ADMIN_REQUIRED', 403)
    const input = object(body, ['request_id', 'asset_id', 'metadata_digest', 'dataset'])
    const asset = await this.readable(actor, identifier(input.asset_id), true)
    if (asset.metadata_digest !== input.metadata_digest) fail('EVALUATION_ASSET_NOT_ADMITTED', 409)
    if (!asset.metadata.owner_user_id || !(await this.options.member(actor.orgId, asset.metadata.owner_user_id))) fail('INVALID_MEMBER', 409)
    return this.registry(actor.orgId).evaluationDatasetRegister(actor.orgId, {
      ...input, api_version: AGENT_REGISTRY_API, kind: 'RegisterEvaluationDataset', initiated_by: actor.userId,
    } as RegisterEvaluationDataset)
  }
  private async evaluationManage(actor: AuthContext, assetId: string) {
    if (!(await this.options.authorize(actor)).canManage) fail('ADMIN_REQUIRED', 403)
    const asset = await this.readable(actor, identifier(assetId), true)
    if (!asset.metadata.owner_user_id || !(await this.options.member(actor.orgId, asset.metadata.owner_user_id))) fail('INVALID_MEMBER', 409)
    return asset
  }
  async evaluationList(actor: AuthContext, id: string, after = '') {
    const { canManage } = await this.options.authorize(actor)
    await this.readable(actor, id, canManage)
    if (after) identifier(after)
    return this.registry(actor.orgId).evaluationList(actor.orgId, id, after)
  }
  async evaluationGet(actor: AuthContext, id: string) {
    const { canManage } = await this.options.authorize(actor)
    const run = await this.registry(actor.orgId).evaluationGet(actor.orgId, identifier(id))
    await this.readable(actor, run.asset_id, canManage)
    return run
  }
  async evaluationCases(actor: AuthContext, id: string, after = '') {
    await this.evaluationGet(actor, id)
    if (after) identifier(after)
    return this.registry(actor.orgId).evaluationCases(actor.orgId, id, after)
  }
  async evaluationStart(actor: AuthContext, body: unknown) {
    const input = object(body, ['request_id', 'asset_id', 'metadata_digest', 'artifact_id', 'dataset_id', 'timeout_seconds', 'max_model_calls', 'role', 'comparison_policy_id'])
    if (input.role !== undefined && !['hosted', 'source_baseline'].includes(String(input.role))) fail('INVALID_EVALUATION_REQUEST')
    const asset = await this.evaluationManage(actor, identifier(input.asset_id))
    if (asset.metadata_digest !== input.metadata_digest) fail('EVALUATION_ASSET_NOT_ADMITTED', 409)
    if (!this.options.hosted) fail('HOSTED_NOT_CONFIGURED', 503)
    return this.options.hosted.start(actor.orgId, {
      ...input, api_version: AGENT_REGISTRY_API, kind: 'StartHostedEvaluation', initiated_by: actor.userId,
    } as StartHostedEvaluation, async () => { await this.evaluationManage(actor, asset.id) })
  }
  async evaluationAction(actor: AuthContext, id: string, action: 'resume' | 'stop' | 'reconcile', body: unknown) {
    object(body, [])
    // Authenticate the manager before loading any result from the owner service.
    if (!(await this.options.authorize(actor)).canManage) fail('ADMIN_REQUIRED', 403)
    const registry = this.registry(actor.orgId), run = await registry.evaluationGet(actor.orgId, identifier(id))
    await this.readable(actor, run.asset_id, true)
    // Cleanup must remain possible after the asset's owner has left the organization.
    if (action === 'stop') return this.options.hosted ? this.options.hosted.stop(actor.orgId, id) : registry.evaluationStop(actor.orgId, id)
    if (action === 'reconcile') return this.options.hosted ? this.options.hosted.reconcile(actor.orgId, id) : registry.evaluationReconcile(actor.orgId, id)
    if (!this.options.hosted) fail('HOSTED_NOT_CONFIGURED', 503)
    await this.options.hosted.resume(actor.orgId, id, async () => { await this.evaluationManage(actor, run.asset_id) })
    return registry.evaluationGet(actor.orgId, id)
  }
  async migrationPolicies(actor: AuthContext, assetId: string, after = '') {
    const { canManage } = await this.options.authorize(actor)
    await this.readable(actor, identifier(assetId), canManage)
    if (after) identifier(after)
    return this.registry(actor.orgId).migrationPolicyList(actor.orgId, assetId, after)
  }
  async migrationPolicyCreate(actor: AuthContext, body: unknown) {
    const input = object(body, ['request_id', 'baseline_run_id', 'minimum_pass_bps', 'maximum_drop_bps'])
    if (!(await this.options.authorize(actor)).canManage) fail('ADMIN_REQUIRED', 403)
    const registry = this.registry(actor.orgId), run = await registry.evaluationGet(actor.orgId, identifier(input.baseline_run_id))
    await this.evaluationManage(actor, run.asset_id)
    return registry.migrationPolicyCreate(actor.orgId, { ...input, initiated_by: actor.userId } as CreateMigrationPolicy)
  }
  async migrationCompare(actor: AuthContext, runId: string, body: unknown) {
    object(body, [])
    if (!(await this.options.authorize(actor)).canManage) fail('ADMIN_REQUIRED', 403)
    const registry = this.registry(actor.orgId), run = await registry.evaluationGet(actor.orgId, identifier(runId))
    await this.evaluationManage(actor, run.asset_id)
    return registry.migrationCompare(actor.orgId, runId)
  }
  async migrationComparison(actor: AuthContext, id: string) {
    const { canManage } = await this.options.authorize(actor)
    const comparison = await this.registry(actor.orgId).migrationComparisonGet(actor.orgId, identifier(id))
    await this.readable(actor, comparison.asset_id, canManage)
    return comparison
  }
  async discovered(actor: AuthContext, after = '') {
    await this.options.authorize(actor)
    if (after) identifier(after)
    const page = await this.registry(actor.orgId).inventoryList(actor.orgId, after, '')
    // Members see only claimable names and source classifications, not other owners' asset metadata.
    return {
      items: page.items
        .filter((row) => row.status === 'discovered')
        .map((row) => ({
          id: row.id,
          revision: row.revision,
          name: row.metadata.name,
          platform: row.metadata.source_platform,
          external_domain: row.external_domain,
        })),
      next_cursor: page.next_cursor,
    }
  }
  private async sources(actor: AuthContext) {
    if (!(await this.options.authorize(actor)).canManage) fail('ADMIN_REQUIRED', 403)
    if (!this.options.sources) fail('DISCOVERY_NOT_CONFIGURED', 503)
    return this.options.sources
  }
  async listSources(actor: AuthContext) {
    return (await this.sources(actor)).list(actor.orgId)
  }
  async createSource(actor: AuthContext, body: unknown) {
    return (await this.sources(actor)).create(actor, body)
  }
  async disableSource(actor: AuthContext, id: string) {
    await (await this.sources(actor)).disable(actor, identifier(id))
    return { disabled: true }
  }
  async discover(actor: AuthContext, input: unknown): Promise<DiscoveryResult> {
    const sources = await this.sources(actor),
      body = object(input, ['source_id']),
      id = identifier(body.source_id)
    const result: DiscoveryResult = {
      source_id: id,
      scanned: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      complete: false,
      boundary: '',
    }
    try {
      const registry = this.registry(actor.orgId),
        scan = await sources.scan(actor.orgId, id)
      result.boundary = scan.boundary
      const bySource = new Map<string, AssetRecord>()
      let after = ''
      do {
        const page = await registry.inventoryList(actor.orgId, after)
        for (const row of page.items) bySource.set(discoverySourceKey(row.metadata), row)
        if (bySource.size > 10000) fail('DISCOVERY_SCAN_LIMIT')
        if (!page.next_cursor) break
        after = page.next_cursor
      } while (true)
      for (const item of scan.items) {
        // A revoked admin or disabled source cannot continue a multi-record import.
        await this.sources(actor)
        await sources.assertEnabled(actor.orgId, id)
        const key = discoverySourceKey(item.metadata),
          current = bySource.get(key)
        result.scanned++
        if (
          current?.status === 'merged' ||
          current?.observations.some(
            (o) =>
              o.source === item.observation.source &&
              o.source_id === item.observation.source_id &&
              o.record_id === item.observation.record_id &&
              o.snapshot_digest === item.observation.snapshot_digest &&
              o.external_domain === item.observation.external_domain,
          )
        ) {
          result.unchanged++
          continue
        }
        const assetId = current?.id ?? `discovered-${key}`
        const command = parseInventoryCommand({
          api_version: AGENT_REGISTRY_API,
          kind: 'ObserveAsset',
          asset_id: assetId,
          request_id: discoveryId([actor.orgId, actor.userId, assetId, current?.revision ?? 0, discoveryDigest(item)]),
          expected_revision: current?.revision ?? 0,
          initiated_by: actor.userId,
          ...item,
        })
        const saved = await registry.inventoryCommand(actor.orgId, command)
        bySource.set(key, saved)
        if (current) result.updated++
        else result.created++
      }
      result.complete = true
    } catch (error) {
      result.error = error instanceof ExternalProviderError ? error.code : 'DISCOVERY_UNAVAILABLE'
    }
    return result
  }
  async command(actor: AuthContext, input: unknown) {
    const { canManage } = await this.options.authorize(actor)
    const body = object(input, [
      'kind',
      'asset_id',
      'request_id',
      'expected_revision',
      'metadata',
      'decision',
      'reason',
      'catalog_id',
      'target_asset_id',
      'target_revision',
    ])
    const kinds = ['SaveAsset', 'SubmitAsset', 'ReviewAsset', 'SuspendAsset', 'MergeAsset', 'LinkAsset', 'ClaimAsset']
    if (typeof body.kind !== 'string' || !kinds.includes(body.kind)) fail('INVALID_INVENTORY_COMMAND')
    if (!canManage && !['SaveAsset', 'SubmitAsset', 'ClaimAsset'].includes(body.kind)) fail('ADMIN_REQUIRED', 403)
    const id = identifier(body.asset_id)
    const registry = this.registry(actor.orgId)
    const { catalog_id, ...fields } = body
    const claimant = body.kind === 'ClaimAsset' ? await this.options.member(actor.orgId, actor.userId) : null
    if (body.kind === 'ClaimAsset' && !claimant) fail('INVALID_MEMBER')
    let principal
    if (body.kind === 'LinkAsset') {
      const catalogId = identifier(catalog_id)
      const catalog = await this.options.catalog.getAgent(catalogId, actor.orgId)
      if (!catalog || catalog.providerBinding?.executionMode !== 'external_hosted') fail('AGENT_CATALOG_LINK_INVALID')
      principal = registry.principal(actor.orgId, catalogId)
    } else if (catalog_id !== undefined) fail('INVALID_INVENTORY_COMMAND')
    const command = parseInventoryCommand({
      ...fields,
      api_version: AGENT_REGISTRY_API,
      initiated_by: actor.userId,
      ...(claimant ? { owner_user_id: claimant.id, department_id: claimant.departmentId } : {}),
      ...(principal ? { principal } : {}),
    })
    const current =
      command.expected_revision === 0 && command.kind === 'SaveAsset'
        ? null
        : command.kind === 'ClaimAsset'
          ? await registry.inventoryGet(actor.orgId, id)
          : await this.readable(actor, id, canManage)
    if (
      command.kind === 'ClaimAsset' &&
      current?.metadata.owner_user_id &&
      current.metadata.owner_user_id !== actor.userId
    )
      fail('AGENT_ASSET_ALREADY_CLAIMED', 409)
    if (command.kind === 'SaveAsset') {
      if (!canManage && command.metadata.owner_user_id !== actor.userId) fail('AGENT_ASSET_OWNER_FORBIDDEN', 403)
    }
    const checkedMetadata =
      command.kind === 'SaveAsset'
        ? command.metadata
        : command.kind === 'SubmitAsset' || (command.kind === 'ReviewAsset' && command.decision === 'approve')
          ? current?.metadata
          : null
    if (checkedMetadata) {
      if (!checkedMetadata.owner_user_id) fail('AGENT_ASSET_OWNER_REQUIRED')
      const owner = await this.options.member(actor.orgId, checkedMetadata.owner_user_id)
      if (!owner) fail('INVALID_MEMBER')
      // Department attribution is authoritative AuthCenter membership, never a browser claim.
      if ((checkedMetadata.department_id ?? null) !== owner.departmentId) fail('AGENT_DEPARTMENT_MISMATCH')
    }
    if (command.kind === 'MergeAsset') await this.readable(actor, command.target_asset_id, true)
    return (await this.present(actor.orgId, [await registry.inventoryCommand(actor.orgId, command)]))[0]
  }
}
