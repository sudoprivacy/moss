import type { AuthCenterDb } from '../authCenter/db.js'
import type { CatalogRepository } from '../catalog/catalogRepository.js'
import type { IdentityActor } from '../identity/organizationIdentityService.js'
import type { IdentityRepository, IntegrationConnection } from '../identity/identityRepository.js'
import { isVisibleTo, type VisibilityFilter } from '../visibilityFilter.js'

export interface DifySecretPort {
  getSecret(namespace: string, key: string, subject?: string): Promise<{
    value: string | null
    status: string
    version: number
  } | null>
}

export interface DifyRuntimeContext {
  orgId: string
  userId: string
  legacyEnterpriseId: number
  legacyUserId: number
  endUserId: string
  connectionId: string
  tenantId: string
  systemAccountId: string | null
  appId: string
  mode: string
  apiKey: string
  baseUrl: string | null
}

export interface DifyEnhancementContext extends Omit<DifyRuntimeContext, 'appId' | 'mode'> {
  appId: string | null
  mode: 'agent-chat' | 'workflow' | 'rag-only' | null
  appApiKey: string | null
  datasetIds: string[]
}

export interface DifyOrganizationContext {
  orgId: string
  connectionId: string
  tenantId: string
  systemAccountId: string | null
  apiKey: string
  baseUrl: string | null
}

export class DifyDomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DifyDomainError'
  }
}

export function parseNexusSecretRef(reference: string): { namespace: string; key: string } {
  const prefix = 'nexus://'
  if (!reference.startsWith(prefix)) throw new Error('Dify credential must use a Nexus secret reference')
  const value = reference.slice(prefix.length)
  const separator = value.lastIndexOf('/')
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('Invalid Nexus secret reference')
  }
  return { namespace: value.slice(0, separator), key: value.slice(separator + 1) }
}

export class DifyConnectionService {
  constructor(private readonly options: {
    auth: AuthCenterDb
    identities: IdentityRepository
    catalog: CatalogRepository
    secrets: DifySecretPort
  }) {}

  getConnection(orgId: string, connectionId: string): IntegrationConnection {
    const connection = this.options.identities.getIntegrationConnection(connectionId)
    if (!connection || connection.orgId !== orgId || connection.providerType !== 'dify' || !connection.enabled) {
      throw new DifyDomainError(404, 'CONNECTION_NOT_FOUND', 'agent binding missing')
    }
    return connection
  }

  async resolveOrganizationContext(orgId: string): Promise<DifyOrganizationContext> {
    const enabled = this.options.identities.listIntegrationConnections(orgId, 'dify')
      .filter(connection => connection.enabled)
    const defaults = enabled.filter(connection => connection.config.isDefault === true)
    const selected = enabled.length === 1 ? enabled[0] : defaults.length === 1 ? defaults[0] : null
    if (!selected) {
      throw new DifyDomainError(
        enabled.length === 0 ? 404 : 409,
        enabled.length === 0 ? 'CONNECTION_NOT_FOUND' : 'CONNECTION_AMBIGUOUS',
        enabled.length === 0 ? 'agent binding missing' : 'multiple Dify connections require one default',
      )
    }
    if (!selected.secretRef) throw new DifyDomainError(502, 'SECRET_NOT_CONFIGURED', 'Dify API key not configured')
    const tenantId = configString(selected.config, 'tenantId')
    if (!tenantId) throw new DifyDomainError(404, 'TENANT_BINDING_MISSING', 'agent binding missing')
    return {
      orgId,
      connectionId: selected.id,
      tenantId,
      systemAccountId: configString(selected.config, 'systemAccountId') || null,
      apiKey: await this.readSecret(selected.secretRef, orgId, 'Dify API key'),
      baseUrl: configString(selected.config, 'baseUrl') || null,
    }
  }

  describeEnhancement(
    actor: IdentityActor,
    assistantId: string,
    visibility: VisibilityFilter,
  ): { enabled: boolean; mode: 'agent-chat' | 'workflow' | 'rag-only' | null } {
    const user = this.options.auth.getUserByIdAndOrg(actor.userId, actor.orgId)
    if (!user || user.status !== 'active') throw new DifyDomainError(401, 'USER_NOT_ACTIVE', 'unauthorized')
    const agent = this.options.catalog.findAgent(assistantId)
    const available = agent && this.options.catalog.isAvailableToOrganization('agent', assistantId, actor.orgId)
    const visible = agent && agent.enabled && agent.status === 'approved' && isVisibleTo(agent.visibleTo, visibility)
    if (!available || !visible) throw new DifyDomainError(403, 'AGENT_NOT_VISIBLE', 'agent not visible to user')
    if (agent.providerType !== 'dify' || !agent.providerBinding) return { enabled: false, mode: null }
    const appId = requiredBindingString(agent.providerBinding, 'appId')
    if (appId) {
      return { enabled: true, mode: requiredBindingString(agent.providerBinding, 'mode') === 'workflow' ? 'workflow' : 'agent-chat' }
    }
    if (stringArray(agent.providerBinding.datasetIds).length > 0) return { enabled: true, mode: 'rag-only' }
    return { enabled: false, mode: null }
  }

  async resolveRuntimeContext(
    actor: IdentityActor,
    assistantId: string,
    visibility: VisibilityFilter,
  ): Promise<DifyRuntimeContext> {
    const resolved = await this.resolveBaseContext(actor, assistantId, visibility)
    const appId = requiredBindingString(resolved.binding, 'appId')
    if (!appId) throw new DifyDomainError(404, 'AGENT_BINDING_MISSING', 'agent binding missing')
    return {
      ...resolved.context,
      appId,
      mode: requiredBindingString(resolved.binding, 'mode') || 'agent-chat',
    }
  }

