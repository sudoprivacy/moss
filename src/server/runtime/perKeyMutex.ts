/**
 * Per-key mutex: serializes async operations that share a logical key while
 * letting different keys run in parallel.
 *
 * Used by UserContainerRegistry to prevent TOCTOU races on container state
 * transitions (starting/running/draining/dead). A single Promise ensureLock
 * cannot prevent two concurrent ensure() calls from both seeing state='dead'
 * and starting two containers.
 */
export class PerKeyMutex {
  readonly #queues = new Map<string, Promise<unknown>>()

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#queues.get(key) ?? Promise.resolve()
    // Swallow upstream rejections so one failed task doesn't poison the queue.
    const gated = prev.catch(() => {})
    const next = gated.then(fn)
    const tail = next.catch(() => {})
    this.#queues.set(key, tail)
    try {
      return await next
    } finally {
      // Only drop the queue entry if no one else has queued behind us. If
      // someone has, our `tail` is no longer the head and removing it would
      // orphan their wait.
      if (this.#queues.get(key) === tail) {
        this.#queues.delete(key)
      }
    }
  }

  /** Test helper: how many keys currently have a pending or running task. */
  size(): number {
    return this.#queues.size
  }
}
