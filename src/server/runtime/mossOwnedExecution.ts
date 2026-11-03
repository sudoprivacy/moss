import type { ManagedSessionSnapshot } from '../nexus/managedAgentClient.js'
import type { NexusSessionEndpoint } from '@nexus-ai-fs/vfs-client'
import type { CohostSessionBinding } from './cohostSessionRepository.js'

/**
 * Whether Moss started this native execution: it is attached, it belongs to the
 * owner, and its durable session is one Moss bound — for a live Moss session or
 * an ended one whose Agent stayed up as a standby receiver. Anything else was
 * started outside Moss and must drain before Moss replaces the runtime.
 */
export function isMossOwnedExecution(snapshot: ManagedSessionSnapshot, ownerId: string,
  bindings: ReadonlyArray<CohostSessionBinding | undefined>): snapshot is ManagedSessionSnapshot & { session_endpoint: NexusSessionEndpoint } {
  return Boolean(snapshot.session_endpoint) && snapshot.owner_id === ownerId && bindings.some(binding =>
    binding?.ownerId === ownerId && binding.agentId === snapshot.agent_id &&
    binding.durableSessionId === snapshot.durable_session_id)
}
