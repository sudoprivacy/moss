import { createHash, randomUUID } from 'node:crypto'
import { sign } from 'hono/jwt'
import JSZip from 'jszip'
import { assertTrustedCommandContext, onlineCommandContext, type CommandContext } from '../application/commandContext.js'
import type { AuthCenterDb } from '../authCenter/db.js'
import type { CatalogAgent, CatalogRepository } from '../catalog/catalogRepository.js'
import type { CatalogService } from '../catalog/catalogService.js'
import type { CatalogArtifactPort } from '../catalog/catalogUploadService.js'
import type { IdentityRepository, IntegrationConnection } from '../identity/identityRepository.js'
import type { IdentityActor } from '../identity/organizationIdentityService.js'
import type { DbDriver } from '../db/driver.js'
import type { VisibleTo } from '../visibilityFilter.js'
import { DifyProviderError, type DifyHttpAdapter } from './difyHttpAdapter.js'
import type { DifyProviderOperation, DifyRepository } from './difyRepository.js'

export interface DifyAdministrationSecretPort {
  putSecret(namespace: string, key: string, value: string, subject?: string): Promise<void>
  deleteSecret(namespace: string, key: string, subject?: string): Promise<void>
}

export type DifyAclEntry = {
  subjectType: 'user' | 'department' | 'role' | 'all'
  subjectId: string | null
}

export interface DifyAgentSummary {
  assistantId: string
  enterpriseId: number | null
  difyTenantId: string
  difyAppId: string
  difyAppMode: string
  createdAt: number
  updatedAt: number
}

export class DifyAdministrationService {
  private readonly idFactory: () => string

  constructor(private readonly options: {
    db: DbDriver
    auth: AuthCenterDb
    identities: IdentityRepository
    catalog: CatalogRepository
    difyRepository: DifyRepository
    catalogService: CatalogService
    adapter: DifyHttpAdapter
    secrets: DifyAdministrationSecretPort
    artifacts?: CatalogArtifactPort
    publicBaseUrl?: string
    ssoSecret?: string
    difyBaseUrl?: string
    clock?: () => number
    idFactory?: () => string
  }) {
    this.idFactory = options.idFactory ?? randomUUID
  }

  async buildSsoLink(input: {
    actor: IdentityActor
    orgId: string
    next?: string
  }): Promise<{ url: string; expiresAt: number }> {
    if (input.actor.role !== 'super_admin' && input.actor.orgId !== input.orgId) {
      throw new Error('cannot operate on another enterprise')
    }
    const secret = this.options.ssoSecret?.trim()
    if (!secret) throw new Error('DIFY_SSO_SECRET not configured: cannot mint SSO tokens')
    const binding = await this.provision(input.orgId, onlineCommandContext(`dify:sso:provision:${input.orgId}`))
    if ('suppressed' in binding) throw new Error('Dify provisioning suppressed')
    const profile = await this.options.identities.getOrganizationProfile(input.orgId)
    const user = await this.options.auth.getUserByIdAndOrg(input.actor.userId, input.actor.orgId)
    const legacyUserId = await this.options.identities.getNumericAlias('user', input.actor.userId)
    if (!profile || !user || legacyUserId === null) throw new Error('Dify SSO identity is incomplete')
    const nowSeconds = Math.floor((this.options.clock?.() ?? Date.now()) / 1000)
    const expiresAt = nowSeconds + 300
    const token = await sign({
      sub: String(legacyUserId),
      email: user.email || undefined,
      name: user.name,
      enterprise_code: profile.code,
      dify_tenant_id: binding.dify_tenant_id,
      role: 'admin',
      iat: nowSeconds,
      exp: expiresAt,
      jti: randomUUID(),
    }, secret, 'HS256')
    const baseUrl = (this.options.difyBaseUrl ?? '').replace(/\/+$/, '')
    if (!baseUrl) throw new Error('DIFY_BASE_URL not configured: cannot build SSO URL')
    const next = input.next ? `&next=${encodeURIComponent(input.next)}` : ''
    return {
      url: `${baseUrl}/sudowork/sso/exchange?token=${encodeURIComponent(token)}${next}`,
      expiresAt,
    }
  }

  async getBinding(orgId: string): Promise<{
    dify_tenant_id: string
    dify_system_account_id: string | null
    created_at: number | null
  } | null> {
    const connection = await this.defaultConnection(orgId)
    if (!connection) return null
    return {
      dify_tenant_id: configString(connection, 'tenantId'),
      dify_system_account_id: configString(connection, 'systemAccountId') || null,
      created_at: configNumber(connection, 'createdAt'),
    }
  }

