import type { SessionRuntimeInfo } from './sessionManager.js'
import type { ServerConfig } from './types.js'

export function resolveRuntimeScodePath(
  config: ServerConfig,
  type: SessionRuntimeInfo['type'],
  explicitPath?: string,
): string | undefined {
  if (explicitPath) return explicitPath
  const typePath = type === 'docker'
    ? config.dockerScodePath
    : config.hostScodePath
  return typePath || config.scodePath
}
