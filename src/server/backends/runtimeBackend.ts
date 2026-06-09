import type {
  BackendHandle,
  BackendSpawnOptions,
  SessionBackend,
  SessionRuntimeOptions,
} from '../sessionManager.js'
import { DockerBackend } from './dockerBackend.js'
import { ScodeBackend } from './scodeBackend.js'

type RuntimeBackendOptions = {
  scodePath?: string
  defaultRuntime?: SessionRuntimeOptions
  docker?: {
    image?: string
    mode?: 'session' | 'user'
    containerMode?: 'session' | 'user'
    execKillGraceMs?: number
    network?: string
    labels?: Record<string, string>
  }
}

export class RuntimeBackend implements SessionBackend {
  readonly #dockerBackend: SessionBackend
  readonly #scodeBackend: SessionBackend
  readonly #defaultRuntime: SessionRuntimeOptions
  readonly #scodePath?: string

  constructor(options: RuntimeBackendOptions = {}) {
    this.#dockerBackend = new DockerBackend(options.docker)
    this.#scodeBackend = new ScodeBackend()
    this.#defaultRuntime = options.defaultRuntime ?? {
      type: 'host',
      engine: 'scode',
    }
    this.#scodePath = options.scodePath || this.#defaultRuntime.scodePath
  }

  async spawn(options: BackendSpawnOptions): Promise<BackendHandle> {
    const runtimeType = options.runtime?.type || this.#defaultRuntime.type || 'host'

    const mergedOptions: BackendSpawnOptions = {
      ...options,
      runtime: {
        ...this.#defaultRuntime,
        scodePath: this.#scodePath,
        ...options.runtime,
        type: runtimeType,
        engine: 'scode',
      },
    }

    if (runtimeType === 'docker') {
      return this.#dockerBackend.spawn(mergedOptions)
    }

    return this.#scodeBackend.spawn(mergedOptions)
  }
}