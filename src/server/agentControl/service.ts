import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AGENT_CONTROL_KEY_PREFIX, AGENT_CONTROL_PROTOCOL, agentControlCatalog, agentControlDelegationRequest,
  agentControlInvocationSchema, agentControlTools, type AgentControlAction, type ManagedControlActor } from './contract.js'
import type { AgentManagementOperations } from '../agentManagementOperations.js'
import { hasScope, type AuthContext } from '../auth/token.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import { contentDigest } from '../agentFederation/provider/protocol.js'
import { AgentControlStore, type ControlDelegation, type ControlOperation } from './store.js'

export interface AgentControlAuthority {
  parent(token: string): Promise<AuthContext | null>
  control(token: string): Promise<AuthContext | null>
  issue(parent: AuthContext, id: string, ttlSeconds: number): { token: string; expiresAt: number; auth: AuthContext }
  parentRevoked(jti: string): Promise<boolean>
  member(userId: string, orgId: string): Promise<{ status: string; role: string; scopes: string[] } | null>
}

export interface AgentControlPorts {
  actor(sessionId: string, userId: string, orgId: string): Promise<ManagedControlActor>
  actorCurrent(actor: ManagedControlActor, orgId: string): Promise<void>
  operations: Pick<AgentManagementOperations, 'list' | 'detail' | 'start' | 'inspectRuntime'>
}

const CONTROL_SCOPES = ['sessions:list', 'sessions:list:any', 'sessions:create', 'sessions:create:any',
  'sessions:attach', 'sessions:attach:any', 'admin:settings'] as const

function denied(message = 'Agent control is not authorized'): never { throw new ResourceAccessError(403, message) }
function allowedAction(auth: AuthContext, action: AgentControlAction, ownerId: string) {
  if (!hasScope(auth.scopes, 'sessions:list') && !hasScope(auth.scopes, 'sessions:list:any')) return false
  return action !== 'agents.spawn' || (hasScope(auth.scopes, 'sessions:create') && hasScope(auth.scopes, 'sessions:attach') &&
    (ownerId === auth.userId || (hasScope(auth.scopes, 'sessions:create:any') && hasScope(auth.scopes, 'sessions:attach:any'))))
}
function publicDelegation(value: ControlDelegation) {
  return { id: value.id, actor: value.actor, target: value.target, actions: value.actions,
    createdAt: value.createdAt, expiresAt: value.expiresAt, status: value.status }
}

export function controlOperationResult(operation: ControlOperation) {
  const stale = ['prepared', 'executing'].includes(operation.status) && operation.expiresAt <= Date.now()
  const status = stale ? 'unknown' : operation.status
  return { protocol: AGENT_CONTROL_PROTOCOL, operationId: operation.operationId, status,
    outcome: status === 'completed' ? 'completed' : status === 'rejected' ? 'not_submitted' : 'unknown',
    audit: { delegationId: operation.delegationId, actor: operation.actor, initiatedBy: operation.userId,
      authentication: { kind: 'moss-control-delegation', credentialId: operation.credentialJti },
      target: operation.target, action: operation.action, requestedInputSha256: operation.requestedInputSha256,
      effectiveInputSha256: operation.effectiveInputSha256, admittedAt: operation.admittedAt },
    ...(status === 'completed' ? { result: operation.result } : {}),
    ...(operation.errorCode ? { errorCode: operation.errorCode } : {}) }
}

/** Both Agent adapters and the human management API consume existing operations.
 * This service adds bounded delegation and receipts, not another Agent issuer.
 */
