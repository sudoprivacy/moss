/**
 * Nexus runtime config resolved from the environment.
 *
 * Split out of `nexusManager.ts` so consumers that only need the *config* do
 * not pull in the daemon-lifecycle machinery. `nexusManager` imports
 * `child_process`, `net`, a lockfile helper and `@sudo/contracts/zone-id`;
 * the session runner bundle (`bin/direct-connect-session-runner.mjs`) inlines
 * everything it imports, so a backend reaching for `resolveNexusConfigFromEnv`
 * would drag the embedded-daemon spawn path into a process that never starts a
 * daemon. This module has no imports at all.
 *
 * Zone-id validation stays in `nexusManager` on purpose: it only applies to the
 * embedded daemon moss starts itself.
 */

export const NEXUS_DEFAULT_GRPC_PORT = Number(process.env.MOSS_NEXUS_GRPC_PORT) || 2126

/** mTLS material for connecting to an external `nexusd-cluster`. */
export type NexusTlsConfig = {
  caPath: string
  certPath: string
  keyPath: string
  /** Server-cert SAN to validate; defaults to the cluster's `nexus-node`. */
  serverName?: string
}

export type NexusMode = 'embedded' | 'external'

/**
 * Resolved nexus runtime config.
 *
 * - `embedded`: moss spawns its own `nexusd serve-local` (trusted loopback,
 *   `--no-tls`) — the standalone/dev default, unchanged behavior.
 * - `external`: moss connects to an already-running production
 *   `nexusd-cluster` over its advertise bind, optionally with mTLS. moss does
 *   NOT spawn or manage the daemon lifecycle in this mode.
 */
export type ResolvedNexusConfig =
  | { mode: 'embedded'; grpcPort: number; zoneId?: string }
  | { mode: 'external'; endpoint: string; authToken: string; tls: NexusTlsConfig | null; zoneId?: string }

/**
 * Resolve the nexus runtime config from the environment.
 *
 * `MOSS_NEXUS_MODE=external` switches moss from the embedded serve-local
 * daemon to an external cluster client:
 *   - `MOSS_NEXUS_ENDPOINT`   host+scheme+port, e.g. `https://127.0.0.1:8443`
 *   - `MOSS_NEXUS_TLS_CA`     cluster CA cert (PEM path)
 *   - `MOSS_NEXUS_TLS_CERT`   moss client cert (PEM path)
 *   - `MOSS_NEXUS_TLS_KEY`    moss client key  (PEM path)
 *   - `MOSS_NEXUS_TLS_SERVER_NAME`  optional SAN override (default `nexus-node`)
 *   - `MOSS_NEXUS_AUTH_TOKEN` optional per-RPC auth token
 *
 * Embedded mode alone accepts `MOSS_NEXUS_ZONE_ID`. Its bytes are preserved
 * exactly so the startup binding can reject normalization or later changes.
 *
 * Anything else stays `embedded` (default), preserving the current
 * spawn-serve-local behavior for standalone/dev.
 */
export function resolveNexusConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ResolvedNexusConfig {
  const mode: NexusMode = env.MOSS_NEXUS_MODE?.trim() === 'external' ? 'external' : 'embedded'
  const zoneId = env.MOSS_NEXUS_ZONE_ID
  const zoneConfig = zoneId === undefined ? {} : { zoneId }
  if (mode === 'embedded') {
    return { mode, grpcPort: Number(env.MOSS_NEXUS_GRPC_PORT) || NEXUS_DEFAULT_GRPC_PORT, ...zoneConfig }
  }

  if (zoneId !== undefined) {
    throw new Error(
      'MOSS_NEXUS_ZONE_ID is only valid for Moss-managed embedded Nexus; external Nexus topology is owned outside Moss',
    )
  }

  const endpoint = env.MOSS_NEXUS_ENDPOINT?.trim()
  if (!endpoint) {
    throw new Error(
      'MOSS_NEXUS_MODE=external requires MOSS_NEXUS_ENDPOINT (e.g. https://127.0.0.1:8443)',
    )
  }

  const caPath = env.MOSS_NEXUS_TLS_CA?.trim()
  const certPath = env.MOSS_NEXUS_TLS_CERT?.trim()
  const keyPath = env.MOSS_NEXUS_TLS_KEY?.trim()
  let tls: NexusTlsConfig | null = null
  if (caPath || certPath || keyPath) {
    if (!caPath || !certPath || !keyPath) {
      throw new Error(
        'mTLS to the external nexus requires all of MOSS_NEXUS_TLS_CA, MOSS_NEXUS_TLS_CERT, MOSS_NEXUS_TLS_KEY',
      )
    }
    tls = { caPath, certPath, keyPath, serverName: env.MOSS_NEXUS_TLS_SERVER_NAME?.trim() || undefined }
  } else if (endpoint.startsWith('https://')) {
    throw new Error(
      'MOSS_NEXUS_ENDPOINT uses https:// but no client certs were provided; set MOSS_NEXUS_TLS_CA/CERT/KEY for mTLS',
    )
  }

  return { mode, endpoint, authToken: env.MOSS_NEXUS_AUTH_TOKEN?.trim() ?? '', tls }
}
