import { randomUUID } from 'node:crypto'
import { definitionDigest, DEFINITION_PROFILE_VERSION } from './definition.js'
export { definitionDigest } from './definition.js'
import type { ExternalAgentAdmin, ExternalPilotPolicy, ExternalProviderMember } from '../../../contracts/external-provider/v1/contract.js'
import type { DifySecretPort } from '../dify/difyConnectionService.js'
import { parseNexusSecretRef } from '../dify/difyConnectionService.js'
import type { CatalogRepository } from '../catalog/catalogRepository.js'
import type { IdentityRepository } from '../identity/identityRepository.js'
import { ExternalTaskStore, digest, type Binding, type ExternalActor } from './store.js'
import { canonicalEndpoint, assertPilot, ExternalProviderError, parseRegistration, type PilotPolicy } from './policy.js'
import { CredentialOperations, type CredentialOperation } from './operations.js'
import { DifyPilotTransport } from './difyTransport.js'
import { providerDefinition } from './providerDefinition.js'
import { CustomHttpAdapter, type ProviderRequest } from '../agentFederation/customHttpAdapter.js'

export interface ExternalSecretPort extends DifySecretPort {
  putSecret?(namespace: string, key: string, value: string, subject?: string): Promise<void>
  deleteSecret?(namespace: string, key: string, subject?: string): Promise<void>
}
export interface AdministrationOptions {
  catalog: CatalogRepository; identities: IdentityRepository; secrets: ExternalSecretPort; policy: PilotPolicy
  isActive: (actor: ExternalActor) => Promise<boolean>
  members?: (orgId: string) => Promise<ExternalProviderMember[]>
  transport?: DifyPilotTransport
  httpRequest?: ProviderRequest
}
const fail = (code: string, status = 400): never => { throw new ExternalProviderError(status, code) }
export function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return fail('INVALID_ADMIN_INPUT')
  return value as Record<string, unknown>
}
function string(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return fail('INVALID_ADMIN_INPUT')
  return value.trim()
}

export class ExternalProviderAdministration {
  readonly operations: CredentialOperations
  constructor(readonly store: ExternalTaskStore, readonly options: AdministrationOptions) { this.operations = new CredentialOperations(store, options) }
  get credentialStorageAvailable(): boolean { return Boolean(this.options.secrets.putSecret && this.options.secrets.deleteSecret) }
  get transport() { return this.options.transport ?? new DifyPilotTransport() }

  async policy(actor: ExternalActor): Promise<ExternalPilotPolicy> {
    await this.store.ready
    const row = await this.store.db.get('SELECT document FROM external_pilot_policy WHERE org_id = ?', [actor.orgId])
    return row ? JSON.parse(String(row.document)) : { enabled: this.options.policy.orgIds.includes(actor.orgId), endpoints: this.options.policy.endpoints, revision: 0 }
  }
  async lockPolicy(actor: ExternalActor): Promise<void> {
    const initial = await this.policy(actor)
    await this.store.db.run('INSERT INTO external_pilot_policy(org_id, document) VALUES (?, ?) ON CONFLICT(org_id) DO NOTHING', [actor.orgId, JSON.stringify(initial)])
    await this.store.db.run('UPDATE external_pilot_policy SET document = document WHERE org_id = ?', [actor.orgId])
  }
  async effectivePolicy(actor: ExternalActor): Promise<PilotPolicy> {
    const policy = await this.policy(actor)
    return { orgIds: policy.enabled ? [actor.orgId] : [], endpoints: policy.endpoints, timeoutMs: this.options.policy.timeoutMs }
  }
  async setPolicy(actor: ExternalActor, input: unknown): Promise<ExternalPilotPolicy> {
    const body = object(input, ['enabled', 'endpoints', 'revision'])
    if (typeof body.enabled !== 'boolean' || !Number.isInteger(body.revision) || !Array.isArray(body.endpoints) || body.endpoints.length > 20 || body.endpoints.some(value => typeof value !== 'string')) return fail('INVALID_POLICY')
    const endpoints = [...new Set(body.endpoints.map(value => canonicalEndpoint(value as string)))]
    if (body.enabled && !endpoints.length) return fail('ENDPOINT_REQUIRED')
    await this.store.ready
    return this.store.db.transaction(async () => {
      await this.lockPolicy(actor)
      const current = await this.policy(actor)
      if (current.revision !== body.revision) return fail('CONFIGURATION_CHANGED', 409)
      const next = { enabled: body.enabled as boolean, endpoints, revision: current.revision + 1 }
      const changed = await this.store.db.run('UPDATE external_pilot_policy SET document = ? WHERE org_id = ? AND document = ?', [JSON.stringify(next), actor.orgId, JSON.stringify(current)])
      if (!changed) return fail('CONFIGURATION_CHANGED', 409)
      await this.audit(actor, 'policy.updated', actor.orgId)
      return next
    })
  }
  async members(actor: ExternalActor): Promise<ExternalProviderMember[]> { return this.options.members?.(actor.orgId) ?? [] }
  async list(actor: ExternalActor): Promise<ExternalAgentAdmin[]> { return (await this.store.bindings(actor)).filter(binding => !binding.archived).map(binding => this.describe(binding)) }

