import { NexusVfsClient, userRuntimeServerName, type NexusVfsTlsConfig } from '@nexus-ai-fs/vfs-client'
import type { ResolvedNexusConfig } from './nexusEnvConfig.js'
import { mintSessionIdentity, renewSessionCredential, SESSION_CREDENTIAL_VALIDITY_SECS, type SessionIdentity } from './sessionIdentity.js'

export type SessionConnectionConfig = Pick<Extract<ResolvedNexusConfig, { mode: 'external' }>, 'endpoint' | 'authToken'> & {
  tls: NexusVfsTlsConfig | null
  /** Destination from the trusted placement resolver; endpoint remains the credential issuer. */
  runtimeEndpoint?: string
}

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
  let serverName: string | undefined
  if (config.runtimeEndpoint !== undefined) {
    if (!ownerId || !config.tls) {
      throw new Error('A user runtime requires an authenticated owner and an mTLS credential issuer')
    }
    serverName = userRuntimeServerName(ownerId)
  }
  const identity = await mintSessionIdentity(config.endpoint, config.tls, ownerId)
  const tls = identity ? { ...identity.tls, ...(serverName ? { serverName } : {}) } : config.tls
  const endpoint = config.runtimeEndpoint ?? config.endpoint
  const client = tls ? NexusVfsClient.withMtls(endpoint, tls) : new NexusVfsClient(endpoint)
  if (identity && config.tls) {
    const minterTls = config.tls
    try {
      client.maintainSessionCredential(identity.credential, {
        validitySecs: SESSION_CREDENTIAL_VALIDITY_SECS,
        renew: (current, signal) => renewSessionCredential(config.endpoint, minterTls, current, signal),
      })
    } catch (error) {
      client.close()
      throw error
    }
  }
  return {
    client,
    // A request token can take precedence over the mTLS peer. A deployment's
    // credential must not override the authenticated session owner.
    authToken: identity ? '' : config.authToken,
    identity,
  }
}
