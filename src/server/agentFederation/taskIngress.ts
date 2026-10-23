import { randomUUID } from 'node:crypto'
import type { TaskRecord } from '../../../contracts/task/v1alpha1/contract.js'
import type { ExternalTask } from '../../../contracts/external-provider/v1/contract.js'
import { ExternalTaskStore, digest, type Binding, type ExternalActor } from '../externalProviders/store.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import type { ProviderCapabilities } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import { canonicalTaskJson, catalogPrincipal, parseTaskSubmission, snapshotVersion, TASK_API } from './taskContract.js'
import type { AgentReleaseSelection } from './releases.js'

interface AdmissionHooks {
  lockPolicy: () => Promise<void>
  policy: () => Promise<{ enabled: boolean; endpoints: string[]; revision: number }>
  executable: (binding: Binding) => Promise<void>
  capabilities: (binding: Binding) => Readonly<ProviderCapabilities>
  resolveRelease: (binding: Binding, version?: string, channel?: string) => Promise<AgentReleaseSelection>
  timeoutMs: number
}

export const MIN_DISPATCH_BUDGET_MS = 100

/** All policy decisions for valid submissions are stored before any provider I/O. */
export async function admitExternalTask(store: ExternalTaskStore, actor: ExternalActor, value: unknown, hooks: AdmissionHooks): Promise<ExternalTask> {
  const input = parseTaskSubmission(value), requestHash = digest(canonicalTaskJson(input))
  const existing = await store.existingRequest(actor, input.constraints.idempotency_key, requestHash)
  if (existing) return existing
  return store.db.transaction(async () => {
    await store.db.run('UPDATE external_pilot_bindings SET document = document WHERE id = ? AND org_id = ?', [input.agent.catalog_id, actor.orgId])
    await hooks.lockPolicy()
    const policy = await hooks.policy()
    let binding: Binding | undefined, release: AgentReleaseSelection | undefined, code = 'ALLOWED', reason = '允许执行已审核的合成数据任务。'
    function deny(nextCode: string, nextReason: string) { if (code === 'ALLOWED') { code = nextCode; reason = nextReason } }
    try { binding = await store.binding(actor, input.agent.catalog_id) }
    catch (error) { if (!(error instanceof ExternalProviderError) || error.code !== 'AGENT_NOT_FOUND') throw error; deny('AGENT_NOT_FOUND', '当前组织中不存在此智能体。') }
    if (input.session_id) {
      const session = await store.session(actor, input.session_id)
      if (session.agent_id !== input.agent.catalog_id) throw new ExternalProviderError(409, 'SESSION_BUSY_OR_AGENT_MISMATCH')
    }
    for (const related of [input.parent_task_id, input.supersedes_task_id]) {
      if (related) await store.task(actor, related)
    }
    if (input.required_capabilities.includes('verified_source_identity')) deny('SOURCE_IDENTITY_UNVERIFIED', '当前接入不能证明服务凭据与声明的应用、工作区及审核来源一致，无法满足强来源审计。')
    if (binding) {
      try { await hooks.executable(binding) }
      catch (error) {
        if (!(error instanceof ExternalProviderError)) throw error
        deny(error.code, '智能体的授权、审批或接入策略当前不允许执行。')
      }
      if (code === 'ALLOWED') {
        try {
          const sessionVersion = input.session_id ? await store.sessionVersion(actor, input.session_id) : undefined
          release = await hooks.resolveRelease(binding,
            input.agent.requested_version ?? (input.agent.requested_channel ? undefined : sessionVersion), input.agent.requested_channel)
          if (sessionVersion && release.manifest.version !== sessionVersion) throw new ExternalProviderError(409, 'VERSION_CHANGE_REQUIRES_NEW_SESSION')
          binding = { ...binding, ...release.manifest.snapshot }
        } catch (error) {
          if (!(error instanceof ExternalProviderError)) throw error
          deny(error.code, error.code === 'VERSION_CHANGE_REQUIRES_NEW_SESSION'
            ? '当前会话已固定智能体版本，切换版本或频道请新建会话。'
            : error.code.startsWith('REGISTRY_')
              ? '暂时无法核验注册中心的版本信息，请恢复服务或配置后重试；当前请求未执行。'
              : '请求的智能体版本或频道不存在、已撤销或审批已过期。')
        }
      }
      try {
        const capabilities = hooks.capabilities(binding)
        if (input.required_capabilities.some(key => capabilities[`supports_${key}` as keyof typeof capabilities] !== true)) deny('CAPABILITY_UNAVAILABLE', '此智能体不支持任务要求的能力。')
      } catch (error) {
        if (!(error instanceof ExternalProviderError)) throw error
        deny(error.code, '此平台尚未注册可执行的适配器。')
      }
    }
    if (input.input.resource_refs.length || input.workspace_refs.length) deny('RESOURCE_INPUT_UNSUPPORTED', '当前接入仅允许文本任务，不能传输资源或工作区。')
    if (input.data_classification !== 'synthetic') deny('DATA_DOMAIN_FORBIDDEN', '当前接入仅允许已审核的合成数据任务。')
    if (!['auto', 'cloud'].includes(input.requested_mode)) deny('RUNTIME_UNAVAILABLE', '此智能体在外部平台托管，不能切换为本地或私有运行时。')
    if (input.constraints.deadline && Date.parse(input.constraints.deadline) <= Date.now()) deny('DEADLINE_EXPIRED', '任务截止时间已过。')
    if (input.constraints.max_cost_units !== undefined) deny('BUDGET_ENFORCEMENT_UNAVAILABLE', '此平台尚不支持可验证的费用预算限制。')
    if (input.constraints.max_attempts !== undefined && input.constraints.max_attempts !== 1) deny('RETRY_UNSUPPORTED', '此接入只允许一次执行，不会自动重试外部任务。')
    if (input.output_contract && Object.keys(input.output_contract).length) deny('OUTPUT_VERIFICATION_UNAVAILABLE', '此接入尚未实现输出契约验证。')
    const principal = release?.manifest.principal ?? catalogPrincipal(input.agent.catalog_id)
    const snapshot = { registry: release?.manifest.registry ?? null, profile: 'external-query-only/v1', organization: actor.orgId, policy, binding_revision: binding?.revision ?? null, source_digest: binding?.source_digest ?? null, release_digest: release?.manifest.spec_digest ?? null, version: release?.manifest.version ?? null, channel: release?.channel ?? null, source_identity_evidence: 'unverified', claimed_app_id: binding?.app_id ?? null, claimed_workspace_id: binding?.workspace_id ?? null }
    const policyVersion = `${snapshot.profile}:revision-${policy.revision}`
    // An unresolved selector is preserved as a rejected task without inventing source or provider facts.
    const selected: Binding = binding ?? { id: input.agent.catalog_id, orgId: actor.orgId, name: input.agent.catalog_id, source_digest: 'unresolved', revision: 1 } as Binding
    const timeout = Math.max(1, Math.min(hooks.timeoutMs, input.constraints.timeout_ms ?? hooks.timeoutMs, input.constraints.deadline ? Date.parse(input.constraints.deadline) - Date.now() : Infinity))
    if (timeout < MIN_DISPATCH_BUDGET_MS) deny('DISPATCH_BUDGET_TOO_SHORT', '任务剩余时间不足，无法安全派发。')
    return store.create(actor, { agent_id: selected.id, session_id: input.session_id, query: input.input.instruction, idempotency_key: input.constraints.idempotency_key }, selected, timeout, {
      requestHash, policySnapshot: snapshot, deadlineAt: input.constraints.deadline ? Date.parse(input.constraints.deadline) : undefined,
      reason: { status: code === 'ALLOWED' ? 'accepted' : 'rejected', reason_code: code, reason, policy_version: policyVersion },
      record: task => {
        const { kind: _kind, session_id: _session, agent, ...rest } = input
        const base = { api_version: TASK_API, kind: 'TaskExecutionResolution' as const, resolution_id: randomUUID(), task_id: task.id, reason_code: code, reason, policy_version: policyVersion, policy_snapshot_digest: digest(canonicalTaskJson(snapshot)), decided_at: new Date(task.created_at).toISOString() }
        const record: TaskRecord = {
          api_version: TASK_API, kind: 'TaskRecord',
          spec: { ...rest, kind: 'TaskSpec', task_id: task.id, session_id: task.session_id, created_at: new Date(task.created_at).toISOString(), requested_by: { subject_type: 'user', subject_id: actor.userId }, agent: { principal, ...(agent.requested_version ? { requested_version: agent.requested_version } : {}), ...(agent.requested_channel ? { requested_channel: agent.requested_channel } : {}) } },
          resolution: code !== 'ALLOWED' ? { ...base, status: 'rejected' } : { ...base, status: 'accepted', attempt_id: task.attempt_id!, execution_mode: 'external_hosted', resolved_runtime: 'external_provider', resolution_mode: 'default', governance_org_id: actor.orgId, agent: {
            principal, version: release?.manifest.version ?? snapshotVersion(selected.source_digest), source_digest: selected.source_digest,
            version_evidence: selected.sourceManifest?.execution_revision ? 'provider_revision_fenced' : 'source_snapshot_only',
            ...(release ? { release_digest: release.manifest.spec_digest } : {}),
            ...(release?.manifest.registry ? { registry: release.manifest.registry } : {}),
            ...(release?.channel ? { resolved_from_channel: release.channel.name, channel_revision: release.channel.revision } : {}),
            ...(selected.sourceManifest?.execution_revision ? { execution_revision: selected.sourceManifest.execution_revision } : {}),
            source_identity_evidence: 'unverified', claimed_app_id: selected.app_id, claimed_workspace_id: selected.workspace_id,
          }, binding_id: selected.id, configuration_revision: selected.revision ?? 1, provider_kind: selected.provider_kind ?? 'dify' },
        }
        return record
      },
    })
  })
}
