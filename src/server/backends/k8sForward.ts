import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface PodForward {
  endpoint: string
  isOpen: () => boolean
  close: () => void
}

/** One loopback transport per user box; session traffic reuses its connection. */
export async function forwardK8sPod(base: string[], name: string, remotePort: number): Promise<PodForward> {
  const child = spawn('kubectl', [...base, 'port-forward', '--address=127.0.0.1', `pod/${name}`, `:${remotePort}`],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const lines = createInterface({ input: child.stdout })
  let isOpen = true
  child.stderr.resume()
  child.once('exit', () => { isOpen = false; lines.close() })
  return new Promise<PodForward>((resolve, reject) => {
    const timer = setTimeout(() => {
      lines.close()
      child.kill()
      reject(new Error('User Pod transport did not become ready'))
    }, 20_000)
    const onFailure = (): void => {
      clearTimeout(timer)
      isOpen = false
      lines.close()
      child.kill()
      reject(new Error('User Pod transport closed'))
    }
    child.once('error', onFailure)
    child.once('exit', onFailure)
    lines.on('line', line => {
      const port = /^Forwarding from 127\.0\.0\.1:(\d+) ->/.exec(line)?.[1]
      if (!port) return
      clearTimeout(timer)
      child.removeListener('error', onFailure)
      child.removeListener('exit', onFailure)
      child.on('error', () => { isOpen = false })
      resolve({
        endpoint: `https://127.0.0.1:${port}`,
        isOpen: () => isOpen,
        close: () => { isOpen = false; lines.close(); child.kill() },
      })
    })
  })
}
