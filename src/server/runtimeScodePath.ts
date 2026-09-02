import type { SessionRuntimeInfo } from './sessionManager.js'
import type { ServerConfig } from './types.js'

export function resolveRuntimeScodePath(
  config: ServerConfig,
  type: SessionRuntimeInfo['type'],
  explicitPath?: string,
): string | undefined {
  if (explicitPath) return explicitPath
  if (type === 'host' && !config.hostScodeEnabled) {
    throw new Error(
      'Host runtime is unavailable: bundled scode requires glibc 2.39 or newer. Use the Docker runtime or upgrade the host OS.',
    )
  }
  const typePath = type === 'docker'
    ? config.dockerScodePath
    : config.hostScodePath
  return typePath || config.scodePath
}
