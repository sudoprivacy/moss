import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import type { AssetMetadata, DiscoveryEvidence } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { stableJson } from './provider/protocol.js'
import { parsePlatformDiscoveryPage } from './registryClient.js'
import type { ProviderRequest } from './customHttpAdapter.js'

import type { DiscoverySource, DiscoveredAgent } from './inventoryViews.js'
export type { DiscoveryKind, DiscoverySource, DiscoveredAgent, DiscoveryResult } from './inventoryViews.js'
export const discoveryDigest = (value: unknown) =>
  `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
export const discoveryId = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
export const discoverySourceKey = (value: AssetMetadata) =>
  discoveryId([value.source_platform, value.source_instance, value.source_agent_id])
function fail(code: string, status = 400): never {
  throw new ExternalProviderError(status, code)
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('DISCOVERY_RESPONSE_INVALID', 502)
  return value as Record<string, unknown>
}
const label = (value: unknown, max = 200): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value))
    fail('DISCOVERY_RESPONSE_INVALID', 502)
  return value
}
export const discoveryIdentifier = (value: unknown): string => {
  const id = label(value, 150)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(id)) fail('DISCOVERY_RESPONSE_INVALID', 502)
  return id
}
const integer = (value: unknown) => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail('DISCOVERY_RESPONSE_INVALID', 502)
  return Number(value)
}

/** Explicit per-organization origins. Literal IPs prevent DNS changes and redirect credential leakage. */
export function discoveryOrigins(orgId: string): string[] {
  let config: unknown
  try {
    config = JSON.parse(process.env.MOSS_AGENT_DISCOVERY_ORIGINS ?? '{}')
  } catch {
    fail('DISCOVERY_CONFIGURATION_INVALID', 503)
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('DISCOVERY_CONFIGURATION_INVALID', 503)
  const values = (config as Record<string, unknown>)[orgId] ?? []
  if (!Array.isArray(values) || values.length > 20) fail('DISCOVERY_CONFIGURATION_INVALID', 503)
  return values.map(discoveryOrigin)
}
export function discoveryOrigin(value: unknown): string {
  let url: URL
  try {
    url = new URL(String(value))
  } catch {
    return fail('INVALID_DISCOVERY_ORIGIN')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    fail('INVALID_DISCOVERY_ORIGIN')
  return url.origin
}

export function discoveredAgent(input: {
  name: string
  platform: AssetMetadata['source_platform']
  instance: string
  id: string
  source: DiscoveryEvidence['source']
  sourceId: string
  recordId?: string
  snapshot: unknown
  external?: boolean
  hosting?: AssetMetadata['hosting']
  now: number
  note: string
  models?: string[]
}): DiscoveredAgent {
  const external = input.external === true
  return {
    metadata: {
      name: label(input.name),
      source_platform: input.platform,
      source_instance: label(input.instance, 300),
      source_agent_id: discoveryIdentifier(input.id),
      owner_user_id: null,
      department_id: null,
      purpose: '待负责人补充业务用途',
      domain: 'office',
      hosting: external ? 'public_saas' : (input.hosting ?? 'external_hosted'),
      requested_level: 'L0',
      data_connections: [],
      tool_refs: [],
      model_paths: input.models ?? [],
      risk_note: input.note,
    },
    observation: {
      source: input.source,
      source_id: input.sourceId,
      record_id: input.recordId ?? input.id,
      snapshot_digest: discoveryDigest(input.snapshot),
      observed_at: input.now,
      external_domain: external,
    },
  }
}

async function readJson(
  url: URL,
  token: string,
  headers: Record<string, string>,
  request: ProviderRequest,
): Promise<unknown> {
  const response = await request(url.toString(), {
    method: 'GET',
    headers: { ...headers, Authorization: `Bearer ${token}`, Accept: 'application/json', 'Cache-Control': 'no-store' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    await response.body?.cancel()
    fail('DISCOVERY_UPSTREAM_UNAVAILABLE', 502)
  }
  if (!response.body) fail('DISCOVERY_RESPONSE_INVALID', 502)
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 2_000_000) fail('DISCOVERY_RESPONSE_LIMIT', 502)
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/** Upstream data is projected to metadata; keys, prompts, model payloads and log content never enter the asset store. */
export async function scanDiscoverySource(
  source: DiscoverySource,
  token: string,
  request: ProviderRequest = fetch,
  now = Date.now(),
  csrfToken?: string,
): Promise<DiscoveredAgent[]> {
  const rows = new Map<string, DiscoveredAgent>()
  const add = (agent: DiscoveredAgent) => {
    rows.set(discoverySourceKey(agent.metadata), agent)
    if (rows.size > 10000) fail('DISCOVERY_SCAN_LIMIT')
  }
  if (source.kind === 'dify') {
    const headers: Record<string, string> = {}
    if (csrfToken) {
      if (!/^[A-Za-z0-9._~-]+$/.test(csrfToken) || !/^[A-Za-z0-9._~-]+$/.test(token))
        fail('INVALID_DISCOVERY_CREDENTIAL')
      headers.Cookie = `access_token=${token}; csrf_token=${csrfToken}`
      headers['X-CSRF-Token'] = csrfToken
    }
    // The console credential selects one workspace; verify it instead of trusting a display name.
    const verifyWorkspace = async () => {
      const data = object(await readJson(new URL('/console/api/workspaces', source.origin), token, headers, request))
      if (!Array.isArray(data.workspaces)) fail('DISCOVERY_RESPONSE_INVALID', 502)
      const current = data.workspaces.map(object).filter((row) => row.current === true)
      if (current.length !== 1 || current[0].id !== source.scope) fail('DISCOVERY_SCOPE_MISMATCH', 403)
    }
    await verifyWorkspace()
    for (let page = 1; page <= 100; page++) {
      const url = new URL('/console/api/apps', source.origin)
      url.search = new URLSearchParams({ page: String(page), limit: '100' }).toString()
      const data = object(await readJson(url, token, headers, request))
      if (!Array.isArray(data.data) || data.data.length > 100 || typeof data.has_more !== 'boolean')
        fail('DISCOVERY_RESPONSE_INVALID', 502)
      for (const raw of data.data) {
        const app = object(raw),
          id = discoveryIdentifier(app.id),
          name = label(app.name),
          mode = label(app.mode)
        add(
          discoveredAgent({
            name,
            platform: 'dify',
            instance: `${source.origin}/workspace/${source.scope}`,
            id,
            source: 'platform',
            sourceId: source.id,
            snapshot: { id, name, mode },
            external: source.external_domain,
            now,
            note: 'Dify 工作区应用清单可见；尚未核验模型、工具、数据和运行权限。',
          }),
        )
      }
      if (!data.has_more) {
        await verifyWorkspace()
        return [...rows.values()]
      }
      if (!data.data.length) fail('DISCOVERY_PAGINATION_INVALID', 502)
    }
  } else if (source.kind === 'router') {
    // The user-facing /api/log/query DTO omits token IDs. Use the real admin
    // ledger; token IDs are still candidates, not proof of an Agent identity.
    const to = Math.floor(now / 1000),
      from = to - 86400
    const accountResponse = object(await readJson(new URL('/api/user/self', source.origin), token, { 'New-Api-User': source.scope }, request))
    if (accountResponse.success !== true) fail('DISCOVERY_UPSTREAM_UNAVAILABLE', 502)
    const account = object(accountResponse.data)
    if (String(account.id) !== source.scope || typeof account.username !== 'string' || !account.username || account.username.includes('%')) fail('DISCOVERY_SCOPE_MISMATCH', 403)
    for (let page = 1; page <= 100; page++) {
      const url = new URL('/api/log/', source.origin)
      url.search = new URLSearchParams({
        username: account.username,
        type: '2',
        start_timestamp: String(from),
        end_timestamp: String(to),
        p: String(page),
        page_size: '100',
      }).toString()
      const response = object(await readJson(url, token, { 'New-Api-User': source.scope }, request))
      if (response.success !== true) fail('DISCOVERY_UPSTREAM_UNAVAILABLE', 502)
      const data = object(response.data),
        total = integer(data.total)
      if (total > 10000 || !Array.isArray(data.items) || data.items.length > 100) fail('DISCOVERY_SCAN_LIMIT')
      for (const raw of data.items) {
        const log = object(raw)
        if (String(log.user_id) !== source.scope) fail('DISCOVERY_SCOPE_MISMATCH', 403)
        if (Number(log.type) !== 2) continue
        const timestamp = integer(log.created_at)
        if (timestamp < from || timestamp > to) fail('DISCOVERY_SCOPE_MISMATCH', 403)
        const tokenId = integer(log.token_id)
        if (tokenId === 0) continue
        const id = `token-${tokenId}`,
          model = label(log.model_name)
        const previous = rows.get(discoveryId(['other', `${source.origin}/user/${source.scope}`, id]))
        const models = [...new Set([...(previous?.metadata.model_paths ?? []), model])].sort()
        if (models.length > 32) fail('DISCOVERY_SCAN_LIMIT')
        add(
          discoveredAgent({
            name: `Router 调用来源 ${id}`,
            platform: 'other',
            instance: `${source.origin}/user/${source.scope}`,
            id,
            source: 'router',
            sourceId: source.id,
            snapshot: { token_id: tokenId, models },
            models,
            now,
            note: '最近 24 小时 Router 消费日志中的 Token 调用来源；可能由多个程序共用，需负责人确认是否为 Agent。未据此赋予身份或成本归属。',
          }),
        )
      }
      if (page * 100 >= total) return [...rows.values()]
      if (!data.items.length) fail('DISCOVERY_PAGINATION_INVALID', 502)
    }
  } else {
    let after = ''
    for (let page = 0; page < 100; page++) {
      const url = new URL('/agent-inventory/v1/agents', source.origin)
      url.search = new URLSearchParams({ scope: source.scope, after }).toString()
      const data = parsePlatformDiscoveryPage(await readJson(url, token, {}, request))
      if (data.scope !== source.scope) fail('DISCOVERY_SCOPE_MISMATCH', 403)
      if (!Array.isArray(data.items) || data.items.length > 100) fail('DISCOVERY_RESPONSE_INVALID', 502)
      let last = after
      for (const raw of data.items) {
        const app = object(raw),
          id = discoveryIdentifier(app.id),
          name = label(app.name)
        if (id <= last) fail('DISCOVERY_PAGINATION_INVALID', 502)
        last = id
        if (!['langgraph', 'http', 'openai', 'mcp', 'a2a', 'saas', 'other'].includes(String(app.platform)))
          fail('DISCOVERY_RESPONSE_INVALID', 502)
        if (typeof app.external_domain !== 'boolean') fail('DISCOVERY_RESPONSE_INVALID', 502)
        const external = source.external_domain || app.external_domain || app.platform === 'saas'
        add(
          discoveredAgent({
            name,
            platform: app.platform as AssetMetadata['source_platform'],
            instance: `${source.origin}/scope/${source.scope}`,
            id,
            source: 'platform',
            sourceId: source.id,
            snapshot: { id, name, platform: app.platform, external_domain: external },
            external,
            now,
            note: external
              ? '平台标记为公有 SaaS／域外，仅建立 L0 台账；原平台权限及出口未纳管。'
              : '来源平台声明的应用清单；接入和运行能力仍待核验。',
          }),
        )
      }
      if (data.next_cursor === null) return [...rows.values()]
      if (data.next_cursor !== last || last === after) fail('DISCOVERY_PAGINATION_INVALID', 502)
      after = last
    }
  }
  return fail('DISCOVERY_SCAN_LIMIT')
}
