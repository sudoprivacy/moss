import { NexusRpcError, NexusVfsClient, userRuntimeServerName, type NexusVfsTlsConfig, type NexusVfsClientOptions } from '@nexus-ai-fs/vfs-client'
import { setTimeout as delay } from 'node:timers/promises'
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
  options: Omit<NexusVfsClientOptions, 'tls'> = {},
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
  const client = tls ? NexusVfsClient.withMtls(endpoint, tls, options) : new NexusVfsClient(endpoint, options)
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

/** Wait for the owner's authenticated data plane after projected certificate delivery. */
export async function waitForSessionRuntime(config: SessionConnectionConfig, ownerId: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const connection = await connectSessionRuntime(config, ownerId, { connectTimeoutMs: 2000 })
  const close = () => connection.client.close()
  signal.addEventListener('abort', close, { once: true })
  const deadline = Date.now() + 90_000
  try {
    while (true) {
      signal.throwIfAborted()
      try { await connection.client.stat('/', connection.authToken); return } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof NexusRpcError) || ![4, 14].includes(error.code)) throw error
        if (Date.now() >= deadline) throw new Error('User runtime did not become mTLS-ready within 90 seconds', { cause: error })
      }
      await delay(1000, undefined, { signal })
    }
  } finally {
    signal.removeEventListener('abort', close)
    close()
  }
}
