import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isDeepStrictEqual } from 'node:util'
import { isAbsolute } from 'node:path'
import type { HostedArtifact, SourceEvaluationRuntime, SourceEvaluationExecution } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { contentDigest } from './provider/protocol.js'
import { runEvaluationProcess } from './evaluationProcess.js'
import type { HostedRunOptions } from './hostedRunner.js'

export interface LangGraphSourceConfig { python: string; entry: string; project: string }
const environment = { PATH: '/usr/bin:/bin', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }
const execute = promisify(execFile)
function fail(code: string): never { throw new ExternalProviderError(502, code) }
/** A deployment-reviewed original project. Separate process; this is not the L2 sandbox. */
export class LangGraphSourceBaseline {
  private readonly config: LangGraphSourceConfig
  constructor(config: LangGraphSourceConfig) {
    if (![config.python, config.entry, config.project].every(path => typeof path === 'string' && isAbsolute(path))) fail('EVALUATION_SOURCE_CONFIGURATION_INVALID')
    this.config = { ...config }
  }
  private args() { return ['-I', '-B', this.config.entry, '--project', this.config.project] }
  private async probe(artifact: HostedArtifact, signal: AbortSignal) {
    if (artifact.image.profile !== 'langgraph-stdio-v1') fail('EVALUATION_SOURCE_MISMATCH')
    let raw: string
    try {
      const result = await execute(this.config.python, [...this.args(), '--inspect'], {
        cwd: '/', env: environment, signal, timeout: 15000, maxBuffer: 256000, encoding: 'utf8',
      })
      raw = result.stdout
    } catch { fail('EVALUATION_SOURCE_UNAVAILABLE') }
    let snapshot: any
    try { snapshot = JSON.parse(raw) } catch { fail('EVALUATION_SOURCE_RUNTIME_INVALID') }
    if (!snapshot || snapshot.source_digest !== artifact.image.source_digest
      || !/^sha256:[a-f0-9]{64}$/.test(snapshot.entry_digest) || typeof snapshot.python !== 'string'
      || !Array.isArray(snapshot.distributions) || !snapshot.distributions.length || snapshot.distributions.length > 1000
      || snapshot.distributions.some((row: unknown) => !Array.isArray(row) || row.length !== 2 || row.some(x => typeof x !== 'string' || !x || x.length > 200))
      || !snapshot.distributions.some((row: string[]) => row[0] === 'langgraph' && row[1] === '1.0.5')) fail('EVALUATION_SOURCE_MISMATCH')
    const runtime: SourceEvaluationRuntime = {profile: 'langgraph-source-v1', source_digest: snapshot.source_digest,
      runtime_digest: contentDigest(snapshot), model_name: artifact.image.model_name, revision_strength: 'local_source_digest'}
    return { snapshot, runtime }
  }
  async snapshot(artifact: HostedArtifact, signal: AbortSignal) { return (await this.probe(artifact, signal)).runtime }
  async run(options: HostedRunOptions, expected: SourceEvaluationRuntime, caseId: string, admit: () => Promise<void>, observe: (execution: SourceEvaluationExecution) => Promise<void>) {
    const { snapshot, runtime } = await this.probe(options.artifact, options.signal)
    if (!isDeepStrictEqual(runtime, expected)) fail('EVALUATION_SOURCE_CHANGED')
    await observe({profile: 'langgraph-source-v1', request_id: caseId, origin: 'source_reported'})
    await admit()
    options.signal.throwIfAborted()
    return runEvaluationProcess(options, {
      command: this.config.python, args: this.args(), env: environment, protocol: 'agent-source-stdio/v1',
      request: {kind: 'execute', query: options.query, expected_snapshot: snapshot, max_model_calls: options.maxModelCalls},
    })
  }
}
