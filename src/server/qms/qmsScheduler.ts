export interface QmsLeaseStore {
  tryAcquire(taskName: string, ownerId: string, now: number, leaseMs: number): Promise<boolean>
  complete(taskName: string, ownerId: string, now?: number): Promise<void>
  fail(taskName: string, ownerId: string, error: string, now?: number): Promise<void>
}

export interface QmsScheduledTask {
  name: string
  intervalMs: number
  leaseMs: number
  run(): Promise<void>
}

export interface QmsTaskStatus {
  name: string
  lastRun: number | null
  nextRun: number
  running: boolean
  lastError: string | null
}

export class QmsScheduler {
  private readonly states = new Map<string, { lastRun?: number; running: boolean; lastError?: string }>()
  private timer?: ReturnType<typeof setInterval>

  constructor(private readonly options: {
    ownerId: string
    leases: QmsLeaseStore
    tasks: readonly QmsScheduledTask[]
    pollIntervalMs?: number
    now?: () => number
  }) {
    if (!options.ownerId.trim()) throw new Error('QMS scheduler owner id is required')
    for (const task of options.tasks) {
      if (this.states.has(task.name)) throw new Error(`Duplicate QMS task: ${task.name}`)
      if (task.intervalMs <= 0 || task.leaseMs <= 0) throw new Error(`Invalid schedule for QMS task: ${task.name}`)
      this.states.set(task.name, { running: false })
    }
  }

  async runDue(now = this.options.now?.() ?? Date.now()): Promise<void> {
    for (const task of this.options.tasks) {
      const state = this.states.get(task.name)!
      if (state.running || (state.lastRun !== undefined && now - state.lastRun < task.intervalMs)) continue
      await this.executeTask(task, state, now)
    }
  }

  async runTask(name: string, now = this.options.now?.() ?? Date.now()): Promise<boolean> {
    const task = this.options.tasks.find(candidate => candidate.name === name)
    if (!task) return false
    const state = this.states.get(name)!
    if (state.running) return false
    return this.executeTask(task, state, now)
  }

  start(): void {
    if (this.timer) return
    const interval = this.options.pollIntervalMs ?? 1_000
    this.timer = setInterval(() => { void this.runDue() }, interval)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  status(now = this.options.now?.() ?? Date.now()): QmsTaskStatus[] {
    return this.options.tasks.map(task => {
      const state = this.states.get(task.name)!
      return {
        name: task.name,
        lastRun: state.lastRun ?? null,
        nextRun: state.lastRun === undefined ? now + task.intervalMs : state.lastRun + task.intervalMs,
        running: state.running,
        lastError: state.lastError ?? null,
      }
    })
  }

  private async executeTask(
    task: QmsScheduledTask,
    state: { lastRun?: number; running: boolean; lastError?: string },
    now: number,
  ): Promise<boolean> {
    state.lastRun = now
    if (!await this.options.leases.tryAcquire(task.name, this.options.ownerId, now, task.leaseMs)) return false
    state.running = true
    try {
      await task.run()
      state.lastError = undefined
      await this.options.leases.complete(task.name, this.options.ownerId, now)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state.lastError = message
      await this.options.leases.fail(task.name, this.options.ownerId, message, now)
    } finally {
      state.running = false
    }
    return true
  }
}
