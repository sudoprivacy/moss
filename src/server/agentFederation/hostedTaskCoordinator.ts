import type { ExternalActor } from '../externalProviders/store.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import type { ProductRegistryClient } from './registryClient.js'
import type { HostedRunner } from './hostedRunner.js'
import type { ExecutionModelGateway } from './executionModelGateway.js'
import { HostedTaskStore, type HostedTaskFence } from './hostedTaskStore.js'

function fail(code: string, status = 409): never { throw new ExternalProviderError(status, code) }
type Reauthorize = () => Promise<void>

/** One claimed Task → one trusted supervisor. A restarted controller cannot redispatch it. */
export class HostedTaskCoordinator {
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>()
  private closed = false
  constructor(
    readonly store: HostedTaskStore,
    private readonly ownerId: string,
    private readonly registry: ProductRegistryClient,
    private readonly gateway: Pick<ExecutionModelGateway, 'invoke' | 'taskCalls' | 'reconcile'>,
    private readonly runner: Pick<HostedRunner, 'run' | 'reconcile' | 'identity'>,
    private readonly configured: (orgId: string, resource: string, model: string) => boolean,
  ) {}
  runtimeIdentity() { return this.runner.identity() }
  async start(actor: ExternalActor, id: string, reauthorize: Reauthorize): Promise<void> {
    await reauthorize()
    const task = await this.store.get(actor, id)
    if (task.status !== 'accepted' || this.active.has(id)) return
    if (this.closed || this.active.size >= 4) fail('HOSTED_CAPACITY_LIMIT', 429)
    // The local slot is reserved synchronously; remote reads cannot allow a fifth concurrent run.
    const abort = new AbortController(), entry = { abort, done: Promise.resolve() }
    this.active.set(id, entry)
    entry.done = this.execute(actor, id, abort, reauthorize).catch(() => {
      // No hidden retry. A failed persistence write leaves the durable lease to expire as unknown.
    }).finally(() => { if (this.active.get(id) === entry) this.active.delete(id) })
  }
  private async execute(actor: ExternalActor, id: string, abort: AbortController, reauthorize: Reauthorize): Promise<void> {
    const claim = await this.store.claim(actor, id, this.ownerId)
    if (!claim) return
    const { task, fence } = claim
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(Math.max(1, task.deadline_at - Date.now() - 3000))])
    let heartbeatRunning = false
    const timer = setInterval(() => {
      if (heartbeatRunning) return
      heartbeatRunning = true
      void this.store.renew(actor, id, fence).then(ok => { if (!ok) abort.abort() }, () => abort.abort()).finally(() => { heartbeatRunning = false })
    }, 5000)
    timer.unref()
    let runtimeAuthorityId: string | undefined
    let runningArtifact: Awaited<ReturnType<ProductRegistryClient['hostedGet']>> | undefined
    let grantId: string | undefined, grantRequested = false, grantAssetId: string | undefined, entered = false, cleaned = true, answer: string | undefined, errorCode: string | null = null
    const fresh = async () => {
      signal.throwIfAborted()
      await reauthorize()
      await this.store.assertActive(actor, id, fence)
      signal.throwIfAborted()
    }
    try {
      await fresh()
      const record = await this.store.record(actor, id), resolution = record.resolution
      if (resolution.status !== 'accepted' || resolution.execution_mode !== 'internal_hosted') fail('HOSTED_TASK_ADMISSION_INVALID')
      if (record.spec.data_classification !== 'synthetic' || record.spec.input.resource_refs.length || record.spec.workspace_refs.length
        || Object.keys(record.spec.input.parameters ?? {}).length || record.spec.output_contract
        || record.spec.constraints.max_cost_units !== undefined || (record.spec.constraints.max_attempts !== undefined && record.spec.constraints.max_attempts !== 1)
        || !['auto', 'private', 'cloud'].includes(record.spec.requested_mode)
        || record.spec.required_capabilities.some(c => !['idempotency', 'version_pin'].includes(c))) fail('HOSTED_TASK_PROFILE_UNSUPPORTED')
      const [artifact, asset, selected] = await Promise.all([
        this.registry.hostedGet(actor.orgId, resolution.artifact_id), this.registry.inventoryGet(actor.orgId, resolution.asset_id),
        this.registry.resolve(actor.orgId, resolution.agent.principal, { version: resolution.agent.version }),
      ])
      if (!asset.principal || asset.principal.trust_domain !== resolution.agent.principal.trust_domain || asset.principal.agent_name !== resolution.agent.principal.agent_name
        || asset.status !== 'approved' || !['L2', 'L3'].includes(asset.actual_level) || asset.metadata.hosting !== 'internal_hosted') fail('HOSTED_ASSET_NOT_ADMITTED')
      if (artifact.asset_id !== asset.id || artifact.metadata_digest !== resolution.metadata_digest || asset.metadata_digest !== resolution.metadata_digest
        || artifact.spec_digest !== resolution.artifact.spec_digest || artifact.image.image_id !== resolution.artifact.image_id
        || artifact.image.source_digest !== resolution.agent.source_digest || artifact.image.dependency_lock_digest !== resolution.artifact.dependency_lock_digest
        || artifact.image.profile !== resolution.artifact.profile || selected.version.manifest.spec_digest !== artifact.spec_digest
        || selected.version.digest !== resolution.agent.registry.registration_digest || selected.version.key_id !== resolution.agent.registry.signing_key_id) fail('HOSTED_TASK_ARTIFACT_MISMATCH')
      if (await this.runner.identity() !== resolution.runtime_authority_id) fail('HOSTED_RUNTIME_AUTHORITY_MISMATCH')
      if (!this.configured(actor.orgId, artifact.image.model_resource, artifact.image.model_name)) fail('HOSTED_MODEL_NOT_CONFIGURED', 503)
      await fresh()
      grantRequested = true; grantAssetId = asset.id
      const issued = await this.registry.executionIssue(actor.orgId, { api_version: 'agent-registry.sudo.dev/v1alpha1', kind: 'IssueExecutionGrant',
        request_id: `hosted-${task.attempt_id}`, asset_id: asset.id, metadata_digest: resolution.metadata_digest, spec_digest: artifact.spec_digest,
        task_id: id, initiated_by: actor.userId, mode: 'run', version: resolution.agent.version, dataset_digest: null,
        permissions: [{ operation: 'model.invoke', resource: artifact.image.model_resource }],
        ttl_seconds: Math.min(300, Math.max(1, Math.ceil((task.deadline_at - Date.now()) / 1000))), max_model_calls: resolution.limits.max_model_calls })
      grantId = issued.grant.id
      if (!issued.api_key || !await this.store.bindGrant(actor, id, fence, grantId)) fail('HOSTED_CREDENTIAL_UNAVAILABLE')
      await fresh()
      await this.registry.executionAuthorize(actor.orgId, { grant_id: grantId, task_id: id, spec_digest: artifact.spec_digest,
        permission: { operation: 'model.invoke', resource: artifact.image.model_resource }, token: issued.api_key })
      if (!await this.store.update(actor, id, fence, { status: 'running' })) fail('EXECUTION_OWNERSHIP_LOST')
      await fresh()
      entered = true; cleaned = false; runningArtifact = artifact; runtimeAuthorityId = resolution.runtime_authority_id
      const result = await this.runner.run({ artifact, query: task.query, signal, executionId: fence.attemptId.replaceAll('-', ''), runtimeAuthorityId: resolution.runtime_authority_id,
        timeoutSeconds: Math.max(1, Math.min(240, Math.floor((task.deadline_at - Date.now() - 30000) / 1000))),
        maxModelCalls: resolution.limits.max_model_calls,
        trace: async frame => { await fresh(); if (!await this.store.trace(actor, id, fence, frame)) fail('EXECUTION_OWNERSHIP_LOST') },
        model: async (sequence, input) => {
          await fresh()
          const call = await this.gateway.invoke(actor.orgId, { call_id: `${id}:${sequence}`, grant_id: grantId!, task_id: id,
            spec_digest: artifact.spec_digest, resource: artifact.image.model_resource, input }, issued.api_key!, signal)
          if (call.status !== 'completed' || call.answer === undefined) fail(call.error ?? 'HOSTED_MODEL_UNCONFIRMED')
          return call.answer
        },
      })
      answer = result.answer; cleaned = true
    } catch (error) {
      const code = error instanceof ExternalProviderError ? error.code : 'HOSTED_EXECUTION_UNCONFIRMED'
      errorCode = /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : 'HOSTED_EXECUTION_UNCONFIRMED'
    } finally {
      if (entered && runningArtifact) {
        try { await this.runner.reconcile(runningArtifact, fence.attemptId.replaceAll('-', ''), runtimeAuthorityId!); cleaned = true }
        catch { cleaned = false; errorCode = 'HOSTED_CLEANUP_UNCONFIRMED' }
      }
      // These authorities are cleaned independently. An unavailable backend cannot skip another revoke.
      try {
        for (const call of await this.gateway.taskCalls(actor.orgId, id)) {
          const updated = await this.gateway.reconcile(actor.orgId, call.id)
          if (updated.tokenCleanupPending || updated.ledgerStatus !== 'router_verified') {
            cleaned = false; errorCode = 'HOSTED_MODEL_RECONCILIATION_PENDING'
          }
        }
      } catch { cleaned = false; errorCode = 'HOSTED_MODEL_RECONCILIATION_PENDING' }
      try {
        if (grantRequested && !grantId) {
          // Recover only the owner record, never the one-time key or the execution.
          let after = ''
          for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
            const page = await this.registry.executionList(actor.orgId, grantAssetId, after)
            const found = page.items.find(g => g.request.request_id === `hosted-${task.attempt_id}` && g.request.task_id === id)
            if (found) { grantId = found.id; break }
            if (!page.next_cursor) break
            after = page.next_cursor
          }
          if (!grantId) { cleaned = false; errorCode = 'HOSTED_IAM_ISSUANCE_UNCONFIRMED' }
        }
        if (grantId && (await this.registry.executionRevoke(actor.orgId, grantId)).cleanup_pending) {
          cleaned = false; errorCode = 'HOSTED_IAM_CLEANUP_PENDING'
        }
      } catch { cleaned = false; errorCode = 'HOSTED_IAM_CLEANUP_PENDING' }
      clearInterval(timer)
    }
    await this.finish(actor, id, fence, { answer, entered, cleaned, errorCode })
  }
  private async finish(actor: ExternalActor, id: string, fence: HostedTaskFence, result: { answer?: string; entered: boolean; cleaned: boolean; errorCode: string | null }) {
    const current = await this.store.get(actor, id), cancelled = current.cancel_requested_at !== null
    const status = !result.cleaned ? 'unknown' : cancelled ? 'cancelled' : result.answer !== undefined ? 'succeeded' : result.entered ? 'unknown' : 'failed'
    await this.store.update(actor, id, fence, { status, cleanup: result.cleaned ? 'confirmed' : 'unknown',
      ...(result.answer !== undefined ? { answer: result.answer } : {}), error_code: status === 'succeeded' ? null : result.errorCode ?? (cancelled ? 'HOSTED_CANCELLED' : 'HOSTED_EXECUTION_UNCONFIRMED') })
  }
  /** Recovery only: it can revoke and close a worker, but never reissue or rerun a Task. */
  async reconcile(actor: ExternalActor, id: string) {
    await this.store.recoverExpired()
    const task = await this.store.get(actor, id)
    if (task.status !== 'unknown') return task
    const resolution = (await this.store.record(actor, id)).resolution
    if (resolution.status !== 'accepted' || resolution.execution_mode !== 'internal_hosted' || !task.attempt_id) fail('HOSTED_TASK_ADMISSION_INVALID')
    const artifact = await this.registry.hostedGet(actor.orgId, resolution.artifact_id)
    if (artifact.spec_digest !== resolution.artifact.spec_digest || artifact.image.image_id !== resolution.artifact.image_id
      || artifact.asset_id !== resolution.asset_id || artifact.metadata_digest !== resolution.metadata_digest) fail('HOSTED_TASK_ARTIFACT_MISMATCH')
    let confirmed = true
    try { await this.runner.reconcile(artifact, task.attempt_id.replaceAll('-', ''), resolution.runtime_authority_id) } catch { confirmed = false }
    try {
      for (const call of await this.gateway.taskCalls(actor.orgId, id)) {
        const updated = await this.gateway.reconcile(actor.orgId, call.id)
        if (updated.tokenCleanupPending || updated.ledgerStatus !== 'router_verified') confirmed = false
      }
    } catch { confirmed = false }
    try {
      let grantId = await this.store.grant(actor, id)
      if (!grantId) {
        let after = ''
        for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
          const page = await this.registry.executionList(actor.orgId, resolution.asset_id, after)
          const found = page.items.find(g => g.request.request_id === `hosted-${task.attempt_id}` && g.request.task_id === id)
          if (found) { grantId = found.id; break }
          if (!page.next_cursor) break
          after = page.next_cursor
        }
      }
      // An unseen issuance may still commit later. Absence does not prove revocation.
      if (!grantId || (await this.registry.executionRevoke(actor.orgId, grantId)).cleanup_pending) confirmed = false
    } catch { confirmed = false }
    return confirmed ? this.store.confirmCleanup(actor, id, task.attempt_id) : this.store.get(actor, id)
  }
  async cancel(actor: ExternalActor, id: string) {
    const task = await this.store.cancel(actor, id)
    this.active.get(id)?.abort.abort()
    return task
  }
  async wait(id: string) { await this.active.get(id)?.done }
  async close() {
    this.closed = true
    const entries = [...this.active.values()]
    for (const entry of entries) entry.abort.abort()
    await Promise.all(entries.map(entry => entry.done))
  }
}