  async provision(orgId: string, context: CommandContext): Promise<{
    dify_tenant_id: string
    dify_system_account_id: string | null
  } | { suppressed: true }> {
    assertTrustedCommandContext(context)
    const existing = await this.defaultConnection(orgId)
    if (existing) return connectionDto(existing)
    const organization = await this.options.auth.getOrganization(orgId)
    const profile = await this.options.identities.getOrganizationProfile(orgId)
    if (!organization || !profile) throw new Error(`enterprise ${orgId} not found`)

    const operation = await this.prepareOperation({
      orgId,
      operationType: 'tenant.provision',
      aggregateId: orgId,
      context,
      request: { enterpriseCode: profile.code, enterpriseName: organization.name },
    })
    if (!operation.created) {
      if (operation.operation.status === 'SUPPRESSED') return { suppressed: true }
      throw operationReplayError(operation.operation)
    }
    if (operation.operation.status === 'SUPPRESSED') return { suppressed: true }
    const namespace = secretNamespace(orgId)
    const key = 'service-api-key'
    let externalSucceeded = false
    try {
      const provisioned = await this.options.adapter.provisionTenant({
        enterpriseCode: profile.code,
        enterpriseName: organization.name,
      })
      externalSucceeded = true
      await this.options.secrets.putSecret(namespace, key, provisioned.service_api_key, `org:${orgId}`)
      await this.options.db.transaction(async () => {
        await this.options.identities.putIntegrationConnection({
          id: connectionId(orgId), orgId, providerType: 'dify', name: 'Dify', enabled: true,
          secretRef: secretReference(namespace, key),
          config: {
            tenantId: provisioned.dify_tenant_id,
            systemAccountId: provisioned.system_account_id || null,
            isDefault: true,
            createdAt: Math.floor((this.options.clock?.() ?? Date.now()) / 1000),
          },
        })
        await this.options.difyRepository.updateOperation(operation.operation.id, {
          status: 'SUCCEEDED',
          result: {
            tenantId: provisioned.dify_tenant_id,
            systemAccountId: provisioned.system_account_id || null,
          },
          errorMessage: null,
        })
      })
      return {
        dify_tenant_id: provisioned.dify_tenant_id,
        dify_system_account_id: provisioned.system_account_id || null,
      }
    } catch (error) {
      await this.options.secrets.deleteSecret(namespace, key, `org:${orgId}`).catch(() => undefined)
      await this.markOperationFailed(
        operation.operation,
        error,
        externalSucceeded || !(error instanceof DifyProviderError),
      )
      throw error
    }
  }

  async createAgent(input: {
    actor: IdentityActor
    orgId: string
    assistantId?: string
    name: string
    description?: string
    mode?: string
    icon?: string
    iconType?: string
    iconBackground?: string
  }, context: CommandContext): Promise<DifyAgentSummary | { suppressed: true }> {
    assertTrustedCommandContext(context)
    const request = {
      orgId: input.orgId,
      assistantId: input.assistantId ?? null,
      name: input.name,
      description: input.description ?? null,
      mode: input.mode ?? 'agent-chat',
      icon: input.icon ?? null,
      iconType: input.iconType ?? null,
      iconBackground: input.iconBackground ?? null,
    }
    const operation = await this.prepareOperation({
      orgId: input.orgId,
      operationType: 'app.create',
      aggregateId: input.assistantId ?? context.idempotencyKey,
      context,
      request,
    })
    if (!operation.created) {
      if (operation.operation.status === 'SUPPRESSED') return { suppressed: true }
      if (operation.operation.status === 'SUCCEEDED') {
        const assistantId = stringValue(operation.operation.result?.assistantId)
        const existing = assistantId ? await this.options.catalog.getAgent(assistantId, input.orgId) : null
        if (existing) return this.agentSummary(existing)
      }
      throw operationReplayError(operation.operation)
    }
    if (operation.operation.status === 'SUPPRESSED') return { suppressed: true }
    const namespace = secretNamespace(input.orgId)
    let key: string | null = null
    let appId: string | null = null
    let tenantId: string | null = null
    let externalSucceeded = false
    try {
      const provisioned = await this.provision(
        input.orgId, onlineCommandContext(`${context.idempotencyKey}:provision`),
      )
      if ('suppressed' in provisioned) return provisioned
      tenantId = provisioned.dify_tenant_id
      const connection = await this.requireConnection(input.orgId)
      const created = objectValue(await this.options.adapter.systemJson(
        tenantId,
        'POST',
        '/sudowork/system/apps',
        {
          name: input.name,
          ...(input.description !== undefined ? { description: input.description } : {}),
          mode: input.mode ?? 'agent-chat',
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          ...(input.iconType !== undefined ? { icon_type: input.iconType } : {}),
          ...(input.iconBackground !== undefined ? { icon_background: input.iconBackground } : {}),
        },
        connection.config.systemAccountId as string | undefined,
      ))
      externalSucceeded = true
      appId = requiredString(created.app_id, 'Dify app id')
      const appKey = requiredString(created.app_api_key, 'Dify app API key')
      const mode = stringValue(created.mode) || input.mode || 'agent-chat'
      key = `apps/${appId}-api-key`
      await this.options.secrets.putSecret(namespace, key, appKey, `org:${input.orgId}`)
      const catalogAgent = await this.options.db.transaction(async () => {
        const result = await this.options.catalogService.createAgent({
          actor: input.actor, orgId: input.orgId, id: input.assistantId ?? this.idFactory(),
          name: input.name, displayName: input.name, description: input.description,
          providerType: 'dify', supportedModes: 'both',
          providerBinding: {
            connectionId: connection.id, tenantId,
            appId, mode, appSecretRef: secretReference(namespace, key!), datasetIds: [],
          },
          externalIdentity: { providerType: 'dify', providerId: connection.id, externalId: appId! },
        }, context)
        await this.options.difyRepository.updateOperation(operation.operation.id, {
          status: 'SUCCEEDED', result: { assistantId: result.id, appId }, errorMessage: null,
        })
        return result
      })
      return this.agentSummary(catalogAgent)
    } catch (error) {
      let compensated = !externalSucceeded
      if (key) await this.options.secrets.deleteSecret(namespace, key, `org:${input.orgId}`).catch(() => undefined)
      if (tenantId && appId) {
        compensated = await this.options.adapter.systemJson(
          tenantId, 'DELETE', `/sudowork/system/apps/${encodeURIComponent(appId)}`,
        ).then(() => true, () => false)
      }
      await this.markOperationFailed(
        operation.operation,
        error,
        externalSucceeded ? !compensated : !(error instanceof DifyProviderError),
      )
      throw error
    }
  }

