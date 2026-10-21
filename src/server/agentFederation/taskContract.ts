import Ajv2020 from 'ajv/dist/2020.js'
import { assertResourceRef } from '@sudo/contracts/common/v1/resource-ref'
import schema from '../../../contracts/task/v1alpha1/schema.json' with { type: 'json' }
import { TASK_API, type SubmitTask, type HostedTask, type HostedTaskEvent, type TaskRecord, type AgentPrincipalRef } from '../../../contracts/task/v1alpha1/contract.js'
import { ExternalProviderError } from '../externalProviders/policy.js'

const ajv = new Ajv2020({ strict: true, allErrors: false })
ajv.addSchema(schema)
const submission = ajv.compile<SubmitTask>({ $ref: `${schema.$id}#/$defs/SubmitTask` })
const record = ajv.compile<TaskRecord>({ $ref: `${schema.$id}#/$defs/TaskRecord` })

const hostedTask = ajv.compile<HostedTask>({ $ref: `${schema.$id}#/$defs/HostedTask` })
const hostedEvent = ajv.compile<HostedTaskEvent>({ $ref: `${schema.$id}#/$defs/HostedTaskEvent` })
export function parseHostedTask(value: unknown): HostedTask {
  if (!hostedTask(value) || Buffer.byteLength(value.answer) > 128000
    || (value.status === 'rejected' ? value.attempt_id !== null : value.attempt_id === null)
    || (value.status === 'succeeded' && (value.cleanup !== 'confirmed' || value.cancel_requested_at !== null))
    || (value.status === 'cancelled' && (value.cancel_requested_at === null || !['not_started', 'confirmed'].includes(value.cleanup)))) throw new ExternalProviderError(500, 'HOSTED_TASK_RECORD_INVALID')
  return value
}
export function parseHostedTaskEvent(value: unknown): HostedTaskEvent {
  if (!hostedEvent(value) || value.task_id !== value.task.id || value.sequence !== value.task.sequence
    || value.created_at !== value.task.updated_at || (value.type === 'trace') !== (value.trace !== undefined)) throw new ExternalProviderError(500, 'HOSTED_TASK_EVENT_INVALID')
  parseHostedTask(value.task)
  return value
}

export function parseTaskSubmission(value: unknown): SubmitTask {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 64 * 1024 || !submission(value)) throw new ExternalProviderError(400, 'INVALID_TASK_SPEC')
  if (value.constraints.deadline && !Number.isFinite(Date.parse(value.constraints.deadline))) throw new ExternalProviderError(400, 'INVALID_TASK_SPEC')
  try {
    for (const ref of [...value.input.resource_refs, ...value.workspace_refs, ...[value.output_contract?.schema_ref, value.output_contract?.rubric_ref].filter(Boolean)]) assertResourceRef(ref)
  } catch { throw new ExternalProviderError(400, 'INVALID_RESOURCE_REF') }
  return JSON.parse(JSON.stringify(value)) as SubmitTask
}
export function parseTaskRecord(value: unknown): TaskRecord {
  if (!record(value)) throw new ExternalProviderError(500, 'INVALID_TASK_RECORD')
  const { spec, resolution } = value
  try {
    for (const ref of [...spec.input.resource_refs, ...spec.workspace_refs, ...[spec.output_contract?.schema_ref, spec.output_contract?.rubric_ref].filter(Boolean)]) assertResourceRef(ref)
    for (const timestamp of [spec.created_at, resolution.decided_at, spec.constraints.deadline].filter(Boolean)) {
      if (!Number.isFinite(Date.parse(timestamp!))) throw new Error('Invalid timestamp')
    }
  } catch { throw new ExternalProviderError(500, 'INVALID_TASK_RECORD') }
  if (spec.task_id !== resolution.task_id || (resolution.status === 'accepted' && (
    spec.required_capabilities.includes('verified_source_identity')
    || spec.agent.principal.trust_domain !== resolution.agent.principal.trust_domain
    || spec.agent.principal.agent_name !== resolution.agent.principal.agent_name
    || (resolution.agent.registry && (!resolution.agent.release_digest
      || resolution.agent.registry.principal.trust_domain !== resolution.agent.principal.trust_domain
      || resolution.agent.registry.principal.agent_name !== resolution.agent.principal.agent_name))
    || (!resolution.agent.release_digest && resolution.agent.version !== snapshotVersion(resolution.agent.source_digest))
    || (resolution.execution_mode === 'external_hosted' && resolution.agent.version_evidence === 'provider_revision_fenced' && !resolution.agent.execution_revision)
    || (resolution.execution_mode === 'internal_hosted' && resolution.agent.release_digest !== resolution.artifact.spec_digest)
    || (spec.agent.requested_channel !== undefined && spec.agent.requested_channel !== resolution.agent.resolved_from_channel)
    || (spec.agent.requested_version !== undefined && spec.agent.requested_version !== resolution.agent.version)
  ))) throw new ExternalProviderError(500, 'TASK_RECORD_MISMATCH')
  return value
}
export function catalogPrincipal(id: string): AgentPrincipalRef {
  return { trust_domain: 'moss.local', agent_name: `external-${id}` }
}
export function snapshotVersion(sourceDigest: string): string { return `snapshot-${sourceDigest.replace('sha256:', '')}` }
export { TASK_API }

export function canonicalTaskJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTaskJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalTaskJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
