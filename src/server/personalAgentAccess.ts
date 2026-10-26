import { defaultAgentName, isDefaultAgentName, isMossAgentName, isUserCreatedAgentName, mossAgentName } from './agentIdentity.js'
import { ResourceAccessError } from './catalog/resourceError.js'
import { getUserAgent, type UserAgent } from './userAgentStore.js'

/** Reject foreign personal references before storing or starting a session. */
export async function requirePersonalAgent(
  orgId: string,
  userId: string,
  reference: string,
): Promise<UserAgent | null> {
  if (isMossAgentName(reference)) {
    if (reference !== mossAgentName(orgId, userId)) throw new ResourceAccessError(404, 'Agent not available')
    return null
  }
  if (isDefaultAgentName(reference)) {
    if (reference !== defaultAgentName(userId)) throw new ResourceAccessError(404, 'Agent not available')
    return null
  }
  if (isUserCreatedAgentName(reference)) {
    const agent = await getUserAgent(orgId, userId, reference.slice('moss-agent:own:'.length))
    if (!agent) throw new ResourceAccessError(404, 'Agent not available')
    return agent
  }
  return null
}