  async inspect(actor: ExternalActor, input: unknown) {
    const body = object(input, ['endpoint', 'api_key', 'provider_kind', 'source_definition'])
    const endpoint = canonicalEndpoint(string(body.endpoint, 1024)), key = string(body.api_key, 1024)
    assertPilot(await this.effectivePolicy(actor), actor.orgId, endpoint)
    try {
      if (body.provider_kind === 'custom_http') {
        const source = providerDefinition(body.provider_kind, body.source_definition)
        return await new CustomHttpAdapter({ manifest: source.sourceManifest!, digest: source.source_digest }, this.options.httpRequest).inspect(endpoint, key, AbortSignal.timeout(10000))
      }
      if (body.provider_kind !== undefined && body.provider_kind !== 'dify') return fail('PROVIDER_NOT_IMPLEMENTED')
      return await this.transport.inspect(endpoint, key, AbortSignal.timeout(10000))
    }
    catch (error) { if (error instanceof ExternalProviderError) throw error; return fail('PROVIDER_PREFLIGHT_FAILED', 502) }
  }

  async onboard(actor: ExternalActor, input: unknown): Promise<ExternalAgentAdmin> {
    if (!this.credentialStorageAvailable) return fail('CREDENTIAL_STORAGE_UNAVAILABLE', 503)
    const body = object(input, ['provider_kind', 'request_id', 'name', 'endpoint', 'api_key', 'app_id', 'workspace_id', 'source_definition', 'decoder', 'allowed_user_ids', 'review_days', 'review_note'])
    const apiKey = string(body.api_key, 1024)
    const requestId = string(body.request_id)
    if (!/^[a-f\d]{8}-[a-f\d-]{27,36}$/i.test(requestId)) return fail('INVALID_REQUEST_ID')
    const source = providerDefinition(body.provider_kind, body.source_definition, body.app_id as string)
    const source_digest = source.source_digest
    const id = randomUUID(), operationId = randomUUID(), namespace = `org:${actor.orgId}:external:${operationId}`, credential_ref = `nexus://${namespace}/app-key`
    const definition = await this.definition(actor, { ...body, source_digest, credential_ref })
    const { review_expires_at: _expiry, credential_ref: _ref, ...stableDefinition } = definition
    const credentialFingerprint = digest(JSON.stringify([actor.orgId, requestId, apiKey]))
    const hash = digest(JSON.stringify({ ...stableDefinition, review_days: body.review_days, credentialFingerprint }))
    const binding: Binding = { ...definition, ...source, id, orgId: actor.orgId, connectionId: randomUUID(), approved: false, parametersDigest: null, reviewedBy: null, revision: 1, definitionProfileVersion: DEFINITION_PROFILE_VERSION, registrationMode: 'onboarding' }
    const operation: CredentialOperation = { id: operationId, actor, kind: 'onboard', binding, targetRef: credential_ref }
    if (!await this.operations.reserve(operation, requestId, hash)) {
      const existing = await this.store.db.get('SELECT * FROM external_pilot_operations WHERE org_id = ? AND kind = ? AND request_id = ?', [actor.orgId, 'onboard', requestId])
      if (!existing) return fail('REGISTRATION_IN_PROGRESS', 409)
      const original = JSON.parse(String(existing.document)) as CredentialOperation
      // Pre-fingerprint requests cannot prove credential equality; fail closed.
      if (existing.request_hash !== hash) return fail('IDEMPOTENCY_CONFLICT', 409)
      if (existing.status !== 'complete') return fail('REGISTRATION_IN_PROGRESS', 409)
      return this.describe(await this.store.binding(actor, original.binding.id))
    }
    let writeStarted = false
    try {
      await this.inspect(actor, { endpoint: definition.endpoint, api_key: body.api_key, provider_kind: body.provider_kind, source_definition: body.source_definition })
      writeStarted = true
      await this.options.secrets.putSecret!(namespace, 'app-key', apiKey, `org:${actor.orgId}`)
      await this.operations.confirmWrite(operation)
      return this.describe(await this.operations.finish(operation))
    } catch (error) {
      // A rejected preflight never started a remote write, so it needs no indefinite guard.
      if (!writeStarted) await this.operations.confirmWrite(operation)
      await this.operations.abandon(operation)
      if (error instanceof ExternalProviderError) throw error
      return fail('REGISTRATION_FAILED', 503)
    }
  }

