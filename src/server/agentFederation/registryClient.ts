import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import Ajv2020 from 'ajv/dist/2020.js'
import type { PlatformDiscoveryPage } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { assertResourceRef } from '@sudo/contracts/common/v1/resource-ref'
import schema from '../../../contracts/agent-registry/v1alpha1/schema.json' with { type: 'json' }
import { AGENT_REGISTRY_API, type CommandResult, type PrincipalRef, type RegistryWire, type Resolution, type SignedVersion, type VersionItem, type VersionsPage } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import type { AssetRecord, AssetPage, AssetHistory, InventoryWire } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { stableJson } from './provider/protocol.js'

export type RegistryCommand = Extract<RegistryWire, { request_id: string }>
export type InventoryCommand = Extract<InventoryWire, { request_id: string }>
export interface RegistryScope { trustDomain: string; zoneId: string }
export type RegistryRequest = (url: string, init: { method: string; redirect: 'error'; cache: 'no-store'; signal: AbortSignal; headers: Record<string, string>; body?: string }) => Promise<Response>
export interface RegistryClientOptions {
  endpoint: string
  token: string
  publicKeys: string[]
  organizations: Record<string, RegistryScope>
  request?: RegistryRequest
}
const RESOURCE_REF_ID = 'urn:sudo:contracts:common:v1:resource-ref'
const ajv = new Ajv2020({ strict: true, allErrors: false })
// Delegate the external reference to its installed owner adapter, without copying its schema.
ajv.addKeyword({ keyword: 'sudoResourceRef', schemaType: 'boolean', validate: (_schema: boolean, value: unknown) => {
  try { assertResourceRef(value); return true } catch { return false }
} })
ajv.addKeyword({ keyword: 'discriminator', valid: true })
ajv.addSchema({ $id: RESOURCE_REF_ID, sudoResourceRef: true })
ajv.addSchema(schema)
const validators = {
  PlatformDiscoveryPage: ajv.compile<PlatformDiscoveryPage>({ $ref: `${schema.$id}#/$defs/PlatformDiscoveryPage` }),
  SignedVersion: ajv.compile<SignedVersion>({ $ref: `${schema.$id}#/$defs/SignedVersion` }),
  CommandResult: ajv.compile<CommandResult>({ $ref: `${schema.$id}#/$defs/CommandResult` }),
  VersionsPage: ajv.compile<VersionsPage>({ $ref: `${schema.$id}#/$defs/VersionsPage` }),
  VersionItem: ajv.compile<VersionItem>({ $ref: `${schema.$id}#/$defs/VersionItem` }),
  Resolution: ajv.compile<Resolution>({ $ref: `${schema.$id}#/$defs/Resolution` }),
  PrincipalRef: ajv.compile<PrincipalRef>({ $ref: `${schema.$id}#/$defs/PrincipalRef` }),
  AssetRecord: ajv.compile<AssetRecord>({ $ref: `${schema.$id}#/$defs/AssetRecord` }),
  AssetPage: ajv.compile<AssetPage>({ $ref: `${schema.$id}#/$defs/AssetPage` }),
  AssetHistory: ajv.compile<AssetHistory>({ $ref: `${schema.$id}#/$defs/AssetHistory` }),
  InventoryCommand: ajv.compile<InventoryCommand>({ oneOf: ['SaveAsset', 'ObserveAsset', 'ClaimAsset', 'SubmitAsset', 'ReviewAsset', 'SuspendAsset', 'LinkAsset', 'MergeAsset', 'RecordAcceptance'].map(name => ({ $ref: `${schema.$id}#/$defs/${name}` })) }),
}
const hash = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
export function parsePlatformDiscoveryPage(value: unknown): PlatformDiscoveryPage {
  if (!validators.PlatformDiscoveryPage(value)) fail('DISCOVERY_RESPONSE_INVALID', 502)
  return value as PlatformDiscoveryPage
}
function fail(code: string, status = 503): never { throw new ExternalProviderError(status, code) }
export function parseInventoryCommand(value: unknown): InventoryCommand {
  if (!validators.InventoryCommand(value) || Buffer.byteLength(JSON.stringify(value)) > 65536) fail('INVALID_INVENTORY_COMMAND', 400)
  return value
}
function base64(value: string, limit = 90_000): Buffer {
  if (value.length > limit) fail('REGISTRY_SIGNATURE_INVALID')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) fail('REGISTRY_SIGNATURE_INVALID')
  return bytes
}

