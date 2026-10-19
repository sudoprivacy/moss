import { describeExternalAgent } from './description.js'
import { definitionDigest, DEFINITION_PROFILE_VERSION } from './definition.js'
import { ExternalProviderAdministration, object, type AdministrationOptions } from './administration.js'
import { randomUUID } from 'node:crypto'
import type { CatalogAgent } from '../catalog/catalogRepository.js'
import type { IntegrationConnection } from '../identity/identityRepository.js'
import { parseNexusSecretRef, type DifySecretPort } from '../dify/difyConnectionService.js'
import { EXTERNAL_PROVIDER_API, type ExternalAgent, type ExternalTaskEvidence } from '../../../contracts/external-provider/v1/contract.js'
import { ExternalTaskStore, digest, type Binding, type ExternalActor } from './store.js'
import { ExternalProviderError, assertPilot, parseRegistration, type PilotPolicy } from './policy.js'
import { decodeOutput } from './decoder.js'
import { providerDefinition } from './providerDefinition.js'
import { createRuntimeRegistry } from '../agentFederation/runtimeRegistry.js'
import { maintainRetention } from './retention.js'
import { admitExternalTask } from '../agentFederation/taskIngress.js'
import { RegistryReleases } from '../agentFederation/registryReleases.js'
import { RegistryMigration } from '../agentFederation/registryMigration.js'
import { ExternalExecutionOwnership } from '../agentFederation/executionOwnership.js'
import { DURABLE_AGENT_HTTP_API } from '../../../contracts/agent-http/v1alpha2/contract.js'

export class ExternalProviderService {
  private readonly timer: ReturnType<typeof setInterval>
  private readonly executions = new Map<string, Promise<void>>()
  private readonly controllers = new Set<AbortController>()
  private maintenance: Promise<void> | null = null
  private nextCredentialMaintenance = 0
  readonly administration: ExternalProviderAdministration
  readonly releases: RegistryReleases
  readonly registryMigration: RegistryMigration
  readonly ownership: ExternalExecutionOwnership
  private closing = false
  private readonly adapters: ReturnType<typeof createRuntimeRegistry>
  constructor(readonly store: ExternalTaskStore, private readonly options: AdministrationOptions, serverInstanceId?: string) {
    this.releases = new RegistryReleases(store, options.registry)
    this.registryMigration = new RegistryMigration(this.releases, { maintenance: options.registryMaintenance ?? false, backupDirectory: options.registryBackupDirectory })
    this.ownership = new ExternalExecutionOwnership(store, serverInstanceId)
    this.administration = new ExternalProviderAdministration(store, options)
    this.adapters = createRuntimeRegistry(options)
    this.timer = setInterval(() => { void this.maintain().catch(() => {}) }, 1000)
    this.timer.unref()
    void this.maintain().catch(() => {})
  }

  async close(): Promise<void> {
    this.closing = true
    clearInterval(this.timer)
    await this.maintenance?.catch(() => {})
    for (const controller of this.controllers) controller.abort()
    await Promise.allSettled(this.executions.values())
    await this.ownership.stop()
  }

  maintain(): Promise<void> {
    if (this.maintenance) return this.maintenance
    this.maintenance = (async () => {
      await this.store.ready
      await this.ownership.heartbeat()
      await this.store.scheduled('expiry', 1000, () => this.store.expire())
      if (Date.now() >= this.nextCredentialMaintenance) {
        this.nextCredentialMaintenance = Date.now() + 60_000
        await this.administration.operations.reconcile()
        await maintainRetention(this.store)
      }
      if (!this.closing && !this.options.registryMaintenance) for (const id of await this.ownership.candidates()) {
        if (this.closing || this.executions.size >= 32) break
        this.startTask(id)
      }
    })().finally(() => { this.maintenance = null })
    return this.maintenance
  }

  async authorize(actor: ExternalActor): Promise<void> {
    if (!await this.options.isActorActive(actor)) throw new ExternalProviderError(401, 'USER_NOT_ACTIVE')
  }

  get isRegistryMaintenance(): boolean { return this.options.registryMaintenance ?? false }

