import type { EvaluationTrace, HostedEvaluationRun, StartHostedEvaluation } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import type { ProductRegistryClient } from './registryClient.js'
import type { ExecutionModelGateway } from './executionModelGateway.js'
import type { HostedRunner } from './hostedRunner.js'

export type EvaluationAdmission = () => Promise<void>
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
  ) {}
  private key(orgId: string, runId: string) { return JSON.stringify([orgId, runId]) }
  async start(orgId: string, command: StartHostedEvaluation, admit: EvaluationAdmission) {
    await admit()
    const artifact = await this.registry.hostedGet(orgId, command.artifact_id)
    if (!this.configured(orgId, artifact.image.model_resource, artifact.image.model_name)) fail('HOSTED_MODEL_NOT_CONFIGURED', 503)
    if (this.closed || this.active.size >= 4) fail('EVALUATION_CAPACITY_LIMIT', 429)
    const run = await this.registry.evaluationStart(orgId, command)
    await this.resume(orgId, run.id, admit)
    return this.registry.evaluationGet(orgId, run.id)
  }
  async resume(orgId: string, runId: string, admit: EvaluationAdmission) {
    await admit()
    const key = this.key(orgId, runId)
    if (this.active.has(key)) return
    if (this.closed || this.active.size >= 4) fail('EVALUATION_CAPACITY_LIMIT', 429)
    const run = await this.registry.evaluationGet(orgId, runId)
    const [artifact, dataset] = await Promise.all([
      this.registry.hostedGet(orgId, run.artifact_id), this.registry.evaluationDatasetGet(orgId, run.dataset_id),
    ])
    if (artifact.asset_id !== run.asset_id || dataset.asset_id !== run.asset_id
      || artifact.metadata_digest !== run.metadata_digest || dataset.metadata_digest !== run.metadata_digest
      || artifact.spec_digest !== run.spec_digest || dataset.dataset_digest !== run.dataset_digest
      || dataset.rubric_digest !== run.rubric_digest || dataset.dataset.cases.length !== run.total_cases) fail('EVALUATION_INPUT_MISMATCH')
    if (!this.configured(orgId, artifact.image.model_resource, artifact.image.model_name)) fail('HOSTED_MODEL_NOT_CONFIGURED', 503)
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
          const output = await this.runner.run({
            artifact, query: sample.query, timeoutSeconds: run.timeout_seconds, maxModelCalls: run.max_model_calls, signal,
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
          })
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
