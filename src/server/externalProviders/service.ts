import { definitionDigest, DEFINITION_PROFILE_VERSION } from './definition.js'
import { ExternalProviderAdministration, object, type AdministrationOptions } from './administration.js'
import { randomUUID } from 'node:crypto'
import type { CatalogAgent } from '../catalog/catalogRepository.js'
import type { IntegrationConnection } from '../identity/identityRepository.js'
import { parseNexusSecretRef, type DifySecretPort } from '../dify/difyConnectionService.js'
import type { CreateExternalTask, ExternalAgent } from '../../../contracts/external-provider/v1/contract.js'
import { ExternalTaskStore, digest, type Binding, type ExternalActor } from './store.js'
import { ExternalProviderError, assertPilot, parseRegistration, type PilotPolicy } from './policy.js'
import { DifyPilotTransport } from './difyTransport.js'
import { decodeOutput } from './decoder.js'

export class ExternalProviderService {
  private readonly timer: ReturnType<typeof setInterval>
  private readonly executions = new Map<string, Promise<void>>()
  private readonly controllers = new Set<AbortController>()
  private maintenance: Promise<void> | null = null
  private nextCredentialMaintenance = 0
  readonly administration: ExternalProviderAdministration
  constructor(readonly store: ExternalTaskStore, private readonly options: AdministrationOptions) {
    this.administration = new ExternalProviderAdministration(store, options)
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
      await this.store.expire()
      if (Date.now() >= this.nextCredentialMaintenance) {
        this.nextCredentialMaintenance = Date.now() + 60_000
        await this.administration.operations.reconcile()
      }
    })().finally(() => { this.maintenance = null })
    return this.maintenance
  }

  async authorize(actor: ExternalActor): Promise<void> {
    if (!await this.options.isActive(actor)) throw new ExternalProviderError(401, 'USER_NOT_ACTIVE')
  }

  async register(actor: ExternalActor, input: unknown): Promise<ExternalAgent> {
    await this.authorize(actor)
    const body = object(input, ['request_id', 'source_definition', 'name', 'endpoint', 'app_id', 'workspace_id', 'credential_ref', 'source_digest', 'decoder', 'allowed_user_ids', 'review_expires_at', 'review_note'])
    const { request_id, source_definition, ...registration } = body
    if (typeof request_id !== 'string' || !/^[\w-]{8,128}$/.test(request_id)) throw new ExternalProviderError(400, 'INVALID_REQUEST_ID')
    const sourceDigest = definitionDigest(source_definition)
    if (registration.source_digest !== sourceDigest) throw new ExternalProviderError(400, 'DEFINITION_DIGEST_MISMATCH')
    const definition = parseRegistration(registration, actor.orgId, await this.administration.effectivePolicy(actor))
    for (const userId of definition.allowed_user_ids) await this.authorize({ orgId: actor.orgId, userId })
    const binding: Binding = { ...definition, id: randomUUID(), orgId: actor.orgId, connectionId: randomUUID(), approved: false, parametersDigest: null, reviewedBy: null, revision: 1, definitionProfileVersion: DEFINITION_PROFILE_VERSION, registrationMode: 'reference_compat' }
    await this.store.ready
    const requestHash = digest(JSON.stringify(definition, Object.keys(definition).sort()))
    return this.store.db.transaction(async () => {
      const reserved = await this.store.db.run(`INSERT INTO external_pilot_operations (id, org_id, kind, request_id, request_hash, status, lease_until, document) VALUES (?, ?, 'reference_register', ?, ?, 'complete', 0, ?) ON CONFLICT(org_id, kind, request_id) DO NOTHING`, [randomUUID(), actor.orgId, request_id, requestHash, JSON.stringify({ bindingId: binding.id })])
      if (!reserved) {
        const existing = await this.store.db.get("SELECT request_hash, document FROM external_pilot_operations WHERE org_id = ? AND kind = 'reference_register' AND request_id = ?", [actor.orgId, request_id])
        if (existing?.request_hash !== requestHash) throw new ExternalProviderError(409, 'IDEMPOTENCY_CONFLICT')
        return this.describe(await this.store.binding(actor, JSON.parse(String(existing.document)).bindingId))
      }
      await this.options.identities.putIntegrationConnection({ id: binding.connectionId, orgId: actor.orgId, providerType: 'dify', name: binding.name, enabled: true, secretRef: binding.credential_ref, config: { executionMode: 'external_hosted', baseUrl: binding.endpoint, tenantId: binding.workspace_id } })
      await this.options.catalog.createAgent({ id: binding.id, orgId: actor.orgId, name: binding.name, authorId: actor.userId, providerType: 'dify', supportedModes: 'cloud', status: 'pending', visibleTo: { user_ids: binding.allowed_user_ids }, providerBinding: { executionMode: 'external_hosted', bindingId: binding.id, connectionId: binding.connectionId, appId: binding.app_id, sourceDigest: binding.source_digest } })
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
      if (binding.definitionProfileVersion !== DEFINITION_PROFILE_VERSION) throw new ExternalProviderError(409, 'DEFINITION_REVIEW_REQUIRED')
      parseRegistration(this.definition(binding), actor.orgId, await this.administration.effectivePolicy(actor))
      if (binding.credentialRecoveryRequired) throw new ExternalProviderError(409, 'CREDENTIAL_ROTATION_REQUIRED')
      await this.administration.assertCredentialUsable(actor, binding)
      const secret = await this.secret(binding)
      credentialVersion = secret.version
      const key = secret.value
      parametersDigest = await this.transport.parameters(binding.endpoint, key, AbortSignal.timeout(10_000))
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
    await this.authorize(actor)
    const effectivePolicy = await this.administration.effectivePolicy(actor)
    if (!effectivePolicy.orgIds.includes(actor.orgId)) return []
    const bindings = await this.store.bindings(actor)
    const [agents, connections] = await Promise.all([
      this.options.catalog.getOrganizationAgentsByIds(actor.orgId, bindings.map(binding => binding.id)),
      this.options.identities.listIntegrationConnections(actor.orgId, 'dify'),
    ])
    const context = { policy: effectivePolicy, agents: new Map(agents.map(agent => [agent.id, agent])), connections: new Map(connections.map(connection => [connection.id, connection])) }
    const result: ExternalAgent[] = []
    for (const binding of bindings) {
      try { await this.executable(actor, binding, context); result.push(this.describe(binding)) } catch (error) { if (!(error instanceof ExternalProviderError)) throw error }
    }
    return result
  }

  async create(actor: ExternalActor, input: unknown) {
    await this.authorize(actor)
    const request = this.parseTask(input)
    const binding = await this.store.binding(actor, request.agent_id)
    await this.executable(actor, binding)
    const task = await this.store.create(actor, request, binding, this.options.policy.timeoutMs)
    if (task.status === 'accepted' && !this.executions.has(task.id)) {
      const execution = this.execute(actor, task.id).catch(() => { /* Persisted dispatch intent is expired to unknown if the DB is unavailable. */ }).finally(() => this.executions.delete(task.id))
      this.executions.set(task.id, execution)
    }
    return task
  }

  async waitForTask(id: string): Promise<void> { await this.executions.get(id) }

  private get transport() { return this.options.transport ?? new DifyPilotTransport() }

  private async execute(actor: ExternalActor, id: string): Promise<void> {
    // A durable CAS wins dispatch once across processes; never replay a claimed attempt.
    const task = await this.store.mutate(id, current => {
      if (current.status !== 'accepted' || current.deadline_at <= Date.now()) return false
      current.status = 'dispatching'; current.attempt_id = randomUUID(); return 'status'
    })
    if (!task) return
    const controller = new AbortController()
    this.controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), Math.max(1, task.deadline_at - Date.now()))
    let submitted = false
    try {
      const binding = await this.store.binding(actor, task.agent_id)
      await this.authorize(actor)
      await this.executable(actor, binding)
      if (task.configuration_revision !== undefined && task.configuration_revision !== (binding.revision ?? 1)) throw new ExternalProviderError(409, 'CONFIGURATION_CHANGED')
      const secret = await this.secret(binding)
      if (binding.credentialVersion !== secret.version) throw new ExternalProviderError(409, 'CREDENTIAL_CHANGED')
      const key = secret.value
      const fingerprint = await this.transport.parameters(binding.endpoint, key, controller.signal)
      if (fingerprint !== binding.parametersDigest) throw new ExternalProviderError(409, 'PROVIDER_PARAMETERS_CHANGED')
      const session = await this.store.session(actor, task.session_id)
      // Linearization point: admin changes use the same Binding row lock. No network
      // I/O here; the approved immutable snapshot is authorized once before dispatch.
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
      const result = await this.transport.execute({ endpoint: binding.endpoint, key, query: task.query, conversationId: session.conversation_id, endUser: digest(JSON.stringify([actor.orgId, actor.userId, task.agent_name])).slice(7), signal: controller.signal }, async progress => {
        await this.store.mutate(id, current => {
          current.status = 'running'; current.raw_answer = progress.raw; current.provider_refs = progress.refs
          current.answer = decodeOutput(progress.raw, binding.decoder).answer
          return 'answer'
        })
      })
      const decoded = decodeOutput(result.raw, binding.decoder, true)
      await this.store.mutate(id, current => {
        current.status = 'succeeded'; current.raw_answer = result.raw; current.answer = decoded.answer
        current.output_status = decoded.valid ? 'valid' : 'invalid'; current.provider_refs = result.refs
        return 'answer'
      })
    } catch (error) {
      const code = error instanceof ExternalProviderError ? error.code : submitted ? 'EXECUTION_UNCONFIRMED' : 'PROVIDER_PREFLIGHT_FAILED'
      await this.store.mutate(id, current => {
        current.status = !submitted || code === 'PROVIDER_REJECTED' ? 'rejected' : code === 'PROVIDER_WORKFLOW_FAILED' ? 'failed' : 'unknown'
        current.error_code = code
        return 'status'
      })
    } finally { clearTimeout(timeout); this.controllers.delete(controller) }
  }

  private async executable(actor: ExternalActor, binding: Binding, context?: { policy: PilotPolicy; agents: Map<string, CatalogAgent>; connections: Map<string, IntegrationConnection> }): Promise<void> {
    if (binding.definitionProfileVersion !== DEFINITION_PROFILE_VERSION) throw new ExternalProviderError(409, 'DEFINITION_REVIEW_REQUIRED')
    assertPilot(context?.policy ?? await this.administration.effectivePolicy(actor), actor.orgId, binding.endpoint)
    if (binding.archived || binding.credentialUpdating || binding.credentialRecoveryRequired || !binding.approved || !binding.parametersDigest || binding.review_expires_at <= Date.now() || !binding.allowed_user_ids.includes(actor.userId)) throw new ExternalProviderError(403, 'AGENT_NOT_APPROVED_FOR_USER')
    const catalog = context ? context.agents.get(binding.id) : await this.options.catalog.getAgent(binding.id, actor.orgId)
    if (!catalog?.enabled || catalog.status !== 'approved' || catalog.providerType !== 'dify' || catalog.providerBinding?.executionMode !== 'external_hosted' || catalog.providerBinding?.bindingId !== binding.id || catalog.providerBinding?.sourceDigest !== binding.source_digest || catalog.providerBinding?.appId !== binding.app_id || catalog.providerBinding?.connectionId !== binding.connectionId || Object.keys(catalog.visibleTo ?? {}).length !== 1 || JSON.stringify([...(catalog.visibleTo?.user_ids ?? [])].sort()) !== JSON.stringify([...binding.allowed_user_ids].sort())) throw new ExternalProviderError(403, 'AGENT_DISABLED_OR_CHANGED')
    if (!context) return this.administration.assertCredentialUsable(actor, binding)
    const connection = context.connections.get(binding.connectionId)
    if (!connection?.enabled || connection.orgId !== actor.orgId || connection.providerType !== 'dify' || connection.secretRef !== binding.credential_ref || connection.config.baseUrl !== binding.endpoint || connection.config.tenantId !== binding.workspace_id || connection.config.executionMode !== 'external_hosted') throw new ExternalProviderError(403, 'CONNECTION_DISABLED_OR_CHANGED')
  }

  private async secret(binding: Binding) {
    const ref = parseNexusSecretRef(binding.credential_ref)
    const secret = await this.options.secrets.getSecret(ref.namespace, ref.key, `org:${binding.orgId}`)
    if (!secret?.value || secret.status !== 'enabled') throw new ExternalProviderError(503, 'CREDENTIAL_UNAVAILABLE')
    return { ...secret, value: secret.value }
  }

  private definition(binding: Binding) {
    return { name: binding.name, endpoint: binding.endpoint, app_id: binding.app_id, workspace_id: binding.workspace_id, credential_ref: binding.credential_ref, source_digest: binding.source_digest, decoder: binding.decoder, allowed_user_ids: binding.allowed_user_ids, review_expires_at: binding.review_expires_at, review_note: binding.review_note }
  }

  private describe(binding: Binding): ExternalAgent {
    return { id: binding.id, name: binding.name, provider: 'dify', execution_mode: 'external_hosted', profile: 'synthetic_pilot', source_digest: binding.source_digest, decoder: binding.decoder, approved: binding.approved, review_expires_at: binding.review_expires_at, capabilities: { streaming: 'supported', cancel: 'unsupported', resume: 'unsupported', version_pin: 'unsupported' } }
  }

  private parseTask(value: unknown): CreateExternalTask {
    const input = value as CreateExternalTask | null
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['agent_id', 'session_id', 'query', 'idempotency_key'].includes(key)) || typeof input.agent_id !== 'string' || !/^[\w-]{1,100}$/.test(input.agent_id) || (input.session_id !== undefined && (typeof input.session_id !== 'string' || !/^[\w-]{1,100}$/.test(input.session_id))) || typeof input.query !== 'string' || !input.query.trim() || input.query.length > 8000 || typeof input.idempotency_key !== 'string' || !/^[\w-]{8,128}$/.test(input.idempotency_key)) throw new ExternalProviderError(400, 'INVALID_TASK')
    return input
  }
}
