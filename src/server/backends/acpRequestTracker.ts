import type { SessionRpcMessage } from '@nexus-ai-fs/vfs-client'

export type AcpRequestCallbacks = {
  onReply(result: unknown): void
  onError(error: Error): void
  /** A timeout is an unknown outcome. The request stays pending for a late reply. */
  onTimeout(): void
}

export class AcpRpcError extends Error {
  constructor(readonly rpcError: { code?: number; message?: string; data?: unknown }) {
    super(rpcError.message || 'ACP request failed')
    this.name = 'AcpRpcError'
  }
}

export function validateAcpTimeout(timeoutMs: number | null): void {
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) throw new Error('Invalid ACP request timeout')
}

/** Request correlation only: no task state, credentials, inference or retry. */
export class AcpRequestTracker {
  readonly #pending = new Map<string | number, AcpRequestCallbacks & { timer?: NodeJS.Timeout }>()
  constructor(private readonly changed: () => void = () => {}) {}
  get size(): number { return this.#pending.size }

  track(id: string | number, callbacks: AcpRequestCallbacks, timeoutMs: number | null = 30000): void {
    if (this.#pending.has(id)) throw new Error('ACP request ID is already pending')
    validateAcpTimeout(timeoutMs)
    const timer = timeoutMs === null ? undefined : setTimeout(() => {
      if (this.#pending.has(id)) callbacks.onTimeout()
    }, timeoutMs)
    this.#pending.set(id, { ...callbacks, timer })
    this.changed()
  }

  handleResponse(message: SessionRpcMessage): boolean {
    if ((typeof message.id !== 'string' && typeof message.id !== 'number') || message.method ||
        (message.result === undefined && message.error === undefined)) return false
    const pending = this.#pending.get(message.id)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.#pending.delete(message.id)
    this.changed()
    if (message.error) pending.onError(new AcpRpcError(message.error))
    else pending.onReply(message.result)
    return true
  }

  failAll(error: Error): void {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const request of pending) clearTimeout(request.timer)
    this.changed()
    for (const request of pending) request.onError(error)
  }
}
