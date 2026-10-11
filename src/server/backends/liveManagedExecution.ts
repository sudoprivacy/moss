import type { InternalSessionChannel } from '../internalSessionChannel.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import { parseCohostSessionBinding, type CohostSessionBinding } from '../runtime/cohostSessionRepository.js'
import { COHOST_RECOVERY_TIMEOUT_MS } from './cohostRecovery.js'

export interface LiveManagedExecution {
  processId: string
  binding: CohostSessionBinding
}

/** Read the live execution identity through the authenticated owner route. */
export async function readLiveManagedExecution(
  channel: InternalSessionChannel,
  sessionId: string,
  timeoutMs = COHOST_RECOVERY_TIMEOUT_MS,
): Promise<LiveManagedExecution> {
  return new Promise<LiveManagedExecution>((resolve, reject) => {
    let buffer = ''
    let isSettled = false
    const finish = (execution?: LiveManagedExecution, error?: unknown): void => {
      if (isSettled) return
      isSettled = true
      clearTimeout(timer)
      channel.off('data', onData)
      channel.off('close', onClose)
      channel.off('error', onError)
      channel.destroy()
      if (execution) resolve(execution)
      else reject(error ?? new ResourceAccessError(503, 'Cohost execution is not ready'))
    }
    const onClose = (): void => finish()
    const onError = (error: unknown): void => finish(undefined, error)
    const onData = (bytes: Buffer | string): void => {
      buffer += bytes.toString()
      if (buffer.length > 65_536) { finish(); return }
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message: Record<string, unknown>
        try { message = JSON.parse(line) as Record<string, unknown> }
        catch { finish(); return }
        if (!message || typeof message !== 'object') { finish(); return }
        if (message.type === 'exit' || message.type === 'error') { finish(); return }
        if (message.type !== 'hello') continue
        if (message.sessionId !== sessionId || message.runtimeType !== 'cohost') {
          finish(undefined, new ResourceAccessError(403, 'Cohost execution does not belong to this session'))
          return
        }
        if (message.state !== 'running') continue
        const id = message.managedProcessId
        if (typeof message.attemptId !== 'string' || !message.attemptId || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) { finish(); return }
        let binding: CohostSessionBinding
        try { binding = parseCohostSessionBinding(message.cohostSessionBinding) }
        catch { finish(); return }
        finish({ processId: id, binding })
        return
      }
    }
    const timer = setTimeout(onClose, timeoutMs)
    channel.on('data', onData)
    channel.once('close', onClose)
    channel.once('error', onError)
    if (channel.destroyed) finish()
  })
}