  async deleteAgent(orgId: string, assistantId: string, context: CommandContext): Promise<void> {
    assertTrustedCommandContext(context)
    const operation = await this.prepareOperation({
      orgId,
      operationType: 'app.delete',
      aggregateId: assistantId,
      context,
      request: { assistantId },
    })
    if (!operation.created) {
      if (operation.operation.status === 'SUPPRESSED' || operation.operation.status === 'SUCCEEDED') return
      throw operationReplayError(operation.operation)
    }
    if (operation.operation.status === 'SUPPRESSED') return
    const agent = await this.requireAgent(orgId, assistantId)
    const binding = agent.providerBinding ?? {}
    const appId = stringValue(binding.appId)
    const tenantId = stringValue(binding.tenantId)
    let externalAttempted = false
    let externalCompleted = false
    try {
      if (appId && tenantId) {
        externalAttempted = true
        await this.options.adapter.systemJson(
          tenantId, 'DELETE', `/sudowork/system/apps/${encodeURIComponent(appId)}`,
        )
        externalCompleted = true
        const ref = parseSecretReference(stringValue(binding.appSecretRef))
        if (ref) await this.options.secrets.deleteSecret(ref.namespace, ref.key, `org:${orgId}`)
      }
      await this.options.db.transaction(async () => {
        await this.options.catalogService.deleteAgent({ userId: 'system', orgId, role: 'super_admin' }, assistantId, orgId)
        await this.options.difyRepository.updateOperation(operation.operation.id, {
          status: 'SUCCEEDED', result: { assistantId }, errorMessage: null,
        })
      })
    } catch (error) {
      await this.markOperationFailed(
        operation.operation,
        error,
        externalCompleted || (externalAttempted && !(error instanceof DifyProviderError)),
      )
      throw error
    }
  }

  async listAgents(orgId: string): Promise<DifyAgentSummary[]> {
    const agents = (await this.options.catalog.listAgents({ orgId, includeDisabled: true })).items
      .filter(agent => agent.providerType === 'dify' && Boolean(agent.providerBinding?.appId))
    return Promise.all(agents.map(agent => this.agentSummary(agent)))
  }

  async getAgent(orgId: string, assistantId: string): Promise<DifyAgentSummary | null> {
    const agent = await this.options.catalog.getAgent(assistantId, orgId)
    return agent?.providerType === 'dify' && agent.providerBinding?.appId
      ? this.agentSummary(agent)
      : null
  }

  async listAcl(orgId: string, assistantId: string): Promise<DifyAclEntry[]> {
    const agent = await this.requireAgent(orgId, assistantId)
    const visible = agent.visibleTo
    if (!visible) return [{ subjectType: 'all', subjectId: null }]
    return [
      ...(visible.user_ids ?? []).map(subjectId => ({ subjectType: 'user' as const, subjectId })),
      ...(visible.department_ids ?? []).map(subjectId => ({ subjectType: 'department' as const, subjectId })),
      ...(visible.role_ids ?? []).map(subjectId => ({ subjectType: 'role' as const, subjectId })),
    ]
  }

  async replaceAcl(orgId: string, assistantId: string, entries: DifyAclEntry[]): Promise<DifyAclEntry[]> {
    await this.requireAgent(orgId, assistantId)
    const visibleTo: VisibleTo = entries.length === 0 || entries.some(entry => entry.subjectType === 'all')
      ? null
      : {
          user_ids: nullableSubjectIds(entries, 'user'),
          role_ids: nullableSubjectIds(entries, 'role'),
          department_ids: nullableSubjectIds(entries, 'department'),
        }
    await this.options.db.transaction(async () => {
      if (!(await this.options.catalog.updateAgentConfiguration(assistantId, orgId, { visibleTo }))) {
        throw new Error('not found')
      }
    })
    return this.listAcl(orgId, assistantId)
  }

  async listDatasets(orgId: string, assistantId: string): Promise<string[]> {
    const agent = await this.requireAgent(orgId, assistantId)
    return stringArray(agent.providerBinding?.datasetIds)
  }

  async replaceDatasets(orgId: string, assistantId: string, datasetIds: string[]): Promise<string[]> {
    const agent = await this.requireAgent(orgId, assistantId)
    const binding = agent.providerBinding ?? {}
    const current = stringArray(binding.datasetIds)
    const desired = [...new Set(datasetIds.map(value => value.trim()).filter(Boolean))]
    if ((current.length === 0) !== (desired.length === 0)) {
      throw new Error('enhancement method cannot be changed after creation')
    }
    if (binding.appId && desired.length > 0) {
      throw new Error(`assistant ${assistantId} has Dify enhancement; dataset attachment is exclusive — clear enhancement first`)
    }
    await this.options.db.transaction(async () => {
      await this.options.catalog.updateAgentConfiguration(assistantId, orgId, {
        providerBinding: { ...binding, datasetIds: desired },
      })
    })
    return desired
  }

  async listAvailableDatasets(orgId: string): Promise<unknown> {
    const provisioned = await this.provision(
      orgId,
      onlineCommandContext(`dify:datasets:auto-provision:${orgId}`),
    )
    if ('suppressed' in provisioned) throw new Error('Dify provisioning suppressed')
    const connection = await this.requireConnection(orgId)
    const response = objectValue(await this.options.adapter.systemJson(
      configString(connection, 'tenantId'), 'GET', '/sudowork/system/datasets',
    ))
    return Array.isArray(response.datasets) ? response.datasets : []
  }

