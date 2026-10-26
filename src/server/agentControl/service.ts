import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AGENT_CONTROL_KEY_PREFIX, AGENT_CONTROL_PROTOCOL, AGENT_CONTROL_SCOPE, agentControlCatalog, agentControlDelegationRequest,
  agentControlInvocationSchema, agentControlTools, type AgentControlAction, type ManagedControlActor } from './contract.js'
import type { AgentManagementOperations } from '../agentManagementOperations.js'
import { hasScope, type AuthContext } from '../auth/token.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import { contentDigest } from '../agentFederation/provider/protocol.js'
import { AgentControlStore, type ControlDelegation, type ControlOperation } from './store.js'
import { deviceDeployReceiptSchema, type DeviceDeployEffect, type DeviceDeployPort } from './deviceDeploy.js'

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
  deviceDeploy?: DeviceDeployPort
}

const CONTROL_SCOPES = ['sessions:list', 'sessions:list:any', 'sessions:create', 'sessions:create:any',
  'sessions:attach', 'sessions:attach:any', 'admin:settings'] as const

function denied(message = 'Agent control is not authorized'): never { throw new ResourceAccessError(403, message) }
function allowedAction(auth: AuthContext, action: AgentControlAction, ownerId: string) {
  if (!hasScope(auth.scopes, 'sessions:list') && !hasScope(auth.scopes, 'sessions:list:any')) return false
  if (action === 'runtime.deploy') return ownerId === auth.userId && hasScope(auth.scopes, 'admin:settings')
  return action !== 'agents.spawn' || (hasScope(auth.scopes, 'sessions:create') && hasScope(auth.scopes, 'sessions:attach') &&
    (ownerId === auth.userId || (hasScope(auth.scopes, 'sessions:create:any') && hasScope(auth.scopes, 'sessions:attach:any'))))
}
function publicDelegation(value: ControlDelegation) {
  return { id: value.id, actor: value.actor, target: value.target, actions: value.actions,
    createdAt: value.createdAt, expiresAt: value.expiresAt, status: value.status,
    ...(value.deploymentPlans ? { deploymentPlans: value.deploymentPlans } : {}) }
}

