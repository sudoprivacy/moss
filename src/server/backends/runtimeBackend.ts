import type {
  BackendHandle,
  BackendSpawnOptions,
  SessionBackend,
  SessionRuntimeOptions,
} from '../sessionManager.js'
import { DockerBackend } from './dockerBackend.js'
import { K8sBackend, type K8sBackendDefaults } from './k8sBackend.js'
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
  k8s?: K8sBackendDefaults
}

export class RuntimeBackend implements SessionBackend {
  readonly #dockerBackend: SessionBackend
  readonly #scodeBackend: SessionBackend
  readonly #k8sBackend: SessionBackend
  readonly #defaultRuntime: SessionRuntimeOptions
  readonly #scodePath?: string

  constructor(options: RuntimeBackendOptions = {}) {
    this.#dockerBackend = new DockerBackend(options.docker)
    this.#k8sBackend = new K8sBackend(options.k8s)
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

    if (runtimeType === 'k8s') {
      return this.#k8sBackend.spawn(mergedOptions)
    }

    return this.#scodeBackend.spawn(mergedOptions)
  }
}