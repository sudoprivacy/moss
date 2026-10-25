import { z } from 'zod'
import { hasScope, type AuthContext } from './auth/token.js'
import { nexusAgentReference, nexusAgentName, sessionAgentName } from './agentIdentity.js'
import type { MyAgent } from './myAgents.js'
import { ResourceAccessError } from './catalog/resourceError.js'

export interface AgentOwner {
  id: string
  displayName: string
  isActive: boolean
}

export interface RuntimeAgentNamespace {
  isOwnerConfined: boolean
  names: string[]
  managedNames: string[]
  executions: Array<{ name: string; ownerId: string; state: string; kind: string; processId?: string; allocationId?: string }>
  agentAllocations?: Record<string, string>
}

export interface ManagedAgentEntry {
  name: string
  path: string
  ownerId: string
  ownerName: string
  displayName: string
  reference: string
  origin: 'moss' | 'nexus'
  state: string
  isPresent: boolean
  canStart: boolean
  isOwnerActive: boolean
}

export interface AgentManagerDependencies {
  visibleOwners(auth: AuthContext): Promise<AgentOwner[]>
  personalAgents(owner: AgentOwner, auth: AuthContext): Promise<MyAgent[]>
  namespace(ownerId: string): Promise<RuntimeAgentNamespace | undefined>
  runtimeState?(ownerId: string): Promise<unknown>
  canStartAgent?(auth: AuthContext, ownerId: string, agentName: string): Promise<boolean>
}

const agentNameSchema = z.string().min(1).max(512)
  .refine(name => !/[\\/\0]/.test(name) && name !== '.' && name !== '..', 'Invalid Agent name')

/** Owners may apply their own credentials; managing another box requires deployment authority. */
export function canUpgradeAgentRuntime(auth: AuthContext, ownerId: string): boolean {
  return hasScope(auth.scopes, 'admin:settings') || (auth.userId === ownerId &&
    hasScope(auth.scopes, 'sessions:create') && hasScope(auth.scopes, 'sessions:attach'))
}

/** Merge durable Nexus presence with Moss identities without treating templates as principals. */
export class AgentManager {
  constructor(private readonly dependencies: AgentManagerDependencies) {}

  async list(auth: AuthContext, ownerId?: string, page?: { after?: string; limit: number }): Promise<{ agents: ManagedAgentEntry[]; unavailableOwners: string[]; runtimeStates?: unknown[]; nextCursor?: string | null }> {
    if (!hasScope(auth.scopes, 'sessions:list') && !hasScope(auth.scopes, 'sessions:list:any')) {
      throw new ResourceAccessError(403, 'Forbidden')
    }
    let owners = await this.dependencies.visibleOwners(auth)
    if (ownerId) {
      owners = owners.filter(owner => owner.id === ownerId)
      if (!owners.length) throw new ResourceAccessError(404, 'Owner not available')
    }
    owners.sort((left, right) => left.id.localeCompare(right.id))
    if (page?.after) owners = owners.filter(owner => owner.id.localeCompare(page.after!) > 0)
    const nextCursor = page && owners.length > page.limit ? owners[page.limit - 1]!.id : null
    if (page) owners = owners.slice(0, page.limit)
    const agents: ManagedAgentEntry[] = []
    const unavailableOwners: string[] = []
    const runtimeStates: unknown[] = []
    // Bound connections and issuer requests while inspecting a large organization.
    for (let offset = 0; offset < owners.length; offset += 4) {
      await Promise.all(owners.slice(offset, offset + 4).map(async owner => {
        const personal = (await this.dependencies.personalAgents(owner, auth))
          .filter(agent => nexusAgentName(agent.ref) === undefined)
        let namespace: RuntimeAgentNamespace | undefined
        try { namespace = await this.dependencies.namespace(owner.id) }
        catch { unavailableOwners.push(owner.id) }
        if (this.dependencies.runtimeState) {
          try { runtimeStates.push(await this.dependencies.runtimeState(owner.id)) }
          catch { if (!unavailableOwners.includes(owner.id)) unavailableOwners.push(owner.id) }
        }
        const ownedExecutions = namespace?.executions.filter(record => record.ownerId === owner.id) ?? []
        const personalByName = new Map(personal.map(agent => [agent.agentName, agent]))
        const names = new Set(personalByName.keys())
        for (const name of namespace?.names ?? []) {
          // A legacy shared namespace has no persistent per-owner boundary.
          // Only an authenticated owner box or a known owner record proves attribution.
          if (namespace?.isOwnerConfined || personalByName.has(name) || ownedExecutions.some(record => record.name === name)) names.add(name)
        }
        for (const execution of ownedExecutions) names.add(execution.name)
        for (const rawName of names) {
          const parsed = agentNameSchema.safeParse(rawName)
          if (!parsed.success) continue
          const name = parsed.data
          const configured = personalByName.get(name)
          const executions = ownedExecutions.filter(record => record.name === name)
          const isManaged = executions.some(record => record.kind.toLowerCase() === 'managed') ||
            Boolean(namespace?.managedNames.includes(name))
          const canUseOwner = (owner.id === auth.userId && hasScope(auth.scopes, 'sessions:attach')) ||
            (hasScope(auth.scopes, 'sessions:create:any') && hasScope(auth.scopes, 'sessions:attach:any'))
          agents.push({ name, path: `/agents/${name}`, ownerId: owner.id, ownerName: owner.displayName,
            displayName: configured?.displayName || name, reference: configured?.ref ?? nexusAgentReference(name),
            origin: configured ? 'moss' : 'nexus',
            state: executions.find(record => record.state === 'busy' || record.state === 'awaiting_input')?.state ?? executions[0]?.state ?? 'stopped',
            isPresent: Boolean(namespace?.names.includes(name)),
            isOwnerActive: owner.isActive,
            canStart: owner.isActive && canUseOwner && hasScope(auth.scopes, 'sessions:create') && Boolean(configured || isManaged) &&
              (await this.dependencies.canStartAgent?.(auth, owner.id, name) ?? true),
          })
        }
      }))
    }
    agents.sort((left, right) => left.ownerId.localeCompare(right.ownerId) || left.name.localeCompare(right.name))
    return { agents, unavailableOwners,
      ...(this.dependencies.runtimeState ? { runtimeStates } : {}), ...(page ? { nextCursor } : {}) }
  }

  async get(auth: AuthContext, ownerId: string, name: string): Promise<ManagedAgentEntry> {
    if (!agentNameSchema.safeParse(name).success) throw new ResourceAccessError(400, 'Invalid Agent name')
    const { agents } = await this.list(auth, ownerId)
    const entry = agents.find(agent => agent.name === name)
    if (!entry) throw new ResourceAccessError(404, 'Agent not available')
    return entry
  }

  async requireStart(auth: AuthContext, ownerId: string, name: string): Promise<ManagedAgentEntry> {
    const entry = await this.get(auth, ownerId, name)
    if (!entry.canStart) throw new ResourceAccessError(403, 'Agent does not allow this conversation')
    return entry
  }
}

/** Resolve the persisted reference in existing Moss session records. */
export function managedSessionAgentName(ownerId: string, reference: string | null): string {
  return sessionAgentName(ownerId, reference)
}
