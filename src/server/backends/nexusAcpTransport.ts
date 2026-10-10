import type { NexusSessionTransport, SessionRpcMessage } from '@nexus-ai-fs/vfs-client'
import type { ManagedAgentClient, StartSessionResult } from '../nexus/managedAgentClient.js'
import type { AcpMessageTransport, AcpTransportEvents } from './acpTransport.js'

/** Both Nexus hosting modes expose this same message connection. */
export class NexusAcpTransport implements AcpMessageTransport {
  private mailbox?: NexusSessionTransport
  private isClosing = false
  constructor(private readonly agent: ManagedAgentClient, readonly session: StartSessionResult) {}
  get connected(): boolean { return this.mailbox?.connected ?? false }
  start(events: AcpTransportEvents): void {
    if (this.mailbox || this.isClosing) throw new Error('Session transport already started or closed')
    this.mailbox = this.agent.openSession(this.session.sessionEndpoint, {
      onMessage: message => {
        const params = message.params as {text?: unknown} | undefined
        if (message.method === '_nexus/diagnostic' && typeof params?.text === 'string') events.onStderr(params.text)
        else events.onMessage(message)
      },
      onClose: error => {
        events.onClose(null, null, error)
        if (!this.isClosing) void this.close().catch(failure => events.onStderr(`${String(failure)}\n`))
      },
    })
    this.mailbox.start()
  }
  send(message: SessionRpcMessage): Promise<void> {
    return this.mailbox?.send(message) ?? Promise.reject(new Error('Session transport has not started'))
  }
  async close(): Promise<void> {
    if (this.isClosing) return
    this.isClosing = true
    try { await this.mailbox?.close() }
    finally {
      try { await this.agent.cancel(this.session.sessionId) }
      finally { this.agent.close() }
    }
  }
}