  async listShareableOrganizations(): Promise<Array<{ id: number; name: string; code: string }>> {
    const items = await Promise.all((await this.options.identities.listOrganizationProfiles()).map(async profile => {
      const organization = await this.options.auth.getOrganization(profile.orgId)
      const legacyId = await this.options.identities.getNumericAlias('enterprise', profile.orgId)
      return organization && legacyId !== null
        ? [{ id: legacyId, name: organization.name, code: profile.code }]
        : []
    }))
    return items.flat()
  }

  async listEnterpriseAssistants(orgId: string): Promise<unknown> {
    const profile = await this.requireProfile(orgId)
    const enterpriseId = await this.options.identities.getNumericAlias('enterprise', orgId)
    const agents = (await this.options.catalog.listAgents({ orgId, includeDisabled: true })).items
      .filter(agent => agent.orgId === orgId)
    return Promise.all(agents.map(async (agent) => {
      const sharedTenantCodes = await this.organizationCodes(
        await this.options.catalog.listAssignedOrganizationIds('agent', agent.id),
      )
      return enterpriseAssistantDto(agent, enterpriseId, profile.code, sharedTenantCodes)
    }))
  }

  async createEnterpriseAssistant(
    input: { actor: IdentityActor; orgId: string; form: FormData },
    context: CommandContext,
  ): Promise<unknown> {
    assertTrustedCommandContext(context)
    const parsed = parseAssistantForm(input.form)
    const operation = await this.prepareOperation({
      orgId: input.orgId,
      operationType: 'enterprise-assistant.create',
      aggregateId: context.idempotencyKey,
      context,
      request: await assistantFormOperationRequest(parsed),
    })
    if (!operation.created) {
      if (operation.operation.status === 'SUPPRESSED') return { suppressed: true }
      if (operation.operation.status === 'SUCCEEDED') {
        const assistantId = stringValue(operation.operation.result?.assistantId)
        const existing = assistantId ? await this.options.catalog.getAgent(assistantId, input.orgId) : null
        if (existing) {
          return enterpriseAssistantSummary(
            existing,
            (await this.requireProfile(input.orgId)).code,
            stringArray(existing.providerBinding?.datasetIds),
          )
        }
      }
      throw operationReplayError(operation.operation)
    }
    if (operation.operation.status === 'SUPPRESSED') return { suppressed: true }
    const id = this.idFactory()
    const assignedOrgIds = await this.resolveSharedOrganizations(input.orgId, parsed.sharedTenantScope, parsed.sharedTenantIds)
    const visibleTo = aclToVisibleTo(parsed.aclEntries)
    const staged = await this.stageAssistantArtifact(input.orgId, id, parsed)
    let providerBinding: Record<string, unknown> | null = null
    let providerType: 'local' | 'dify' = 'local'
    let appSecret: { namespace: string; key: string } | null = null
    let createdApp: { tenantId: string; appId: string } | null = null
    let catalogCreated = false
    let externalAttempted = false
    let externalSucceeded = false
    try {
      if (parsed.enhancementMode) {
        const provisioned = await this.provision(
          input.orgId, onlineCommandContext(`${context.idempotencyKey}:provision`),
        )
        if ('suppressed' in provisioned) return provisioned
        const connection = await this.requireConnection(input.orgId)
        externalAttempted = true
        const created = objectValue(await this.options.adapter.systemJson(
          provisioned.dify_tenant_id, 'POST', '/sudowork/system/apps',
          { name: parsed.name, description: parsed.description, mode: parsed.enhancementMode },
          configString(connection, 'systemAccountId') || undefined,
        ))
        externalSucceeded = true
        const appId = requiredString(created.app_id, 'Dify app id')
        const appKey = requiredString(created.app_api_key, 'Dify app API key')
        appSecret = { namespace: secretNamespace(input.orgId), key: `apps/${appId}-api-key` }
        createdApp = { tenantId: provisioned.dify_tenant_id, appId }
        await this.options.secrets.putSecret(appSecret.namespace, appSecret.key, appKey, `org:${input.orgId}`)
        providerType = 'dify'
        providerBinding = {
          connectionId: connection.id, tenantId: provisioned.dify_tenant_id, appId,
          mode: parsed.enhancementMode,
          appSecretRef: secretReference(appSecret.namespace, appSecret.key), datasetIds: [],
        }
      } else if (parsed.datasetIds.length > 0) {
        const provisioned = await this.provision(
          input.orgId, onlineCommandContext(`${context.idempotencyKey}:provision`),
        )
        if ('suppressed' in provisioned) return provisioned
        providerType = 'dify'
        providerBinding = {
          connectionId: (await this.requireConnection(input.orgId)).id,
          tenantId: provisioned.dify_tenant_id, datasetIds: parsed.datasetIds, mode: 'rag-only',
        }
      }
      const agent = await this.options.catalogService.createAgent({
        actor: input.actor, orgId: input.orgId, id, name: parsed.name, displayName: parsed.name,
        profession: parsed.profession, description: parsed.description,
        defaultInitPrompt: parsed.defaultInitPrompt, promptsI18n: parsed.promptsI18n,
        categories: parsed.categories, skills: parsed.skills, version: '1.0.0',
        checksum: staged?.checksum, filePath: staged?.finalPath,
        sourceUrl: staged ? `${(this.options.publicBaseUrl ?? '').replace(/\/+$/, '')}/api/assistants/${id}/download` : null,
        providerType, providerBinding, supportedModes: providerType === 'local' ? 'local' : 'both',
        availability: assignedOrgIds.length > 0 ? 'assigned' : 'organization',
      }, context)
      catalogCreated = agent.id === id
      await this.options.db.transaction(async () => {
        await this.options.catalog.updateAgentConfiguration(id, input.orgId, { visibleTo })
        await this.options.catalog.replaceOrganizationAssignments('agent', id, assignedOrgIds)
      })
      if (staged) await this.options.artifacts!.publish(staged)
      await this.options.db.transaction(async () => this.options.difyRepository.updateOperation(operation.operation.id, {
        status: 'SUCCEEDED', result: { assistantId: agent.id }, errorMessage: null,
      }))
      return enterpriseAssistantSummary(agent, (await this.requireProfile(input.orgId)).code, parsed.datasetIds)
    } catch (error) {
      if (staged) await this.options.artifacts!.discard(staged).catch(() => undefined)
      const compensated = createdApp ? await this.options.adapter.systemJson(
        createdApp.tenantId, 'DELETE', `/sudowork/system/apps/${encodeURIComponent(createdApp.appId)}`,
      ).then(() => true, () => false) : !externalSucceeded
      if (appSecret) await this.options.secrets.deleteSecret(
        appSecret.namespace, appSecret.key, `org:${input.orgId}`,
      ).catch(() => undefined)
      if (catalogCreated) await this.options.db.transaction(async () => {
        await this.options.catalog.deleteAgent(id, input.orgId)
        await this.options.catalog.clearCommandResult('catalog.create_agent', context.idempotencyKey)
      })
      await this.markOperationFailed(
        operation.operation,
        error,
        externalSucceeded ? !compensated : (externalAttempted && !(error instanceof DifyProviderError)),
      )
      throw error
    }
  }

