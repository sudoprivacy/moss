import type {
  BackendHandle,
  BackendSpawnOptions,
  SessionBackend,
  SessionRuntimeOptions,
} from '../sessionManager.js'
import { DangerousBackend } from './dangerousBackend.js'
import { DockerBackend } from './dockerBackend.js'

type RuntimeBackendOptions = {
  defaultRuntime?: SessionRuntimeOptions
  docker?: {
    image?: string
    mode?: 'session' | 'user'
    network?: string
    labels?: Record<string, string>
  }
}

export class RuntimeBackend implements SessionBackend {
  readonly #hostBackend: SessionBackend
  readonly #dockerBackend: SessionBackend
  readonly #defaultRuntime: SessionRuntimeOptions

  constructor(options: RuntimeBackendOptions = {}) {
    this.#hostBackend = new DangerousBackend()
    this.#dockerBackend = new DockerBackend(options.docker)
    this.#defaultRuntime = options.defaultRuntime ?? { type: 'host' }
  }

  async spawn(options: BackendSpawnOptions): Promise<BackendHandle> {
    const runtimeType = options.runtime?.type || this.#defaultRuntime.type || 'host'
    const mergedOptions: BackendSpawnOptions = {
      ...options,
      runtime: {
        ...this.#defaultRuntime,
        ...options.runtime,
        type: runtimeType,
      },
    }

    if (runtimeType === 'docker') {
      return this.#dockerBackend.spawn(mergedOptions)
    }
    return this.#hostBackend.spawn(mergedOptions)
  }
}
