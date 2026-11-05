import pMap from 'p-map'
import { AgentRuntimeHomes, PRIMARY_RUNTIME_ALLOCATION, type AgentRuntimeHomeStore, type UserPodService, type UserRuntimeConnectionConfig } from '@sudo/user-runtime'
import type { RuntimeAgentNamespace } from '../agentManager.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import { readAgentNamespace } from '../nexus/agentNamespace.js'
import { ManagedAgentClient } from '../nexus/managedAgentClient.js'
import { connectSessionRuntime, type SessionConnectionConfig } from '../nexus/sessionConnection.js'

type PlacementService = Pick<UserPodService, 'resolve' | 'find' | 'inspect' | 'upgrade'> &
  Partial<Pick<UserPodService, 'configurePolicy' | 'retire' | 'recoverUpgradeLock'>>
type PlacementRoot = { forAllocation(allocationId: string): PlacementService }
type NamespaceReader = (config: UserRuntimeConnectionConfig, ownerId: string) => Promise<RuntimeAgentNamespace>
type HomeStore = AgentRuntimeHomeStore & { remove(ownerId: string, agentId: string): Promise<void> }
/** Delete one Agent's native presence; true when there was one to delete. */
export type NativeAgentRemover = (config: UserRuntimeConnectionConfig, ownerId: string, agentName: string) => Promise<boolean>

async function authenticatedNamespace(config: SessionConnectionConfig, ownerId: string): Promise<RuntimeAgentNamespace> {
  const { client, authToken } = await connectSessionRuntime(config, ownerId)
  try { return await readAgentNamespace(client, authToken, ownerId, true) }
  finally { client.close() }
}

/**
 * Stop the Agent's idle executions and delete its presence (`/agents/<name>`:
 * memory, chat list and session records). Active work refuses the deletion
 * before anything changes. Pair conversations stay with the peers sharing them.
 */
async function removeAuthenticatedAgent(config: SessionConnectionConfig, ownerId: string, agentName: string): Promise<boolean> {
  const { client, authToken } = await connectSessionRuntime(config, ownerId)
  try {
    const namespace = await readAgentNamespace(client, authToken, ownerId, true)
    const executions = namespace.executions.filter(record => record.name === agentName && record.state !== 'terminated')
    if (executions.some(record => record.kind !== 'managed' || record.state !== 'ready' || !record.processId)) {
      throw new ResourceAccessError(409, 'Finish the Agent\'s active work before deleting it')
    }
    const agent = new ManagedAgentClient(client, authToken)
    for (const execution of executions) {
      const snapshot = await agent.getSession(execution.processId!)
      await agent.cancel(execution.processId!, snapshot.session_endpoint)
    }
    const path = `/agents/${agentName}`
    if (!await client.stat(path, authToken)) return false
    await client.delete(path, authToken, { recursive: true })
    return true
  } finally { client.close() }
}

/** One Agent home selects execution, files, discovery and controlled replacement. */
export class CohostOwnerRuntime {
  private readonly homes: AgentRuntimeHomes

  constructor(private readonly pods: PlacementRoot, private readonly store: HomeStore, agentsPerAllocation = 16,
    private readonly namespaceReader: NamespaceReader = authenticatedNamespace,
    private readonly nativeRemover: NativeAgentRemover = removeAuthenticatedAgent) {
    this.homes = new AgentRuntimeHomes(store, agentsPerAllocation)
  }

  /**
   * Delete an Agent from the allocation that holds its home (primary for an
   * Agent that predates home routing), then forget the home. A stopped
   * runtime starts with `configuration` so its retained data can be deleted.
   */
  async removeAgent(ownerId: string, agentName: string,
    configuration: () => Promise<Record<string, string>>): Promise<boolean> {
    const home = await this.store.find(ownerId, agentName)
    const service = this.pods.forAllocation(home?.allocationId ?? PRIMARY_RUNTIME_ALLOCATION)
    const config = await service.find(ownerId) ?? await service.resolve(ownerId, await configuration())
    const isRemoved = await this.nativeRemover(config, ownerId, agentName)
    await this.store.remove(ownerId, agentName)
    return isRemoved
  }

  resolveHome(ownerId: string, agentId: string) {
    return this.homes.resolve(ownerId, agentId)
  }

  async connection(ownerId: string, agentId: string, configuration?: Record<string, string>): Promise<SessionConnectionConfig> {
    const home = await this.resolveHome(ownerId, agentId)
    return this.pods.forAllocation(home.allocationId).resolve(ownerId, configuration)
  }

  async placements(ownerId: string) {
    return (await this.homes.allocations(ownerId))
      .map(allocationId => ({ allocationId, service: this.pods.forAllocation(allocationId) }))
  }

  /** Explicitly starting a discovered native Agent may adopt its observed storage home. */
  async adopt(ownerId: string, agentId: string, allocationId: string): Promise<void> {
    const home = await this.homes.resolve(ownerId, agentId, allocationId)
    if (home.allocationId !== allocationId) {
      throw new ResourceAccessError(409, 'Agent storage conflicts with its registered runtime home')
    }
  }

  async namespace(ownerId: string): Promise<RuntimeAgentNamespace | undefined> {
    const snapshots = await pMap(await this.placements(ownerId), async placement => {
      const config = await placement.service.find(ownerId)
      return config ? { allocationId: placement.allocationId, namespace: await this.namespaceReader(config, ownerId) } : undefined
    }, { concurrency: 4 })
    const available = snapshots.filter(snapshot => snapshot !== undefined)
    if (!available.length) return undefined
    const agentAllocations = new Map<string, string>()
    const managedNames = new Set<string>()
    const executions: RuntimeAgentNamespace['executions'] = []
    for (const { allocationId, namespace } of available) {
      if (!namespace.isOwnerConfined) throw new ResourceAccessError(403, 'Runtime namespace is not bound to its owner')
      for (const name of namespace.names) {
        const previous = agentAllocations.get(name)
        if (previous && previous !== allocationId) throw new ResourceAccessError(409, 'Agent exists in multiple runtime allocations')
        agentAllocations.set(name, allocationId)
      }
      for (const name of namespace.managedNames) managedNames.add(name)
      for (const execution of namespace.executions) {
        if (execution.ownerId !== ownerId) throw new ResourceAccessError(403, 'Runtime execution belongs to another owner')
        executions.push({ ...execution, allocationId })
      }
    }
    return { isOwnerConfined: true, names: [...agentAllocations.keys()], managedNames: [...managedNames],
      executions, agentAllocations: Object.fromEntries(agentAllocations) }
  }

  async inspect(ownerId: string) {
    const allocations = await pMap(await this.placements(ownerId), placement => placement.service.inspect(ownerId), { concurrency: 4 })
    const primary = allocations[0]!
    return { ...primary, allocations, phase: allocations.every(state => state.phase === primary.phase) ? primary.phase : 'mixed',
      isPresent: allocations.some(state => state.isPresent),
      isDrifted: allocations.some(state => state.isDrifted),
      upgradeLock: allocations.find(state => state.upgradeLock)?.upgradeLock ?? null }
  }
}