  async getEnterpriseAssistant(orgId: string, assistantId: string): Promise<unknown> {
    const agent = await this.requireAgent(orgId, assistantId)
    const profile = await this.requireProfile(orgId)
    let promptText: string | null = null
    if (agent.filePath && agent.checksum && this.options.artifacts) {
      try {
        promptText = await readPromptText(await this.options.artifacts.read(agent.filePath, agent.checksum), agent.name)
      } catch {
        promptText = null
      }
    }
    const assigned = await this.options.catalog.listAssignedOrganizationIds('agent', agent.id)
    const tenantIds = [profile.code, ...(await this.organizationCodes(assigned))]
    const acl = await this.listAcl(orgId, assistantId)
    const scope = acl.length === 1 && acl[0]?.subjectType === 'all' ? 'all' : 'specific'
    return {
      assistant: enterpriseAssistantDto(
        agent,
        await this.options.identities.getNumericAlias('enterprise', orgId),
        profile.code,
        await this.organizationCodes(assigned),
      ),
      tenantIds, tenant_ids: tenantIds,
      shared_tenant_scope: assigned.length > 0 ? 'selected' : 'none',
      shared_tenant_ids: tenantIds.slice(1),
      promptText, prompt_text: promptText,
      enhancement: await this.getEnhancement(orgId, assistantId),
      dataset_ids: await this.listDatasets(orgId, assistantId),
      acl_summary: { scope, user_ids: acl.filter(entry => entry.subjectType === 'user').flatMap(entry => entry.subjectId ? [entry.subjectId] : []) },
    }
  }

  async updateEnterpriseAssistant(
    input: { actor: IdentityActor; orgId: string; assistantId: string; form: FormData },
    context: CommandContext,
  ): Promise<unknown> {
    assertTrustedCommandContext(context)
    const agent = await this.requireAgent(input.orgId, input.assistantId)
    if (context.externalEffects === 'suppress_external') return { suppressed: true }
    const parsed = parseAssistantForm(input.form)
    const assigned = await this.resolveSharedOrganizations(input.orgId, parsed.sharedTenantScope, parsed.sharedTenantIds)
    const priorAssigned = await this.options.catalog.listAssignedOrganizationIds('agent', input.assistantId)
    const nextVersion = parsed.sourceFile || parsed.promptFile ? incrementPatchVersion(agent.version) : agent.version
    const staged = parsed.sourceFile || parsed.promptFile
      ? await this.stageAssistantArtifact(input.orgId, input.assistantId, parsed, nextVersion ?? '1.0.1')
      : null
    try {
      await this.options.db.transaction(async () => {
        await this.options.catalog.updateAgentConfiguration(input.assistantId, input.orgId, {
          name: parsed.name, displayName: parsed.name, profession: parsed.profession,
          description: parsed.description, defaultInitPrompt: parsed.defaultInitPrompt,
          promptsI18n: parsed.promptsI18n, categories: parsed.categories, skills: parsed.skills,
          availability: assigned.length > 0 ? 'assigned' : 'organization',
          ...(staged ? {
            version: nextVersion,
            checksum: staged.checksum,
            filePath: staged.finalPath,
            sourceUrl: `${(this.options.publicBaseUrl ?? '').replace(/\/+$/, '')}/api/assistants/${input.assistantId}/download`,
          } : {}),
        })
        await this.options.catalog.replaceOrganizationAssignments('agent', input.assistantId, assigned)
      })
      if (staged) await this.options.artifacts!.publish(staged)
    } catch (error) {
      if (staged) await this.options.artifacts!.discard(staged).catch(() => undefined)
      await this.options.db.transaction(async () => {
        await this.options.catalog.updateAgentConfiguration(input.assistantId, input.orgId, catalogConfiguration(agent))
        await this.options.catalog.replaceOrganizationAssignments('agent', input.assistantId, priorAssigned)
      })
      throw error
    }
    const updated = await this.requireAgent(input.orgId, input.assistantId)
    return {
      assistantId: updated.id,
      enterpriseId: await this.options.identities.getNumericAlias('enterprise', input.orgId),
      tenantCode: (await this.requireProfile(input.orgId)).code,
      version: updated.version ?? '1.0.0',
      raw: updated,
    }
  }

