import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import type { HostedArtifact } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { runEvaluationProcess } from './evaluationProcess.js'

export interface HostedRunnerConfig {
  python: string
  docker: string
  /** Development/assembled source location; never supplied by a task. */
  modulePath?: string
}
export interface HostedRunOptions {
  artifact: HostedArtifact
  /** Canonical attempt UUID without separators; never a user-selected container name. */
  executionId?: string
  runtimeAuthorityId?: string
  query: string
  timeoutSeconds: number
  maxModelCalls: number
  signal: AbortSignal
  model: (sequence: number, body: unknown) => Promise<string>
  trace: (frame: { node: string; phase: 'started' | 'completed'; origin: 'worker_reported' }) => Promise<void>
}
/** Launches the trusted Nexus supervisor, which owns strict Docker isolation and cleanup. */
export class HostedRunner {
  private readonly config: HostedRunnerConfig
  constructor(config: HostedRunnerConfig) {
    if (!isAbsolute(config.python) || !isAbsolute(config.docker) || (config.modulePath && !isAbsolute(config.modulePath)))
      throw new ExternalProviderError(502, 'HOSTED_RUNNER_CONFIGURATION_INVALID')
    this.config = { ...config }
  }
  private env() {
    return { PATH: '/usr/bin:/bin', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
      ...(this.config.modulePath ? { PYTHONPATH: this.config.modulePath } : {}) }
  }
  private executionId(value: string) {
    if (!/^[a-f0-9]{32}$/.test(value)) throw new ExternalProviderError(502, 'HOSTED_EXECUTION_ID_INVALID')
    return value
  }
  private async control(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const bytes = JSON.stringify({ protocol: 'agent-hosted-supervisor/v1', ...request }) + '\n'
    if (Buffer.byteLength(bytes) > 256000) throw new ExternalProviderError(502, 'HOSTED_FRAME_LIMIT')
    return new Promise((resolve, reject) => {
      const fail = () => reject(new ExternalProviderError(502, 'HOSTED_CLEANUP_UNCONFIRMED'))
      const child = execFile(this.config.python, ['-m', 'nexus.bricks.sandbox.hosted_supervisor', '--docker', this.config.docker],
        { cwd: '/', env: this.env(), encoding: 'utf8', timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 4096 }, (error, stdout) => {
          if (error) return fail()
          try {
            const frame = JSON.parse(stdout)
            if (!frame || typeof frame !== 'object' || frame.protocol !== 'agent-hosted-supervisor/v1') return fail()
            resolve(frame)
          } catch { fail() }
        })
      child.stdin?.on('error', () => {})
      child.stdin?.end(bytes)
    })
  }
  async identity(): Promise<string> {
    const frame = await this.control({ kind: 'identity' })
    if (Object.keys(frame).sort().join(',') !== 'kind,protocol,runtime_authority_id'
      || frame.kind !== 'runtime_identity' || typeof frame.runtime_authority_id !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(frame.runtime_authority_id)) throw new ExternalProviderError(502, 'HOSTED_RUNTIME_UNAVAILABLE')
    return frame.runtime_authority_id
  }
  async reconcile(artifact: HostedArtifact, executionId: string, runtimeAuthorityId: string): Promise<void> {
    this.executionId(executionId)
    if (!/^sha256:[a-f0-9]{64}$/.test(runtimeAuthorityId)) throw new ExternalProviderError(502, 'HOSTED_RUNTIME_AUTHORITY_MISMATCH')
    const frame = await this.control({ kind: 'reconcile', artifact: artifact.image, execution_id: executionId, runtime_authority_id: runtimeAuthorityId })
    if (Object.keys(frame).sort().join(',') !== 'execution_id,kind,protocol,runtime_authority_id'
      || frame.kind !== 'cleanup_confirmed' || frame.execution_id !== executionId || frame.runtime_authority_id !== runtimeAuthorityId)
      throw new ExternalProviderError(502, 'HOSTED_CLEANUP_UNCONFIRMED')
  }
  run(options: HostedRunOptions) {
    if (options.executionId !== undefined) {
      this.executionId(options.executionId)
      if (!/^sha256:[a-f0-9]{64}$/.test(options.runtimeAuthorityId ?? '')) throw new ExternalProviderError(502, 'HOSTED_RUNTIME_AUTHORITY_MISMATCH')
    }
    return runEvaluationProcess(options, {
      command: this.config.python,
      args: ['-m', 'nexus.bricks.sandbox.hosted_supervisor', '--docker', this.config.docker],
      env: this.env(),
      protocol: 'agent-hosted-supervisor/v1',
      request: { kind: 'execute', artifact: options.artifact.image, query: options.query,
        ...(options.executionId ? { execution_id: options.executionId, runtime_authority_id: options.runtimeAuthorityId } : {}),
        timeout_seconds: options.timeoutSeconds, max_model_calls: options.maxModelCalls,
        max_output_tokens: options.artifact.image.max_output_tokens },
    })
  }
}
