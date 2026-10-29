import { randomUUID } from 'node:crypto'
import type { ExecutionGrant } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import type { McpStore } from '../mcp/db.js'
import type { McpAuthSecretsApi } from '../mcp/authResolver.js'
import { ReviewedMcpAccess, mcpServerDigest } from '../mcp/reviewedAccess.js'
import type { VisibilityFilter } from '../visibilityFilter.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import type { ProductRegistryClient } from './registryClient.js'
import { assertAssetOpen } from './assetControlStore.js'
import { ToolProtocol, toolFailure, validateToolArguments, type ToolConnection, type ToolDescriptor } from './toolProtocol.js'
import { ToolGatewayStore, type ReviewedTool } from './toolGatewayStore.js'
import { contentDigest } from './provider/protocol.js'

interface ToolInput { call_id: string; grant_id: string; task_id: string; spec_digest: string; resource: string; arguments: Record<string, unknown> }
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,149}$/.test(value)
const resourceFor = (server: string, tool: string) => `mcp:${server}/${tool}`
function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k))) toolFailure('INVALID_TOOL_REQUEST', 400)
  return value as Record<string, unknown>
}

/** Existing MCP catalog routes; Registry/IAM stays authoritative for each task and tool. */
export class AgentToolGateway {
  private readonly access: ReviewedMcpAccess
  constructor(readonly store: ToolGatewayStore, private readonly deps: {
    registry: Pick<ProductRegistryClient, 'scope' | 'executionAuthorize' | 'inventoryGet' | 'catalogId'>
    mcp: Pick<McpStore, 'getMcpServer' | 'getMcpPolicy'>
    member(org: string, user: string): Promise<VisibilityFilter | null>
    secrets?: (org: string) => McpAuthSecretsApi
    /** Deployment network exceptions, never browser/invocation input. */
    addresses?(org: string, server: string): readonly string[] | undefined
    protocol?(connection: ToolConnection, signal: AbortSignal): ToolProtocol
  }) { this.access = new ReviewedMcpAccess(store, deps) }
  private connection(org: string, id: string) { return this.access.connection(org, id) }
  private protocol(config: ToolConnection, signal: AbortSignal) { return this.access.protocol(config, signal) }
  async discover(org: string, serverId: string): Promise<ToolDescriptor[]> {
    this.deps.registry.scope(org)
    const { config } = await this.connection(org, serverId), protocol = this.protocol(config, AbortSignal.timeout(30000))
    try { await protocol.connect(); return await protocol.descriptors() } finally { await protocol.close() }
  }
  async approve(org: string, serverId: string, user: string, value: unknown) {
    const body = record(value, ['tool', 'digest', 'action', 'sensitive', 'outbound', 'enabled', 'expected_revision'])
    if (typeof body.tool !== 'string' || typeof body.digest !== 'string' || !['read', 'write'].includes(String(body.action))
      || [body.sensitive, body.outbound, body.enabled].some(v => typeof v !== 'boolean')
      || (body.expected_revision !== null && typeof body.expected_revision !== 'string')) toolFailure('INVALID_TOOL_REVIEW', 400)
    const { server } = await this.connection(org, serverId)
    const descriptor = (await this.discover(org, serverId)).find(d => d.tool.name === body.tool)
    if (!descriptor || descriptor.digest !== body.digest) toolFailure('TOOL_DESCRIPTOR_CHANGED')
    validateToolArguments(descriptor.tool.inputSchema)
    const currentServer = (await this.connection(org, serverId)).server
    if (mcpServerDigest(server) !== mcpServerDigest(currentServer)) toolFailure('TOOL_SERVER_CHANGED')
    const valueToSave: ReviewedTool = { ...descriptor, orgId: org, serverId, serverDigest: mcpServerDigest(server), resource: resourceFor(serverId, descriptor.tool.name),
      action: body.action as 'read' | 'write', sensitive: body.sensitive as boolean, outbound: body.outbound as boolean,
      enabled: body.enabled as boolean, revision: randomUUID(), reviewedBy: user, reviewedAt: Date.now() }
    return this.store.saveReview(valueToSave, body.expected_revision as string | null)
  }
  async disable(org: string, serverId: string, user: string, value: unknown) {
    const body = record(value, ['resource', 'expected_revision'])
    if (typeof body.resource !== 'string' || typeof body.expected_revision !== 'string') toolFailure('INVALID_TOOL_REVIEW', 400)
    const review = await this.store.review(org, body.resource)
    if (!review || review.serverId !== serverId) toolFailure('TOOL_REVIEW_NOT_FOUND', 404)
    return this.store.saveReview({ ...review, enabled: false, reviewedBy: user, reviewedAt: Date.now(), revision: randomUUID() }, body.expected_revision)
  }
  private async allowed(org: string, grant: ExecutionGrant, review: ReviewedTool) {
    const { server, config, policyDigest } = await this.access.authorize(org, grant.request.initiated_by, review)
    if (server.bound_assistants) {
      const asset = await this.deps.registry.inventoryGet(org, grant.request.asset_id)
      if (!asset.principal || !server.bound_assistants.includes(this.deps.registry.catalogId(org, asset.principal))) toolFailure('TOOL_AGENT_DENIED', 403)
    }
    await assertAssetOpen(this.store.db, org, grant.request.asset_id)
    return { config, policyDigest }
  }
  async invoke(org: string, value: unknown, token: string, cancellation?: AbortSignal) {
    await this.store.ready
    if (!token || token.length > 8192 || /[\r\n]/.test(token)) toolFailure('EXECUTION_TOKEN_INVALID', 401)
    const body = record(value, ['call_id', 'grant_id', 'task_id', 'spec_digest', 'resource', 'arguments'])
    if (![body.call_id, body.grant_id, body.task_id].every(identifier) || typeof body.spec_digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(body.spec_digest)
      || typeof body.resource !== 'string' || body.resource.length > 500 || Buffer.byteLength(JSON.stringify(body)) > 40000) toolFailure('INVALID_TOOL_REQUEST', 400)
    const input = JSON.parse(JSON.stringify(body)) as ToolInput
    const authorize = async () => {
      const decision = await this.deps.registry.executionAuthorize(org, { grant_id: input.grant_id, task_id: input.task_id, spec_digest: input.spec_digest,
        permission: { operation: 'tool.invoke', resource: input.resource }, token })
      const grant = decision.grant
      if (decision.cacheable || grant.zone !== this.deps.registry.scope(org).zoneId || grant.id !== input.grant_id || grant.request.task_id !== input.task_id
        || grant.request.spec_digest !== input.spec_digest || grant.status !== 'active' || grant.expires_at <= Date.now()
        || !grant.request.permissions.some(p => p.operation === 'tool.invoke' && p.resource === input.resource)) toolFailure('TOOL_AUTHORIZATION_INVALID', 503)
      return grant
    }
    const grant = await authorize(), review = await this.store.review(org, input.resource)
    if (!review) toolFailure('TOOL_REVIEW_REQUIRED', 403)
    const { call, created } = await this.store.reserve(org, input.call_id, contentDigest(input), grant, review)
    if (!created) return ['preparing', 'dispatching'].includes(call.status) && call.deadline <= Date.now() ? { ...call, status: 'unknown' as const, errorCode: 'TOOL_OUTCOME_UNCONFIRMED' } : call
    let protocol: ToolProtocol | undefined
    try {
      if (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) toolFailure('INVALID_TOOL_ARGUMENTS', 400)
      validateToolArguments(review.tool.inputSchema, input.arguments)
      const { config, policyDigest } = await this.allowed(org, grant, review)
      const signal = AbortSignal.any([...(cancellation ? [cancellation] : []), AbortSignal.timeout(Math.max(1, call.deadline - Date.now()))])
      signal.throwIfAborted()
      protocol = this.protocol(config, signal)
      await protocol.connect()
      const descriptor = (await protocol.descriptors()).find(d => d.tool.name === review.tool.name)
      if (descriptor?.digest !== review.digest) toolFailure('TOOL_DESCRIPTOR_CHANGED')
      await authorize()
      if ((await this.allowed(org, grant, review)).policyDigest !== policyDigest) toolFailure('TOOL_POLICY_CHANGED')
      signal.throwIfAborted()
      await this.store.dispatch(call, async () => {
        const server = await this.deps.mcp.getMcpServer(org, review.serverId), policy = await this.deps.mcp.getMcpPolicy(org)
        if (contentDigest({ server, policy }) !== policyDigest) toolFailure('TOOL_POLICY_CHANGED')
      })
      signal.throwIfAborted()
      const result = await protocol.call(review.tool.name, input.arguments)
      await this.store.transition(call, 'dispatching', { status: result.isError ? 'tool_error' : 'completed', result })
    } catch (error) {
      const status = call.status === 'dispatching' ? 'unknown' : 'rejected'
      await this.store.transition(call, call.status, { status, errorCode: error instanceof ExternalProviderError ? error.code : status === 'unknown' ? 'TOOL_OUTCOME_UNCONFIRMED' : 'TOOL_PREFLIGHT_FAILED' })
    } finally { await protocol?.close() }
    return call
  }
}