  async getEnhancement(orgId: string, assistantId: string): Promise<{ enabled: boolean; mode?: string; dify_app_id?: string; dify_tenant_id?: string }> {
    const agent = await this.requireAgent(orgId, assistantId)
    const binding = agent.providerBinding ?? {}
    const appId = stringValue(binding.appId)
    const mode = stringValue(binding.mode)
    if (!appId || mode === 'rag-only') return { enabled: false }
    return {
      enabled: true, mode: mode || 'agent-chat', dify_app_id: appId,
      dify_tenant_id: stringValue(binding.tenantId),
    }
  }

  async setEnhancement(input: {
    actor: IdentityActor
    orgId: string
    assistantId: string
    enable: boolean
    mode?: string
    appName?: string
  }, context: CommandContext): Promise<unknown> {
    assertTrustedCommandContext(context)
    const current = await this.getEnhancement(input.orgId, input.assistantId)
    const changes = current.enabled !== input.enable
      || (current.enabled && input.enable && input.mode !== undefined && input.mode !== current.mode)
    if (changes) throw new Error('enhancement method cannot be changed after creation')
    return current
  }

  private async defaultConnection(orgId: string): Promise<IntegrationConnection | null> {
    const enabled = (await this.options.identities.listIntegrationConnections(orgId, 'dify'))
      .filter(connection => connection.enabled)
    return enabled.find(connection => connection.config.isDefault === true)
      ?? (enabled.length === 1 ? enabled[0]! : null)
  }

  private async requireConnection(orgId: string): Promise<IntegrationConnection> {
    const connection = await this.defaultConnection(orgId)
    if (!connection) throw new Error(`enterprise ${orgId} has no Dify tenant binding`)
    return connection
  }

  private async requireAgent(orgId: string, assistantId: string): Promise<CatalogAgent> {
    const agent = await this.options.catalog.getAgent(assistantId, orgId)
    if (!agent) throw new Error('not found')
    return agent
  }

  private async requireProfile(orgId: string) {
    const profile = await this.options.identities.getOrganizationProfile(orgId)
    if (!profile) throw new Error(`enterprise ${orgId} missing`)
    return profile
  }

  private async resolveSharedOrganizations(orgId: string, scope: string | undefined, codes: string[]): Promise<string[]> {
    if (scope === 'all') throw new Error('shared_tenant_scope=all is no longer supported; select tenants explicitly')
    if (scope !== 'selected') return []
    const resolved = await Promise.all([...new Set(codes)].map(async (code) => {
      const profile = await this.options.identities.getOrganizationProfileByCode(code)
      if (!profile) throw new Error(`tenant ${code} not found`)
      return profile.orgId === orgId ? [] : [profile.orgId]
    }))
    const ids = resolved.flat()
    if (ids.length === 0) throw new Error('shared_tenant_ids is required when shared_tenant_scope is selected')
    return ids
  }

  private async organizationCodes(orgIds: string[]): Promise<string[]> {
    const codes = await Promise.all(orgIds.map(async (orgId) => {
      const profile = await this.options.identities.getOrganizationProfile(orgId)
      return profile ? [profile.code] : []
    }))
    return codes.flat()
  }

  private prepareOperation(input: {
    orgId: string
    operationType: string
    aggregateId: string
    context: CommandContext
    request: Record<string, unknown>
  }): Promise<{ operation: DifyProviderOperation; created: boolean }> {
    return this.options.db.transaction(async () => {
      let operation = await this.options.difyRepository.getOperationByIdempotencyKey(input.context.idempotencyKey)
      if (!operation) {
        operation = await this.options.difyRepository.createOperation({
          id: `dify-operation:${input.context.idempotencyKey}`,
          orgId: input.orgId,
          operationType: input.operationType,
          aggregateId: input.aggregateId,
          idempotencyKey: input.context.idempotencyKey,
          status: input.context.externalEffects === 'suppress_external' ? 'SUPPRESSED' : 'PENDING',
          request: input.request,
          contextSource: input.context.source,
        })
      }
      if (operation.orgId !== input.orgId
        || operation.operationType !== input.operationType
        || operation.aggregateId !== input.aggregateId
        || JSON.stringify(operation.request) !== JSON.stringify(input.request)) {
        throw new Error('idempotency key already used for a different Dify command')
      }
      if (operation.status === 'SUPPRESSED') return { operation, created: false }
      const claimed = await this.options.difyRepository.claimOperation(operation.id)
      return { operation: claimed ?? operation, created: claimed !== null }
    })
  }

  private async markOperationFailed(operation: DifyProviderOperation, error: unknown, uncertain: boolean): Promise<void> {
    await this.options.db.transaction(async () => this.options.difyRepository.updateOperation(operation.id, {
      status: uncertain ? 'UNKNOWN' : 'FAILED',
      errorMessage: error instanceof Error ? error.message : String(error),
    }))
  }

