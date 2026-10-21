import type { ObserveSourceEvaluation, CreateMigrationPolicy, MigrationPolicy, MigrationPolicyPage, MigrationComparison, StartHostedEvaluation, HostedEvaluationRun, HostedEvaluationCase, HostedEvaluationPage, HostedEvaluationCasePage, HostedEvaluationClaim, EvaluationCaseLease, CompleteHostedEvaluationCase } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import Ajv2020 from 'ajv/dist/2020.js'
import type { EvaluationDataset, EvaluationDatasetPage, RegisterEvaluationDataset } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import type { PlatformDiscoveryPage } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import type { DifyTextPlan, HostedArtifact, HostedArtifactPage, RegisterHostedArtifact } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import type { RevokeExecutionRequest, ExecutionRequestRevocation, CheckExecutionGrant, ExecutionAuthorization, ExecutionGrant, ExecutionGrantPage, ExecutionGrantResult, IssueExecutionGrant } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { assertResourceRef } from '@sudo/contracts/common/v1/resource-ref'
import schema from '../../../contracts/agent-registry/v1alpha1/schema.json' with { type: 'json' }
import { AGENT_REGISTRY_API, type CommandResult, type PrincipalRef, type RegistryWire, type Resolution, type SignedVersion, type VersionItem, type VersionsPage } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import type { AssetRecord, AssetPage, AssetHistory, InventoryWire } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { stableJson } from './provider/protocol.js'

