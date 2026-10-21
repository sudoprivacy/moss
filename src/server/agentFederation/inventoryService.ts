import { AGENT_REGISTRY_API, type AssetRecord } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import type { AuthContext } from '../auth/token.js'
import type { CatalogRepository } from '../catalog/catalogRepository.js'
import { object } from '../externalProviders/administration.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { parseInventoryCommand, type ProductRegistryClient } from './registryClient.js'
import type { InventoryAssetView, InventoryPageView } from './inventoryViews.js'

export interface InventoryServiceOptions {
  registry?: ProductRegistryClient
  catalog: Pick<CatalogRepository, 'getAgent'>
  authorize: (actor: AuthContext) => Promise<{ canManage: boolean }>
  member: (orgId: string, userId: string) => Promise<{ id: string; departmentId: string | null } | null>
  members: (
    orgId: string,
    after: string,
    search: string,
  ) => Promise<{ id: string; name: string; department_id: string | null }[]>
  labels: (
    orgId: string,
    userIds: string[],
    departmentIds: string[],
  ) => Promise<{ users: Map<string, string>; departments: Map<string, string> }>
}
function fail(code: string, status = 400): never {
  throw new ExternalProviderError(status, code)
}
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,149}$/.test(value)) fail('INVALID_INVENTORY_ID')
  return value as string
}

/** Authenticated management gateway. Never accepts an end-user's attestation or IAM grant. */
export class AgentInventoryService {
  constructor(private readonly options: InventoryServiceOptions) {}
  private registry(orgId: string): ProductRegistryClient {
    if (!this.options.registry) fail('REGISTRY_NOT_CONFIGURED', 503)
    this.options.registry.scope(orgId)
    return this.options.registry
  }
  async access(actor: AuthContext) {
    const access = await this.options.authorize(actor)
    let configured = false
    try {
      this.registry(actor.orgId)
      configured = true
    } catch (error) {
      if (
        !(error instanceof ExternalProviderError) ||
        !['REGISTRY_NOT_CONFIGURED', 'REGISTRY_ORGANIZATION_UNCONFIGURED'].includes(error.code)
      )
        throw error
    }
    const member = await this.options.member(actor.orgId, actor.userId)
    return {
      can_manage: access.canManage,
      configured,
      user_id: actor.userId,
      department_id: member?.departmentId ?? null,
      can_own: !!member,
    }
  }
  async members(actor: AuthContext, after = '', search = '') {
    if (!(await this.options.authorize(actor)).canManage) fail('ADMIN_REQUIRED', 403)
    if (after) identifier(after)
    if (search.length > 100) fail('INVALID_INVENTORY_SEARCH')
    const rows = await this.options.members(actor.orgId, after, search)
    return { items: rows.slice(0, 50), next_cursor: rows.length > 50 ? rows[49].id : null }
  }
  private async readable(actor: AuthContext, id: string, canManage: boolean): Promise<AssetRecord> {
    const asset = await this.registry(actor.orgId).inventoryGet(actor.orgId, identifier(id))
    if (!canManage && asset.metadata.owner_user_id !== actor.userId) fail('AGENT_ASSET_NOT_FOUND', 404)
    return asset
  }
  private async present(orgId: string, rows: AssetRecord[]): Promise<InventoryAssetView[]> {
    const labels = await this.options.labels(
      orgId,
      [...new Set(rows.map((row) => row.metadata.owner_user_id))],
      [...new Set(rows.map((row) => row.metadata.department_id).filter((id): id is string => !!id))],
    )
    return rows.map((row) => ({
      ...row,
      owner_display_name: labels.users.get(row.metadata.owner_user_id) ?? null,
      department_display_name: labels.departments.get(row.metadata.department_id ?? '') ?? null,
    }))
  }
  async list(actor: AuthContext, after = ''): Promise<InventoryPageView> {
    const { canManage } = await this.options.authorize(actor)
    if (after) identifier(after)
    const page = await this.registry(actor.orgId).inventoryList(
      actor.orgId,
      after,
      canManage ? undefined : actor.userId,
    )
    return { ...page, items: await this.present(actor.orgId, page.items) }
  }
  async get(actor: AuthContext, id: string) {
    const { canManage } = await this.options.authorize(actor)
    return (await this.present(actor.orgId, [await this.readable(actor, id, canManage)]))[0]
  }
  async history(actor: AuthContext, id: string, after = 0) {
    const { canManage } = await this.options.authorize(actor)
    if (!Number.isSafeInteger(after) || after < 0) fail('INVALID_ASSET_CURSOR')
    await this.readable(actor, id, canManage)
    return this.registry(actor.orgId).inventoryHistory(actor.orgId, id, after)
  }
  async command(actor: AuthContext, input: unknown) {
    const { canManage } = await this.options.authorize(actor)
    const body = object(input, [
      'kind',
      'asset_id',
      'request_id',
      'expected_revision',
      'metadata',
      'decision',
      'reason',
      'catalog_id',
      'target_asset_id',
      'target_revision',
    ])
    const kinds = ['SaveAsset', 'SubmitAsset', 'ReviewAsset', 'SuspendAsset', 'MergeAsset', 'LinkAsset']
    if (typeof body.kind !== 'string' || !kinds.includes(body.kind)) fail('INVALID_INVENTORY_COMMAND')
    if (!canManage && !['SaveAsset', 'SubmitAsset'].includes(body.kind)) fail('ADMIN_REQUIRED', 403)
    const id = identifier(body.asset_id)
    const registry = this.registry(actor.orgId)
    const { catalog_id, ...fields } = body
    let principal
    if (body.kind === 'LinkAsset') {
      const catalogId = identifier(catalog_id)
      const catalog = await this.options.catalog.getAgent(catalogId, actor.orgId)
      if (!catalog || catalog.providerBinding?.executionMode !== 'external_hosted') fail('AGENT_CATALOG_LINK_INVALID')
      principal = registry.principal(actor.orgId, catalogId)
    } else if (catalog_id !== undefined) fail('INVALID_INVENTORY_COMMAND')
    const command = parseInventoryCommand({
      ...fields,
      api_version: AGENT_REGISTRY_API,
      initiated_by: actor.userId,
      ...(principal ? { principal } : {}),
    })
    const current =
      command.expected_revision === 0 && command.kind === 'SaveAsset' ? null : await this.readable(actor, id, canManage)
    if (command.kind === 'SaveAsset') {
      if (!canManage && command.metadata.owner_user_id !== actor.userId) fail('AGENT_ASSET_OWNER_FORBIDDEN', 403)
    }
    const checkedMetadata =
      command.kind === 'SaveAsset'
        ? command.metadata
        : command.kind === 'SubmitAsset' || (command.kind === 'ReviewAsset' && command.decision === 'approve')
          ? current?.metadata
          : null
    if (checkedMetadata) {
      const owner = await this.options.member(actor.orgId, checkedMetadata.owner_user_id)
      if (!owner) fail('INVALID_MEMBER')
      // Department attribution is authoritative AuthCenter membership, never a browser claim.
      if ((checkedMetadata.department_id ?? null) !== owner.departmentId) fail('AGENT_DEPARTMENT_MISMATCH')
    }
    if (command.kind === 'MergeAsset') await this.readable(actor, command.target_asset_id, true)
    return (await this.present(actor.orgId, [await registry.inventoryCommand(actor.orgId, command)]))[0]
  }
}
