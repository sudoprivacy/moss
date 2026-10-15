import { definitionDigest, DEFINITION_PROFILE_VERSION } from './definition.js'
import { ExternalProviderAdministration, object, type AdministrationOptions } from './administration.js'
import { randomUUID } from 'node:crypto'
import type { CatalogAgent } from '../catalog/catalogRepository.js'
import type { IntegrationConnection } from '../identity/identityRepository.js'
import { parseNexusSecretRef, type DifySecretPort } from '../dify/difyConnectionService.js'
import type { ExternalAgent } from '../../../contracts/external-provider/v1/contract.js'
import { ExternalTaskStore, digest, type Binding, type ExternalActor } from './store.js'
import { ExternalProviderError, assertPilot, parseRegistration, type PilotPolicy } from './policy.js'
import { decodeOutput } from './decoder.js'
import { providerDefinition } from './providerDefinition.js'
import { createRuntimeRegistry } from '../agentFederation/runtimeRegistry.js'
import { maintainRetention } from './retention.js'
import { admitExternalTask } from '../agentFederation/taskIngress.js'

export class ExternalProviderService {
  private readonly timer: ReturnType<typeof setInterval>
  private readonly executions = new Map<string, Promise<void>>()
  private readonly controllers = new Set<AbortController>()
  private maintenance: Promise<void> | null = null
  private nextCredentialMaintenance = 0
  readonly administration: ExternalProviderAdministration
  private readonly adapters: ReturnType<typeof createRuntimeRegistry>
  constructor(readonly store: ExternalTaskStore, private readonly options: AdministrationOptions) {
    this.administration = new ExternalProviderAdministration(store, options)
    this.adapters = createRuntimeRegistry(options)
    this.timer = setInterval(() => { void this.maintain().catch(() => {}) }, 1000)
    this.timer.unref()
    void this.maintain().catch(() => {})
  }

  async close(): Promise<void> {
    clearInterval(this.timer)
    for (const controller of this.controllers) controller.abort()
    await Promise.allSettled(this.executions.values())
    await this.maintenance
  }

  maintain(): Promise<void> {
    if (this.maintenance) return this.maintenance
    this.maintenance = (async () => {
      await this.store.scheduled('expiry', 1000, () => this.store.expire())
      if (Date.now() >= this.nextCredentialMaintenance) {
        this.nextCredentialMaintenance = Date.now() + 60_000
        await this.administration.operations.reconcile()
        await maintainRetention(this.store)
      }
    })().finally(() => { this.maintenance = null })
    return this.maintenance
  }

  async authorize(actor: ExternalActor): Promise<void> {
    if (!await this.options.isActive(actor)) throw new ExternalProviderError(401, 'USER_NOT_ACTIVE')
  }

