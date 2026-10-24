import type { WorkAdmission } from '@sudo/user-runtime'
import type { RuntimeInputBarrier } from './runtimeInputBarrier.js'

interface AdmissionSnapshot {
  instanceId: string
  epochId: string
  scope: 'controller-input'
  isPaused: boolean
  activeOperations: number
  pauseIds: string[]
  isInputDrained?: boolean
  connections?: Awaited<ReturnType<RuntimeInputBarrier['pause']>>
}

/** Ephemeral, independently releasable operator fences for this controller. */
export class RuntimeAdmissionPauses {
  readonly #pauses = new Map<string, { resume(): void }>()
  readonly #operations = new Map<string, { type: 'pause' | 'resume'; pending: Promise<AdmissionSnapshot> }>()

  constructor(
    private readonly instanceId: string,
    private readonly admission: WorkAdmission,
    private readonly inputs: RuntimeInputBarrier,
    private readonly timeoutMs = 5000,
  ) {}

  snapshot(): AdmissionSnapshot {
    return { instanceId: this.instanceId, epochId: this.admission.epochId, scope: 'controller-input', isPaused: this.admission.isPaused,
      activeOperations: this.admission.activeCount, pauseIds: [...this.#pauses.keys()] }
  }

  pause(id: string): Promise<AdmissionSnapshot> {
    const previous = this.#operations.get(id)
    if (previous?.type === 'pause') return previous.pending
    return this.#schedule(id, 'pause', () => this.#prepare(id))
  }

  resume(id: string): Promise<AdmissionSnapshot> {
    return this.#schedule(id, 'resume', async () => {
      await this.#release(id)
      return this.snapshot()
    })
  }

  #schedule(id: string, type: 'pause' | 'resume', operation: () => Promise<AdmissionSnapshot>): Promise<AdmissionSnapshot> {
    const previous = this.#operations.get(id)
    const pending = previous ? previous.pending.catch(() => {}).then(operation) : operation()
    const current = { type, pending }
    this.#operations.set(id, current)
    void pending.finally(() => {
      if (this.#operations.get(id) === current) this.#operations.delete(id)
    }).catch(() => {})
    return pending
  }

  async #prepare(id: string): Promise<AdmissionSnapshot> {
    if (!this.#pauses.has(id)) this.#pauses.set(id, this.admission.pause())
    let connections: Awaited<ReturnType<RuntimeInputBarrier['pause']>>
    let isInputDrained: boolean
    try {
      const isJoined = await this.admission.waitForIdle(this.timeoutMs)
      connections = isJoined ? await this.inputs.pause(id, this.timeoutMs) : []
      isInputDrained = isJoined && connections.every(connection => connection.state === 'idle')
    } catch (error) {
      await this.#release(id)
      throw error
    }
    if (!isInputDrained) await this.#release(id)
    return { ...this.snapshot(), isInputDrained, connections }
  }

  async #release(id: string): Promise<void> {
    // Keep the controller fence if a consuming daemon has not confirmed release.
    await this.inputs.resume(id)
    this.#pauses.get(id)?.resume()
    this.#pauses.delete(id)
  }
}
