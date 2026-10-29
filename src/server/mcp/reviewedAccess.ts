import type { McpStore } from './db.js'
import { resolveAuthHeaders, resolveSecretRefHeaders, type McpAuthSecretsApi } from './authResolver.js'
import type { McpServer } from './types.js'
import { isVisibleTo, type VisibilityFilter } from '../visibilityFilter.js'
import type { ReviewedTool, ToolGatewayStore } from '../agentFederation/toolGatewayStore.js'
import { ToolProtocol, toolFailure, validateToolArguments, type ToolConnection } from '../agentFederation/toolProtocol.js'
import { contentDigest } from '../agentFederation/provider/protocol.js'

export interface ReviewedMcpDependencies {
  mcp: Pick<McpStore, 'getMcpServer' | 'getMcpPolicy'>
  member(org: string, user: string): Promise<VisibilityFilter | null>
  secrets?: (org: string) => McpAuthSecretsApi
  addresses?(org: string, server: string): readonly string[] | undefined
  protocol?(connection: ToolConnection, signal: AbortSignal): ToolProtocol
}

export function mcpServerDigest(server: McpServer) {
  return contentDigest({ id: server.id, org: server.org_id, type: server.mcp_type, endpoint: server.url, scope: server.scope, owner: server.owner_id })
}

/** Shared current MCP policy/credential resolution; this class grants no task execution. */
export class ReviewedMcpAccess {
  constructor(private readonly store: Pick<ToolGatewayStore, 'review'>, private readonly deps: ReviewedMcpDependencies) {}

  async connection(org: string, id: string) {
    const server = await this.deps.mcp.getMcpServer(org, id), policy = await this.deps.mcp.getMcpPolicy(org)
    if (!server || server.org_id !== org || server.status !== 'enabled' || !server.enabled || server.scope === 'user'
      || server.mcp_type !== 'http' || !server.url || server.use_proxy || !policy.allow_http_sse_mcp) toolFailure('TOOL_SERVER_UNAVAILABLE', 403)
    const target = new URL(server.url)
    if (!policy.allow_external_network || !policy.domain_whitelist_json?.includes(target.hostname)) toolFailure('TOOL_DESTINATION_DENIED', 403)
    if (server.auth_type === 'oauth') toolFailure('TOOL_AUTH_UNSUPPORTED')
    const secrets = this.deps.secrets?.(org)
    const headers = server.auth_type === 'secret_ref' && server.secret_ref && secrets
      ? await resolveSecretRefHeaders(server.secret_ref, p => secrets!.getConfigItemByPinyin(p), (ns, subject) => secrets!.listSecrets(ns, subject), org)
      : resolveAuthHeaders(server.auth_type, server.auth_config_json)
    if (server.auth_type !== 'none' && !Object.keys(headers).length) toolFailure('TOOL_CREDENTIAL_UNAVAILABLE', 503)
    return { server, policy, config: { endpoint: server.url, headers, timeoutMs: Math.min(Math.max(server.timeout_ms, 1000), 15000), allowedAddresses: this.deps.addresses?.(org, id) } satisfies ToolConnection }
  }

  protocol(config: ToolConnection, signal: AbortSignal) { return this.deps.protocol?.(config, signal) ?? new ToolProtocol(config, signal) }

  async authorize(org: string, userId: string, review: ReviewedTool) {
    const { server, policy, config } = await this.connection(org, review.serverId)
    if (!review.enabled || review.orgId !== org || mcpServerDigest(server) !== review.serverDigest) toolFailure('TOOL_REVIEW_REQUIRED', 403)
    // The existing IT review classifies effects; remote annotations never grant access.
    if ((review.action === 'read' && !server.allow_read) || (review.action === 'write' && !server.allow_write)
      || (review.sensitive && !server.allow_read_sensitive_fields) || (review.outbound && !server.allow_outbound_network)) toolFailure('TOOL_POLICY_DENIED', 403)
    if ((review.action === 'write' && (server.require_confirmation_for_write || policy.require_confirmation_for_write))
      || (server.risk_level === 'high' && policy.require_confirmation_for_high_risk)) toolFailure('TOOL_CONFIRMATION_REQUIRED', 403)
    const user = await this.deps.member(org, userId)
    if (!user || user.userId !== userId || (server.scope === 'department' && server.owner_id !== user.departmentId)
      || !isVisibleTo(server.visible_to, { ...user, isAdmin: false })) toolFailure('TOOL_USER_DENIED', 403)
    return { server, config, policyDigest: contentDigest({ server, policy }) }
  }

  async authorizeHostRead(org: string, userId: string, serverId: string, tool: string) {
    const resource = `mcp:${serverId}/${tool}`
    const review = await this.store.review(org, resource)
    if (!review || review.serverId !== serverId || review.tool.name !== tool || review.action !== 'read') toolFailure('HOST_READ_REVIEW_REQUIRED', 403)
    validateToolArguments(review.tool.inputSchema, {})
    const initial = await this.authorize(org, userId, review)
    // A host context read has no task asset identity. Never ignore an agent/skill restriction.
    if (initial.server.bound_assistants !== null || initial.server.bound_skills !== null) toolFailure('HOST_READ_AGENT_BINDING_UNSUPPORTED', 403)
    return { review, ...initial }
  }

  /** Trusted host reads only. Agent calls retain the separate task/grant/asset gate. */
  async readForHost(org: string, userId: string, serverId: string, tool: string, cancellation?: AbortSignal) {
    const resource = `mcp:${serverId}/${tool}`
    const initial = await this.authorizeHostRead(org, userId, serverId, tool)
    const { review } = initial
    const identity = contentDigest({ policy: initial.policyDigest, config: initial.config })
    const current = async () => {
      const latest = await this.store.review(org, resource)
      if (!latest || latest.revision !== review.revision || contentDigest(latest) !== contentDigest(review)) toolFailure('TOOL_REVIEW_CHANGED', 403)
      const allowed = await this.authorize(org, userId, latest)
      if (contentDigest({ policy: allowed.policyDigest, config: allowed.config }) !== identity) toolFailure('TOOL_POLICY_CHANGED', 403)
    }
    const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(cancellation ? [cancellation] : [])])
    signal.throwIfAborted()
    const protocol = this.protocol(initial.config, signal)
    try {
      await protocol.connect()
      const descriptor = (await protocol.descriptors()).find(item => item.tool.name === tool)
      if (descriptor?.digest !== review.digest) toolFailure('TOOL_DESCRIPTOR_CHANGED')
      await current()
      signal.throwIfAborted()
      const result = await protocol.call(tool, {})
      await current()
      signal.throwIfAborted()
      if (result.isError) toolFailure('HOST_READ_FAILED', 502)
      return result
    } finally { await protocol.close() }
  }
}
