/**
 * Client for nexus's `managed_agent` service — the control plane that owns an
 * agent's process record (PCB), its `/proc/{pid}` entry and the byte tunnel on
 * `/proc/{pid}/fd/{0,1,2}`.
 *
 * Transport is the generic `Call` RPC: `<service>.<method>` with a JSON payload
 * and a JSON reply, the same surface `nexusSecretClient` already uses for
 * `password-vault.*`. The daemon's rpc_codec wraps a success as
 * `{"result": <value>}`; {@link call} unwraps it.
 *
 * Only the `spawn_spec` path is used here: nexus launches the command moss
 * computes and pumps its stdio through node-local memory `DT_STREAM`s. nexus
 * never frames or parses ACP — moss keeps that, unchanged, in `acpBridge`.
 */

import type { NexusVfsClient, StreamReadResult } from '@nexus-ai-fs/vfs-client'

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
    spawnSpec: NexusSpawnSpec
    model?: string
    ownerId?: string
    zoneId?: string
  }): Promise<StartSessionResult> {
    const res = await this.call<{ session_id: string; os_pid?: number | null }>(
      'managed_agent.start_session_v1',
      {
        agent_id: input.agentId,
        ...(input.model ? { model: input.model } : {}),
        ...(input.ownerId ? { owner_id: input.ownerId } : {}),
        ...(input.zoneId ? { zone_id: input.zoneId } : {}),
        spawn_spec: {
          cmd: input.spawnSpec.cmd,
          args: input.spawnSpec.args,
          env: input.spawnSpec.env,
          cwd: input.spawnSpec.cwd,
        },
      },
    )
    return { sessionId: res.session_id, osPid: res.os_pid ?? null }
  }

  /** Terminate the session nexus is supervising. */
  async cancel(sessionId: string, mode: 'session' | 'agent' = 'session'): Promise<void> {
    await this.call<unknown>('managed_agent.cancel_v1', { session_id: sessionId, mode })
  }

  /** Append bytes to the agent's stdin stream (`/proc/{sid}/fd/0`). */
  streamWrite(streamPath: string, data: Buffer): Promise<void> {
    return this.client.streamWrite(streamPath, data, this.authToken)
  }

  /**
   * Read from an fd stream. A blocking read long-polls; a timeout or `eof`
   * means "nothing yet, re-read at the same offset". A real disconnect rejects
   * — that, not `eof`, is how the caller learns the agent is gone.
   */
  streamReadAt(
    streamPath: string,
    offset: string,
    options?: { blocking?: boolean; timeoutMs?: number },
  ): Promise<StreamReadResult> {
    return this.client.streamReadAt(streamPath, offset, this.authToken, options)
  }
}