  async update(actor: ExternalActor, id: string, input: unknown): Promise<ExternalAgentAdmin> {
    const body = object(input, ['revision', 'name', 'decoder', 'allowed_user_ids', 'review_days', 'review_note', 'source_definition'])
    const binding = await this.store.binding(actor, id)
    const source = body.source_definition === undefined ? undefined : providerDefinition(binding.provider_kind, body.source_definition, binding.app_id)
    const source_digest = source?.source_digest ?? binding.source_digest
    if (body.source_definition === undefined && binding.definitionProfileVersion !== DEFINITION_PROFILE_VERSION) return fail('DEFINITION_REVIEW_REQUIRED', 409)
    const definition = await this.definition(actor, { ...binding, ...body, source_digest })
    return this.change(actor, id, Number(body.revision), 'agent.updated', async current => {
      Object.assign(current, definition, source, { approved: false, parametersDigest: null, reviewedBy: null, definitionProfileVersion: DEFINITION_PROFILE_VERSION })
      const catalog = await this.options.catalog.getAgent(id, actor.orgId)
      await this.options.catalog.updateAgentConfiguration(id, actor.orgId, { name: current.name, visibleTo: { user_ids: current.allowed_user_ids }, status: 'pending', enabled: false, providerBinding: { ...catalog?.providerBinding, sourceDigest: current.source_digest } })
    })
  }

  async parameters(binding: Binding, key: string, signal: AbortSignal): Promise<string> {
    if (binding.provider_kind !== 'custom_http') return this.transport.parameters(binding.endpoint, key, signal)
    if (!binding.sourceManifest) return fail('DEFINITION_REVIEW_REQUIRED', 409)
    const inspected = await new CustomHttpAdapter({ manifest: binding.sourceManifest, digest: binding.source_digest }, this.options.httpRequest).inspect(binding.endpoint, key, signal)
    return inspected.parameters_digest
  }

  async rotate(actor: ExternalActor, id: string, input: unknown): Promise<ExternalAgentAdmin> {
    const body = object(input, ['revision', 'api_key'])
    if (!this.credentialStorageAvailable) return fail('CREDENTIAL_STORAGE_UNAVAILABLE', 503)
    const binding = await this.store.binding(actor, id)
    await this.inspect(actor, { endpoint: binding.endpoint, api_key: body.api_key, provider_kind: binding.provider_kind, source_definition: binding.sourceManifest ? JSON.stringify(binding.sourceManifest) : undefined })
    const operationId = randomUUID(), targetRef = `nexus://org:${actor.orgId}:external:${operationId}/app-key`
    const operation: CredentialOperation = { id: operationId, actor, kind: 'rotate', binding, targetRef, previousRef: binding.credential_ref }
    await this.change(actor, id, Number(body.revision), 'credential.rotation_requested', async current => {
      current.approved = false; current.parametersDigest = null; current.credentialUpdating = true; current.credentialOperationId = operationId
      await this.operations.reserve(operation, operationId, '')
      await this.options.catalog.updateAgentConfiguration(id, actor.orgId, { status: 'pending', enabled: false })
    })
    const ref = parseNexusSecretRef(targetRef)
    try {
      await this.options.secrets.putSecret!(ref.namespace, ref.key, string(body.api_key, 1024), `org:${actor.orgId}`)
      await this.operations.confirmWrite(operation)
      return this.describe(await this.operations.finish(operation))
    } catch (error) {
      await this.operations.abandon(operation)
      if (error instanceof ExternalProviderError) throw error
      return fail('CREDENTIAL_ROTATION_FAILED', 503)
    }
  }

  async testSaved(actor: ExternalActor, id: string) {
    const binding = await this.store.binding(actor, id)
    await this.assertCredentialUsable(actor, binding)
    const ref = parseNexusSecretRef(binding.credential_ref)
    const secret = await this.options.secrets.getSecret(ref.namespace, ref.key, `org:${actor.orgId}`)
    if (!secret?.value || secret.status !== 'enabled') return fail('CREDENTIAL_UNAVAILABLE', 503)
    // Recheck after the asynchronous vault read. A revoke/rotation wins before dispatch.
    await this.store.db.transaction(async () => {
      await this.store.db.run('UPDATE external_pilot_bindings SET document = document WHERE id = ? AND org_id = ?', [id, actor.orgId])
      const current = await this.store.binding(actor, id)
      if (JSON.stringify(current) !== JSON.stringify(binding)) return fail('CONFIGURATION_CHANGED', 409)
      await this.assertCredentialUsable(actor, current)
    })
    return this.inspect(actor, { endpoint: binding.endpoint, api_key: secret.value, provider_kind: binding.provider_kind, source_definition: binding.sourceManifest ? JSON.stringify(binding.sourceManifest) : undefined })
  }