  async register(actor: ExternalActor, input: unknown): Promise<ExternalAgent> {
    await this.authorize(actor)
    const body = object(input, ['provider_kind', 'request_id', 'source_definition', 'name', 'endpoint', 'app_id', 'workspace_id', 'credential_ref', 'source_digest', 'decoder', 'allowed_user_ids', 'review_expires_at', 'review_note'])
    const { request_id, source_definition, ...registration } = body
    if (typeof request_id !== 'string' || !/^[\w-]{8,128}$/.test(request_id)) throw new ExternalProviderError(400, 'INVALID_REQUEST_ID')
    const source = providerDefinition(body.provider_kind, source_definition, registration.app_id as string)
    const sourceDigest = source.source_digest
    if (registration.source_digest !== sourceDigest) throw new ExternalProviderError(400, 'DEFINITION_DIGEST_MISMATCH')
    const definition = parseRegistration(registration, actor.orgId, await this.administration.effectivePolicy(actor))
    for (const userId of definition.allowed_user_ids) await this.authorize({ orgId: actor.orgId, userId })
    const binding: Binding = { ...definition, ...source, id: randomUUID(), orgId: actor.orgId, connectionId: randomUUID(), approved: false, parametersDigest: null, reviewedBy: null, revision: 1, definitionProfileVersion: DEFINITION_PROFILE_VERSION, registrationMode: 'reference_compat' }
    await this.store.ready
    const requestHash = digest(JSON.stringify(definition, Object.keys(definition).sort()))
    return this.store.db.transaction(async () => {
      const reserved = await this.store.db.run(`INSERT INTO external_pilot_operations (id, org_id, kind, request_id, request_hash, status, lease_until, document) VALUES (?, ?, 'reference_register', ?, ?, 'complete', 0, ?) ON CONFLICT(org_id, kind, request_id) DO NOTHING`, [randomUUID(), actor.orgId, request_id, requestHash, JSON.stringify({ bindingId: binding.id })])
      if (!reserved) {
        const existing = await this.store.db.get("SELECT request_hash, document FROM external_pilot_operations WHERE org_id = ? AND kind = 'reference_register' AND request_id = ?", [actor.orgId, request_id])
        if (existing?.request_hash !== requestHash) throw new ExternalProviderError(409, 'IDEMPOTENCY_CONFLICT')
        return this.describe(await this.store.binding(actor, JSON.parse(String(existing.document)).bindingId))
      }
      await this.options.identities.putIntegrationConnection({ id: binding.connectionId, orgId: actor.orgId, providerType: binding.provider_kind ?? 'dify', name: binding.name, enabled: true, secretRef: binding.credential_ref, config: { executionMode: 'external_hosted', baseUrl: binding.endpoint, tenantId: binding.workspace_id } })
      await this.options.catalog.createAgent({ id: binding.id, orgId: actor.orgId, name: binding.name, authorId: actor.userId, providerType: binding.provider_kind ?? 'dify', supportedModes: 'cloud', status: 'pending', visibleTo: { user_ids: binding.allowed_user_ids }, providerBinding: { executionMode: 'external_hosted', bindingId: binding.id, connectionId: binding.connectionId, appId: binding.app_id, sourceDigest: binding.source_digest } })
      await this.store.saveBinding(binding)
      await this.administration.audit(actor, 'agent.reference_registered', binding.id)
      return this.describe(binding)
    })
  }

  async review(actor: ExternalActor, id: string, approved: boolean, revision: number, reviewDays?: number): Promise<ExternalAgent> {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new ExternalProviderError(400, 'INVALID_REVIEW')
    await this.authorize(actor)
    const binding = await this.store.binding(actor, id)
    if ((binding.revision ?? 1) !== revision) throw new ExternalProviderError(409, 'CONFIGURATION_CHANGED')
    if (binding.credentialUpdating) throw new ExternalProviderError(409, 'CREDENTIAL_UPDATE_IN_PROGRESS')
    if (reviewDays !== undefined) {
      if (![1, 3, 7].includes(reviewDays)) throw new ExternalProviderError(400, 'INVALID_REVIEW_DAYS')
      binding.review_expires_at = Date.now() + reviewDays * 86400_000
    }
    let parametersDigest: string | null = null
    let credentialVersion: number | undefined
    if (approved) {
      this.adapters.get(binding.provider_kind ?? 'dify')
      if (binding.definitionProfileVersion !== DEFINITION_PROFILE_VERSION) throw new ExternalProviderError(409, 'DEFINITION_REVIEW_REQUIRED')
      parseRegistration(this.definition(binding), actor.orgId, await this.administration.effectivePolicy(actor))
      if (binding.credentialRecoveryRequired) throw new ExternalProviderError(409, 'CREDENTIAL_ROTATION_REQUIRED')
      await this.administration.assertCredentialUsable(actor, binding)
      const secret = await this.secret(binding)
      credentialVersion = secret.version
      const key = secret.value
      parametersDigest = await this.administration.parameters(binding, key, AbortSignal.timeout(10_000))
    }
    return this.administration.change(actor, id, revision, approved ? 'agent.approved' : 'agent.disabled', async current => {
      if (current.credentialUpdating) throw new ExternalProviderError(409, 'CREDENTIAL_UPDATE_IN_PROGRESS')
      current.credentialVersion = credentialVersion
      current.approved = approved; current.parametersDigest = parametersDigest; current.reviewedBy = actor.userId
      current.review_expires_at = binding.review_expires_at
      await this.options.catalog.updateAgentConfiguration(id, actor.orgId, { status: approved ? 'approved' : 'pending', enabled: approved })
    })
  }

