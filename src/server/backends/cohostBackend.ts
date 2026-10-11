import type {
  BackendHandle,
  BackendSpawnOptions,
  SessionBackend,
  SessionRuntimeInfo,
} from '../sessionManager.js'
import { sessionAgentName } from '../agentIdentity.js'
import { buildAvailableSkillSnapshot, buildSessionEnv, getAssistantRuntimeConfig } from './backendUtils.js'
import { createAcpBridgeHandle } from './acpBridge.js'
import { NexusAcpTransport } from './nexusAcpTransport.js'
import { resolveCohostNexusConfig } from '../nexus/nexusEnvConfig.js'
import { isUnknownManagedSession, ManagedAgentClient } from '../nexus/managedAgentClient.js'
import { ownerField } from '../nexus/sessionIdentity.js'
import { connectSessionRuntime } from '../nexus/sessionConnection.js'
import { syncWorkspaceSkills, type WorkspaceSkillLink } from '../../utils/scodeBridge.js'
import { cohostRepositoryPath, readCohostSessionState } from './cohostSessionState.js'
import { startCohostExecution } from './cohostRecovery.js'

/**
 * Session backend for a co-hosted sudocode runtime.
 *
 * Moss remains the WebUI/session API and transcript owner. Nexus owns the
 * ManagedAgentService record and the in-process scode loop; ACP messages travel
 * over the authenticated session mailbox. There is deliberately no local
 * scode child and no `spawn_spec` in this backend.
 */
export class CohostBackend implements SessionBackend {
  async spawn(options: BackendSpawnOptions): Promise<BackendHandle> {
    options.signal?.throwIfAborted()
    const assistantConfig = await getAssistantRuntimeConfig(options.assistantName)
    const enabledSkills = options.assistantName
      ? [...new Set([...assistantConfig.enabledSkills, ...(options.enabledSkillNames ?? [])])]
      : (options.enabledSkillNames ?? assistantConfig.enabledSkills)

    const env = buildSessionEnv(options)
    const model = env.MOSS_DEFAULT_MODEL || options.runtime?.model || 'gemini-3-flash-preview'
    let workspaceSkillLinks: WorkspaceSkillLink[] = []
    try {
      workspaceSkillLinks = await syncWorkspaceSkills(options.cwd, enabledSkills, options.visibilityFilter)
    } catch (error) {
      process.stderr.write(`[CohostBackend] workspace skill sync warning: ${String(error)}\n`)
    }
    const availableSkills = await buildAvailableSkillSnapshot(workspaceSkillLinks)

    // Secrets and ordinary Moss services may use the deployment's primary
    // Nexus. The co-host runtime can be a separate local cohost daemon (for
    // example during the 0.2.23 rollout), so give it an explicit connection
    // namespace instead of silently moving Moss's vault connection with it.
    const config = resolveCohostNexusConfig()
    const saved = options.cohostSessionBinding ??
      (options.resumeSessionId ? await readCohostSessionState(options.cwd) : undefined)
    const agentId = requireAgentId(options)
    if (options.cohostSessionBinding && (options.cohostSessionBinding.agentId !== agentId || options.cohostSessionBinding.ownerId !== options.userId)) {
      throw new Error('Cohost binding does not belong to this agent')
    }
    const expectedRepository = cohostRepositoryPath(agentId, options.sessionId)
    if (saved?.repositoryPath && saved.repositoryPath !== expectedRepository && saved.repositoryPath !== options.cwd) {
      throw new Error('Cohost repository does not belong to this session')
    }
    // Keep the recorded repository identity when resuming existing native history.
    const repositoryPath = saved ? saved.repositoryPath ?? options.cwd : expectedRepository

    const { identity, client, authToken } = await connectSessionRuntime(config, options.userId)
    const agent = new ManagedAgentClient(client, authToken)

    let session
    let isResume = !!saved
    try {
      const execution = await startCohostExecution(agent, {
        agentId,
        model,
        ...ownerField(identity, options.userId),
        repos: [{ hostPath: repositoryPath, alias: 'workspace' }],
        resumeSessionId: saved?.durableSessionId,
      }, { ownerId: options.userId!, repositoryPath, controllerId: identity?.subjectId },
      { signal: options.signal, isResumeRequired: !!options.resumeSessionId || !!saved })
      session = execution.session
      isResume = execution.isResume
      if (!session.durableSessionId) throw new Error('Cohost daemon did not return a durable session ID')
      await client.mkdir(repositoryPath, authToken, { parents: true, existOk: true })
      options.signal?.throwIfAborted()
    } catch (error) {
      let failure = error
      try { if (session) await agent.cancel(session.sessionId) }
      catch (cleanupError) {
        if (!session || !isUnknownManagedSession(cleanupError, session.sessionId)) {
          failure = new AggregateError([error, cleanupError], 'Failed cohost startup could not clean up its execution')
        }
      } finally { agent.close() }
      throw failure
    }

    process.stderr.write(
      `[CohostBackend] managed session ready (moss=${options.sessionId}, nexus=${session.sessionId}, ` +
        `workspace=${session.workspacePath ?? 'nexus-managed'}, model=${model})\n`,
    )

    const runtime: SessionRuntimeInfo = {
      type: 'cohost',
      engine: 'scode',
      model,
    }
    const transport = new NexusAcpTransport(agent, session)
    const handle = createAcpBridgeHandle({
      transport,
      sessionId: options.sessionId,
      cwd: options.cwd,
      ...(repositoryPath && session.workspacePath ? {
        executionWorkspace: { repository: repositoryPath, workingRoot: session.workspacePath },
      } : {}),
      model,
      modelProviderId: env.MOSS_MODEL_PROVIDER_ID,
      transcriptPath: options.transcriptPath,
      resumeSessionId: isResume ? session.durableSessionId : undefined,
      assistantName: options.assistantName,
      assistantDisplayName: options.assistantDisplayName,
      enabledSkillNames: enabledSkills,
      availableWikis: options.availableWikis,
      availableCorpApps: options.availableCorpApps,
      sharedMemory: options.sharedMemory,
      runtime,
    })
    handle.availableSkills = availableSkills
    handle.managedProcessId = session.sessionId
    handle.cohostSessionBinding = { ownerId: options.userId!, agentId, durableSessionId: session.durableSessionId!, repositoryPath }
    return handle
  }
}

function requireAgentId(options: BackendSpawnOptions): string {
  if (!options.assistantName || !options.userId) {
    throw new Error(
      `cohost spawn for session ${options.sessionId} has no agent; RuntimeService assigns one to every session`,
    )
  }
  return sessionAgentName(options.userId, options.assistantName)
}
