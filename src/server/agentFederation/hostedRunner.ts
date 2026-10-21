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
  run(options: HostedRunOptions) {
    return runEvaluationProcess(options, {
      command: this.config.python,
      args: ['-m', 'nexus.bricks.sandbox.hosted_supervisor', '--docker', this.config.docker],
      env: { PATH: '/usr/bin:/bin', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
        ...(this.config.modulePath ? { PYTHONPATH: this.config.modulePath } : {}) },
      protocol: 'agent-hosted-supervisor/v1',
      request: { kind: 'execute', artifact: options.artifact.image, query: options.query,
        timeout_seconds: options.timeoutSeconds, max_model_calls: options.maxModelCalls,
        max_output_tokens: options.artifact.image.max_output_tokens },
    })
  }
}