  private async stageAssistantArtifact(
    orgId: string,
    id: string,
    parsed: AssistantForm,
    version = '1.0.0',
  ): Promise<Awaited<ReturnType<CatalogArtifactPort['stage']>> | null> {
    if (!this.options.artifacts) return null
    const source = parsed.sourceFile
      ? Buffer.from(await parsed.sourceFile.arrayBuffer())
      : await buildAssistantArchive(parsed)
    if (!source) return null
    return await this.options.artifacts.stage({
      kind: 'agent', orgId, resourceId: id, version, bytes: source,
    })
  }

  private async agentSummary(agent: CatalogAgent): Promise<DifyAgentSummary> {
    const binding = agent.providerBinding ?? {}
    return {
      assistantId: agent.id,
      enterpriseId: await this.options.identities.getNumericAlias('enterprise', agent.orgId),
      difyTenantId: stringValue(binding.tenantId),
      difyAppId: stringValue(binding.appId),
      difyAppMode: stringValue(binding.mode) || 'agent-chat',
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    }
  }
}

function connectionId(orgId: string): string {
  return `dify:${orgId}`
}

function secretNamespace(orgId: string): string {
  return `org:${orgId}:dify`
}

function secretReference(namespace: string, key: string): string {
  return `nexus://${namespace}/${key}`
}

function connectionDto(connection: IntegrationConnection): {
  dify_tenant_id: string
  dify_system_account_id: string | null
} {
  return {
    dify_tenant_id: configString(connection, 'tenantId'),
    dify_system_account_id: configString(connection, 'systemAccountId') || null,
  }
}

function configString(connection: IntegrationConnection, key: string): string {
  return stringValue(connection.config[key])
}