/** Trust is operator-configured; keys returned by a remote service are never imported. */
export class ProductRegistryClient {
  private readonly keys = new Map<string, KeyObject>()
  private readonly endpoint: string
  private readonly request: RegistryRequest
  private readonly scopes: Record<string, RegistryScope>
  constructor(private readonly options: RegistryClientOptions) {
    const url = new URL(options.endpoint)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) fail('REGISTRY_CONFIGURATION_INVALID', 500)
    if (!options.token || /[\r\n]/.test(options.token) || !options.publicKeys.length || !Object.keys(options.organizations).length) fail('REGISTRY_CONFIGURATION_INVALID', 500)
    this.endpoint = url.toString().replace(/\/$/, '')
    this.request = options.request ?? ((url, init) => fetch(url, init))
    this.scopes = structuredClone(options.organizations)
    for (const scope of Object.values(this.scopes)) {
      if (!validators.PrincipalRef({ trust_domain: scope.trustDomain, agent_name: 'validation' })) fail('REGISTRY_CONFIGURATION_INVALID', 500)
      assertResourceRef({ api_version: 'common.sudo.dev/v1', kind: 'ResourceRef', zone_id: scope.zoneId, path: '/' })
    }
    for (const pem of options.publicKeys) {
      const key = createPublicKey(pem)
      if (key.asymmetricKeyType !== 'ed25519') fail('REGISTRY_CONFIGURATION_INVALID', 500)
      const der = key.export({ format: 'der', type: 'spki' })
      this.keys.set(hash(der.subarray(-32)), key)
    }
  }
  scope(orgId: string): RegistryScope {
    const scope = this.scopes[orgId]
    if (!scope) fail('REGISTRY_ORGANIZATION_UNCONFIGURED', 403)
    return { ...scope }
  }
  identity(orgId: string): string { return hash(Buffer.from(JSON.stringify([this.endpoint, this.scope(orgId)]))) }
  principal(orgId: string, catalogId: string): PrincipalRef {
    const principal = { trust_domain: this.scope(orgId).trustDomain, agent_name: `external-${catalogId}` }
    if (!validators.PrincipalRef(principal)) fail('REGISTRY_CONFIGURATION_INVALID', 500)
    return principal
  }
  private path(ref: PrincipalRef): string { return `/${encodeURIComponent(ref.trust_domain)}/${encodeURIComponent(ref.agent_name)}` }
  verifyVersion(value: unknown, orgId: string, expected: PrincipalRef, version?: string): SignedVersion {
    if (!validators.SignedVersion(value) || value.algorithm !== 'Ed25519') fail('REGISTRY_SIGNATURE_INVALID')
    const key = this.keys.get(value.key_id)
    if (!key) fail('REGISTRY_SIGNATURE_INVALID')
    const payload = base64(value.payload_base64), signature = base64(value.signature_base64)
    if (payload.length > 65536 || signature.length !== 64 || hash(payload) !== value.digest || !verify(null, payload, key, signature)) fail('REGISTRY_SIGNATURE_INVALID')
    let decoded: unknown
    try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)) } catch { fail('REGISTRY_SIGNATURE_INVALID') }
    if (!isDeepStrictEqual(decoded, value.manifest) || value.manifest.api_version !== AGENT_REGISTRY_API || value.manifest.kind !== 'VersionManifest'
      || value.manifest.evidence !== 'signed_registration_only' || !isDeepStrictEqual(value.manifest.principal, expected)
      || (version !== undefined && value.manifest.version !== version)) fail('REGISTRY_SIGNATURE_INVALID')
    const zone = this.scope(orgId).zoneId
    if (value.manifest.spec_ref.digest !== value.manifest.spec_digest
      || [value.manifest.spec_ref, ...value.manifest.source_evidence_refs].some(ref => ref.zone_id !== zone || typeof ref.digest !== 'string')) fail('REGISTRY_REFERENCE_MISMATCH')
    return value
  }
  private async call(orgId: string, suffix: string, command?: unknown, apiRoot = '/api/v2/product-agents'): Promise<unknown> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await this.request(`${this.endpoint}${apiRoot}${suffix}`, {
        method: command ? 'POST' : 'GET', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.options.token}`, 'X-Nexus-Zone-ID': this.scope(orgId).zoneId, ...(command ? { 'Content-Type': 'application/json' } : {}) },
        ...(command ? { body: JSON.stringify(command) } : {}),
      })
      if (!response.body) fail('REGISTRY_RESPONSE_INVALID')
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.length
          if (size > 8 * 1024 * 1024) fail('REGISTRY_RESPONSE_LIMIT')
          chunks.push(next.value)
        }
      } finally { await reader.cancel().catch(() => {}) }
      let body: unknown
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail('REGISTRY_RESPONSE_INVALID') }
      if (!response.ok) {
        if (apiRoot === '/api/v2/files') {
          if ([409, 412].includes(response.status)) fail('REGISTRY_RESOURCE_PRECONDITION', 409)
          if (response.status === 404) fail('REGISTRY_RESOURCE_NOT_FOUND', 404)
          fail('REGISTRY_RESOURCE_UNAVAILABLE')
        }
        const code = (body as { detail?: { code?: unknown } })?.detail?.code
        if (typeof code === 'string' && /^(AGENT_|REGISTRY_|CHANNEL_|PRINCIPAL_|IMMUTABLE_|INVALID_|AMBIGUOUS_)[A-Z_]{1,64}$/.test(code)) fail(code, [400, 403, 404, 409].includes(response.status) ? response.status : 503)
        fail('REGISTRY_REQUEST_FAILED')
      }
      return body
    } catch (error) {
      if (error instanceof ExternalProviderError) throw error
      fail('REGISTRY_UNAVAILABLE')
    } finally { clearTimeout(timer) }
  }
  async readSnapshot(orgId: string, ref: Record<string, unknown>, minRevision?: string): Promise<unknown> {
    assertResourceRef(ref)
    if (ref.zone_id !== this.scope(orgId).zoneId || typeof ref.path !== 'string' || !ref.path.startsWith('/agent-snapshots/') || typeof ref.digest !== 'string') fail('REGISTRY_REFERENCE_MISMATCH')
    const query = new URLSearchParams({ path: ref.path, encoding: 'base64', ...(minRevision ? { min_revision: minRevision } : {}) })
    const result = await this.call(orgId, `/read?${query}`, undefined, '/api/v2/files') as { content?: unknown; encoding?: unknown }
    if (typeof result?.content !== 'string' || result.encoding !== 'base64') fail('REGISTRY_RESOURCE_INVALID')
    const content = base64(result.content, 180_000)
    if (hash(content) !== ref.digest) fail('REGISTRY_RESOURCE_DIGEST_MISMATCH')
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)) } catch { fail('REGISTRY_RESOURCE_INVALID') }
  }
  private inventoryRecord(value: unknown, orgId: string, id?: string): AssetRecord {
    if (!validators.AssetRecord(value) || value.owner_zone !== this.scope(orgId).zoneId || (id !== undefined && value.id !== id)
      || (value.principal && value.principal.trust_domain !== this.scope(orgId).trustDomain)
      || value.metadata_digest !== hash(Buffer.from(stableJson(value.metadata)))) fail('REGISTRY_RESPONSE_INVALID')
    return value
  }
  async inventoryCommand(orgId: string, command: InventoryCommand): Promise<AssetRecord> {
    parseInventoryCommand(command)
    if (command.kind === 'LinkAsset' && command.principal.trust_domain !== this.scope(orgId).trustDomain) fail('REGISTRY_ORGANIZATION_MISMATCH', 403)
    return this.inventoryRecord(await this.call(orgId, '/inventory/commands', command), orgId, command.asset_id)
  }
  async inventoryGet(orgId: string, id: string): Promise<AssetRecord> {
    return this.inventoryRecord(await this.call(orgId, `/inventory/assets/${encodeURIComponent(id)}`), orgId, id)
  }
  async inventoryList(orgId: string, after = '', owner?: string): Promise<AssetPage> {
    const query = new URLSearchParams({ after, ...(owner === undefined ? {} : { owner }) })
    const value = await this.call(orgId, `/inventory/assets?${query}`)
    if (!validators.AssetPage(value)) fail('REGISTRY_RESPONSE_INVALID')
    for (const row of value.items) {
      this.inventoryRecord(row, orgId)
      if (owner !== undefined && (row.metadata.owner_user_id ?? '') !== owner) fail('REGISTRY_RESPONSE_INVALID')
    }
    if (value.items.some((row, i) => row.id <= (i ? value.items[i - 1].id : after))
      || (value.next_cursor !== null && (!value.items.length || value.next_cursor !== value.items.at(-1)!.id))) fail('REGISTRY_RESPONSE_INVALID')
    return value
  }
  async inventoryHistory(orgId: string, id: string, after = 0): Promise<AssetHistory> {
    const value = await this.call(orgId, `/inventory/assets/${encodeURIComponent(id)}/history?after=${after}`)
    if (!validators.AssetHistory(value) || value.asset_id !== id
      || value.events.some((row, i) => row.revision <= (i ? value.events[i - 1].revision : after))
      || (value.next_revision !== null && (!value.events.length || value.next_revision !== value.events.at(-1)!.revision))) fail('REGISTRY_RESPONSE_INVALID')
    return value
  }
  async putSnapshot(orgId: string, ref: Record<string, unknown>, snapshot: unknown): Promise<void> {
    assertResourceRef(ref)
    if (ref.zone_id !== this.scope(orgId).zoneId || typeof ref.path !== 'string' || !ref.path.startsWith('/agent-snapshots/')) fail('REGISTRY_REFERENCE_MISMATCH')
    const content = Buffer.from(stableJson(snapshot))
    if (content.length > 128 * 1024 || hash(content) !== ref.digest) fail('REGISTRY_RESOURCE_DIGEST_MISMATCH')
    try { await this.readSnapshot(orgId, ref); return } catch (error) {
      if (!(error instanceof ExternalProviderError) || error.code !== 'REGISTRY_RESOURCE_NOT_FOUND') throw error
    }
    try { await this.call(orgId, '/mkdir', { path: ref.path.slice(0, ref.path.lastIndexOf('/')), parents: true }, '/api/v2/files') }
    catch (error) { if (!(error instanceof ExternalProviderError) || error.code !== 'REGISTRY_RESOURCE_PRECONDITION') throw error }
    let revision: string | undefined
    try {
      const written = await this.call(orgId, '/write', { path: ref.path, content: content.toString('base64'), encoding: 'base64', if_none_match: true }, '/api/v2/files') as { revision?: unknown }
      revision = typeof written.revision === 'string' ? written.revision : undefined
    } catch (error) { if (!(error instanceof ExternalProviderError) || error.code !== 'REGISTRY_RESOURCE_PRECONDITION') throw error }
    await this.readSnapshot(orgId, ref, revision)
  }
  async command(orgId: string, command: RegistryCommand): Promise<CommandResult> {
    if (command.principal.trust_domain !== this.scope(orgId).trustDomain) fail('REGISTRY_ORGANIZATION_MISMATCH', 403)
    const value = await this.call(orgId, '/commands', command)
    if (!validators.CommandResult(value) || value.api_version !== AGENT_REGISTRY_API || value.kind !== 'RegistryCommandResult'
      || value.principal.owner_zone !== this.scope(orgId).zoneId || !isDeepStrictEqual(value.principal.principal, command.principal)) fail('REGISTRY_RESPONSE_INVALID')
    if (value.version) this.verifyVersion(value.version, orgId, command.principal, 'version' in command ? command.version : undefined)
    return value
  }
  async versions(orgId: string, ref: PrincipalRef, after = ''): Promise<VersionsPage> {
    const value = await this.call(orgId, `${this.path(ref)}/versions?after=${encodeURIComponent(after)}`)
    if (!validators.VersionsPage(value) || value.api_version !== AGENT_REGISTRY_API || value.kind !== 'RegistryVersionsPage'
      || value.principal.owner_zone !== this.scope(orgId).zoneId || !isDeepStrictEqual(value.principal.principal, ref)) fail('REGISTRY_RESPONSE_INVALID')
    for (const item of value.items) {
      this.verifyVersion(item.version, orgId, ref)
      if (item.decision && item.decision.version !== item.version.manifest.version) fail('REGISTRY_RESPONSE_INVALID')
    }
    if (new Set(value.items.map(item => item.version.manifest.version)).size !== value.items.length
      || (value.next_cursor !== null && (value.next_cursor === after || !value.items.length))) fail('REGISTRY_RESPONSE_INVALID')
    return value
  }
  async version(orgId: string, ref: PrincipalRef, version: string): Promise<VersionItem> {
    const value = await this.call(orgId, `${this.path(ref)}/versions/${encodeURIComponent(version)}`)
    if (!validators.VersionItem(value)) fail('REGISTRY_RESPONSE_INVALID')
    this.verifyVersion(value.version, orgId, ref, version)
    if (value.decision && value.decision.version !== version) fail('REGISTRY_RESPONSE_INVALID')
    return value
  }
  async resolve(orgId: string, ref: PrincipalRef, selector: { version?: string; channel?: string } = {}): Promise<Resolution> {
    const query = new URLSearchParams(Object.entries(selector).filter((entry): entry is [string, string] => entry[1] !== undefined))
    const value = await this.call(orgId, `${this.path(ref)}/resolve?${query}`)
    if (!validators.Resolution(value) || value.api_version !== AGENT_REGISTRY_API || value.kind !== 'RegistryResolution'
      || !isDeepStrictEqual(value.principal.principal, ref) || value.principal.owner_zone !== this.scope(orgId).zoneId || value.principal.status !== 'active') fail('REGISTRY_RESPONSE_INVALID')
    this.verifyVersion(value.version, orgId, ref, selector.version)
    const now = Date.now()
    if (Math.abs(now - value.evaluated_at) > 30_000 || value.approval.decision !== 'approved' || value.approval.version !== value.version.manifest.version
      || value.approval.expires_at === null || value.approval.expires_at <= now) fail('AGENT_VERSION_APPROVAL_EXPIRED', 409)
    if (value.channel && (!value.channel.enabled || value.channel.version !== value.version.manifest.version || value.channel.spec_digest !== value.version.manifest.spec_digest
      || value.channel.name !== (selector.channel ?? 'stable'))) fail('REGISTRY_RESPONSE_INVALID')
    if (!selector.version && !value.channel) fail('REGISTRY_RESPONSE_INVALID')
    return value
  }
}
