import type { NexusSessionTransport, SessionRpcMessage } from '@nexus-ai-fs/vfs-client'
import { isUnknownManagedSession, type ManagedAgentClient, type StartSessionResult } from '../nexus/managedAgentClient.js'
import type { AcpMessageTransport, AcpTransportEvents } from './acpTransport.js'

/** Both Nexus hosting modes expose this same message connection. */
export class NexusAcpTransport implements AcpMessageTransport {
  private mailbox?: NexusSessionTransport
  private isClosing = false
  private closing?: Promise<void>
  private readiness?: Promise<boolean>
  private events?: AcpTransportEvents
  private closeError?: Error
  private isCloseReported = false
  constructor(private readonly agent: ManagedAgentClient, readonly session: StartSessionResult) {}
  get connected(): boolean { return this.mailbox?.connected ?? false }
  /** Foreground readiness cannot be inferred from a retained mailbox stream. */
  checkReady(): Promise<boolean> {
    if (this.isClosing || !this.connected) return Promise.resolve(false)
    this.readiness ??= this.agent.verifySessionEndpoint(this.session.sessionId, this.session.sessionEndpoint)
      .then(() => !this.isClosing && this.connected)
      .finally(() => { this.readiness = undefined })
    return this.readiness
  }
  start(events: AcpTransportEvents): void {
    if (this.mailbox || this.isClosing) throw new Error('Session transport already started or closed')
    this.events = events
    this.mailbox = this.agent.openSession(this.session.sessionEndpoint, {
      onMessage: message => {
        const params = message.params as {text?: unknown} | undefined
        if (message.method === '_nexus/diagnostic' && typeof params?.text === 'string') events.onStderr(params.text)
        else events.onMessage(message)
      },
      onClose: error => {
        if (this.isCloseReported) return
        if (this.isClosing) { this.closeError ??= error; return }
        this.reportClose(error)
        void this.close().catch(failure => events.onStderr(`${String(failure)}\n`))
      },
    }, this.session.sessionId)
    this.mailbox.start()
  }
  send(message: SessionRpcMessage): Promise<void> {
    return this.mailbox?.send(message) ?? Promise.reject(new Error('Session transport has not started'))
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.isClosing = true
    this.closing = this.closeResources()
    return this.closing
  }
  private async closeResources(): Promise<void> {
    const failures: Error[] = []
    const recordFailure = (error: unknown) => failures.push(error instanceof Error ? error : new Error(String(error)))
    try { await this.mailbox?.close() }
    catch (error) { recordFailure(error) }
    try { await this.agent.cancel(this.session.sessionId, this.session.sessionEndpoint) }
    catch (error) { if (!isUnknownManagedSession(error, this.session.sessionId)) recordFailure(error) }
    try { this.agent.close() }
    catch (error) { recordFailure(error) }
    if (this.closeError && !failures.includes(this.closeError)) failures.unshift(this.closeError)
    const failure = failures.length > 1
      ? new AggregateError(failures, failures.map(error => error.message).join('; '))
      : failures[0]
    this.reportClose(failure)
    if (failure) throw failure
  }
  private reportClose(error?: Error): void {
    if (this.isCloseReported) return
    this.isCloseReported = true
    this.events?.onClose(null, null, error)
  }
}
