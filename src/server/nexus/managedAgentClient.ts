/** Managed session control plane and the shared conversation transport. */
import { NexusSessionTransport, type NexusVfsClient, type NexusSessionEndpoint, type SessionRpcMessage } from '@nexus-ai-fs/vfs-client'
import { z } from 'zod'

const IDLE_EXECUTION_CHECK_MS = 5_000
const EXECUTION_RECONNECT_TIMEOUT_MS = 30_000

/**
 * Raw subprocess spec. The launch-logic SSOT stays moss-side: nexus executes
 * `cmd` + `args` with `env` in `cwd` and supervises the child, nothing more.
 */
export type NexusSpawnSpec = {
  cmd: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

export type StartSessionResult = {
  /** AgentRegistry pid. `cancel` / `get_session` take this back. */
  sessionId: string
  /**
   * Real OS pid of the spawned subprocess, on the host running nexusd. Returned
   * only on the spawn_spec path. moss keys its pid-bound auth-proxy token on
   * this, which works because the broker is co-located with moss.
   */
  osPid: number | null
  sessionEndpoint: NexusSessionEndpoint
  durableSessionId?: string
  workspacePath?: string
}

export interface ManagedSessionSnapshot {
  session_id: string
  agent_id: string
  owner_id: string
  workspace_path: string
  state?: string
  durable_session_id?: string
  session_endpoint?: NexusSessionEndpoint
}

/** OS PID[.local_id], with legacy synthetic IDs accepted during rolling upgrades. */
export const managedProcessIdSchema = z.string().min(1).max(128)
  .regex(/^(?:[A-Za-z0-9_-]+|[1-9][0-9]*\.[0-9]+)$/)

const managedRegistrySchema = z.array(z.object({
  pid: managedProcessIdSchema,
  name: z.string().min(1),
  owner_id: z.string().min(1),
  repos: z.array(z.object({ alias: z.string(), mount_path: z.string() })).default([]),
}))

const managedSessionSchema: z.ZodType<ManagedSessionSnapshot> = z.object({
  session_id: managedProcessIdSchema,
  agent_id: z.string().min(1),
  owner_id: z.string().min(1),
  workspace_path: z.string().min(1),
  state: z.enum(['registered', 'warming_up', 'ready', 'busy', 'awaiting_input', 'terminated']).optional(),
  durable_session_id: z.string().min(1).optional(),
  session_endpoint: z.object({
    protocol: z.literal('acp-mailbox/1'), channel_id: z.string().min(1),
    agent: z.string().min(1), controller: z.string().min(1),
    transcript: z.string().regex(/^\/conversations\/[a-f0-9]{32}\/transcript$/),
  }).optional(),
})

/** Recognize only the pinned managed-session RPC's explicit writer-lease refusal. */
export function isManagedSessionBusy(error: unknown): boolean {
  const failure = rpcFailure(error)
  return failure?.message === 'managed_agent.start_session_v1: internal: spawn agent runtime: co-host: session is still running; stop it before resuming'
}

/** A reaped process is already stopped; authentication and other failures remain errors. */
export function isUnknownManagedSession(error: unknown, processId: string): boolean {
  const failure = rpcFailure(error)
  return failure?.message === `managed_agent.get_session_v1: invalid argument: unknown session_id ${JSON.stringify(processId)}` ||
    failure?.message === `managed_agent.cancel_v1: invalid argument: unknown session_id ${JSON.stringify(processId)}`
    || failure?.message === `managed_agent.cancel_v2: invalid argument: unknown session_id ${JSON.stringify(processId)}`
}

function rpcFailure(error: unknown): { message: string } | undefined {
  if (!(error instanceof Error)) return undefined
  try {
    const body: unknown = JSON.parse(error.message)
    if (body && typeof body === 'object' && 'code' in body && body.code === -32603 &&
      'message' in body && typeof body.message === 'string') return { message: body.message }
  } catch {}
  return undefined
}

export class ManagedAgentClient {
  constructor(
    private readonly client: NexusVfsClient,
    private readonly authToken: string,
  ) {}

  /** One generic dispatch Call: method + JSON params → parsed JSON result. */
  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const raw = await this.client.call(method, JSON.stringify(params), this.authToken)
    const body: unknown = raw.length ? JSON.parse(raw) : null
    if (body && typeof body === 'object' && 'result' in body) {
      return (body as { result: T }).result
    }
    return body as T
  }

  /**
   * Ask nexus to plant a session and launch `spec`. `agentId` is the static
   * agent profile id. A delegated credential proves the owner; `ownerId` is
   * used only by the existing non-delegated local daemon contract.
   */
  async startSession(input: {
    agentId: string
    repos?: Array<{ hostPath: string; alias: string }>
    /**
     * Omitted when the daemon supplies the runtime itself.
     *
     * `nexusd-cohost` turns a spawn into a thread inside its own process, so
     * there is no command to hand it — and nexus already treats the field as
     * optional. Requiring it here was moss assuming the only host it had seen.
     */
    spawnSpec?: NexusSpawnSpec
    model?: string
    ownerId?: string
    zoneId?: string
    resumeSessionId?: string
  }): Promise<StartSessionResult> {
    const res = await this.call<{
      session_id: string
      os_pid?: number | null
      session_endpoint?: NexusSessionEndpoint
      durable_session_id?: string
      workspace_path?: string
    }>(
      'managed_agent.start_session_v1',
      {
        agent_id: input.agentId,
        ...(input.repos?.length
          ? { repos: input.repos.map(repo => ({ host_path: repo.hostPath, alias: repo.alias })) }
          : {}),
        ...(input.resumeSessionId ? { resume_session_id: input.resumeSessionId } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.ownerId ? { owner_id: input.ownerId } : {}),
        ...(input.zoneId ? { zone_id: input.zoneId } : {}),
        ...(input.spawnSpec
          ? {
              spawn_spec: {
                cmd: input.spawnSpec.cmd,
                args: input.spawnSpec.args,
                env: input.spawnSpec.env,
                cwd: input.spawnSpec.cwd,
              },
            }
          : {}),
      },
    )
    if (!res.session_endpoint) {
      await this.cancel(res.session_id)
      throw new Error('Nexus daemon does not support acp-mailbox/1; upgrade the daemon before starting sessions')
    }
    return { sessionId: res.session_id, osPid: res.os_pid ?? null,
      sessionEndpoint: res.session_endpoint, durableSessionId: res.durable_session_id,
      workspacePath: res.workspace_path }
  }

  /** Terminate the session nexus is supervising. */
  async cancel(sessionId: string, endpoint?: Pick<NexusSessionEndpoint, 'channel_id'>): Promise<void> {
    if (endpoint) {
      await this.call<unknown>('managed_agent.cancel_v2', { session_id: sessionId, channel_id: endpoint.channel_id })
    } else {
      await this.call<unknown>('managed_agent.cancel_v1', { session_id: sessionId, mode: 'session' })
    }
  }

  /** Read the daemon's ownership and workspace record without starting a session. */
  async getSession(sessionId: string): Promise<ManagedSessionSnapshot> {
    return managedSessionSchema.parse(await this.call<unknown>('managed_agent.get_session_v1', { session_id: sessionId }))
  }

  /** Verify the live execution, including its channel generation, without submitting input. */
  async verifySessionEndpoint(processId: string, endpoint: NexusSessionEndpoint, cause?: unknown): Promise<void> {
    let snapshot: ManagedSessionSnapshot
    try { snapshot = await this.getSession(processId) }
    catch (error) {
      if (isUnknownManagedSession(error, processId)) {
        throw new Error('Managed execution disappeared; resume the durable session', { cause: error })
      }
      throw error
    }
    if (snapshot.session_id !== processId || snapshot.state === 'terminated' ||
      !snapshot.session_endpoint || Object.entries(endpoint).some(([key, value]) =>
        snapshot.session_endpoint![key as keyof NexusSessionEndpoint] !== value)) {
      throw new Error('Managed execution channel changed; resume the durable session', { cause })
    }
  }

  /** Discover an owned live execution from the daemon's existing registry, without persisting a PID. */
  async findSession(input: { ownerId: string; agentId: string; repositoryPath?: string; durableSessionId?: string }): Promise<ManagedSessionSnapshot | undefined> {
    if (!input.repositoryPath && !input.durableSessionId) throw new Error('A durable session or repository is required')
    const records = managedRegistrySchema.parse(await this.call<unknown>(
      'agent_list', { owner_id: input.ownerId, kind: 'managed' }))
    const candidates = records.filter(record => record.name === input.agentId && record.owner_id === input.ownerId &&
      (!input.repositoryPath || record.repos?.some(repo => repo.alias === 'workspace' && repo.mount_path === input.repositoryPath)))
    const snapshots = await Promise.all(candidates.map(async record => {
      try {
        const snapshot = await this.getSession(record.pid)
        if (snapshot.session_id !== record.pid || snapshot.agent_id !== input.agentId || snapshot.owner_id !== input.ownerId) {
          throw new Error('Managed execution does not belong to the requested owner and agent')
        }
        return !input.durableSessionId || snapshot.durable_session_id === input.durableSessionId ? snapshot : undefined
      } catch (error) {
        if (isUnknownManagedSession(error, record.pid)) return undefined
        throw error
      }
    }))
    const matches = snapshots.filter((snapshot): snapshot is ManagedSessionSnapshot => snapshot !== undefined)
    if (matches.length > 1) throw new Error('Multiple managed executions share this durable session or repository')
    return matches[0]
  }

  openSession(endpoint: NexusSessionEndpoint, events: {
    onMessage(message: SessionRpcMessage): void
    onClose(error: Error | undefined): void
  }, managedProcessId?: string): NexusSessionTransport {
    let lastVerifiedAt = performance.now()
    let unavailableSince: number | undefined
    const verifyExecution = async (cause?: unknown): Promise<void> => {
      await this.verifySessionEndpoint(managedProcessId!, endpoint, cause)
      lastVerifiedAt = performance.now()
    }
    const client: Pick<NexusVfsClient, 'streamReadAt' | 'streamWrite'> = managedProcessId ? {
      streamWrite: this.client.streamWrite.bind(this.client),
      streamReadAt: async (...args) => {
        try {
          const result = await this.client.streamReadAt(...args)
          if (!result.data.length && performance.now() - lastVerifiedAt >= IDLE_EXECUTION_CHECK_MS) await verifyExecution()
          unavailableSince = undefined
          return result
        }
        catch (error) {
          const code = (error as { code?: unknown })?.code
          if (![4, 8, 10, 14, 'DEADLINE_EXCEEDED', 'RESOURCE_EXHAUSTED', 'ABORTED', 'UNAVAILABLE'].includes(code as string | number)) throw error
          unavailableSince ??= performance.now()
          if (performance.now() - unavailableSince >= EXECUTION_RECONNECT_TIMEOUT_MS) {
            throw new Error('Managed execution remained unavailable; resume the durable session', { cause: error })
          }
          await verifyExecution(error)
          throw error
        }
      },
    } : this.client
    return new NexusSessionTransport({ client, authToken: this.authToken, endpoint, ...events })
  }

  close(): void { this.client.close() }
}
