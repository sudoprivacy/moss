export interface AutomationServiceLifecycle {
  name: string
  start(): void | Promise<void>
  stop(): void | Promise<void>
}

/** Coordinates startup and reverse-order, idempotent shutdown of background services. */
export class AutomationLifecycle {
  private readonly started: AutomationServiceLifecycle[] = []
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null

  constructor(private readonly services: readonly AutomationServiceLifecycle[]) {}

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startInOrder()
    return this.startPromise
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.stopInReverseOrder()
    return this.stopPromise
  }

  private async startInOrder(): Promise<void> {
    try {
      for (const service of this.services) {
        // Include a partially-started service in rollback.
        this.started.push(service)
        await service.start()
      }
    } catch (error) {
      try {
        await this.stop()
      } catch {
        // Preserve the startup failure; individual shutdown errors are secondary.
      }
      throw error
    }
  }

  private async stopInReverseOrder(): Promise<void> {
    const errors: unknown[] = []
    for (const service of this.started.splice(0).reverse()) {
      try {
        await service.stop()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to stop one or more automation services')
    }
  }
}
