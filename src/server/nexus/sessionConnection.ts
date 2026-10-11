import { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import type { ResolvedNexusConfig } from './nexusEnvConfig.js'
import { mintSessionIdentity, type SessionIdentity } from './sessionIdentity.js'

type SessionConnectionConfig = Pick<Extract<ResolvedNexusConfig, { mode: 'external' }>, 'endpoint' | 'tls' | 'authToken'>

export interface SessionRuntimeConnection {
  client: NexusVfsClient
  authToken: string
  identity: SessionIdentity | null
}

/** Use the user's delegated certificate as the sole credential for execution and files. */
export async function connectSessionRuntime(
  config: SessionConnectionConfig,
  ownerId: string | undefined,
): Promise<SessionRuntimeConnection> {
  const identity = await mintSessionIdentity(config.endpoint, config.tls, ownerId)
  const tls = identity?.tls ?? config.tls
  return {
    client: tls ? NexusVfsClient.withMtls(config.endpoint, tls) : new NexusVfsClient(config.endpoint),
    // A request token can take precedence over the mTLS peer. A deployment's
    // credential must not override the authenticated session owner.
    authToken: identity ? '' : config.authToken,
    identity,
  }
}
