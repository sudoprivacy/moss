import { setTimeout as delay } from 'node:timers/promises'
import type { BackendSpawnOptions } from '../sessionManager.js'
import type { StandardAcpProfileBinding } from '../runtime/standardAcpSessionRepository.js'
import { ManagedAgentClient, isUnknownManagedSession, type NexusSpawnSpec, type StartSessionResult } from '../nexus/managedAgentClient.js'
import { connectSessionRuntime, type SessionConnectionConfig, type SessionRuntimeConnection } from '../nexus/sessionConnection.js'
import { NexusAcpTransport } from './nexusAcpTransport.js'
import type { StandardAcpLauncher, StandardAcpLaunchPlan } from './standardAcpBackend.js'

/** The existing product scheduler owns this account/PVC-wide lease, not this adapter. */
export interface StandardAcpRuntimeLease {
  assertCurrent(): Promise<void>
  /** Supervisor/Pod authority must attest the physical writer, not a registry tombstone. */
  confirmWriterStopped(execution: { processId: string; channelId: string }): Promise<void>
  release(): Promise<void>
  /** Retain exclusion when a launch or physical stop cannot be reconciled. */
  quarantine(reason: 'start_unconfirmed' | 'cleanup_unconfirmed'): Promise<void>
}

/** Resolved only by trusted host composition; never deserialize this from a Task. */
export interface NexusStandardAcpDeployment {
  binding: StandardAcpProfileBinding
  connection: SessionConnectionConfig
  spawnSpec: NexusSpawnSpec
  authorize(): Promise<void>
  acquire(signal?: AbortSignal): Promise<StandardAcpRuntimeLease>
  mcpServers?: unknown[]
  permission?: StandardAcpLaunchPlan['permission']
}

type Agent = Pick<ManagedAgentClient, 'startSession' | 'getSession' | 'cancel' | 'openSession' | 'verifySessionEndpoint' | 'close'>
type Ports = {
  connect(config: SessionConnectionConfig, ownerId: string): Promise<SessionRuntimeConnection>
  agent(connection: SessionRuntimeConnection): Agent
}
const defaultPorts: Ports = { connect: connectSessionRuntime,
  agent: connection => new ManagedAgentClient(connection.client, connection.authToken) }

/** A single, literal subprocess launch on an owner-authenticated managed host.
 * There is no account login, model configuration, extra inference or retry here.
 */
export class NexusStandardAcpLauncher implements StandardAcpLauncher {
  constructor(private readonly resolve: (options: BackendSpawnOptions) => Promise<NexusStandardAcpDeployment>,
    private readonly ports: Ports = defaultPorts,
    private readonly cleanup: { timeoutMs: number; pollMs: number } = { timeoutMs: 15000, pollMs: 100 }) {
    if (!Number.isSafeInteger(cleanup.timeoutMs) || cleanup.timeoutMs <= 0 ||
      !Number.isSafeInteger(cleanup.pollMs) || cleanup.pollMs <= 0) throw new Error('Invalid managed cleanup budget')
  }

