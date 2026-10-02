import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { SessionRpcMessage } from '@nexus-ai-fs/vfs-client'

export interface AcpTransportEvents {
  onMessage(message: SessionRpcMessage): void
  onStderr(line: string): void
  onClose(code: number | null, signal: NodeJS.Signals | null, error?: Error): void
}

/** A message connection; hosting details belong to the transport. */
export interface AcpMessageTransport {
  readonly connected: boolean
  start(events: AcpTransportEvents): void
  send(message: SessionRpcMessage): Promise<void>
  close(force?: boolean): Promise<void>
}

/** Local CLI processes still speak NDJSON on their own stdio. */
export class StdioAcpTransport implements AcpMessageTransport {
  private isClosed = false
  constructor(private readonly child: ChildProcess, private readonly closeStdinOnly = false) {
    if (!child.stdin || !child.stdout) throw new Error('Failed to start scode process pipes')
  }
  get connected(): boolean { return !this.isClosed && !this.child.stdin?.destroyed }
  start(events: AcpTransportEvents): void {
    const lines = createInterface({ input: this.child.stdout! })
    lines.on('line', line => {
      if (!line.trim()) return
      try { events.onMessage(JSON.parse(line)) }
      catch (error) { events.onStderr(`Invalid ACP message: ${String(error)}\n`) }
    })
    if (this.child.stderr) {
      createInterface({ input: this.child.stderr }).on('line', line => events.onStderr(`${line}\n`))
    }
    let isCloseNotified = false
    const onClose = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (isCloseNotified) return
      isCloseNotified = true
      this.isClosed = true
      events.onClose(code, signal, error)
    }
    this.child.once('error', error => onClose(null, null, error))
    this.child.once('close', (code, signal) => onClose(code, signal))
  }
  send(message: SessionRpcMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.connected) { reject(new Error('ACP connection is closed')); return }
      this.child.stdin!.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve())
    })
  }
  async close(force = false): Promise<void> {
    if (this.isClosed) return
    if (this.closeStdinOnly) this.child.stdin?.end()
    else this.child.kill(force ? 'SIGKILL' : 'SIGTERM')
    this.isClosed = true
  }
}
