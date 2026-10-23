import type { NativeConversion, SourceEvaluationExecution, EvaluationTrace, HostedArtifact, HostedEvaluationRun, SourceEvaluationRuntime, StartHostedEvaluation } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { isDeepStrictEqual } from 'node:util'
import { ExternalProviderError } from '../externalProviders/policy.js'
import type { ProductRegistryClient } from './registryClient.js'
import type { ExecutionModelGateway } from './executionModelGateway.js'
import type { HostedRunner, HostedRunOptions } from './hostedRunner.js'

export type EvaluationAdmission = () => Promise<void>
export interface SourceBaselineRunner {
  snapshot(artifact: HostedArtifact, signal: AbortSignal): Promise<SourceEvaluationRuntime>
  run(options: HostedRunOptions, expected: SourceEvaluationRuntime, caseId: string, admit: EvaluationAdmission, observe: (execution: SourceEvaluationExecution) => Promise<void>): Promise<{ answer: string; modelCalls: number }>
}
function fail(code: string, status = 409): never { throw new ExternalProviderError(status, code) }

/** Registry owns durable claims/results. A restarted coordinator never replays a claimed case. */
export class HostedEvaluationCoordinator {
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>()
  private closed = false
  constructor(
    private readonly registry: ProductRegistryClient,
    private readonly gateway: Pick<ExecutionModelGateway, 'invoke' | 'reconcile' | 'taskCalls'>,
    private readonly runner: Pick<HostedRunner, 'run'>,
    private readonly configured: (orgId: string, resource: string, model: string) => boolean,
    private readonly sourceFor?: (orgId: string, assetId: string) => SourceBaselineRunner | undefined,
  ) {}
  private key(orgId: string, runId: string) { return JSON.stringify([orgId, runId]) }
  private artifact(orgId: string, request: Pick<StartHostedEvaluation, 'artifact_id' | 'execution_kind'>) {
    return request.execution_kind === 'native' ? this.registry.nativeGet(orgId, request.artifact_id) : this.registry.hostedGet(orgId, request.artifact_id)
  }
  private nativeSource(conversion: NativeConversion): SourceEvaluationRuntime {
    return { profile: 'registry-hosted-artifact-v1', runtime_digest: conversion.source_spec_digest,
      source_digest: conversion.image.source_digest, model_name: conversion.image.model_name, revision_strength: 'local_source_digest' }
  }
  async start(orgId: string, command: StartHostedEvaluation, admit: EvaluationAdmission) {
    await admit()
    const artifact = await this.artifact(orgId, command)
    if (!this.configured(orgId, artifact.image.model_resource, artifact.image.model_name)) fail('HOSTED_MODEL_NOT_CONFIGURED', 503)
    if (this.closed || this.active.size >= 4) fail('EVALUATION_CAPACITY_LIMIT', 429)
    let request = command
    if (command.role === 'source_baseline') {
      if (artifact.kind === 'NativeConversion') {
        request = { ...command, source_runtime: this.nativeSource(artifact), comparison_policy_id: null }
      } else {
        if (artifact.kind !== 'HostedArtifact') fail('EVALUATION_SOURCE_CHANGED')
        const source = this.sourceFor?.(orgId, command.asset_id)
        if (!source) fail('EVALUATION_SOURCE_NOT_CONFIGURED', 503)
        request = { ...command, source_runtime: await source.snapshot(artifact, AbortSignal.timeout(60000)), comparison_policy_id: null }
      }
      await admit()
    }
    const run = await this.registry.evaluationStart(orgId, request)
    await this.resume(orgId, run.id, admit)
    return this.registry.evaluationGet(orgId, run.id)
  }
  async resume(orgId: string, runId: string, admit: EvaluationAdmission) {
    await admit()
    const key = this.key(orgId, runId)
    if (this.active.has(key)) return
    if (this.closed || this.active.size >= 4) fail('EVALUATION_CAPACITY_LIMIT', 429)
    const run = await this.registry.evaluationGet(orgId, runId)
    // A source baseline must execute the original platform. Never run an imported
    // image under a source label when its dedicated adapter is unavailable.
    const originalPlatform = run.role === 'source_baseline' && run.execution_kind !== 'native'
    const source = originalPlatform ? this.sourceFor?.(orgId, run.asset_id) : undefined
    if (originalPlatform && (!source || !run.source_runtime)) fail('EVALUATION_SOURCE_NOT_CONFIGURED', 503)
    const [artifact, dataset] = await Promise.all([
      this.artifact(orgId, run), this.registry.evaluationDatasetGet(orgId, run.dataset_id),
    ])
    if (artifact.asset_id !== run.asset_id || dataset.asset_id !== run.asset_id
      || artifact.metadata_digest !== run.metadata_digest || dataset.metadata_digest !== run.metadata_digest
      || artifact.spec_digest !== run.spec_digest || dataset.dataset_digest !== run.dataset_digest
      || dataset.rubric_digest !== run.rubric_digest || dataset.dataset.cases.length !== run.total_cases) fail('EVALUATION_INPUT_MISMATCH')
    if (!this.configured(orgId, artifact.image.model_resource, artifact.image.model_name)) fail('HOSTED_MODEL_NOT_CONFIGURED', 503)
    let runtimeArtifact = artifact
    if (artifact.kind === 'NativeConversion' && run.role === 'source_baseline') {
      if (!isDeepStrictEqual(this.nativeSource(artifact), run.source_runtime)) fail('EVALUATION_SOURCE_CHANGED')
      const original = await this.registry.hostedGet(orgId, artifact.source_artifact_id)
      if (original.asset_id !== artifact.source_asset_id || original.metadata_digest !== artifact.source_metadata_digest
        || original.spec_digest !== artifact.source_spec_digest || original.image.source_digest !== artifact.image.source_digest
        || original.image.model_resource !== artifact.image.model_resource || original.image.model_name !== artifact.image.model_name) fail('EVALUATION_SOURCE_CHANGED')
      runtimeArtifact = original
    }
    if (source) {
      if (artifact.kind !== 'HostedArtifact' || !isDeepStrictEqual(await source.snapshot(artifact, AbortSignal.timeout(60000)), run.source_runtime)) fail('EVALUATION_SOURCE_CHANGED')
    }
    if (run.status === 'finished') return
    if (run.running_cases) fail('EVALUATION_CASE_IN_PROGRESS')
    // Recheck after reads, before claiming the local execution slot.
    if (this.active.has(key)) return
    if (this.closed || this.active.size >= 4) fail('EVALUATION_CAPACITY_LIMIT', 429)
    const abort = new AbortController()
    const loop = async () => {
      while (!abort.signal.aborted) {
        await admit() // Active membership/role is rechecked for every new case.
        const claim = await this.registry.evaluationClaim(orgId, runId)
        if (!claim) return
        const command = { case_id: claim.case.id, lease_token: claim.lease_token }
        const sample = dataset.dataset.cases.find(row => row.id === claim.case.sample_id)
        if (!sample) fail('EVALUATION_INPUT_MISMATCH')
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(Math.max(1, claim.case.deadline_at! - Date.now() - 5000))])
        const trace: EvaluationTrace[] = []
        let answer: string | null = null, enteredRunner = false, cleanup = true, grantId: string | undefined
        let errorCode: string | null = null
        try {
          signal.throwIfAborted()
          const issued = await this.registry.evaluationGrant(orgId, runId, command)
          grantId = issued.grant.id
          const request = issued.grant.request
          if (!issued.api_key) fail('EVALUATION_CREDENTIAL_UNAVAILABLE')
          if (request.asset_id !== run.asset_id || request.task_id !== claim.case.id || request.mode !== 'evaluation'
            || request.spec_digest !== run.spec_digest || request.metadata_digest !== run.metadata_digest
            || request.dataset_digest !== run.dataset_digest || request.initiated_by !== run.initiated_by
            || request.max_model_calls !== run.max_model_calls || request.permissions.length !== 1
            || request.permissions[0].operation !== 'model.invoke' || request.permissions[0].resource !== artifact.image.model_resource) fail('EVALUATION_INPUT_MISMATCH')
          signal.throwIfAborted()
          enteredRunner = true; cleanup = false
          const options: HostedRunOptions<HostedArtifact | NativeConversion> = {
            artifact: runtimeArtifact, query: sample.query, timeoutSeconds: run.timeout_seconds, maxModelCalls: run.max_model_calls, signal,
            trace: async frame => { if (trace.length >= 256) fail('HOSTED_TRACE_LIMIT'); trace.push(frame) },
            model: async (sequence, input) => {
              await admit()
              const call = await this.gateway.invoke(orgId, {
                call_id: `${claim.case.id}:${sequence}`, grant_id: issued.grant.id,
                task_id: claim.case.id, spec_digest: run.spec_digest, resource: artifact.image.model_resource, input,
              }, issued.api_key!, signal)
              if (call.status !== 'completed' || call.answer === undefined) fail(call.error ?? 'HOSTED_MODEL_UNCONFIRMED')
              return call.answer
            },
          }
          let output: { answer: string; modelCalls: number }
          if (source && run.source_runtime) {
            if (runtimeArtifact.kind !== 'HostedArtifact') fail('EVALUATION_SOURCE_CHANGED')
            output = await source.run({ ...options, artifact: runtimeArtifact }, run.source_runtime, claim.case.id, async () => {
                await admit()
                await this.registry.executionAuthorize(orgId, { grant_id: issued.grant.id, task_id: claim.case.id, spec_digest: run.spec_digest,
                  permission: { operation: 'model.invoke', resource: artifact.image.model_resource }, token: issued.api_key! })
              }, async execution => { await this.registry.evaluationObserveSource(orgId, runId, { ...command, source_execution: execution }) })
          } else output = await this.runner.run(options)
          answer = output.answer; cleanup = true
        } catch (error) {
          errorCode = error instanceof ExternalProviderError ? error.code : 'HOSTED_RESULT_UNCONFIRMED'
          if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(errorCode)) errorCode = 'HOSTED_RESULT_UNCONFIRMED'
        }
        // Cleanup each authority independently, even if another backend is unavailable.
        let callIds: string[] = []
        try {
          const calls = await this.gateway.taskCalls(orgId, claim.case.id)
          callIds = calls.map(call => call.id)
          for (const call of calls) {
            const updated = await this.gateway.reconcile(orgId, call.id)
            if (updated.tokenCleanupPending) fail('MODEL_CLEANUP_PENDING')
          }
        } catch { answer = null; cleanup = false; errorCode = 'MODEL_RECONCILIATION_PENDING' }
        try {
          if (grantId) await this.registry.executionRevoke(orgId, grantId)
        } catch { answer = null; cleanup = false; errorCode = 'EVALUATION_IAM_CLEANUP_PENDING' }
        await this.registry.evaluationComplete(orgId, runId, {
          ...command, status: answer !== null ? 'succeeded' : enteredRunner ? 'unknown' : 'failed',
          answer, error_code: answer !== null ? null : errorCode ?? 'HOSTED_RESULT_UNCONFIRMED',
          model_call_ids: callIds, trace, cleanup_confirmed: cleanup,
        })
        if (!cleanup) return
      }
    }
    const entry = { abort, done: Promise.resolve() }
    this.active.set(key, entry)
    entry.done = loop().catch(() => {
      // No retry: the durable case stays visible and expires to explicit unknown reconciliation.
      // Raw exceptions can contain provider data and must not enter logs/UI.
    }).finally(() => { if (this.active.get(key) === entry) this.active.delete(key) })
  }
  async stop(orgId: string, runId: string): Promise<HostedEvaluationRun> {
    this.active.get(this.key(orgId, runId))?.abort.abort()
    return this.registry.evaluationStop(orgId, runId)
  }
  async reconcile(orgId: string, runId: string) {
    const run = await this.registry.evaluationReconcile(orgId, runId)
    let after = ''
    do {
      const page = await this.registry.evaluationCases(orgId, runId, after)
      for (const row of page.items) {
        if (row.status === 'queued' || row.status === 'running') continue
        for (const call of await this.gateway.taskCalls(orgId, row.id)) await this.gateway.reconcile(orgId, call.id)
      }
      if (!page.next_cursor) return run
      after = page.next_cursor
    } while (true)
  }
  async close() {
    this.closed = true
    const entries = [...this.active.values()]
    for (const entry of entries) entry.abort.abort()
    await Promise.all(entries.map(entry => entry.done))
  }
}