  async prepare(options: BackendSpawnOptions): Promise<StandardAcpLaunchPlan> {
    const deployment = await this.resolve(options)
    // Freeze selection before any execution side effect. Credentials remain private host state.
    const binding = Object.freeze(structuredClone(deployment.binding)), spec = structuredClone(deployment.spawnSpec)
    const connectionConfig = structuredClone(deployment.connection)
    if (binding.ownerId !== options.userId || binding.orgId !== options.orgId ||
      binding.profileId !== options.runtime?.standardAcpProfileId || options.runtime.engine !== 'standard_acp') {
      throw new Error('Managed ACP deployment does not match the admitted owner, organization and profile')
    }
    if (!spec.cmd.startsWith('/') || spec.cwd !== binding.workspacePath || !Array.isArray(spec.args) ||
      spec.args.some(value => typeof value !== 'string') || Object.values(spec.env).some(value => typeof value !== 'string')) {
      throw new Error('Managed ACP requires a trusted absolute executable and its exact bound workspace')
    }
    let lease: StandardAcpRuntimeLease | undefined
    let launched = false
    const authorize = async () => { await deployment.authorize(); await lease?.assertCurrent() }
    const mcpServers = structuredClone(deployment.mcpServers ?? [])
    return { binding, authorize, mcpServers, permission: deployment.permission,
      start: async signal => {
        if (launched) throw new Error('Managed ACP launch has already been attempted; reconcile before retrying')
        launched = true
        await authorize(); signal?.throwIfAborted()
        lease = await deployment.acquire(signal)
        let connection: SessionRuntimeConnection | undefined, agent: Agent | undefined
        let session: StartSessionResult | undefined
        let dispatched = false, owned = false
        let confirming: Promise<void> | undefined
        const confirmStopped = (): Promise<void> => confirming ??= (async () => {
          const deadline = Date.now() + this.cleanup.timeoutMs
          try {
            for (;;) {
              try {
                const current = await agent!.getSession(session!.sessionId)
                if (current.owner_id !== binding.ownerId || current.agent_id !== binding.agentId ||
                  !current.session_endpoint || Object.entries(session!.sessionEndpoint).some(([key, value]) =>
                    current.session_endpoint![key as keyof StartSessionResult['sessionEndpoint']] !== value)) {
                  throw new Error('Managed ACP writer identity or channel changed during cleanup')
                }
                if (current.state === 'terminated') break
              } catch (error) {
                if (isUnknownManagedSession(error, session!.sessionId)) break
                throw error
              }
              if (Date.now() >= deadline) throw new Error('Managed ACP physical writer termination is unconfirmed')
              await delay(Math.min(this.cleanup.pollMs, Math.max(1, deadline - Date.now())))
            }
            await lease!.confirmWriterStopped({ processId: session!.sessionId, channelId: session!.sessionEndpoint.channel_id })
            await lease!.release()
          } catch (error) {
            await lease!.quarantine('cleanup_unconfirmed')
            throw error
          } finally { agent!.close() }
        })()
        try {
          await authorize(); signal?.throwIfAborted()
          connection = await this.ports.connect(connectionConfig, binding.ownerId)
          if (!connection.identity) throw new Error('Managed ACP requires an owner-delegated runtime credential')
          agent = this.ports.agent(connection)
          await authorize(); signal?.throwIfAborted()
          // Exactly one start RPC. A lost reply may already have created a process.
          dispatched = true
          session = await agent.startSession({ agentId: binding.agentId,
            repos: [{ hostPath: binding.workspacePath, alias: 'workspace' }], spawnSpec: spec })
          const current = await agent.getSession(session.sessionId)
          owned = current.session_id === session.sessionId && current.owner_id === binding.ownerId &&
            current.agent_id === binding.agentId && current.session_endpoint?.controller === connection.identity.subjectId &&
            Boolean(current.session_endpoint) && Object.entries(session.sessionEndpoint).every(([key, value]) =>
              current.session_endpoint![key as keyof StartSessionResult['sessionEndpoint']] === value)
          if (!owned) throw new Error('Managed ACP start returned an unowned execution or channel')
          if (current.workspace_path !== binding.workspacePath || current.state === 'terminated') {
            throw new Error('Managed ACP execution did not retain its approved workspace or live state')
          }
          await authorize(); signal?.throwIfAborted()
          // Leave control-plane reads open until physical termination is confirmed.
          const transport = new NexusAcpTransport(agent, session, { closeAgent: false })
          return { transport, managedProcessId: session.sessionId,
            checkReady: async () => { await authorize(); return transport.checkReady() }, confirmStopped }
        } catch (error) {
          if (owned && session && agent) {
            try {
              await agent.cancel(session.sessionId, session.sessionEndpoint)
              await confirmStopped()
            } catch {
              // A cancel acknowledgement or cleanup error cannot free a retained writer.
              await lease.quarantine('cleanup_unconfirmed')
              agent.close()
            }
          } else {
            try {
              if (dispatched) await lease.quarantine('start_unconfirmed')
              else await lease.release()
            } finally { if (agent) agent.close(); else connection?.client.close() }
          }
          throw error
        }
      },
    }
  }
}
