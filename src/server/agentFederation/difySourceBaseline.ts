import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { HostedArtifact, SourceEvaluationRuntime, SourceEvaluationExecution } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { DifyPilotTransport } from '../externalProviders/difyTransport.js'
import { discoveryOrigin } from './inventoryDiscovery.js'
import { boundedJson } from './provider/runtime.js'
import { contentDigest } from './provider/protocol.js'
import type { ProductRegistryClient } from './registryClient.js'
import type { HostedRunOptions } from './hostedRunner.js'

interface Credentials { apiKey: string; consoleToken: string; csrfToken: string }
export interface DifySourceBaselineConfig {
  orgId: string
  assetId: string
  origin: string
  appId: string
  workspaceId: string
  credentials: () => Promise<Credentials>
  request?: typeof fetch
}
function fail(code: string): never { throw new ExternalProviderError(502, code) }
/** Invokes the actual published Dify app. No imported image or simulated answers. */
export class DifySourceBaseline {
  private readonly origin: string
  private readonly request: typeof fetch
  constructor(private readonly config: DifySourceBaselineConfig, private readonly registry: Pick<ProductRegistryClient, 'hostedInspectDify'>) {
    this.origin = discoveryOrigin(config.origin)
    if (![config.appId, config.workspaceId].every(id => /^[A-Za-z0-9-]{1,150}$/.test(id))) fail('EVALUATION_SOURCE_CONFIGURATION_INVALID')
    this.request = config.request ?? fetch
  }
  async snapshot(artifact: HostedArtifact, signal: AbortSignal): Promise<SourceEvaluationRuntime> {
    return this.inspect(artifact, signal, await this.config.credentials())
  }
  private async inspect(artifact: HostedArtifact, signal: AbortSignal, credentials: Credentials): Promise<SourceEvaluationRuntime> {
    if (artifact.asset_id !== this.config.assetId || !artifact.dify_plan) fail('EVALUATION_SOURCE_MISMATCH')
    if (![credentials.apiKey, credentials.consoleToken, credentials.csrfToken].every(value => /^[A-Za-z0-9._~-]{1,8192}$/.test(value))) fail('EVALUATION_SOURCE_CREDENTIAL_INVALID')
    const read = async (path: string) => {
      const response = await this.request(this.origin + '/console/api' + path, {
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        headers: { Authorization: `Bearer ${credentials.consoleToken}`, Cookie: `access_token=${credentials.consoleToken}; csrf_token=${credentials.csrfToken}`, 'X-CSRF-Token': credentials.csrfToken },
      })
      if (!response.ok) { await response.body?.cancel(); fail('EVALUATION_SOURCE_UNAVAILABLE') }
      return await boundedJson(response, 1024 * 1024) as any
    }
    const workspaces = await read('/workspaces')
    const active = Array.isArray(workspaces?.workspaces) ? workspaces.workspaces.filter((row: any) => row.current === true) : []
    if (active.length !== 1 || active[0].id !== this.config.workspaceId) fail('EVALUATION_SOURCE_SCOPE_MISMATCH')
    // Verify that the model-dispatch credential belongs to this exact reviewed app.
    const keys = await read(`/apps/${this.config.appId}/api-keys`)
    if (!Array.isArray(keys?.data) || !keys.data.some((row: any) => row.token === credentials.apiKey)) fail('EVALUATION_SOURCE_KEY_MISMATCH')
    const published = await read(`/apps/${this.config.appId}/workflows/publish`)
    if (!published || typeof published.id !== 'string' || !/^[A-Za-z0-9-]{1,150}$/.test(published.id)) fail('EVALUATION_SOURCE_NOT_PUBLISHED')
    // Export the published workflow, not the mutable editor draft.
    const exported = await read(`/apps/${this.config.appId}/export?include_secret=false&workflow_id=${encodeURIComponent(published.id)}`)
    if (typeof exported?.data !== 'string' || Buffer.byteLength(exported.data) > 256000) fail('EVALUATION_SOURCE_INVALID')
    const plan = await this.registry.hostedInspectDify(this.config.orgId, exported.data)
    const { source_digest: observedDigest, ...observed } = plan
    const { source_digest: importedDigest, ...imported } = artifact.dify_plan
    // YAML/app display metadata can differ after import; all supported executable
    // plan fields must be identical. Preserve the actual export digest separately.
    if (!isDeepStrictEqual(observed, imported)) fail('EVALUATION_SOURCE_MISMATCH')
    return { profile: 'dify-service-api-v1', source_digest: importedDigest,
      runtime_digest: contentDigest({ origin: this.origin, workspaceId: this.config.workspaceId, appId: this.config.appId, workflowId: published.id, exportDigest: observedDigest,
        credentialDigest: createHash('sha256').update(credentials.apiKey).digest('hex') }),
      model_name: plan.source_model, revision_strength: 'observed_source_snapshot' }
  }
  async run(options: HostedRunOptions, expected: SourceEvaluationRuntime, caseId: string, admit: () => Promise<void>, observe: (execution: SourceEvaluationExecution) => Promise<void>) {
    const credentials = await this.config.credentials()
    if (!isDeepStrictEqual(await this.inspect(options.artifact, options.signal, credentials), expected)) fail('EVALUATION_SOURCE_CHANGED')
    const { apiKey } = credentials
    const transport = new DifyPilotTransport(this.request)
    await transport.parameters(this.origin + '/v1', apiKey, options.signal)
    await observe({ profile: 'dify-service-api-v1', request_id: caseId, origin: 'source_reported' })
    await admit()
    options.signal.throwIfAborted()
    const result = await transport.execute({ endpoint: this.origin + '/v1', key: apiKey, query: options.query, conversationId: null,
      endUser: 'migration-' + createHash('sha256').update(caseId).digest('hex'), signal: options.signal }, async progress => { await observe({ profile: 'dify-service-api-v1', request_id: caseId, ...progress.refs, origin: 'source_reported' }) }, options.trace)
    if (!isDeepStrictEqual(await this.snapshot(options.artifact, options.signal), expected)) fail('EVALUATION_SOURCE_CHANGED')
    return { answer: result.raw, modelCalls: 0 }
  }
}
