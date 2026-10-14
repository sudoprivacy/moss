import type { ProviderObservation } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import { DifyPilotTransport } from '../externalProviders/difyTransport.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { createObserver, invocationContext, runBinding, type ProviderAdapter, type ProviderInvocation } from './adapter.js'
import { DIFY_CAPABILITIES } from './manifest.js'

export class DifyGatewayAdapter implements ProviderAdapter {
  readonly kind = 'dify' as const
  readonly version = 'dify/query-only-v1@0.1.0'
  readonly capabilities = DIFY_CAPABILITIES
  constructor(private readonly expectedParametersDigest: string, private readonly transport = new DifyPilotTransport()) {}

  async invoke(input: ProviderInvocation, observe: (event: ProviderObservation) => Promise<void>) {
    const { endpoint, signal } = invocationContext(input)
    if (await this.transport.parameters(endpoint, input.key, signal) !== this.expectedParametersDigest) throw new ExternalProviderError(409, 'PROVIDER_PARAMETERS_CHANGED')
    signal.throwIfAborted()
    const startedAt = new Date().toISOString(), publish = createObserver(this, input, observe)
    await input.authorize_dispatch()
    signal.throwIfAborted()
    const result = await this.transport.execute({ endpoint, key: input.key, signal, query: input.query, endUser: input.end_user, conversationId: input.provider_session_id }, async value => {
      const refs = value.refs
      await publish(value.raw, {
        ...(refs.workflow_run_id || refs.task_id ? { run_id: refs.workflow_run_id ?? refs.task_id } : {}),
        ...(refs.conversation_id ? { session_id: refs.conversation_id } : {}),
        ...(refs.message_id ? { message_id: refs.message_id } : {}),
        ...(refs.task_id ? { provider_task_id: refs.task_id } : {}),
        ...(refs.workflow_run_id ? { provider_workflow_run_id: refs.workflow_run_id } : {}),
      }, 'running')
    })
    if (input.provider_session_id && result.refs.conversation_id !== input.provider_session_id) throw new ExternalProviderError(502, 'PROVIDER_SESSION_CHANGED')
    const binding = runBinding(this, input, result.refs.workflow_run_id ?? result.refs.task_id ?? '', result.refs.conversation_id, startedAt)
    await publish(result.raw, { run_id: binding.provider_run_id, ...(binding.provider_session_id ? { session_id: binding.provider_session_id } : {}), ...(result.refs.message_id ? { message_id: result.refs.message_id } : {}), ...(result.refs.task_id ? { provider_task_id: result.refs.task_id } : {}), ...(result.refs.workflow_run_id ? { provider_workflow_run_id: result.refs.workflow_run_id } : {}) }, 'succeeded')
    return { text: result.raw, status: 'succeeded' as const, binding }
  }
}