  async list(actor: ExternalActor): Promise<ExternalAgent[]> {
    const items: ExternalAgent[] = []
    let after = ''
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await this.listPage(actor, after)
      items.push(...page.items)
      if (!page.next_cursor) return items
      after = page.next_cursor
    }
    throw new ExternalProviderError(429, 'PILOT_DIRECTORY_CAPACITY_REACHED')
  }

  async listPage(actor: ExternalActor, after = '') {
    await this.authorize(actor)
    const effectivePolicy = await this.administration.effectivePolicy(actor)
    if (!effectivePolicy.orgIds.includes(actor.orgId)) return { items: [], next_cursor: null }
    const page = await this.store.bindings(actor, after, 101), bindings = page.slice(0, 100)
    const [agents, connections] = await Promise.all([
      this.options.catalog.getOrganizationAgentsByIds(actor.orgId, bindings.map(binding => binding.id)),
      this.options.identities.getOrganizationConnectionsByIds(actor.orgId, bindings.map(binding => binding.connectionId)),
    ])
    const context = { policy: effectivePolicy, agents: new Map(agents.map(agent => [agent.id, agent])), connections: new Map(connections.map(connection => [connection.id, connection])) }
    const result: ExternalAgent[] = []
    for (const binding of bindings) {
      try { await this.executable(actor, binding, context); result.push(this.describe(binding)) } catch (error) { if (!(error instanceof ExternalProviderError)) throw error }
    }
    return { items: result, next_cursor: page.length > 100 ? bindings.at(-1)!.id : null }
  }

  async create(actor: ExternalActor, input: unknown) {
    await this.authorize(actor)
    if (!input || typeof input !== 'object' || !('api_version' in input)) throw new ExternalProviderError(409, 'TASK_CLIENT_UPGRADE_REQUIRED')
    const task = await admitExternalTask(this.store, actor, input, {
      lockPolicy: () => this.administration.lockPolicy(actor),
      policy: () => this.administration.policy(actor),
      executable: binding => this.executable(actor, binding),
      timeoutMs: this.options.policy.timeoutMs,
      capabilities: binding => this.adapters.get(binding.provider_kind ?? 'dify').capabilities,
    })
    if (task.status === 'accepted' && !this.executions.has(task.id)) {
      const execution = this.execute(actor, task.id).catch(() => { /* Persisted dispatch intent is expired to unknown if the DB is unavailable. */ }).finally(() => this.executions.delete(task.id))
      this.executions.set(task.id, execution)
    }
    return task
  }

  async waitForTask(id: string): Promise<void> { await this.executions.get(id) }

  private async execute(actor: ExternalActor, id: string): Promise<void> {
    // A durable CAS wins dispatch once across processes; never replay a claimed attempt.
    const task = await this.store.mutate(id, current => {
      if (current.status !== 'accepted') return false
      if (current.deadline_at <= Date.now()) {
        current.status = current.task_contract_version ? 'failed' : 'rejected'
        current.error_code = 'DISPATCH_DEADLINE'
        return 'status'
      }
      current.status = 'dispatching'; current.attempt_id ??= randomUUID(); return 'status'
    })
    if (!task || task.status !== 'dispatching') return
    const controller = new AbortController()
    this.controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), Math.max(1, task.deadline_at - Date.now()))
    let submitted = false
    try {
      const binding = await this.store.binding(actor, task.agent_id)
      await this.authorize(actor)
      await this.executable(actor, binding)
      if (task.configuration_revision !== undefined && task.configuration_revision !== (binding.revision ?? 1)) throw new ExternalProviderError(409, 'CONFIGURATION_CHANGED')
      const adapter = this.adapters.get(binding.provider_kind ?? 'dify').create(binding)
      const secret = await this.secret(binding)
      if (binding.credentialVersion !== secret.version) throw new ExternalProviderError(409, 'CREDENTIAL_CHANGED')
      const key = secret.value
      const session = await this.store.session(actor, task.session_id)
      const result = await adapter.invoke({
        task_id: task.id, attempt_id: task.attempt_id!, session_id: task.session_id,
        binding_id: binding.id, external_agent_id: binding.app_id, source_digest: binding.source_digest,
        endpoint: binding.endpoint, org_id: actor.orgId, policy: await this.administration.effectivePolicy(actor),
        key, query: task.query, provider_session_id: session.conversation_id,
        end_user: digest(JSON.stringify([actor.orgId, actor.userId, task.agent_name])).slice(7), signal: controller.signal,
        authorize_dispatch: async () => {
          // Adapter preflight precedes the same durable governance linearization point.
          await this.store.db.transaction(async () => {
            await this.store.db.run('UPDATE external_pilot_bindings SET document = document WHERE id = ? AND org_id = ?', [binding.id, actor.orgId])
            const current = await this.store.binding(actor, binding.id)
            if (JSON.stringify(current) !== JSON.stringify(binding)) throw new ExternalProviderError(409, 'CONFIGURATION_CHANGED')
            await this.administration.lockPolicy(actor)
            await this.authorize(actor)
            await this.executable(actor, current)
            const claimed = await this.store.mutate(id, value => {
              if (value.status !== 'dispatching' || value.deadline_at <= Date.now()) return false
              value.dispatch_authorized_at = Date.now()
              return 'status'
            })
            if (!claimed) throw new ExternalProviderError(409, 'DISPATCH_DEADLINE')
          })
          controller.signal.throwIfAborted()
          submitted = true
        },
      }, async observation => {
        await this.store.mutate(id, current => {
          current.status = 'running'; current.raw_answer = observation.text
          current.provider_refs = {
            ...(observation.provider_refs.run_id ? { run_id: observation.provider_refs.run_id } : {}),
            ...(observation.provider_refs.session_id ? { conversation_id: observation.provider_refs.session_id } : {}),
            ...(observation.provider_refs.message_id ? { message_id: observation.provider_refs.message_id } : {}),
            ...(observation.provider_refs.provider_task_id ? { task_id: observation.provider_refs.provider_task_id } : {}),
            ...(observation.provider_refs.provider_workflow_run_id ? { workflow_run_id: observation.provider_refs.provider_workflow_run_id } : {}),
          }
          current.answer = decodeOutput(observation.text, binding.decoder).answer
          return 'answer'
        })
      })
      const decoded = decodeOutput(result.text, binding.decoder, true)
      await this.store.db.transaction(async () => {
        const completed = await this.store.mutate(id, current => {
          current.status = result.status; current.raw_answer = result.text; current.answer = decoded.answer
          current.output_status = decoded.valid ? 'valid' : 'invalid'
          return 'answer'
        })
        if (completed) await this.store.saveRunBinding(actor, result.binding)
      })
    } catch (error) {
      const code = error instanceof ExternalProviderError ? error.code : submitted ? 'EXECUTION_UNCONFIRMED' : 'PROVIDER_PREFLIGHT_FAILED'
      await this.store.mutate(id, current => {
        current.status = !submitted || code === 'PROVIDER_REJECTED' ? current.task_contract_version ? 'failed' : 'rejected' : code === 'PROVIDER_WORKFLOW_FAILED' ? 'failed' : 'unknown'
        current.error_code = code
        return 'status'
      })
    } finally { clearTimeout(timeout); this.controllers.delete(controller) }
  }

  private async executable(actor: ExternalActor, binding: Binding, context?: { policy: PilotPolicy; agents: Map<string, CatalogAgent>; connections: Map<string, IntegrationConnection> }): Promise<void> {
    this.adapters.get(binding.provider_kind ?? 'dify')
    if (binding.definitionProfileVersion !== DEFINITION_PROFILE_VERSION) throw new ExternalProviderError(409, 'DEFINITION_REVIEW_REQUIRED')
    assertPilot(context?.policy ?? await this.administration.effectivePolicy(actor), actor.orgId, binding.endpoint)
    if (binding.archived || binding.credentialUpdating || binding.credentialRecoveryRequired || !binding.approved || !binding.parametersDigest || binding.review_expires_at <= Date.now() || !binding.allowed_user_ids.includes(actor.userId)) throw new ExternalProviderError(403, 'AGENT_NOT_APPROVED_FOR_USER')
    const catalog = context ? context.agents.get(binding.id) : await this.options.catalog.getAgent(binding.id, actor.orgId)
    if (!catalog?.enabled || catalog.status !== 'approved' || catalog.providerType !== (binding.provider_kind ?? 'dify') || catalog.providerBinding?.executionMode !== 'external_hosted' || catalog.providerBinding?.bindingId !== binding.id || catalog.providerBinding?.sourceDigest !== binding.source_digest || catalog.providerBinding?.appId !== binding.app_id || catalog.providerBinding?.connectionId !== binding.connectionId || Object.keys(catalog.visibleTo ?? {}).length !== 1 || JSON.stringify([...(catalog.visibleTo?.user_ids ?? [])].sort()) !== JSON.stringify([...binding.allowed_user_ids].sort())) throw new ExternalProviderError(403, 'AGENT_DISABLED_OR_CHANGED')
    if (!context) return this.administration.assertCredentialUsable(actor, binding)
    const connection = context.connections.get(binding.connectionId)
    if (!connection?.enabled || connection.orgId !== actor.orgId || connection.providerType !== (binding.provider_kind ?? 'dify') || connection.secretRef !== binding.credential_ref || connection.config.baseUrl !== binding.endpoint || connection.config.tenantId !== binding.workspace_id || connection.config.executionMode !== 'external_hosted') throw new ExternalProviderError(403, 'CONNECTION_DISABLED_OR_CHANGED')
  }

  private async secret(binding: Binding) {
    const ref = parseNexusSecretRef(binding.credential_ref)
    const secret = await this.options.secrets.getSecret(ref.namespace, ref.key, `org:${binding.orgId}`)
    if (!secret?.value || secret.status !== 'enabled') throw new ExternalProviderError(503, 'CREDENTIAL_UNAVAILABLE')
    return { ...secret, value: secret.value }
  }

  private definition(binding: Binding) {
    return { ...(binding.provider_kind ? { provider_kind: binding.provider_kind } : {}), name: binding.name, endpoint: binding.endpoint, app_id: binding.app_id, workspace_id: binding.workspace_id, credential_ref: binding.credential_ref, source_digest: binding.source_digest, decoder: binding.decoder, allowed_user_ids: binding.allowed_user_ids, review_expires_at: binding.review_expires_at, review_note: binding.review_note }
  }

  private describe(binding: Binding): ExternalAgent {
    return { id: binding.id, name: binding.name, provider: binding.provider_kind ?? 'dify', execution_mode: 'external_hosted', profile: 'synthetic_pilot', source_identity_evidence: 'unverified', source_digest: binding.source_digest, decoder: binding.decoder, approved: binding.approved, review_expires_at: binding.review_expires_at, capabilities: { streaming: binding.provider_kind === 'custom_http' ? 'unsupported' : 'supported', cancel: 'unsupported', resume: 'unsupported', version_pin: 'unsupported' } }
  }


}