  async onboard(actor: ExternalActor, input: unknown) {
    const agent = await this.administration.onboard(actor, input)
    await this.registryMigration.enrollNew(actor, agent.id)
    return agent
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
    for (const userId of definition.allowed_user_ids) {
      if (!await this.options.isMemberActive({ orgId: actor.orgId, userId })) {
        throw new ExternalProviderError(400, 'INVALID_MEMBER')
      }
    }
    const binding: Binding = { ...definition, ...source, ...(this.options.registry ? { registryRequired: true } : {}), id: randomUUID(), orgId: actor.orgId, connectionId: randomUUID(), approved: false, parametersDigest: null, reviewedBy: null, revision: 1, definitionProfileVersion: DEFINITION_PROFILE_VERSION, registrationMode: 'reference_compat' }
    await this.store.ready
    const requestHash = digest(JSON.stringify(definition, Object.keys(definition).sort()))
    const agent = await this.store.db.transaction(async () => {
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
    await this.registryMigration.enrollNew(actor, agent.id)
    return agent
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
    const isRegistry = await this.releases.isRegistry(actor, id)
    const result = await this.administration.change(actor, id, revision, approved ? 'agent.approved' : 'agent.disabled', async current => {
      if (current.credentialUpdating) throw new ExternalProviderError(409, 'CREDENTIAL_UPDATE_IN_PROGRESS')
      current.credentialVersion = credentialVersion
      current.approved = approved; current.parametersDigest = parametersDigest; current.reviewedBy = actor.userId; current.reviewedAt = approved ? Date.now() : null
      current.review_expires_at = binding.review_expires_at
      await this.options.catalog.updateAgentConfiguration(id, actor.orgId, { status: approved ? 'approved' : 'pending', enabled: approved })
      if (approved && !isRegistry) {
        const version = await this.releases.publish(actor, current, this.releases.defaultVersion(current), current.review_note)
        const page = await this.releases.list(actor, id)
        await this.releases.moveChannel(actor, id, 'stable', version.version, page.channels.find(c => c.name === 'stable')?.revision ?? 0)
      }
    })
    if (approved && isRegistry) {
      try {
        const current = await this.store.binding(actor, id)
        const version = await this.releases.publish(actor, current, this.releases.defaultVersion(current), current.review_note)
        const page = await this.releases.list(actor, id)
        await this.releases.moveChannel(actor, id, 'stable', version.version, page.channels.find(channel => channel.name === 'stable')?.revision ?? 0)
      } catch {
        // The local governance change committed before the remote operation. Do not report it as rolled back.
        throw new ExternalProviderError(503, 'REGISTRY_PUBLICATION_INCOMPLETE')
      }
    }
    return result
  }

  async publishVersion(actor: ExternalActor, id: string, input: unknown) {
    const body = object(input, ['revision', 'version', 'note'])
    if (typeof body.version !== 'string' || typeof body.note !== 'string' || !Number.isSafeInteger(body.revision)) throw new ExternalProviderError(400, 'INVALID_RELEASE_INPUT')
    await this.authorize(actor)
    if (await this.releases.isRegistry(actor, id)) {
      const binding = await this.store.db.transaction(async () => {
        await this.store.db.run('UPDATE external_pilot_bindings SET document = document WHERE id = ? AND org_id = ?', [id, actor.orgId])
        const current = await this.store.binding(actor, id)
        if ((current.revision ?? 1) !== body.revision) throw new ExternalProviderError(409, 'CONFIGURATION_CHANGED')
        await this.administration.assertCredentialUsable(actor, current)
        return current
      })
      const result = await this.releases.publish(actor, binding, body.version as string, body.note as string)
      await this.administration.audit(actor, 'agent.version_published', id)
      return result
    }
    return this.store.db.transaction(async () => {
      await this.store.db.run('UPDATE external_pilot_bindings SET document = document WHERE id = ? AND org_id = ?', [id, actor.orgId])
      const binding = await this.store.binding(actor, id)
      if ((binding.revision ?? 1) !== body.revision) throw new ExternalProviderError(409, 'CONFIGURATION_CHANGED')
      await this.administration.assertCredentialUsable(actor, binding)
      const version = await this.releases.publish(actor, binding, body.version as string, body.note as string)
      await this.administration.audit(actor, 'agent.version_published', id)
      return version
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
    if (this.closing) throw new ExternalProviderError(503, 'EXTERNAL_PROVIDER_STOPPING')
    if (this.isRegistryMaintenance) throw new ExternalProviderError(503, 'REGISTRY_MAINTENANCE_REQUIRED')
    await this.authorize(actor)
    if (!input || typeof input !== 'object' || !('api_version' in input)) throw new ExternalProviderError(409, 'TASK_CLIENT_UPGRADE_REQUIRED')
    const task = await admitExternalTask(this.store, actor, input, {
      lockPolicy: () => this.administration.lockPolicy(actor),
      policy: () => this.administration.policy(actor),
      executable: binding => this.executable(actor, binding),
      timeoutMs: this.options.policy.timeoutMs,
      capabilities: binding => this.adapters.get(binding.provider_kind ?? 'dify').create(binding).capabilities,
      resolveRelease: (binding, version, channel) => this.releases.resolve(actor, binding.id, version, channel),
    })
    if (task.status === 'accepted') this.startTask(task.id)
    return task
  }

  async releaseOptions(actor: ExternalActor, id: string, after = '') {
    await this.authorize(actor)
    const binding = await this.store.binding(actor, id)
    await this.executable(actor, binding)
    return this.releases.options(actor, id, after)
  }

  async evidence(actor: ExternalActor, id: string): Promise<ExternalTaskEvidence> {
    await this.authorize(actor)
    const task = await this.store.task(actor, id)
    const record = await this.store.taskRecord(actor, id), run = await this.store.runBinding(actor, id)
    const selected = record?.resolution.status === 'accepted' ? record.resolution.agent : undefined
    return { api_version: EXTERNAL_PROVIDER_API, kind: 'ExternalTaskEvidence', task_id: task.id, session_id: task.session_id, attempt_id: task.attempt_id, status: task.status,
      ...(selected ? { selection: { version: selected.version, source_digest: selected.source_digest, release_digest: selected.release_digest,
        resolved_from_channel: selected.resolved_from_channel, channel_revision: selected.channel_revision,
        execution_revision: selected.execution_revision, version_evidence: selected.version_evidence,
        ...(selected.registry ? { registry: selected.registry } : {}) } } : {}),
      ...(run ? { execution: { provider_run_id: run.provider_run_id, execution_revision: run.execution_revision, version_evidence: run.version_evidence, resume: run.resume } } : {}),
    }
  }

  async waitForTask(id: string): Promise<void> { await this.executions.get(id) }

  private startTask(id: string) {
    if (this.closing || this.executions.has(id)) return
    const execution = this.execute(id).catch(() => { /* Lease recovery retries observation if storage is temporarily unavailable. */ }).finally(() => this.executions.delete(id))
    this.executions.set(id, execution)
  }

  private async execute(id: string): Promise<void> {
    const owned = await this.ownership.claim(id)
    if (!owned) return
    const { task, actor, fence, recovery } = owned
    const controller = new AbortController()
    this.controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), Math.max(1, task.deadline_at - Date.now()))
    let renewing: Promise<void> | undefined
    const heartbeat = setInterval(() => {
      if (renewing) return
      renewing = this.ownership.renew(fence).then(ok => { if (!ok) controller.abort() }, () => controller.abort()).finally(() => { renewing = undefined })
    }, 5000)
    heartbeat.unref()
    let submitted = Boolean(task.dispatch_authorized_at) || recovery, durable = false
    try {
      const governedBinding = await this.store.binding(actor, task.agent_id)
      await this.authorize(actor)
      await this.executable(actor, governedBinding)
      if (task.configuration_revision !== undefined && task.configuration_revision !== (governedBinding.revision ?? 1)) throw new ExternalProviderError(409, 'CONFIGURATION_CHANGED')
      let binding = governedBinding
      const record = await this.store.taskRecord(actor, task.id)
      const resolution = record?.resolution
      if (resolution?.status === 'accepted' && resolution.agent.release_digest) {
        const version = await this.releases.version(actor, task.agent_id, resolution.agent.version)
        if (version.spec_digest !== resolution.agent.release_digest || version.snapshot.source_digest !== task.source_digest) throw new ExternalProviderError(409, 'AGENT_VERSION_DIGEST_MISMATCH')
        binding = { ...governedBinding, ...version.snapshot }
      }
      durable = binding.sourceManifest?.protocol === DURABLE_AGENT_HTTP_API
      if (recovery && !durable) {
        await this.store.mutate(id, current => { current.status = 'unknown'; current.error_code = 'RECOVERY_UNSUPPORTED'; return 'status' }, fence)
        return
      }
      const adapter = this.adapters.get(binding.provider_kind ?? 'dify').create(binding)
      const secret = await this.secret(binding)
      if (binding.credentialVersion !== secret.version) throw new ExternalProviderError(409, 'CREDENTIAL_CHANGED')
      const key = secret.value
      const session = await this.store.session(actor, task.session_id)
      const invocation = await this.store.invocationContext(task, fence, {
        provider_session_id: session.conversation_id,
        end_user: digest(JSON.stringify([actor.orgId, actor.userId, task.agent_name])).slice(7),
      })
      const result = await adapter.invoke({
        task_id: task.id, attempt_id: task.attempt_id!, session_id: task.session_id,
        binding_id: binding.id, external_agent_id: binding.app_id, source_digest: binding.source_digest,
        endpoint: binding.endpoint, org_id: actor.orgId, policy: await this.administration.effectivePolicy(actor),
        key, query: task.query, provider_session_id: invocation.provider_session_id, deadline_at: task.deadline_at,
        end_user: invocation.end_user, signal: controller.signal, recovery, known_provider_run_id: task.provider_refs.run_id,
        authorize_dispatch: async () => {
          // Adapter preflight precedes the same durable governance linearization point.
          await this.store.db.transaction(async () => {
            await this.store.db.run('UPDATE external_pilot_bindings SET document = document WHERE id = ? AND org_id = ?', [binding.id, actor.orgId])
            const current = await this.store.binding(actor, binding.id)
            if (JSON.stringify(current) !== JSON.stringify(governedBinding)) throw new ExternalProviderError(409, 'CONFIGURATION_CHANGED')
            if (resolution?.status === 'accepted' && resolution.agent.release_digest) await this.releases.resolve(actor, task.agent_id, resolution.agent.version)
            await this.administration.lockPolicy(actor)
            await this.authorize(actor)
            await this.executable(actor, current)
            const claimed = await this.store.mutate(id, value => {
              if (!['dispatching', 'running'].includes(value.status) || value.deadline_at <= Date.now()) return false
              value.dispatch_authorized_at = Date.now()
              return 'status'
            }, fence)
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
        }, fence)
      })
      const decoded = decodeOutput(result.text, binding.decoder, true)
      await this.store.db.transaction(async () => {
        const completed = await this.store.mutate(id, current => {
          current.status = result.status; current.raw_answer = result.text; current.answer = decoded.answer
          current.output_status = decoded.valid ? 'valid' : 'invalid'
          return 'answer'
        }, fence)
        if (completed) await this.store.saveRunBinding(actor, result.binding)
      })
    } catch (error) {
      if (this.closing && durable) return // Another controller resumes observation using the saved request.
      const code = error instanceof ExternalProviderError ? error.code : submitted ? 'EXECUTION_UNCONFIRMED' : 'PROVIDER_PREFLIGHT_FAILED'
      await this.store.mutate(id, current => {
        current.status = !submitted || code === 'PROVIDER_REJECTED' ? current.task_contract_version ? 'failed' : 'rejected' : code === 'PROVIDER_WORKFLOW_FAILED' ? 'failed' : 'unknown'
        current.error_code = code
        return 'status'
      }, fence)
    } finally { clearTimeout(timeout); clearInterval(heartbeat); await renewing; this.controllers.delete(controller) }
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
    return describeExternalAgent(binding)
  }


}