  async assertCredentialUsable(actor: ExternalActor, binding: Binding): Promise<void> {
    if (binding.archived) return fail('AGENT_ARCHIVED', 409)
    if (binding.credentialUpdating) return fail('CREDENTIAL_UPDATE_IN_PROGRESS', 409)
    if (binding.credentialRecoveryRequired) return fail('CREDENTIAL_ROTATION_REQUIRED', 409)
    const connection = await this.options.identities.getIntegrationConnection(binding.connectionId)
    if (!connection?.enabled || connection.orgId !== actor.orgId || connection.providerType !== (binding.provider_kind ?? 'dify') || connection.secretRef !== binding.credential_ref || connection.config.baseUrl !== binding.endpoint || connection.config.tenantId !== binding.workspace_id || connection.config.executionMode !== 'external_hosted') return fail('CONNECTION_DISABLED_OR_CHANGED', 403)
  }

  async archive(actor: ExternalActor, id: string, input: unknown) {
    const body = object(input, ['revision'])
    return this.change(actor, id, Number(body.revision), 'agent.archived', async current => {
      current.archived = true; current.approved = false; current.parametersDigest = null
      const connection = await this.options.identities.getIntegrationConnection(current.connectionId)
      if (connection) await this.options.identities.putIntegrationConnection({ ...connection, enabled: false })
      await this.operations.queueCleanup(actor, current.credential_ref)
      await this.options.catalog.updateAgentConfiguration(id, actor.orgId, { enabled: false, status: 'pending' })
    })
  }

  async change(actor: ExternalActor, id: string, revision: number, action: string, update: (binding: Binding) => Promise<void>) {
    await this.store.ready
    return this.store.db.transaction(async () => {
      await this.store.db.run('UPDATE external_pilot_bindings SET document = document WHERE id = ? AND org_id = ?', [id, actor.orgId])
      const current = await this.store.binding(actor, id)
      if (current.archived || (current.revision ?? 1) !== revision) return fail('CONFIGURATION_CHANGED', 409)
      if (current.credentialUpdating && action !== 'credential.rotation_finished') return fail('CREDENTIAL_UPDATE_IN_PROGRESS', 409)
      await update(current)
      current.revision = revision + 1
      await this.store.saveBinding(current)
      await this.audit(actor, action, id)
      return this.describe(current)
    })
  }

  async audit(actor: ExternalActor, action: string, id: string) {
    await this.store.db.run('INSERT INTO external_pilot_admin_audit(id, org_id, user_id, action, resource_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [randomUUID(), actor.orgId, actor.userId, action, id, Date.now()])
  }
  describe(binding: Binding): ExternalAgentAdmin {
    return { id: binding.id, name: binding.name, provider: binding.provider_kind ?? 'dify', execution_mode: 'external_hosted', profile: 'synthetic_pilot', source_digest: binding.source_digest, decoder: binding.decoder, approved: binding.approved, review_expires_at: binding.review_expires_at, capabilities: { streaming: binding.provider_kind === 'custom_http' ? 'unsupported' : 'supported', cancel: 'unsupported', resume: 'unsupported', version_pin: 'unsupported' }, endpoint: binding.endpoint, app_id: binding.app_id, workspace_id: binding.workspace_id, allowed_user_ids: binding.allowed_user_ids, review_note: binding.review_note, revision: binding.revision ?? 1, archived: binding.archived ?? false, credential_configured: Boolean(binding.credential_ref), credential_state: binding.credentialUpdating ? 'updating' : binding.credentialRecoveryRequired ? 'rotation_required' : 'ready', registration_mode: binding.registrationMode ?? 'reference_compat', definition_evidence: binding.definitionProfileVersion === DEFINITION_PROFILE_VERSION ? binding.provider_kind === 'custom_http' ? 'validated_manifest' : 'validated_dsl' : 'digest_only' }
  }
  private async definition(actor: ExternalActor, body: Record<string, unknown>) {
    if (![1, 3, 7].includes(Number(body.review_days))) return fail('INVALID_REVIEW_DAYS')
    const definition = parseRegistration({ ...(body.provider_kind ? { provider_kind: body.provider_kind } : {}), name: body.name, endpoint: body.endpoint, app_id: body.app_id, workspace_id: body.workspace_id, credential_ref: body.credential_ref, source_digest: body.source_digest, decoder: body.decoder, allowed_user_ids: body.allowed_user_ids, review_expires_at: Date.now() + Number(body.review_days) * 86400_000, review_note: body.review_note }, actor.orgId, await this.effectivePolicy(actor))
    for (const userId of definition.allowed_user_ids) if (!await this.options.isActive({ orgId: actor.orgId, userId })) return fail('INVALID_MEMBER')
    return definition
  }
}