function configNumber(connection: IntegrationConnection, key: string): number | null {
  const value = connection.config[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function requiredString(value: unknown, label: string): string {
  const result = stringValue(value)
  if (!result) throw new Error(`${label} missing`)
  return result
}

function operationReplayError(operation: DifyProviderOperation): Error {
  return new Error(`Dify operation ${operation.idempotencyKey} is ${operation.status}`)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function uniqueSubjectIds(entries: DifyAclEntry[], type: DifyAclEntry['subjectType']): string[] {
  return [...new Set(entries
    .filter(entry => entry.subjectType === type && entry.subjectId)
    .map(entry => entry.subjectId!))]
}

function nullableSubjectIds(
  entries: DifyAclEntry[],
  type: DifyAclEntry['subjectType'],
): string[] | null {
  const values = uniqueSubjectIds(entries, type)
  return values.length > 0 ? values : null
}

interface AssistantForm {
  name: string
  profession: string
  description?: string
  defaultInitPrompt?: string
  promptsI18n?: Record<string, string[]>
  categories: string[]
  skills: string[]
  aclEntries: DifyAclEntry[]
  datasetIds: string[]
  enhancementMode?: string
  sharedTenantScope?: string
  sharedTenantIds: string[]
  promptFile?: File
  avatarFile?: File
  sourceFile?: File
}

async function assistantFormOperationRequest(input: AssistantForm): Promise<Record<string, unknown>> {
  const file = async (value: File | undefined) => value ? {
    name: value.name,
    type: value.type,
    size: value.size,
    checksum: createHash('sha256').update(Buffer.from(await value.arrayBuffer())).digest('hex'),
  } : null
  return {
    name: input.name,
    profession: input.profession,
    description: input.description ?? null,
    defaultInitPrompt: input.defaultInitPrompt ?? null,
    promptsI18n: input.promptsI18n ?? null,
    categories: input.categories,
    skills: input.skills,
    aclEntries: input.aclEntries,
    datasetIds: input.datasetIds,
    enhancementMode: input.enhancementMode ?? null,
    sharedTenantScope: input.sharedTenantScope ?? null,
    sharedTenantIds: input.sharedTenantIds,
    promptFile: await file(input.promptFile),
    avatarFile: await file(input.avatarFile),
    sourceFile: await file(input.sourceFile),
  }
}

function parseAssistantForm(form: FormData): AssistantForm {
  const prompt = form.get('prompt_file')
  const avatar = form.get('avatar')
  const source = form.get('source_url')
  const enhancementMode = formText(form, 'enable_enhancement') === 'true'
    ? formText(form, 'enhancement_mode')
    : undefined
  return {
    name: formText(form, 'name') ?? '',
    profession: formText(form, 'profession') ?? '',
    description: formText(form, 'description'),
    defaultInitPrompt: formText(form, 'default_init_prompt') ?? formText(form, 'defaultInitPrompt'),
    promptsI18n: formJsonObject(form, 'promptsI18n') ?? formJsonObject(form, 'prompts_i18n'),
    categories: formJsonArray(form, 'categories'),
    skills: formJsonArray(form, 'skills'),
    aclEntries: formAclEntries(form),
    datasetIds: formJsonArray(form, 'dataset_ids'),
    enhancementMode,
    sharedTenantScope: formText(form, 'shared_tenant_scope'),
    sharedTenantIds: formJsonArray(form, 'shared_tenant_ids'),
    promptFile: prompt instanceof File ? prompt : undefined,
    avatarFile: avatar instanceof File ? avatar : undefined,
    sourceFile: source instanceof File ? source : undefined,
  }
}

async function buildAssistantArchive(input: AssistantForm): Promise<Buffer | null> {
  if (!input.promptFile) return null
  const zip = new JSZip()
  zip.file(`${input.name}.md`, Buffer.from(await input.promptFile.arrayBuffer()))
  if (input.avatarFile) zip.file(input.avatarFile.name, Buffer.from(await input.avatarFile.arrayBuffer()))
  zip.file('_moss_meta.json', JSON.stringify({
    name: input.name, display_name: input.name, profession: input.profession,
    description: input.description ?? '', defaultInitPrompt: input.defaultInitPrompt ?? null,
    promptsI18n: input.promptsI18n ?? { 'zh-CN': [] }, categories: input.categories,
    skills: input.skills, ruleFile: `${input.name}.md`, version: '1.0.0',
  }, null, 2))
  return Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
}

function formText(form: FormData, key: string): string | undefined {
  const value = form.get(key)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function formJsonArray(form: FormData, key: string): string[] {
  const raw = formText(form, key)
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function formJsonObject(form: FormData, key: string): Record<string, string[]> | undefined {
  const raw = formText(form, key)
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, string[]>
      : undefined
  } catch {
    return undefined
  }
}

function formAclEntries(form: FormData): DifyAclEntry[] {
  const raw = formText(form, 'acl_entries')
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.map(objectValue).flatMap(entry => {
      const subjectType = stringValue(entry.subjectType || entry.subject_type) as DifyAclEntry['subjectType']
      if (!['user', 'department', 'role', 'all'].includes(subjectType)) return []
      const subjectId = stringValue(entry.subjectId || entry.subject_id) || null
      return [{ subjectType, subjectId }]
    })
  } catch {
    return []
  }
}

function aclToVisibleTo(entries: DifyAclEntry[]): VisibleTo {
  if (entries.length === 0 || entries.some(entry => entry.subjectType === 'all')) return null
  return {
    user_ids: nullableSubjectIds(entries, 'user'),
    role_ids: nullableSubjectIds(entries, 'role'),
    department_ids: nullableSubjectIds(entries, 'department'),
  }
}

async function readPromptText(bytes: Buffer, preferredName: string): Promise<string | null> {
  const zip = await JSZip.loadAsync(bytes)
  const markdown = Object.values(zip.files).filter(entry => !entry.dir && /\.md$/i.test(entry.name))
  const preferred = markdown.find(entry => entry.name.split('/').pop() === `${preferredName}.md`)
  return await (preferred ?? markdown[0])?.async('string') ?? null
}

function enterpriseAssistantSummary(agent: CatalogAgent, tenantCode: string, datasetIds: string[]): Record<string, unknown> {
  const binding = agent.providerBinding ?? {}
  return {
    assistantId: agent.id,
    enterpriseId: null,
    tenantCode,
    tenantIds: [tenantCode],
    ...(binding.appId ? {
      difyAppId: binding.appId,
      difyTenantId: binding.tenantId,
      difyAppMode: binding.mode,
      enhancement: { mode: binding.mode },
    } : { enhancement: null }),
    datasetIds,
  }
}

function enterpriseAssistantDto(
  agent: CatalogAgent,
  enterpriseId: number | null,
  tenantCode: string,
  sharedTenantCodes: string[],
): Record<string, unknown> {
  const binding = agent.providerBinding ?? {}
  const datasetIds = stringArray(binding.datasetIds)
  const enhancement = binding.appId && binding.mode !== 'rag-only'
    ? { enabled: true, mode: binding.mode, dify_app_id: binding.appId }
    : { enabled: false }
  return {
    assistant_id: agent.id,
    enterprise_id: enterpriseId,
    name: agent.name,
    display_name: agent.displayName ?? agent.name,
    description: agent.description ?? '',
    promptsI18n: agent.promptsI18n,
    prompts_i18n: agent.promptsI18n,
    avatar: agent.avatar,
    categories: agent.categories,
    profession: agent.profession,
    tenantId: tenantCode,
    tenantIds: [tenantCode, ...sharedTenantCodes],
    shared_tenant_scope: sharedTenantCodes.length > 0 ? 'selected' : 'none',
    shared_tenant_ids: sharedTenantCodes,
    status: agent.status === 'approved' ? 1 : agent.status === 'rejected' ? 2 : 0,
    enhancement,
    dataset_ids: datasetIds,
    acl_summary: aclSummary(agent.visibleTo),
  }
}

function incrementPatchVersion(value: string | null): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value ?? '')
  if (!match) return '1.0.1'
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

function catalogConfiguration(agent: CatalogAgent): Parameters<CatalogRepository['updateAgentConfiguration']>[2] {
  return {
    name: agent.name,
    displayName: agent.displayName,
    profession: agent.profession,
    description: agent.description,
    defaultInitPrompt: agent.defaultInitPrompt,
    promptsI18n: agent.promptsI18n,
    categories: agent.categories,
    avatar: agent.avatar,
    skills: agent.skills,
    promptFile: agent.promptFile,
    version: agent.version,
    sourceUrl: agent.sourceUrl,
    checksum: agent.checksum,
    filePath: agent.filePath,
    visibleTo: agent.visibleTo,
    providerType: agent.providerType,
    providerBinding: agent.providerBinding,
    supportedModes: agent.supportedModes,
    availability: agent.availability,
    enabled: agent.enabled,
    status: agent.status,
  }
}

function aclSummary(visibleTo: VisibleTo): { scope: 'all' | 'specific'; user_ids: string[] } {
  return visibleTo
    ? { scope: 'specific', user_ids: visibleTo.user_ids ?? [] }
    : { scope: 'all', user_ids: [] }
}

function parseSecretReference(value: string): { namespace: string; key: string } | null {
  if (!value.startsWith('nexus://')) return null
  const raw = value.slice('nexus://'.length)
  const separator = raw.lastIndexOf('/')
  return separator > 0 ? { namespace: raw.slice(0, separator), key: raw.slice(separator + 1) } : null
}
