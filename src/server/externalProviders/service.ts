import { ExternalProviderAdministration, type AdministrationOptions } from './administration.js'
import { randomUUID } from 'node:crypto'
import type { CatalogRepository } from '../catalog/catalogRepository.js'
import type { IdentityRepository } from '../identity/identityRepository.js'
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
  readonly administration: ExternalProviderAdministration
  constructor(readonly store: ExternalTaskStore, private readonly options: AdministrationOptions) {
    this.administration = new ExternalProviderAdministration(store, options)
    this.timer = setInterval(() => { void this.store.expire().catch(() => {}) }, 1000)
    this.timer.unref()
  }

  async close(): Promise<void> {
    clearInterval(this.timer)
    for (const controller of this.controllers) controller.abort()
    await Promise.allSettled(this.executions.values())
  }

  async authorize(actor: ExternalActor): Promise<void> {
    if (!await this.options.isActive(actor)) throw new ExternalProviderError(401, 'USER_NOT_ACTIVE')
  }

  async register(actor: ExternalActor, input: unknown): Promise<ExternalAgent> {
    await this.authorize(actor)
    const definition = parseRegistration(input, actor.orgId, await this.administration.effectivePolicy(actor))
    for (const userId of definition.allowed_user_ids) await this.authorize({ orgId: actor.orgId, userId })
    const binding: Binding = { ...definition, id: randomUUID(), orgId: actor.orgId, connectionId: randomUUID(), approved: false, parametersDigest: null, reviewedBy: null }
    await this.store.ready
    await this.store.db.transaction(async () => {
      await this.options.identities.putIntegrationConnection({ id: binding.connectionId, orgId: actor.orgId, providerType: 'dify', name: binding.name, enabled: true, secretRef: binding.credential_ref, config: { executionMode: 'external_hosted', baseUrl: binding.endpoint, tenantId: binding.workspace_id } })
      await this.options.catalog.createAgent({ id: binding.id, orgId: actor.orgId, name: binding.name, authorId: actor.userId, providerType: 'dify', supportedModes: 'cloud', status: 'pending', visibleTo: { user_ids: binding.allowed_user_ids }, providerBinding: { executionMode: 'external_hosted', bindingId: binding.id, connectionId: binding.connectionId, appId: binding.app_id, sourceDigest: binding.source_digest } })
      await this.store.saveBinding(binding)
    })
    return this.describe(binding)
  }

  async review(actor: ExternalActor, id: string, approved: boolean, revision?: number, reviewDays?: number): Promise<ExternalAgent> {
    await this.authorize(actor)
    const binding = await this.store.binding(actor, id)
    if (binding.credentialUpdating) throw new ExternalProviderError(409, 'CREDENTIAL_UPDATE_IN_PROGRESS')
    if (reviewDays !== undefined) {
      if (![1, 3, 7].includes(reviewDays)) throw new ExternalProviderError(400, 'INVALID_REVIEW_DAYS')
      binding.review_expires_at = Date.now() + reviewDays * 86400_000
    }
    let parametersDigest: string | null = null
    if (approved) {
      parseRegistration(this.definition(binding), actor.orgId, await this.administration.effectivePolicy(actor))
      const key = await this.key(binding)
      parametersDigest = await this.transport.parameters(binding.endpoint, key, AbortSignal.timeout(10_000))
    }
    return this.administration.change(actor, id, revision ?? binding.revision ?? 1, approved ? 'agent.approved' : 'agent.disabled', async current => {
      if (current.credentialUpdating) throw new ExternalProviderError(409, 'CREDENTIAL_UPDATE_IN_PROGRESS')
      current.approved = approved; current.parametersDigest = parametersDigest; current.reviewedBy = actor.userId
      current.review_expires_at = binding.review_expires_at
      await this.options.catalog.updateAgentConfiguration(id, actor.orgId, { status: approved ? 'approved' : 'pending', enabled: approved })
    })
  }

  async list(actor: ExternalActor): Promise<ExternalAgent[]> {
    await this.authorize(actor)
    if (!(await this.administration.policy(actor)).enabled) return []
    const result: ExternalAgent[] = []
    for (const binding of await this.store.bindings(actor)) {
      try { await this.executable(actor, binding); result.push(this.describe(binding)) } catch (error) { if (!(error instanceof ExternalProviderError)) throw error }
    }
    return result
  }

  async create(actor: ExternalActor, input: unknown) {
    await this.authorize(actor)
    const request = this.parseTask(input)
    const binding = await this.store.binding(actor, request.agent_id)
    await this.executable(actor, binding)
    await this.store.expire()
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
      const key = await this.key(binding)
      const fingerprint = await this.transport.parameters(binding.endpoint, key, controller.signal)
      if (fingerprint !== binding.parametersDigest) throw new ExternalProviderError(409, 'PROVIDER_PARAMETERS_CHANGED')
      const session = await this.store.session(actor, task.session_id)
      // Recheck revocation following network preflight, immediately before sending.
      await this.executable(actor, await this.store.binding(actor, task.agent_id))
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

  private async executable(actor: ExternalActor, binding: Binding): Promise<void> {
    assertPilot(await this.administration.effectivePolicy(actor), actor.orgId, binding.endpoint)
    if (binding.archived || binding.credentialUpdating || !binding.approved || !binding.parametersDigest || binding.review_expires_at <= Date.now() || !binding.allowed_user_ids.includes(actor.userId)) throw new ExternalProviderError(403, 'AGENT_NOT_APPROVED_FOR_USER')
    const catalog = await this.options.catalog.getAgent(binding.id, actor.orgId)
    if (!catalog?.enabled || catalog.status !== 'approved' || catalog.providerType !== 'dify' || catalog.providerBinding?.executionMode !== 'external_hosted' || catalog.providerBinding?.bindingId !== binding.id || catalog.providerBinding?.sourceDigest !== binding.source_digest || catalog.providerBinding?.appId !== binding.app_id || catalog.providerBinding?.connectionId !== binding.connectionId || Object.keys(catalog.visibleTo ?? {}).length !== 1 || JSON.stringify([...(catalog.visibleTo?.user_ids ?? [])].sort()) !== JSON.stringify([...binding.allowed_user_ids].sort())) throw new ExternalProviderError(403, 'AGENT_DISABLED_OR_CHANGED')
    const connection = await this.options.identities.getIntegrationConnection(binding.connectionId)
    if (!connection?.enabled || connection.orgId !== actor.orgId || connection.providerType !== 'dify' || connection.secretRef !== binding.credential_ref || connection.config.baseUrl !== binding.endpoint || connection.config.tenantId !== binding.workspace_id || connection.config.executionMode !== 'external_hosted') throw new ExternalProviderError(403, 'CONNECTION_DISABLED_OR_CHANGED')
  }

  private async key(binding: Binding): Promise<string> {
    const ref = parseNexusSecretRef(binding.credential_ref)
    const secret = await this.options.secrets.getSecret(ref.namespace, ref.key, `org:${binding.orgId}`)
    if (!secret?.value || secret.status !== 'enabled') throw new ExternalProviderError(503, 'CREDENTIAL_UNAVAILABLE')
    return secret.value
  }

  private definition(binding: Binding) {
    const { id: _id, orgId: _orgId, connectionId: _connectionId, approved: _approved, parametersDigest: _parametersDigest, reviewedBy: _reviewedBy, revision: _revision, archived: _archived, credentialUpdating: _credentialUpdating, ...definition } = binding
    return definition
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