export function controlOperationResult(operation: ControlOperation) {
  const stale = ['prepared', 'executing'].includes(operation.status) && operation.expiresAt <= Date.now()
  const status = stale ? 'unknown' : operation.status
  return { protocol: AGENT_CONTROL_PROTOCOL, operationId: operation.operationId, status,
    outcome: status === 'completed' ? 'completed' : status === 'rejected' ? 'not_submitted' : 'unknown',
    audit: { delegationId: operation.delegationId, actor: operation.actor, initiatedBy: operation.userId,
      authentication: { kind: 'moss-control-delegation', credentialId: operation.credentialJti },
      target: operation.target, action: operation.action, requestedInputSha256: operation.requestedInputSha256,
      effectiveInputSha256: operation.effectiveInputSha256, admittedAt: operation.admittedAt,
      ...(operation.deviceEffect ? { deviceEffect: operation.deviceEffect } : {}) },
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
    if (input.actions.includes('runtime.deploy')) {
      if (!this.deps.deviceDeploy || !input.deploymentPlans?.length ||
        new Set(input.deploymentPlans.map(plan => plan.planId)).size !== input.deploymentPlans.length)
        denied('Device deployment requires explicit operator-approved plans')
      for (const plan of input.deploymentPlans) {
        const actual = await this.deps.deviceDeploy.inspect(plan.planId)
        if (actual.deploymentId !== input.target.deploymentId || actual.ownerId !== input.target.ownerId || actual.planSha256 !== plan.sha256)
          denied('Requested plan differs from current device approval')
      }
    } else if (input.deploymentPlans) denied('Deployment plans require an explicit deployment action')
    await this.deps.operations.list(effective, input.target.ownerId, { limit: 1 })
    const ttl = Math.min(input.ttlSeconds, parent.exp - Math.floor(Date.now() / 1000))
    if (ttl < 1) denied('Delegating login expires before issuance')
    const id = randomUUID(), issued = this.deps.authority.issue(parent, id, ttl)
    const delegation: ControlDelegation = { id, orgId: parent.orgId, userId: parent.userId, role: parent.role, scopes: [...parent.scopes],
      parentJti: parent.jti, tokenJti: issued.auth.jti, actor, target: input.target, actions: input.actions,
      createdAt: Date.now(), expiresAt: issued.expiresAt * 1000, status: 'active',
      ...(input.deploymentPlans ? { deploymentPlans: input.deploymentPlans } : {}) }
    await this.store.create(delegation)
    // Only the explicit private setup channel receives this short-lived token.
    // Native tool results and operation receipts never contain it.
    return { protocol: AGENT_CONTROL_PROTOCOL, delegation: publicDelegation(delegation), credential: { accessToken: issued.token } }
  }

  private async authorize(token: string, requireActor: boolean) {
    const auth = await this.deps.authority.control(token)
    if (!auth || !hasScope(auth.scopes, AGENT_CONTROL_SCOPE) || !auth.keyId.startsWith(AGENT_CONTROL_KEY_PREFIX)) denied()
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
      tools: agentControlTools(delegation.actions.filter(action => allowedAction(effective, action, delegation.target.ownerId) &&
        (action !== 'runtime.deploy' || Boolean(this.deps.deviceDeploy && delegation.deploymentPlans?.length))), delegation.deploymentPlans) }
  }

  private execute(action: AgentControlAction, args: Record<string, unknown>, auth: AuthContext, ownerId: string) {
    switch (action) {
      case 'agents.list': return this.deps.operations.list(auth, ownerId, args as { after?: string; limit: number })
      case 'agents.inspect': return this.deps.operations.detail(auth, ownerId, String(args.agent))
      case 'agents.spawn': return this.deps.operations.start(auth, ownerId, String(args.agent))
      case 'runtime.inspect': return this.deps.operations.inspectRuntime(auth, ownerId)
      case 'runtime.deploy': throw new Error('Device deployment requires its durable effect boundary')
    }
  }

  private async deviceReceipt(operation: ControlOperation, value: any) {
    const effect = operation.deviceEffect
    if (!effect) throw new Error('Missing durable device effect')
    const actual = deviceDeployReceiptSchema.parse(value)
    for (const key of Object.keys(effect) as (keyof DeviceDeployEffect)[])
      if (actual[key] !== effect[key]) throw new Error('Device effect receipt binding differs')
    const completed = actual.status === 'completed' && actual.outcome === 'completed' &&
      actual.selectionAccepted === true && actual.productQualificationAccepted === true &&
      actual.nativeBindingPreserved?.ownerId === effect.ownerId && Boolean(actual.originalSessionId) && (actual.modelTurnsCompleted ?? 0) >= 3
    await this.store.transition(operation, operation.status, completed
      ? { status: 'completed', result: actual, completedAt: Date.now(), errorCode: undefined }
      : { status: 'unknown', errorCode: 'DEVICE_DEPLOYMENT_UNCONFIRMED' })
    return controlOperationResult(operation)
  }

  private async recover(operation: ControlOperation) {
    if (operation.deviceEffect && this.deps.deviceDeploy && ['executing', 'unknown'].includes(operation.status)) {
      try { return await this.deviceReceipt(operation, await this.deps.deviceDeploy.query(operation.deviceEffect)) }
      catch { return { ...controlOperationResult(operation), status: 'unknown', outcome: 'unknown', errorCode: 'DEVICE_RECEIPT_UNCONFIRMED' } }
    }
    return controlOperationResult(operation)
  }

  async invoke(token: string, value: unknown) {
    const input = agentControlInvocationSchema.parse(value)
    const args = agentControlCatalog[input.action].arguments.parse(input.arguments)
    const { delegation, effective } = await this.authorize(token, true)
    if (!delegation.actions.includes(input.action) || !allowedAction(effective, input.action, delegation.target.ownerId))
      denied('Control action is outside current permissions')
    let deviceEffect: DeviceDeployEffect | undefined
    if (input.action === 'runtime.deploy') {
      const planId = agentControlCatalog['runtime.deploy'].arguments.parse(args).planId
      const plan = delegation.deploymentPlans?.find(plan => plan.planId === planId)
      if (!plan || !this.deps.deviceDeploy) denied('Deployment plan is not delegated')
      const selected = await this.deps.deviceDeploy.inspect(plan.planId)
      if (selected.deploymentId !== delegation.target.deploymentId || selected.ownerId !== delegation.target.ownerId || selected.planSha256 !== plan.sha256)
        denied('Operator approval changed; obtain a new delegation')
      deviceEffect = { ...delegation.target, planId: plan.planId, planSha256: plan.sha256,
        operationId: 'moss-' + contentDigest({ protocol: 'moss-device-deploy/v1', orgId: delegation.orgId, operationId: input.operationId }).slice('sha256:'.length) }
    }
    const { operation, created } = await this.store.reserve({ operationId: input.operationId, orgId: delegation.orgId,
      delegationId: delegation.id, userId: delegation.userId, actor: delegation.actor, target: delegation.target, action: input.action,
      credentialJti: (await this.deps.authority.control(token))?.jti ?? denied(),
      requestDigest: contentDigest(input), requestedInputSha256: contentDigest(input.arguments), effectiveInputSha256: contentDigest(deviceEffect ? { ...args, deviceEffect } : args),
      status: 'prepared', createdAt: Date.now(), expiresAt: delegation.expiresAt, ...(deviceEffect ? { deviceEffect } : {}) })
    if (!created) return this.recover(operation)
    let admitted = false
    let admittedAuth = effective
    try {
      await this.store.admit(operation, async () => {
        admittedAuth = (await this.authorize(token, false)).effective
        if (!allowedAction(admittedAuth, input.action, delegation.target.ownerId)) denied()
        await this.deps.actorCurrent(delegation.actor, delegation.orgId)
      })
      admitted = true
      if (deviceEffect) return await this.deviceReceipt(operation, await this.deps.deviceDeploy!.submit(deviceEffect))
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
      return this.recover(operation)
    }
    const { delegation } = await this.authorize(token, true)
    const operation = await this.store.operation(delegation.orgId, operationId)
    if (!operation || operation.delegationId !== delegation.id) throw new ResourceAccessError(404, 'Control operation not available')
    return this.recover(operation)
  }

  async revoke(parentToken: string, id: string) {
    const parent = await this.deps.authority.parent(parentToken)
    if (!parent || parent.assistantId !== undefined) denied()
    return publicDelegation(await this.store.revoke(parent.orgId, id, parent.userId))
  }
}
