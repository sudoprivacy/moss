import type { ChildProcess } from 'node:child_process'

/** Wait for actual readiness within the parent test's single cancellation budget. */
export function waitForFixtureReady(
  child: ChildProcess,
  pattern: RegExp,
  getLogs: () => { output: string; errors: string },
  signal: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let isFinished = false
    const finish = (port?: number, error?: Error): void => {
      if (isFinished) return
      isFinished = true
      child.stdout?.off('data', onOutput)
      child.off('error', onError)
      child.off('close', onClose)
      signal.removeEventListener('abort', onAbort)
      if (port !== undefined) resolve(port)
      else reject(error)
    }
    const onOutput = (): void => {
      const match = getLogs().output.match(pattern)
      if (!match) return
      const port = Number(match[1])
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        finish(undefined, new Error('Fixture announced an invalid port'))
        return
      }
      finish(port)
    }
    const onError = (error: Error): void => finish(undefined, error)
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(undefined, new Error(`Fixture exited before readiness (${code ?? signal}): ${getLogs().errors}`))
    }
    const onAbort = (): void => finish(undefined,
      new Error(`Fixture startup aborted: ${getLogs().errors}`, { cause: signal.reason }))
    child.stdout?.on('data', onOutput)
    child.once('error', onError)
    child.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else {
      onOutput()
      if (!isFinished && child.stdout?.readableEnded && child.stderr?.readableEnded &&
        (child.exitCode !== null || child.signalCode !== null)) onClose(child.exitCode, child.signalCode)
    }
  })
}
