import { setTimeout as delay } from 'node:timers/promises'
import { isManagedSessionBusy, isUnknownManagedSession, type ManagedAgentClient, type StartSessionResult } from '../nexus/managedAgentClient.js'

type SessionStartInput = Parameters<ManagedAgentClient['startSession']>[0]

/** The native writer lease lasts 60 seconds; startup and attach share this recovery budget. */
export const COHOST_RECOVERY_TIMEOUT_MS = 90_000

/** Reconcile an owned orphan and honor the existing bounded writer lease when recovering. */
export async function startCohostExecution(
  agent: Pick<ManagedAgentClient, 'findSession' | 'startSession' | 'cancel'>,
  input: SessionStartInput,
  scope: { ownerId: string; repositoryPath?: string; controllerId?: string },
  recovery: { timeoutMs?: number; retryMs?: number; signal?: AbortSignal; isResumeRequired?: boolean } = {},
): Promise<{ session: StartSessionResult; isResume: boolean }> {
  let resumeSessionId = input.resumeSessionId
  const deadline = Date.now() + (recovery.timeoutMs ?? COHOST_RECOVERY_TIMEOUT_MS)
  recovery.signal?.throwIfAborted()
  const existing = await agent.findSession({ ownerId: scope.ownerId, agentId: input.agentId,
    repositoryPath: scope.repositoryPath, durableSessionId: resumeSessionId })
  recovery.signal?.throwIfAborted()
  if (existing) {
    if (!existing.durable_session_id || !existing.session_endpoint) throw new Error('Cohost execution has not published its durable identity')
    if (!resumeSessionId && !recovery.isResumeRequired && scope.controllerId && existing.session_endpoint.controller === scope.controllerId) {
      return { session: { sessionId: existing.session_id, osPid: null, sessionEndpoint: existing.session_endpoint,
        durableSessionId: existing.durable_session_id, workspacePath: existing.workspace_path }, isResume: false }
    }
    resumeSessionId = existing.durable_session_id
    try { await agent.cancel(existing.session_id) }
    catch (error) { if (!isUnknownManagedSession(error, existing.session_id)) throw error }
  }
  if (recovery.isResumeRequired && !resumeSessionId) {
    throw new Error('Cohost resume has no durable binding or owned live execution; migrate the original session locator before retrying')
  }
  for (;;) {
    recovery.signal?.throwIfAborted()
    try {
      const session = await agent.startSession({ ...input, resumeSessionId })
      if (recovery.signal?.aborted) {
        try { await agent.cancel(session.sessionId) }
        catch (error) {
          if (!isUnknownManagedSession(error, session.sessionId)) {
            throw new AggregateError([recovery.signal.reason, error], 'Cancelled cohost creation could not be cleaned up')
          }
        }
        recovery.signal.throwIfAborted()
      }
      return { session, isResume: !!resumeSessionId }
    } catch (error) {
      if (!resumeSessionId || !isManagedSessionBusy(error) || Date.now() >= deadline) throw error
      await delay(Math.min(recovery.retryMs ?? 500, deadline - Date.now()), undefined,
        { signal: recovery.signal })
    }
  }
}