export type RegistryCommand = Extract<RegistryWire, { request_id: string }>
export type InventoryCommand = Extract<InventoryWire, { request_id: string }>
export class DifySourceError extends ExternalProviderError {
  constructor(code: string, readonly fieldPath: string) { super(400, code) }
}
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
// JSON Schema password format is a redaction/display hint, not a new credential format.
ajv.addFormat('password', { type: 'string', validate: () => true })
// Delegate the external reference to its installed owner adapter, without copying its schema.
ajv.addKeyword({ keyword: 'sudoResourceRef', schemaType: 'boolean', validate: (_schema: boolean, value: unknown) => {
  try { assertResourceRef(value); return true } catch { return false }
} })
ajv.addKeyword({ keyword: 'discriminator', valid: true })
ajv.addSchema({ $id: RESOURCE_REF_ID, sudoResourceRef: true })
ajv.addSchema(schema)
const validators = {
  RevokeExecutionRequest: ajv.compile<RevokeExecutionRequest>({ $ref: `${schema.$id}#/$defs/RevokeExecutionRequest` }),
  ExecutionRequestRevocation: ajv.compile<ExecutionRequestRevocation>({ $ref: `${schema.$id}#/$defs/ExecutionRequestRevocation` }),
  ObserveSourceEvaluation: ajv.compile<ObserveSourceEvaluation>({ $ref: `${schema.$id}#/$defs/ObserveSourceEvaluation` }),
  CreateMigrationPolicy: ajv.compile<CreateMigrationPolicy>({ $ref: `${schema.$id}#/$defs/CreateMigrationPolicy` }),
  MigrationPolicy: ajv.compile<MigrationPolicy>({ $ref: `${schema.$id}#/$defs/MigrationPolicy` }),
  MigrationPolicyPage: ajv.compile<MigrationPolicyPage>({ $ref: `${schema.$id}#/$defs/MigrationPolicyPage` }),
  MigrationComparison: ajv.compile<MigrationComparison>({ $ref: `${schema.$id}#/$defs/MigrationComparison` }),
  StartHostedEvaluation: ajv.compile<StartHostedEvaluation>({ $ref: `${schema.$id}#/$defs/StartHostedEvaluation` }),
  HostedEvaluationRun: ajv.compile<HostedEvaluationRun>({ $ref: `${schema.$id}#/$defs/HostedEvaluationRun` }),
  HostedEvaluationCase: ajv.compile<HostedEvaluationCase>({ $ref: `${schema.$id}#/$defs/HostedEvaluationCase` }),
  HostedEvaluationPage: ajv.compile<HostedEvaluationPage>({ $ref: `${schema.$id}#/$defs/HostedEvaluationPage` }),
  HostedEvaluationCasePage: ajv.compile<HostedEvaluationCasePage>({ $ref: `${schema.$id}#/$defs/HostedEvaluationCasePage` }),
  HostedEvaluationClaim: ajv.compile<HostedEvaluationClaim>({ $ref: `${schema.$id}#/$defs/HostedEvaluationClaim` }),
  EvaluationCaseLease: ajv.compile<EvaluationCaseLease>({ $ref: `${schema.$id}#/$defs/EvaluationCaseLease` }),
  CompleteHostedEvaluationCase: ajv.compile<CompleteHostedEvaluationCase>({ $ref: `${schema.$id}#/$defs/CompleteHostedEvaluationCase` }),

  EvaluationDataset: ajv.compile<EvaluationDataset>({ $ref: `${schema.$id}#/$defs/EvaluationDataset` }),
  EvaluationDatasetPage: ajv.compile<EvaluationDatasetPage>({ $ref: `${schema.$id}#/$defs/EvaluationDatasetPage` }),
  RegisterEvaluationDataset: ajv.compile<RegisterEvaluationDataset>({ $ref: `${schema.$id}#/$defs/RegisterEvaluationDataset` }),
  DifyTextPlan: ajv.compile<DifyTextPlan>({ $ref: `${schema.$id}#/$defs/DifyTextPlan` }),
  HostedArtifact: ajv.compile<HostedArtifact>({ $ref: `${schema.$id}#/$defs/HostedArtifact` }),
  HostedArtifactPage: ajv.compile<HostedArtifactPage>({ $ref: `${schema.$id}#/$defs/HostedArtifactPage` }),
  RegisterHostedArtifact: ajv.compile<RegisterHostedArtifact>({ $ref: `${schema.$id}#/$defs/RegisterHostedArtifact` }),
  IssueExecutionGrant: ajv.compile<IssueExecutionGrant>({ $ref: `${schema.$id}#/$defs/IssueExecutionGrant` }),
  CheckExecutionGrant: ajv.compile<CheckExecutionGrant>({ $ref: `${schema.$id}#/$defs/CheckExecutionGrant` }),
  ExecutionGrant: ajv.compile<ExecutionGrant>({ $ref: `${schema.$id}#/$defs/ExecutionGrant` }),
  ExecutionGrantResult: ajv.compile<ExecutionGrantResult>({ $ref: `${schema.$id}#/$defs/ExecutionGrantResult` }),
  ExecutionGrantPage: ajv.compile<ExecutionGrantPage>({ $ref: `${schema.$id}#/$defs/ExecutionGrantPage` }),
  ExecutionAuthorization: ajv.compile<ExecutionAuthorization>({ $ref: `${schema.$id}#/$defs/ExecutionAuthorization` }),
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
  private async call(orgId: string, suffix: string, command?: unknown, apiRoot = '/api/v2/product-agents', rawSource?: string): Promise<unknown> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await this.request(`${this.endpoint}${apiRoot}${suffix}`, {
        method: command || rawSource !== undefined ? 'POST' : 'GET', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.options.token}`, 'X-Nexus-Zone-ID': this.scope(orgId).zoneId, ...(rawSource !== undefined ? { 'Content-Type': 'application/yaml' } : command ? { 'Content-Type': 'application/json' } : {}) },
        ...(rawSource !== undefined ? { body: rawSource } : command ? { body: JSON.stringify(command) } : {}),
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
        const fieldPath = (body as { detail?: { path?: unknown } })?.detail?.path
        if (response.status === 400 && typeof code === 'string' && /^DIFY_[A-Z_]{1,64}$/.test(code)
          && typeof fieldPath === 'string' && /^[A-Za-z0-9_.$\[\]]{1,160}$/.test(fieldPath)) throw new DifySourceError(code, fieldPath)
        if (typeof code === 'string' && /^(EVALUATION_|HOSTED_|DIFY_|EXECUTION_|AGENT_|REGISTRY_|CHANNEL_|PRINCIPAL_|IMMUTABLE_|INVALID_|AMBIGUOUS_)[A-Z_]{1,64}$/.test(code)) fail(code, [400, 401, 403, 404, 409, 413].includes(response.status) ? response.status : 503)
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
    const content = base64(result.content, 750_000)
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
  async hostedInspectDify(orgId: string, source: string): Promise<DifyTextPlan> {
    if (typeof source !== 'string' || !source || Buffer.byteLength(source) > 256000) fail('DIFY_SOURCE_SIZE', 400)
    const value = await this.call(orgId, '/hosted/dify/inspect', undefined, undefined, source)
    if (!validators.DifyTextPlan(value) || value.source_digest !== hash(Buffer.from(source))) fail('HOSTED_RESPONSE_INVALID')
    return value
  }
  private hostedArtifact(orgId: string, value: unknown, assetId?: string, id?: string): HostedArtifact {
    if (!validators.HostedArtifact(value) || value.zone !== this.scope(orgId).zoneId
      || (assetId !== undefined && value.asset_id !== assetId) || (id !== undefined && value.id !== id)
      || (value.image.profile === 'dify-0.6.0-linear-text-v1') !== (value.dify_plan !== null)
      || (value.dify_plan && value.image.max_output_tokens !== (value.dify_plan.max_tokens ?? 128))
      || (value.dify_plan && (value.dify_plan.source_digest !== value.image.source_digest || value.dify_plan.source_model !== value.image.model_name))) fail('HOSTED_RESPONSE_INVALID')
    const payload = base64(value.spec_payload_base64, 750000)
    if (hash(payload) !== value.spec_digest) fail('HOSTED_RESPONSE_INVALID')
    let decoded: unknown
    try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)) } catch { fail('HOSTED_RESPONSE_INVALID') }
    if (!isDeepStrictEqual(decoded, { image: value.image, dify_plan: value.dify_plan })) fail('HOSTED_RESPONSE_INVALID')
    return value
  }
  async hostedRegister(orgId: string, command: RegisterHostedArtifact): Promise<HostedArtifact> {
    if (!validators.RegisterHostedArtifact(command) || Buffer.byteLength(JSON.stringify(command)) > 1024000) fail('INVALID_HOSTED_ARTIFACT', 400)
    const value = this.hostedArtifact(orgId, await this.call(orgId, '/hosted/artifacts', command), command.asset_id)
    if (value.metadata_digest !== command.metadata_digest || value.initiated_by !== command.initiated_by
      || !isDeepStrictEqual(value.image, { api_version: AGENT_REGISTRY_API, kind: 'HostedImage', protocol: 'agent-hosted-stdio/v1', max_output_tokens: 128, ...command.image })) fail('HOSTED_RESPONSE_INVALID')
    return value
  }
  async hostedList(orgId: string, assetId: string, after = ''): Promise<HostedArtifactPage> {
    const value = await this.call(orgId, `/hosted/artifacts?${new URLSearchParams({ asset_id: assetId, after })}`)
    if (!validators.HostedArtifactPage(value)) fail('HOSTED_RESPONSE_INVALID')
    for (const row of value.items) this.hostedArtifact(orgId, row, assetId)
    if (value.items.some((row, i) => row.id <= (i ? value.items[i - 1].id : after))
      || (value.next_cursor !== null && value.next_cursor !== value.items.at(-1)?.id)) fail('HOSTED_RESPONSE_INVALID')
    return value
  }
  async hostedGet(orgId: string, id: string): Promise<HostedArtifact> {
    return this.hostedArtifact(orgId, await this.call(orgId, `/hosted/artifacts/${encodeURIComponent(id)}`), undefined, id)
  }
  private evaluationDataset(orgId: string, value: unknown, assetId?: string, id?: string): EvaluationDataset {
    if (!validators.EvaluationDataset(value) || value.zone !== this.scope(orgId).zoneId
      || (assetId !== undefined && value.asset_id !== assetId) || (id !== undefined && value.id !== id)
      || new Set(value.dataset.cases.map(row => row.id)).size !== value.dataset.cases.length
      || value.dataset_digest !== hash(Buffer.from(stableJson(value.dataset)))) fail('EVALUATION_RESPONSE_INVALID')
    // Semantics are fixed by the owner exact-strip-v1 profile, not supplied by callers.
    const rubric = { id: 'exact-strip-v1', comparison: 'strip-leading-trailing-ASCII-whitespace-U0009-U000D-U0020-exact-case-sensitive', denominator: 'all-cases-including-errors', aggregation: 'passed-cases/total-cases' }
    if (value.rubric_digest !== hash(Buffer.from(stableJson(rubric)))) fail('EVALUATION_RESPONSE_INVALID')
    return value
  }
  async evaluationDatasetRegister(orgId: string, command: RegisterEvaluationDataset): Promise<EvaluationDataset> {
    const normalized = { api_version: AGENT_REGISTRY_API, kind: 'RegisterEvaluationDataset', ...command,
      dataset: { input_scope: 'synthetic_text', rubric: 'exact-strip-v1', ...command.dataset } }
    if (!validators.RegisterEvaluationDataset(normalized) || Buffer.byteLength(JSON.stringify(normalized)) > 600000) fail('INVALID_EVALUATION_DATASET', 400)
    const value = this.evaluationDataset(orgId, await this.call(orgId, '/hosted/datasets', normalized), command.asset_id)
    if (value.metadata_digest !== command.metadata_digest || value.initiated_by !== command.initiated_by || !isDeepStrictEqual(value.dataset, normalized.dataset)) fail('EVALUATION_RESPONSE_INVALID')
    return value
  }
  async evaluationDatasetGet(orgId: string, id: string): Promise<EvaluationDataset> {
    return this.evaluationDataset(orgId, await this.call(orgId, `/hosted/datasets/${encodeURIComponent(id)}`), undefined, id)
  }
  async evaluationDatasetList(orgId: string, assetId: string, after = ''): Promise<EvaluationDatasetPage> {
    const value = await this.call(orgId, `/hosted/datasets?${new URLSearchParams({ asset_id: assetId, after })}`)
    if (!validators.EvaluationDatasetPage(value)) fail('EVALUATION_RESPONSE_INVALID')
    for (const row of value.items) this.evaluationDataset(orgId, row, assetId)
    if (value.items.some((row, i) => row.id <= (i ? value.items[i - 1].id : after))
      || (value.next_cursor !== null && value.next_cursor !== value.items.at(-1)?.id)) fail('EVALUATION_RESPONSE_INVALID')
    return value
  }
  private evaluationRun(orgId: string, value: unknown, assetId?: string, id?: string): HostedEvaluationRun {
    if (!validators.HostedEvaluationRun(value) || value.zone !== this.scope(orgId).zoneId
      || (assetId !== undefined && value.asset_id !== assetId) || (id !== undefined && value.id !== id)
      || value.queued_cases + value.running_cases + value.finished_cases !== value.total_cases
      || value.passed_cases > value.finished_cases || value.running_cases > 1
      || ((value.role === 'source_baseline') !== (value.source_runtime != null))
      || (value.role === 'source_baseline' && value.comparison_policy_id != null)
      || value.status !== (!value.queued_cases && !value.running_cases ? 'finished' : value.queued_cases === value.total_cases ? 'queued' : 'running')) fail('EVALUATION_RESPONSE_INVALID')
    return value
  }
  private evaluationCase(value: unknown, runId: string): HostedEvaluationCase {
    if (!validators.HostedEvaluationCase(value) || value.run_id !== runId
      || (value.trace_digest != null && value.trace_digest !== hash(Buffer.from(stableJson(value.trace))))
      || (value.passed && value.status !== 'succeeded')
      || (value.status === 'succeeded' && (value.answer == null || !value.cleanup_confirmed || !value.iam_cleanup_confirmed))) fail('EVALUATION_RESPONSE_INVALID')
    return value
  }
  async evaluationStart(orgId: string, command: StartHostedEvaluation): Promise<HostedEvaluationRun> {
    const normalized = { api_version: AGENT_REGISTRY_API, kind: 'StartHostedEvaluation', timeout_seconds: 120, max_model_calls: 1, role: 'hosted', source_runtime: null, comparison_policy_id: null, ...command }
    if (!validators.StartHostedEvaluation(normalized)) fail('INVALID_EVALUATION_REQUEST', 400)
    const value = this.evaluationRun(orgId, await this.call(orgId, '/hosted/evaluations', normalized), command.asset_id)
    for (const key of ['metadata_digest', 'artifact_id', 'dataset_id', 'initiated_by', 'timeout_seconds', 'max_model_calls'] as const)
      if (value[key] !== normalized[key]) fail('EVALUATION_RESPONSE_INVALID')
    if ((value.role ?? 'hosted') !== normalized.role || !isDeepStrictEqual(value.source_runtime ?? null, normalized.source_runtime)
      || (value.comparison_policy_id ?? null) !== normalized.comparison_policy_id) fail('EVALUATION_RESPONSE_INVALID')
    return value
  }
  private migrationPolicy(orgId: string, value: unknown, id?: string, assetId?: string): MigrationPolicy {
    if (!validators.MigrationPolicy(value) || value.zone !== this.scope(orgId).zoneId
      || (id !== undefined && value.id !== id) || (assetId !== undefined && value.asset_id !== assetId)
      || value.baseline_passed > value.total_cases) fail('EVALUATION_POLICY_RESPONSE_INVALID')
    return value
  }
  async migrationPolicyCreate(orgId: string, command: CreateMigrationPolicy): Promise<MigrationPolicy> {
    if (!validators.CreateMigrationPolicy(command)) fail('INVALID_EVALUATION_POLICY', 400)
    const policy = this.migrationPolicy(orgId, await this.call(orgId, '/hosted/migration/policies', command))
    for (const field of ['baseline_run_id', 'minimum_pass_bps', 'maximum_drop_bps', 'initiated_by'] as const)
      if (policy[field] !== command[field]) fail('EVALUATION_POLICY_RESPONSE_INVALID')
    return policy
  }
  async migrationPolicyGet(orgId: string, id: string): Promise<MigrationPolicy> {
    return this.migrationPolicy(orgId, await this.call(orgId, `/hosted/migration/policies/${encodeURIComponent(id)}`), id)
  }
  async migrationPolicyList(orgId: string, assetId: string, after = ''): Promise<MigrationPolicyPage> {
    const page = await this.call(orgId, `/hosted/migration/policies?${new URLSearchParams({ asset_id: assetId, after })}`)
    if (!validators.MigrationPolicyPage(page)) fail('EVALUATION_POLICY_RESPONSE_INVALID')
    page.items.forEach(row => this.migrationPolicy(orgId, row, undefined, assetId))
    if (page.items.some((row, i) => row.id <= (i ? page.items[i - 1].id : after))
      || (page.next_cursor !== null && page.next_cursor !== page.items.at(-1)?.id)) fail('EVALUATION_POLICY_RESPONSE_INVALID')
    return page
  }
  private migrationComparison(orgId: string, value: unknown, id?: string, runId?: string): MigrationComparison {
    if (!validators.MigrationComparison(value) || value.zone !== this.scope(orgId).zoneId
      || (id !== undefined && value.id !== id) || (runId !== undefined && value.candidate_run_id !== runId)
      || value.baseline_passed > value.total_cases || value.candidate_passed > value.total_cases
      || value.passed !== (value.candidate_passed * 10000 >= value.minimum_pass_bps * value.total_cases
        && (value.baseline_passed - value.candidate_passed) * 10000 <= value.maximum_drop_bps * value.total_cases)) fail('EVALUATION_COMPARISON_RESPONSE_INVALID')
    return value
  }
  async migrationCompare(orgId: string, runId: string): Promise<MigrationComparison> {
    return this.migrationComparison(orgId, await this.call(orgId, `/hosted/evaluations/${encodeURIComponent(runId)}/compare`, {}), undefined, runId)
  }
  async migrationComparisonGet(orgId: string, id: string): Promise<MigrationComparison> {
    return this.migrationComparison(orgId, await this.call(orgId, `/hosted/migration/comparisons/${encodeURIComponent(id)}`), id)
  }
  async evaluationGet(orgId: string, id: string): Promise<HostedEvaluationRun> {
    return this.evaluationRun(orgId, await this.call(orgId, `/hosted/evaluations/${encodeURIComponent(id)}`), undefined, id)
  }
  async evaluationList(orgId: string, assetId: string, after = ''): Promise<HostedEvaluationPage> {
    const value = await this.call(orgId, `/hosted/evaluations?${new URLSearchParams({ asset_id: assetId, after })}`)
    if (!validators.HostedEvaluationPage(value)) fail('EVALUATION_RESPONSE_INVALID')
    for (const row of value.items) this.evaluationRun(orgId, row, assetId)
    this.evaluationCursor(value, after)
    return value
  }
  private evaluationCursor(value: {items: {id: string}[]; next_cursor: string | null}, after: string) {
    if (value.items.some((row, i) => row.id <= (i ? value.items[i - 1].id : after))
      || (value.next_cursor !== null && value.next_cursor !== value.items.at(-1)?.id)) fail('EVALUATION_RESPONSE_INVALID')
  }
  async evaluationCases(orgId: string, runId: string, after = ''): Promise<HostedEvaluationCasePage> {
    const value = await this.call(orgId, `/hosted/evaluations/${encodeURIComponent(runId)}/cases?${new URLSearchParams({ after })}`)
    if (!validators.HostedEvaluationCasePage(value)) fail('EVALUATION_RESPONSE_INVALID')
    for (const row of value.items) this.evaluationCase(row, runId)
    this.evaluationCursor(value, after)
    return value
  }
  async evaluationClaim(orgId: string, runId: string): Promise<HostedEvaluationClaim | null> {
    const value = await this.call(orgId, `/hosted/evaluations/${encodeURIComponent(runId)}/claim`, {})
    if (value === null) return null
    if (!validators.HostedEvaluationClaim(value) || value.case.status !== 'running') fail('EVALUATION_RESPONSE_INVALID')
    this.evaluationCase(value.case, runId)
    return value
  }
  async evaluationGrant(orgId: string, runId: string, command: EvaluationCaseLease): Promise<ExecutionGrantResult> {
    if (!validators.EvaluationCaseLease(command)) fail('INVALID_EVALUATION_REQUEST', 400)
    const value = await this.call(orgId, `/hosted/evaluations/${encodeURIComponent(runId)}/grant`, command)
    if (!validators.ExecutionGrantResult(value)) fail('EVALUATION_RESPONSE_INVALID')
    this.executionGrant(value.grant, orgId)
    if (value.grant.request.task_id !== command.case_id || value.grant.request.request_id !== `evaluation-${command.case_id}`
      || (value.api_key != null && (value.grant.status !== 'active' || !/^sk-[A-Za-z0-9_-]{16,}$/.test(value.api_key)))) fail('EVALUATION_RESPONSE_INVALID')
    return value
  }
  async evaluationObserveSource(orgId: string, runId: string, command: ObserveSourceEvaluation): Promise<HostedEvaluationCase> {
    if (!validators.ObserveSourceEvaluation(command)) fail('INVALID_EVALUATION_REQUEST', 400)
    const value = this.evaluationCase(await this.call(orgId, `/hosted/evaluations/${encodeURIComponent(runId)}/source`, command), runId)
    if (value.id !== command.case_id || !isDeepStrictEqual(value.source_execution, { task_id: null, workflow_run_id: null, conversation_id: null, message_id: null, origin: 'source_reported', ...command.source_execution })) fail('EVALUATION_RESPONSE_INVALID')
    return value
  }
  async evaluationComplete(orgId: string, runId: string, command: CompleteHostedEvaluationCase): Promise<HostedEvaluationCase> {
    if (!validators.CompleteHostedEvaluationCase(command)) fail('INVALID_EVALUATION_REQUEST', 400)
    const value = this.evaluationCase(await this.call(orgId, `/hosted/evaluations/${encodeURIComponent(runId)}/complete`, command), runId)
    if (value.id !== command.case_id || value.status !== command.status) fail('EVALUATION_RESPONSE_INVALID')
    return value
  }
  async evaluationReconcile(orgId: string, runId: string): Promise<HostedEvaluationRun> {
    return this.evaluationRun(orgId, await this.call(orgId, `/hosted/evaluations/${encodeURIComponent(runId)}/reconcile`, {}), undefined, runId)
  }
  async evaluationStop(orgId: string, runId: string): Promise<HostedEvaluationRun> {
    return this.evaluationRun(orgId, await this.call(orgId, `/hosted/evaluations/${encodeURIComponent(runId)}/stop`, {}), undefined, runId)
  }
  private executionGrant(value: unknown, orgId: string, id?: string): ExecutionGrant {
    if (!validators.ExecutionGrant(value) || value.zone !== this.scope(orgId).zoneId || (id !== undefined && value.id !== id)
      || value.expires_at <= value.created_at || value.expires_at - value.created_at > 300_000
      || value.created_at > Date.now() + 5000
      || (value.status === 'active' && (!value.key_id || !value.delegation_id || value.cleanup_pending))) fail('EXECUTION_RESPONSE_INVALID')
    return value
  }
  /** Trusted server callers only. Never expose the returned key to browser management routes. */
  async executionIssue(orgId: string, command: IssueExecutionGrant): Promise<ExecutionGrantResult> {
    const normalized: IssueExecutionGrant = { api_version: AGENT_REGISTRY_API, kind: 'IssueExecutionGrant', version: null, dataset_digest: null, ttl_seconds: 120, max_model_calls: 8, ...command }
    if (!validators.IssueExecutionGrant(normalized)) fail('INVALID_EXECUTION_REQUEST', 400)
    const value = await this.call(orgId, '/execution/grants', normalized)
    if (!validators.ExecutionGrantResult(value)) fail('EXECUTION_RESPONSE_INVALID')
    const grant = this.executionGrant(value.grant, orgId)
    if (!isDeepStrictEqual(grant.request, normalized)
      || (value.api_key != null && (grant.status !== 'active' || grant.expires_at <= Date.now() || !/^sk-[A-Za-z0-9_-]{16,}$/.test(value.api_key)))) fail('EXECUTION_RESPONSE_INVALID')
    return value
  }
  async executionGet(orgId: string, id: string): Promise<ExecutionGrant> {
    return this.executionGrant(await this.call(orgId, `/execution/grants/${encodeURIComponent(id)}`), orgId, id)
  }
  async executionList(orgId: string, assetId?: string, after = ''): Promise<ExecutionGrantPage> {
    const query = new URLSearchParams({ after, ...(assetId ? { asset_id: assetId } : {}) })
    const value = await this.call(orgId, `/execution/grants?${query}`)
    if (!validators.ExecutionGrantPage(value)) fail('EXECUTION_RESPONSE_INVALID')
    for (const row of value.items) {
      this.executionGrant(row, orgId)
      if (assetId !== undefined && row.request.asset_id !== assetId) fail('EXECUTION_RESPONSE_INVALID')
    }
    if (value.items.some((row, i) => row.id <= (i ? value.items[i - 1].id : after))
      || (value.next_cursor !== null && (!value.items.length || value.next_cursor !== value.items.at(-1)!.id))) fail('EXECUTION_RESPONSE_INVALID')
    return value
  }
  async executionRevokeRequest(orgId: string, requestId: string, taskId: string): Promise<ExecutionRequestRevocation> {
    const command: RevokeExecutionRequest = { api_version: AGENT_REGISTRY_API, kind: 'RevokeExecutionRequest', request_id: requestId, task_id: taskId }
    if (!validators.RevokeExecutionRequest(command)) fail('INVALID_EXECUTION_REQUEST', 400)
    const value = await this.call(orgId, '/execution/requests/revoke', command)
    if (!validators.ExecutionRequestRevocation(value) || value.zone !== this.scope(orgId).zoneId || value.request_id !== requestId
      || value.task_id !== taskId || value.fenced_at > Date.now() + 5000 || value.grants.length > 64
      || new Set(value.grants.map(row => row.id)).size !== value.grants.length
      || value.cleanup_pending !== value.grants.some(row => row.cleanup_pending)) fail('EXECUTION_RESPONSE_INVALID')
    for (const row of value.grants) {
      this.executionGrant(row, orgId)
      if (row.status !== 'revoked' || row.request.request_id !== requestId || row.request.task_id !== taskId) fail('EXECUTION_RESPONSE_INVALID')
    }
    return value
  }
  async executionRevoke(orgId: string, id: string): Promise<ExecutionGrant> {
    const value = this.executionGrant(await this.call(orgId, `/execution/grants/${encodeURIComponent(id)}/revoke`, {}), orgId, id)
    if (value.status !== 'revoked') fail('EXECUTION_RESPONSE_INVALID')
    return value
  }
  async executionAuthorize(orgId: string, command: CheckExecutionGrant): Promise<ExecutionAuthorization> {
    if (!validators.CheckExecutionGrant(command)) fail('INVALID_EXECUTION_REQUEST', 400)
    const value = await this.call(orgId, '/execution/authorize', command)
    if (!validators.ExecutionAuthorization(value) || value.cacheable !== false || Math.abs(Date.now() - value.authorized_at) > 5000) fail('EXECUTION_RESPONSE_INVALID')
    const grant = this.executionGrant(value.grant, orgId, command.grant_id)
    if (grant.status !== 'active' || grant.expires_at <= Date.now() || grant.request.task_id !== command.task_id
      || grant.request.spec_digest !== command.spec_digest
      || !grant.request.permissions.some(p => isDeepStrictEqual(p, command.permission))) fail('EXECUTION_RESPONSE_INVALID')
    return value
  }
  async putSnapshot(orgId: string, ref: Record<string, unknown>, snapshot: unknown): Promise<void> {
    const content = Buffer.from(stableJson(snapshot))
    if (content.length > 128 * 1024) fail('REGISTRY_RESOURCE_DIGEST_MISMATCH')
    await this.putSnapshotContent(orgId, { ...ref }, content)
  }
  /** Keep the owner bytes that were evaluated; JS reserialization changes Python floats. */
  async putHostedSnapshot(orgId: string, ref: Record<string, unknown>, artifact: HostedArtifact): Promise<void> {
    const validated = this.hostedArtifact(orgId, artifact)
    if (ref.digest !== validated.spec_digest) fail('REGISTRY_RESOURCE_DIGEST_MISMATCH')
    await this.putSnapshotContent(orgId, { ...ref }, base64(validated.spec_payload_base64, 750000))
  }
  private async putSnapshotContent(orgId: string, ref: Record<string, unknown>, content: Buffer): Promise<void> {
    assertResourceRef(ref)
    if (ref.zone_id !== this.scope(orgId).zoneId || typeof ref.path !== 'string' || !ref.path.startsWith('/agent-snapshots/')) fail('REGISTRY_REFERENCE_MISMATCH')
    if (content.length > 562_500 || hash(content) !== ref.digest) fail('REGISTRY_RESOURCE_DIGEST_MISMATCH')
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