export class AgentControlService {
  constructor(readonly store: AgentControlStore, private readonly deps: AgentControlPorts & {
    deploymentId: string
    authority: AgentControlAuthority
  }) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(deps.deploymentId)) throw new Error('Invalid Agent control deployment identity')
  }

  async issue(parentToken: string, value: unknown) {
    const parent = await this.deps.authority.parent(parentToken)
    if (!parent || parent.assistantId !== undefined || !hasScope(parent.scopes, 'sessions:attach')) denied()
    const input = agentControlDelegationRequest.parse(value)
    if (input.target.deploymentId !== this.deps.deploymentId) denied('Control deployment does not match')
    const actor = await this.deps.actor(input.actorSessionId, parent.userId, parent.orgId)
    if (actor.ownerId !== parent.userId || actor.sessionId !== input.actorSessionId) denied()
    const member = await this.deps.authority.member(parent.userId, parent.orgId)
    if (!member || member.status !== 'active' || member.role !== parent.role) denied()
    const effective = { ...parent, scopes: CONTROL_SCOPES.filter(scope => hasScope(parent.scopes, scope) && hasScope(member.scopes, scope)) }
    if (input.actions.some(action => !allowedAction(effective, action, input.target.ownerId))) denied('Requested control actions exceed current permissions')
    await this.deps.operations.list(effective, input.target.ownerId, { limit: 1 })
    const ttl = Math.min(input.ttlSeconds, parent.exp - Math.floor(Date.now() / 1000))
    if (ttl < 1) denied('Delegating login expires before issuance')
    const id = randomUUID(), issued = this.deps.authority.issue(parent, id, ttl)
    const delegation: ControlDelegation = { id, orgId: parent.orgId, userId: parent.userId, role: parent.role, scopes: [...parent.scopes],
      parentJti: parent.jti, tokenJti: issued.auth.jti, actor, target: input.target, actions: input.actions,
      createdAt: Date.now(), expiresAt: issued.expiresAt * 1000, status: 'active' }
    await this.store.create(delegation)
    // Only the explicit private setup channel receives this short-lived token.
    // Native tool results and operation receipts never contain it.
    return { protocol: AGENT_CONTROL_PROTOCOL, delegation: publicDelegation(delegation), credential: { accessToken: issued.token } }
  }

  private async authorize(token: string, requireActor: boolean) {
    const auth = await this.deps.authority.control(token)
    if (!auth || !auth.keyId.startsWith(AGENT_CONTROL_KEY_PREFIX)) denied()
    const delegation = await this.store.delegation(auth.orgId, auth.keyId.slice(AGENT_CONTROL_KEY_PREFIX.length))
    if (!delegation || delegation.userId !== auth.userId || delegation.role !== auth.role || delegation.tokenJti !== auth.jti ||
      delegation.target.deploymentId !== this.deps.deploymentId || delegation.status !== 'active' ||
      delegation.expiresAt <= Date.now() || await this.deps.authority.parentRevoked(delegation.parentJti)) denied()
    const member = await this.deps.authority.member(auth.userId, auth.orgId)
    if (!member || member.status !== 'active' || member.role !== delegation.role) denied()
    const scopes = CONTROL_SCOPES.filter(scope => hasScope(delegation.scopes, scope) && hasScope(member.scopes, scope))
    const effective = { ...auth, scopes: [...scopes] }
    if (!hasScope(effective.scopes, 'sessions:attach')) denied()
    if (requireActor && !isDeepStrictEqual(await this.deps.actor(delegation.actor.sessionId, auth.userId, auth.orgId), delegation.actor))
      denied('Control actor execution changed; reconnect explicitly')
    return { delegation, effective }
  }

  async capabilities(token: string) {
    const { delegation, effective } = await this.authorize(token, true)
    await this.deps.operations.list(effective, delegation.target.ownerId, { limit: 1 })
    return { protocol: AGENT_CONTROL_PROTOCOL, delegation: publicDelegation(delegation),
      tools: agentControlTools(delegation.actions.filter(action => allowedAction(effective, action, delegation.target.ownerId))) }
  }

  private execute(action: AgentControlAction, args: Record<string, unknown>, auth: AuthContext, ownerId: string) {
    switch (action) {
      case 'agents.list': return this.deps.operations.list(auth, ownerId, args as { after?: string; limit: number })
      case 'agents.inspect': return this.deps.operations.detail(auth, ownerId, String(args.agent))
      case 'agents.spawn': return this.deps.operations.start(auth, ownerId, String(args.agent))
      case 'runtime.inspect': return this.deps.operations.inspectRuntime(auth, ownerId)
    }
  }

  async invoke(token: string, value: unknown) {
    const input = agentControlInvocationSchema.parse(value)
    const args = agentControlCatalog[input.action].arguments.parse(input.arguments)
    const { delegation, effective } = await this.authorize(token, true)
    if (!delegation.actions.includes(input.action) || !allowedAction(effective, input.action, delegation.target.ownerId))
      denied('Control action is outside current permissions')
    const { operation, created } = await this.store.reserve({ operationId: input.operationId, orgId: delegation.orgId,
      delegationId: delegation.id, userId: delegation.userId, actor: delegation.actor, target: delegation.target, action: input.action,
      credentialJti: (await this.deps.authority.control(token))?.jti ?? denied(),
      requestDigest: contentDigest(input), requestedInputSha256: contentDigest(input.arguments), effectiveInputSha256: contentDigest(args),
      status: 'prepared', createdAt: Date.now(), expiresAt: delegation.expiresAt })
    if (!created) return controlOperationResult(operation)
    let admitted = false
    let admittedAuth = effective
    try {
      await this.store.admit(operation, async () => {
        admittedAuth = (await this.authorize(token, false)).effective
        if (!allowedAction(admittedAuth, input.action, delegation.target.ownerId)) denied()
        await this.deps.actorCurrent(delegation.actor, delegation.orgId)
      })
      admitted = true
      const result = await this.execute(input.action, args, admittedAuth, delegation.target.ownerId)
      if (JSON.stringify(result)?.includes(token)) throw new Error('Control credential disclosure refused')
      await this.store.transition(operation, 'executing', { status: 'completed', result, completedAt: Date.now() })
    } catch {
      const patch = { status: admitted ? 'unknown' as const : 'rejected' as const,
        errorCode: admitted ? 'CONTROL_OUTCOME_UNCONFIRMED' : 'CONTROL_ADMISSION_REFUSED' }
      try { await this.store.transition(operation, operation.status, patch) }
      catch { return { ...controlOperationResult(operation), status: 'unknown', outcome: 'unknown', errorCode: 'CONTROL_RECEIPT_UNCONFIRMED' } }
    }
    return controlOperationResult(operation)
  }

  async operation(token: string, operationId: string) {
    // Explicit human recovery remains available after the Agent exits or its
    // delegation expires/is revoked. It cannot admit or replay any operation.
    const parent = await this.deps.authority.parent(token)
    if (parent) {
      if (parent.assistantId !== undefined) denied()
      const member = await this.deps.authority.member(parent.userId, parent.orgId)
      if (!member || member.status !== 'active' || member.role !== parent.role ||
        !['sessions:list', 'sessions:attach'].every(scope => hasScope(parent.scopes, scope) && hasScope(member.scopes, scope))) denied()
      const operation = await this.store.operation(parent.orgId, operationId)
      if (!operation || operation.userId !== parent.userId) throw new ResourceAccessError(404, 'Control operation not available')
      return controlOperationResult(operation)
    }
    const { delegation } = await this.authorize(token, true)
    const operation = await this.store.operation(delegation.orgId, operationId)
    if (!operation || operation.delegationId !== delegation.id) throw new ResourceAccessError(404, 'Control operation not available')
    return controlOperationResult(operation)
  }

  async revoke(parentToken: string, id: string) {
    const parent = await this.deps.authority.parent(parentToken)
    if (!parent || parent.assistantId !== undefined) denied()
    return publicDelegation(await this.store.revoke(parent.orgId, id, parent.userId))
  }
}