  async resolveEnhancementContext(
    actor: IdentityActor,
    assistantId: string,
    visibility: VisibilityFilter,
  ): Promise<DifyEnhancementContext> {
    const resolved = await this.resolveBaseContext(actor, assistantId, visibility)
    const appId = requiredBindingString(resolved.binding, 'appId') || null
    const datasetIds = stringArray(resolved.binding.datasetIds)
    const rawMode = requiredBindingString(resolved.binding, 'mode')
    const mode = appId
      ? (rawMode === 'workflow' ? 'workflow' : 'agent-chat')
      : datasetIds.length > 0 ? 'rag-only' : null
    const appSecretRef = requiredBindingString(resolved.binding, 'appSecretRef')
    const appApiKey = appId
      ? await this.readSecret(appSecretRef, actor.orgId, 'Dify App API key')
      : null
    return { ...resolved.context, appId, mode, appApiKey, datasetIds }
  }

  private async resolveBaseContext(
    actor: IdentityActor,
    assistantId: string,
    visibility: VisibilityFilter,
  ): Promise<{
    context: Omit<DifyRuntimeContext, 'appId' | 'mode'>
    binding: Record<string, unknown>
  }> {
    const user = this.options.auth.getUserByIdAndOrg(actor.userId, actor.orgId)
    if (!user || user.status !== 'active') {
      throw new DifyDomainError(401, 'USER_NOT_ACTIVE', 'unauthorized')
    }

    const agent = this.options.catalog.findAgent(assistantId)
    const available = agent && this.options.catalog.isAvailableToOrganization('agent', assistantId, actor.orgId)
    const visible = agent && agent.enabled && agent.status === 'approved' && isVisibleTo(agent.visibleTo, visibility)
    if (!available || !visible) {
      throw new DifyDomainError(403, 'AGENT_NOT_VISIBLE', 'agent not visible to user')
    }
    if (agent.providerType !== 'dify' || !agent.providerBinding) {
      throw new DifyDomainError(404, 'AGENT_BINDING_MISSING', 'agent binding missing')
    }

    const legacyEnterpriseId = this.options.identities.getNumericAlias('enterprise', actor.orgId)
    const legacyUserId = this.options.identities.getNumericAlias('user', actor.userId)
    if (legacyEnterpriseId === null || legacyUserId === null) {
      throw new DifyDomainError(500, 'LEGACY_ALIAS_MISSING', 'Dify legacy identity alias missing')
    }

    const binding = agent.providerBinding
    const connectionId = connectionIdForOrg(binding, actor.orgId)
    if (!connectionId) {
      throw new DifyDomainError(404, 'AGENT_BINDING_MISSING', 'agent binding missing')
    }
    const connection = this.getConnection(actor.orgId, connectionId)
    if (!connection.secretRef) {
      throw new DifyDomainError(502, 'SECRET_NOT_CONFIGURED', 'Dify API key not configured')
    }

    const apiKey = await this.readSecret(connection.secretRef, actor.orgId, 'Dify API key')

    const tenantId = configString(connection.config, 'tenantId') || requiredBindingString(binding, 'tenantId')
    if (!tenantId) throw new DifyDomainError(404, 'TENANT_BINDING_MISSING', 'agent binding missing')
    return { context: {
      orgId: actor.orgId,
      userId: actor.userId,
      legacyEnterpriseId,
      legacyUserId,
      endUserId: `sudowork:${legacyEnterpriseId}:${legacyUserId}`,
      connectionId,
      tenantId,
      systemAccountId: configString(connection.config, 'systemAccountId') || null,
      apiKey,
      baseUrl: configString(connection.config, 'baseUrl') || null,
    }, binding }
  }

  private async readSecret(referenceValue: string, orgId: string, label: string): Promise<string> {
    if (!referenceValue) throw new DifyDomainError(502, 'SECRET_NOT_CONFIGURED', `${label} not configured`)
    let reference: { namespace: string; key: string }
    try {
      reference = parseNexusSecretRef(referenceValue)
    } catch {
      throw new DifyDomainError(502, 'SECRET_REFERENCE_INVALID', `${label} reference is invalid`)
    }
    let secret: Awaited<ReturnType<DifySecretPort['getSecret']>>
    try {
      secret = await this.options.secrets.getSecret(reference.namespace, reference.key, `org:${orgId}`)
    } catch {
      throw new DifyDomainError(502, 'SECRET_LOOKUP_FAILED', `${label} lookup failed`)
    }
    if (!secret?.value || secret.status !== 'enabled') {
      throw new DifyDomainError(502, 'SECRET_NOT_AVAILABLE', `${label} is unavailable`)
    }
    return secret.value
  }
}

function requiredBindingString(binding: Record<string, unknown>, key: string): string {
  const value = binding[key]
  return typeof value === 'string' ? value.trim() : ''
}

function configString(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value.trim() : ''
}

function connectionIdForOrg(binding: Record<string, unknown>, orgId: string): string {
  const byOrg = binding.connectionIdByOrg
  if (byOrg && typeof byOrg === 'object' && !Array.isArray(byOrg)) {
    const value = (byOrg as Record<string, unknown>)[orgId]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return requiredBindingString(binding, 'connectionId')
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))]
    : []
}
