import { AgentManager, canUpgradeAgentRuntime, managedSessionAgentName } from './agentManager.js'
import { isMossRuntimeAgentName, sessionAgentName, userCreatedAgentId } from './agentIdentity.js'
import type { AuthContext } from './auth/token.js'
import { ResourceAccessError } from './catalog/resourceError.js'
import type { RuntimeService } from './runtimeService.js'
import type { SessionRecord } from './types.js'

type ManagementEvent = {
  name: 'agent_runtime_upgraded' | 'agent_manager_session_created' | 'agent_deleted'
  fields: Record<string, string>
}

export interface AgentManagementDependencies {
  manager: AgentManager
  runtime: Pick<RuntimeService, 'inspectUserRuntime' | 'upgradeUserRuntime' | 'createSession' | 'deleteOwnerAgent'>
  owner(ownerId: string, orgId: string): Promise<{ status: string; role: string; scopes: string[] } | null>
  sessions(orgId: string, ownerId: string): Promise<SessionRecord[]>
  workspaceUrl(sessionId: string, orgId?: string): string | null
  record(event: ManagementEvent): void
  /** Remove a personal Agent's identity once its runtime data is gone. */
  deleteUserAgent(orgId: string, ownerId: string, id: string): Promise<boolean>
  audit(event: { actorUserId: string; orgId: string; ownerId: string; agentName: string; details: Record<string, unknown> }): Promise<void>
}

/** Why an owner's Agent always stays, or null when it may be deleted. */
function keptAgentReason(ownerId: string, name: string): string | null {
  if (name === sessionAgentName(ownerId, null)) return 'The default Agent cannot be deleted'
  if (isMossRuntimeAgentName(name)) return 'The Moss Agent cannot be deleted here'
  return null
}

/** Shared commands for the browser and authenticated Agent adapters.
 * Authorization remains in the existing manager and runtime. An adapter must
 * obtain AuthContext from its verified authority, never from invocation JSON.
 */
export class AgentManagementOperations {
  constructor(private readonly deps: AgentManagementDependencies) {}

  list(auth: AuthContext, ownerId?: string, page?: { after?: string; limit: number }) {
    return this.deps.manager.list(auth, ownerId, page)
  }

  requireWorkspace() {
    if (!this.deps.workspaceUrl('probe')) throw new ResourceAccessError(503, 'Agent workspace is not configured')
  }

  async detail(auth: AuthContext, ownerId: string, name: string) {
    const agent = await this.deps.manager.get(auth, ownerId, name)
    const sessions = (await this.deps.sessions(auth.orgId, ownerId))
      .filter(session => managedSessionAgentName(ownerId, session.assistantName) === name)
      .map(session => ({ sessionId: session.sessionId, status: session.status,
        createdAt: session.createdAt, title: session.title,
        workspaceUrl: session.userId === auth.userId ||
          (session.source === 'agent-manager' && session.clientMetadata?.agent_manager_actor_id === auth.userId)
          ? this.deps.workspaceUrl(session.sessionId, session.orgId) : null }))
    return { agent, sessions, runtime: await this.deps.runtime.inspectUserRuntime(ownerId),
      canUpgrade: agent.isOwnerActive && canUpgradeAgentRuntime(auth, ownerId),
      canDelete: agent.isOwnerActive && canUpgradeAgentRuntime(auth, ownerId) && keptAgentReason(ownerId, name) === null,
      isWorkspaceAvailable: Boolean(this.deps.workspaceUrl('probe')) }
  }

  async start(auth: AuthContext, ownerId: string, name: string) {
    this.requireWorkspace()
    const agent = await this.deps.manager.requireStart(auth, ownerId, name)
    const owner = await this.deps.owner(ownerId, auth.orgId)
    if (!owner || owner.status !== 'active') throw new ResourceAccessError(409, 'Agent owner is unavailable')
    const session = await this.deps.runtime.createSession({
      userId: ownerId, orgId: auth.orgId, role: owner.role, scopes: owner.scopes,
      dangerouslySkipPermissions: false,
      assistantName: agent.reference, assistantDisplayName: agent.displayName,
      runtime: { type: 'cohost', engine: 'scode' }, source: 'agent-manager', managementActorId: auth.userId,
      managementAgent: { name: agent.name, displayName: agent.displayName, ownerName: agent.ownerName },
    })
    this.deps.record({ name: 'agent_manager_session_created', fields: {
      actorUserId: auth.userId, ownerId, orgId: auth.orgId, agentName: name, sessionId: session.sessionId,
    } })
    return { sessionId: session.sessionId, workspaceUrl: this.deps.workspaceUrl(session.sessionId, session.orgId) }
  }

  async upgrade(auth: AuthContext, ownerId: string) {
    if (!canUpgradeAgentRuntime(auth, ownerId)) throw new ResourceAccessError(403, 'Runtime upgrade is not permitted')
    await this.deps.manager.list(auth, ownerId)
    const runtime = await this.deps.runtime.upgradeUserRuntime(ownerId, auth.orgId)
    this.deps.record({ name: 'agent_runtime_upgraded', fields: { ownerId, orgId: auth.orgId, actorUserId: auth.userId } })
    return { runtime }
  }

  /**
   * Delete one of an owner's Agents: its native data, home and sessions, and
   * a personal Agent's identity. The owner's default Agent and Moss Agent stay.
   * Owners delete their own Agents; settings administrators the Agents of
   * owners they manage.
   */
  async deleteAgent(auth: AuthContext, ownerId: string, name: string) {
    if (!canUpgradeAgentRuntime(auth, ownerId)) throw new ResourceAccessError(403, 'Deleting this Agent is not permitted')
    const agent = await this.deps.manager.get(auth, ownerId, name)
    const kept = keptAgentReason(ownerId, name)
    if (kept) throw new ResourceAccessError(409, kept)
    const result = await this.deps.runtime.deleteOwnerAgent(ownerId, auth.orgId, name)
    const personalId = userCreatedAgentId(agent.reference)
    const isIdentityDeleted = personalId ? await this.deps.deleteUserAgent(auth.orgId, ownerId, personalId) : false
    const details = { sessions: result.sessions, isNativeDeleted: result.isNativeDeleted, isIdentityDeleted }
    this.deps.record({ name: 'agent_deleted', fields: { actorUserId: auth.userId, ownerId, orgId: auth.orgId, agentName: name } })
    await this.deps.audit({ actorUserId: auth.userId, orgId: auth.orgId, ownerId, agentName: name, details })
    return { name, ...details }
  }

  async inspectRuntime(auth: AuthContext, ownerId: string) {
    await this.deps.manager.list(auth, ownerId)
    return this.deps.runtime.inspectUserRuntime(ownerId)
  }
}
