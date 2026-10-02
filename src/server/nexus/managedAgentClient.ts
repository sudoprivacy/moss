/** Managed session control plane and the shared conversation transport. */
import { NexusSessionTransport, type NexusVfsClient, type NexusSessionEndpoint, type SessionRpcMessage } from '@nexus-ai-fs/vfs-client'

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
   * agent profile id; `ownerId` / `zoneId` are the identity the descriptor is
   * stamped with — nexus takes them from the request as-is, so moss states the
   * owning user honestly rather than letting them default to `system` / `root`.
   */
  async startSession(input: {
    agentId: string
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
    const res = await this.call<{ session_id: string; os_pid?: number | null; session_endpoint?: NexusSessionEndpoint; durable_session_id?: string }>(
      'managed_agent.start_session_v1',
      {
        agent_id: input.agentId,
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
      sessionEndpoint: res.session_endpoint, durableSessionId: res.durable_session_id }
  }

  /** Terminate the session nexus is supervising. */
  async cancel(sessionId: string, mode: 'session' = 'session'): Promise<void> {
    await this.call<unknown>('managed_agent.cancel_v1', { session_id: sessionId, mode })
  }

  openSession(endpoint: NexusSessionEndpoint, events: {
    onMessage(message: SessionRpcMessage): void
    onClose(error: Error | undefined): void
  }): NexusSessionTransport {
    return new NexusSessionTransport({ client: this.client, authToken: this.authToken, endpoint, ...events })
  }

  close(): void { this.client.close() }
}
