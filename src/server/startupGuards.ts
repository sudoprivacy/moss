import type { ServerConfig } from './types.js'

type InstanceIdentityConfig = Pick<ServerConfig, 'instanceId' | 'publicBaseUrl'>

/**
 * Refuse a second unidentified instance, but keep public single-node installs
 * compatible. publicBaseUrl is an address for generated URLs and is not proof
 * that multiple server processes share state.
 */
export function assertSafeInstanceIdentity(
  config: InstanceIdentityConfig,
  livePeerCount: number,
): void {
  if (config.instanceId || livePeerCount < 1) return

  throw new Error(
    `[Startup] Refusing to start: ${livePeerCount} live peer instance(s) found but MOSS_INSTANCE_ID is not set. ` +
      'Without a per-instance id, container names, docker labels and wiki job claims collapse to the shared ' +
      '"default" suffix and two instances will destroy each other\'s state. Set a unique MOSS_INSTANCE_ID per instance.',
  )
}
