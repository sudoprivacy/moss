import type {
  BackendHandle,
  BackendSpawnOptions,
  SessionBackend,
  SessionRuntimeOptions,
} from '../sessionManager.js'
import { DockerBackend } from './dockerBackend.js'
import { K8sBackend, type K8sBackendDefaults } from './k8sBackend.js'
import { CohostBackend } from './cohostBackend.js'
import { ScodeBackend } from './scodeBackend.js'

type RuntimeBackendOptions = {
  /** Trusted host composition; never read from a session request or manifest. */
  standardAcpBackend?: SessionBackend
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
  readonly #cohostBackend: SessionBackend
  readonly #defaultRuntime: SessionRuntimeOptions
  readonly #scodePath?: string
  readonly #standardAcpBackend?: SessionBackend

  constructor(options: RuntimeBackendOptions = {}) {
    this.#standardAcpBackend = options.standardAcpBackend
    this.#dockerBackend = new DockerBackend(options.docker)
    this.#k8sBackend = new K8sBackend(options.k8s)
    this.#cohostBackend = new CohostBackend()
    this.#scodeBackend = new ScodeBackend()
    this.#defaultRuntime = options.defaultRuntime ?? {
      type: 'host',
      engine: 'scode',
    }
    this.#scodePath = options.scodePath || this.#defaultRuntime.scodePath
  }

  async spawn(options: BackendSpawnOptions): Promise<BackendHandle> {
    const engine = options.runtime?.engine ?? this.#defaultRuntime.engine ?? 'scode'
    if (engine !== 'scode' && engine !== 'standard_acp') throw new Error('Unknown native execution engine')
    if (engine === 'standard_acp') {
      if (!this.#standardAcpBackend) throw new Error('Standard ACP execution is not registered by this trusted host')
      return this.#standardAcpBackend.spawn({ ...options, runtime: { ...this.#defaultRuntime, ...options.runtime, engine } })
    }
    const runtimeType = options.runtime?.type || this.#defaultRuntime.type || 'host'

    if (!['host', 'docker', 'k8s', 'cohost'].includes(runtimeType)) throw new Error('Task-managed sessions cannot launch a native runtime backend')

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

    if (runtimeType === 'cohost') {
      return this.#cohostBackend.spawn(mergedOptions)
    }

    return this.#scodeBackend.spawn(mergedOptions)
  }
}
