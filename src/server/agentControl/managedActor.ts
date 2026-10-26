import type { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import type { ManagedControlActor } from './contract.js'
import { sessionAgentName } from '../agentIdentity.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import { ManagedAgentClient } from '../nexus/managedAgentClient.js'
import type { CohostSessionBinding } from '../runtime/cohostSessionRepository.js'
import type { SessionRecord } from '../types.js'

type ControlSession = Pick<SessionRecord, 'sessionId' | 'taskId' | 'orgId' | 'userId' | 'role' | 'assistantName' |
  'runtime' | 'desiredState' | 'currentAttemptId' | 'deletedAt'>

export interface ManagedActorSource {
  session(id: string): Promise<ControlSession | null>
  binding(id: string): Promise<CohostSessionBinding | undefined>
  requireAccess(session: ControlSession): Promise<void>
  /** The actual configured owner-authenticated cohost connection, not invocation input. */
  connect(ownerId: string, agentId: string): Promise<{ client: NexusVfsClient; authToken: string }>
}

function unavailable(): never { throw new ResourceAccessError(403, 'Control actor is not an active owned cohost session') }
async function binding(source: ManagedActorSource, sessionId: string, ownerId: string, orgId: string) {
  const session = await source.session(sessionId)
  if (!session || session.sessionId !== sessionId || session.orgId !== orgId || session.userId !== ownerId || session.deletedAt !== null ||
    session.runtime.type !== 'cohost' || session.desiredState !== 'active' || !session.currentAttemptId) unavailable()
  await source.requireAccess(session)
  const bound = await source.binding(sessionId)
  if (!bound || bound.ownerId !== ownerId || bound.agentId !== sessionAgentName(ownerId, session.assistantName)) unavailable()
  return { session, bound, attemptId: session.currentAttemptId }
}

/** Local final fence after actual native evidence; performs no network request. */
export async function assertManagedActorCurrent(source: ManagedActorSource, actor: ManagedControlActor, orgId: string) {
  const { session, bound, attemptId } = await binding(source, actor.sessionId, actor.ownerId, orgId)
  if (attemptId !== actor.attemptId || session.taskId !== actor.taskId || bound.agentId !== actor.agentId ||
    bound.durableSessionId !== actor.durableSessionId || bound.repositoryPath !== actor.repositoryPath) unavailable()
}

/** Only fresh owned native execution evidence creates an actor. No history is fabricated. */
export async function inspectManagedActor(source: ManagedActorSource, sessionId: string, ownerId: string, orgId: string): Promise<ManagedControlActor> {
  const { session, bound, attemptId } = await binding(source, sessionId, ownerId, orgId)
  const connection = await source.connect(ownerId, bound.agentId)
  const client = new ManagedAgentClient(connection.client, connection.authToken)
  try {
    const native = await client.findSession({ ownerId, agentId: bound.agentId,
      durableSessionId: bound.durableSessionId, repositoryPath: bound.repositoryPath })
    if (!native || !['ready', 'busy', 'awaiting_input'].includes(native.state ?? '') ||
      native.durable_session_id !== bound.durableSessionId) unavailable()
    const actor: ManagedControlActor = { plane: 'managed-cohost', ownerId, agentId: bound.agentId, sessionId, taskId: session.taskId, attemptId,
      durableSessionId: bound.durableSessionId, repositoryPath: bound.repositoryPath, executionId: native.session_id }
    await assertManagedActorCurrent(source, actor, orgId)
    return actor
  } finally { client.close() }
}
