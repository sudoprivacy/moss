import type {
  BackendHandle,
  BackendSpawnOptions,
  SessionBackend,
} from '../sessionManager.js'
import {
  buildSessionEnv,
  createStreamBackendHandle,
  spawnLocalCliProcess,
} from './backendUtils.js'

export class DangerousBackend implements SessionBackend {
  async spawn(options: BackendSpawnOptions): Promise<BackendHandle> {
    const child = spawnLocalCliProcess(
      {
        ...options,
        runtime: {
          ...options.runtime,
          type: 'host',
        },
      },
      buildSessionEnv(options, {
        MOSS_SESSION_RUNTIME_TYPE: 'host',
        CLAUDE_CONFIG_DIR: options.runtime?.configDir,
      }),
    )

    return createStreamBackendHandle(child, options, {
      type: 'host',
      configDir: options.runtime?.configDir,
    })
  }
}
