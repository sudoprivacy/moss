import { randomUUID } from 'node:crypto'
import type { AuthContext } from '../auth/token.js'
import type { CatalogRepository } from '../catalog/catalogRepository.js'
import type { DbDriver } from '../db/driver.js'
import type { IdentityRepository, IntegrationConnection } from '../identity/identityRepository.js'
import type { ExternalSecretPort } from '../externalProviders/administration.js'
import { object } from '../externalProviders/administration.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import {
  discoveredAgent,
  discoveryId,
  discoveryIdentifier,
  discoveryOrigin,
  discoveryOrigins,
  scanDiscoverySource,
  type DiscoveredAgent,
  type DiscoverySource,
} from './inventoryDiscovery.js'

const provider = 'agent_inventory_discovery'
function fail(code: string, status = 400): never {
  throw new ExternalProviderError(status, code)
}

/** Operational source configuration uses the existing integration and secret owners. No asset authority is duplicated. */
export class InventorySources {
  constructor(
    private readonly options: {
      db: DbDriver
      identities: IdentityRepository
      catalog: CatalogRepository
      secrets?: ExternalSecretPort
    },
  ) {}

  private view(connection: IntegrationConnection): DiscoverySource {
    const c = connection.config
    if (
      !['dify', 'router', 'platform'].includes(String(c.kind)) ||
      typeof c.scope !== 'string' ||
      typeof c.external_domain !== 'boolean'
    )
      fail('DISCOVERY_CONFIGURATION_INVALID', 503)
    return {
      id: connection.id,
      name: connection.name,
      enabled: connection.enabled,
      kind: c.kind as DiscoverySource['kind'],
      origin: discoveryOrigin(c.origin),
      scope: discoveryIdentifier(c.scope),
      external_domain: c.external_domain,
    }
  }
  async list(orgId: string) {
    const rows = await this.options.identities.listIntegrationConnections(orgId, provider)
    return {
      items: rows.map((row) => this.view(row)),
      allowed_origins: discoveryOrigins(orgId),
      credentials_available: !!this.options.secrets?.putSecret && !!this.options.secrets?.deleteSecret,
    }
  }
  private async audit(actor: AuthContext, action: string, id: string, details: unknown) {
    const eventId = randomUUID()
    await this.options.identities.insertOperationAudit({
      id: eventId,
      idempotencyKey: eventId,
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action,
      resource: 'agent_inventory_source',
      resourceId: id,
      requestData: details,
    })
  }
  async create(actor: AuthContext, input: unknown) {
    const body = object(input, ['name', 'kind', 'origin', 'scope', 'external_domain', 'api_key', 'csrf_token'])
    const secrets = this.options.secrets
    if (!secrets?.putSecret || !secrets.deleteSecret) fail('CREDENTIAL_STORAGE_UNAVAILABLE', 503)
    const origin = discoveryOrigin(body.origin)
    if (!discoveryOrigins(actor.orgId).includes(origin)) fail('DISCOVERY_ORIGIN_NOT_APPROVED', 403)
    if (
      !['dify', 'router', 'platform'].includes(String(body.kind)) ||
      typeof body.external_domain !== 'boolean' ||
      typeof body.name !== 'string' ||
      !body.name.trim() ||
      body.name.length > 200 ||
      typeof body.api_key !== 'string' ||
      !body.api_key ||
      body.api_key.length > 8192 ||
      /[\r\n]/.test(body.api_key)
    )
      fail('INVALID_DISCOVERY_SOURCE')
    const scope = discoveryIdentifier(body.scope)
    if (
      body.csrf_token !== undefined &&
      (body.kind !== 'dify' ||
        typeof body.csrf_token !== 'string' ||
        body.csrf_token.length > 8192 ||
        /[\r\n;]/.test(body.csrf_token))
    )
      fail('INVALID_DISCOVERY_SOURCE')
    if (body.kind === 'router' && !/^[1-9][0-9]{0,12}$/.test(scope)) fail('INVALID_DISCOVERY_SOURCE')
    const existing = await this.list(actor.orgId)
    if (existing.items.filter((row) => row.enabled).length >= 20) fail('DISCOVERY_SOURCE_LIMIT')
    const id = randomUUID(),
      namespace = `org:${actor.orgId}:agent-discovery:${id}`
    const config = { kind: body.kind, origin, scope, external_domain: body.external_domain }
    // Each create has its own immutable secret slot. A retry cannot overwrite another connection's credential.
    await secrets.putSecret(
      namespace,
      'credential',
      JSON.stringify({ token: body.api_key, csrf_token: body.csrf_token || undefined }),
      `org:${actor.orgId}`,
    )
    try {
      await this.options.db.transaction(async () => {
        await this.options.identities.putIntegrationConnection({
          id,
          orgId: actor.orgId,
          providerType: provider,
          name: body.name as string,
          enabled: true,
          secretRef: `nexus://${namespace}/credential`,
          config,
        })
        await this.audit(actor, 'agent.discovery.source.created', id, config)
      })
    } catch (error) {
      await secrets.deleteSecret(namespace, 'credential', `org:${actor.orgId}`).catch(() => undefined)
      throw error
    }
    return this.view((await this.options.identities.getIntegrationConnection(id))!)
  }
  private async connection(orgId: string, id: string) {
    const connection = await this.options.identities.getIntegrationConnection(discoveryIdentifier(id))
    if (!connection || connection.orgId !== orgId || connection.providerType !== provider)
      fail('DISCOVERY_SOURCE_NOT_FOUND', 404)
    return connection
  }
  async disable(actor: AuthContext, id: string) {
    await this.connection(actor.orgId, id)
    await this.options.db.transaction(async () => {
      await this.options.db.run(
        'UPDATE integration_connections SET enabled = 0 WHERE id = ? AND org_id = ? AND provider_type = ?',
        [id, actor.orgId, provider],
      )
      await this.audit(actor, 'agent.discovery.source.disabled', id, {})
    })
  }
  async assertEnabled(orgId: string, id: string) {
    if (id === 'catalog' || id === 'im') return
    const source = this.view(await this.connection(orgId, id))
    if (!source.enabled || !discoveryOrigins(orgId).includes(source.origin)) fail('DISCOVERY_SOURCE_DISABLED', 409)
  }
  async scan(orgId: string, id: string): Promise<{ items: DiscoveredAgent[]; boundary: string }> {
    const now = Date.now()
    if (id === 'catalog') {
      const items: DiscoveredAgent[] = []
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        const page = await this.options.catalog.listAgents({ orgId, includeDisabled: true, limit: 100, cursor })
        for (const row of page.items) {
          if (row.orgId !== orgId) continue
          const hosted = row.providerBinding?.executionMode === 'external_hosted'
          items.push(
            discoveredAgent({
              name: row.displayName || row.name,
              platform: row.providerType === 'dify' ? 'dify' : hosted ? 'http' : 'native',
              instance: 'moss-catalog',
              id: row.id,
              source: 'catalog',
              sourceId: 'catalog',
              now,
              snapshot: {
                id: row.id,
                name: row.name,
                enabled: row.enabled,
                status: row.status,
                version: row.version,
                provider: row.providerType,
              },
              hosting: hosted ? 'external_hosted' : 'internal_hosted',
              note: '当前组织 Moss 目录记录；目录发布状态不代表已完成分级纳管。',
            }),
          )
        }
        if (items.length > 10000) fail('DISCOVERY_SCAN_LIMIT')
        if (!page.nextCursor) break
        if (seen.has(page.nextCursor)) fail('DISCOVERY_PAGINATION_INVALID', 502)
        seen.add(page.nextCursor)
        cursor = page.nextCursor
      } while (true)
      return { items, boundary: '当前组织持有的 Moss 智能体目录；不包含其他组织共享目录。' }
    }
    if (id === 'im') {
      // Select only metadata, scoped by BOTH recorded organization and current member organization.
      const rows = await this.options.db.all<{
        id: string
        name: string
        type: string
        user_id: string
        enabled: number
      }>(
        `SELECT p.id, p.name, p.type, p.user_id, p.enabled FROM channel_plugins p
         INNER JOIN users u ON u.id = p.user_id AND u.org_id = p.org_id
         WHERE p.org_id = ? ORDER BY p.id, p.user_id LIMIT 10001`,
        [orgId],
      )
      if (rows.length > 10000) fail('DISCOVERY_SCAN_LIMIT')
      return {
        boundary: '已接入 Moss 的组织 IM Bot 连接；未连接平台中的 Bot 不在可观测范围内。',
        items: rows.map((row) => {
          const recordId = discoveryId([row.user_id, row.id])
          return discoveredAgent({
            name: row.name || row.type,
            platform: 'other',
            instance: `moss-im:${row.type}`,
            id: recordId,
            source: 'im',
            sourceId: 'im',
            snapshot: { id: row.id, type: row.type, enabled: row.enabled },
            now,
            note: 'IM Bot 连接候选项，需负责人确认对应 Agent 并与目录项合并；未读取聊天或凭据。',
          })
        }),
      }
    }
    const connection = await this.connection(orgId, id),
      source = this.view(connection)
    await this.assertEnabled(orgId, id)
    if (!this.options.secrets) fail('CREDENTIAL_STORAGE_UNAVAILABLE', 503)
    const namespace = `org:${orgId}:agent-discovery:${id}`
    if (connection.secretRef !== `nexus://${namespace}/credential`) fail('DISCOVERY_CONFIGURATION_INVALID', 503)
    const secret = await this.options.secrets.getSecret(namespace, 'credential', `org:${orgId}`)
    if (!secret?.value || secret.status !== 'enabled') fail('DISCOVERY_CREDENTIAL_UNAVAILABLE', 503)
    const credential = JSON.parse(secret.value) as { token: string; csrf_token?: string }
    if (typeof credential.token !== 'string' || !credential.token || /[\r\n]/.test(credential.token))
      fail('DISCOVERY_CREDENTIAL_UNAVAILABLE', 503)
    const items = await scanDiscoverySource(source, credential.token, undefined, now, credential.csrf_token)
    return {
      items,
      boundary:
        source.kind === 'router'
          ? '指定 Router 账户最近 24 小时的可识别 Token 消费来源；无 Token ID 和网关外流量不可识别。'
          : source.kind === 'dify'
            ? '凭据验证的单个 Dify 工作区应用清单。'
            : '指定平台、指定 scope 的完整分页清单；清单外资产不可见。',
    }
  }
}
