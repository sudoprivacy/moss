import { NexusVfsClient } from '@nexus-ai-fs/vfs-client'

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
import { ManagedAgentClient } from '../nexus/managedAgentClient.js'
import { mintSessionIdentity, ownerField } from '../nexus/sessionIdentity.js'
import { syncWorkspaceSkills, type WorkspaceSkillLink } from '../../utils/scodeBridge.js'
import { cohostRepositoryPath, readCohostSessionState, writeCohostSessionState } from './cohostSessionState.js'

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
    const saved = options.resumeSessionId ? await readCohostSessionState(options.cwd) : undefined
    const agentId = requireAgentId(options)
    const expectedRepository = cohostRepositoryPath(agentId, options.sessionId)
    if (saved?.repositoryPath && saved.repositoryPath !== expectedRepository) {
      throw new Error('Cohost repository does not belong to this session')
    }
    // Keep the recorded repository identity when resuming existing native history.
    const repositoryPath = saved ? saved.repositoryPath : expectedRepository

    const identity = await mintSessionIdentity(config.endpoint, config.tls, options.userId)
    const client = identity
      ? NexusVfsClient.withMtls(config.endpoint, identity.tls)
      : config.tls
        ? NexusVfsClient.withMtls(config.endpoint, config.tls)
        : new NexusVfsClient(config.endpoint)
    const agent = new ManagedAgentClient(client, config.authToken)

    let session
    try {
      session = await agent.startSession({
        agentId,
        model,
        ...ownerField(identity, options.userId),
        repos: [{ hostPath: repositoryPath ?? options.cwd, alias: 'workspace' }],
        resumeSessionId: saved?.durableSessionId,
      })
      if (!session.durableSessionId) throw new Error('Cohost daemon did not return a durable session ID')
      if (repositoryPath) await client.mkdir(repositoryPath, config.authToken, { parents: true, existOk: true })
      await writeCohostSessionState(options.cwd, {
        sessionId: session.sessionId,
        durableSessionId: session.durableSessionId,
        ...(repositoryPath ? { repositoryPath } : {}),
      })
    } catch (error) {
      if (session) await agent.cancel(session.sessionId).catch(() => {})
      agent.close()
      throw error
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
      model,
      modelProviderId: env.MOSS_MODEL_PROVIDER_ID,
      transcriptPath: options.transcriptPath,
      resumeSessionId: saved?.durableSessionId,
      assistantName: options.assistantName,
      assistantDisplayName: options.assistantDisplayName,
      enabledSkillNames: enabledSkills,
      availableWikis: options.availableWikis,
      availableCorpApps: options.availableCorpApps,
      sharedMemory: options.sharedMemory,
      runtime,
    })
    handle.availableSkills = availableSkills
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
