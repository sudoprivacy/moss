import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { InternalSessionChannel } from '../internalSessionChannel.js'
import type { RuntimeService } from '../runtimeService.js'

type Receipt = { state: 'pending' | 'unknown' } | { state: 'complete'; text: string; error?: string }
type Hooks = { onStarted(): Promise<void>; onCompleted(text: string, error?: string): Promise<void> }

/** The ordinary owner-routed runner channel; no alternate chat or prompt dispatcher. */
class ReviewChannel extends EventEmitter {
  readonly ready: Promise<void>
  private readonly pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private isClosed = false
  private buffer = ''

  constructor(private readonly channel: InternalSessionChannel, sessionId: string) {
    super()
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Native receipt capability was not confirmed')), 30000)
      this.once('closed', error => { clearTimeout(timer); reject(error) })
      this.once('hello', hello => {
        clearTimeout(timer)
        if (hello.session_id !== sessionId || hello.nativeInputReceipts?.version !== 1) {
          this.fail(new Error('Upgrade the native runner: input receipt protocol v1 is required'))
        } else resolve()
      })
    })
    channel.on('data', this.onData)
    channel.on('error', this.onError)
    channel.on('close', this.onClose)
  }

  private readonly onError = (error: unknown) => this.fail(error instanceof Error ? error : new Error('Native channel failed'))
  private readonly onClose = () => this.fail(new Error('Native input outcome is unknown; recover the original conversation'))
  private readonly onData = (chunk: unknown) => {
    try {
      this.buffer += String(chunk)
      if (this.buffer.length > 32 * 1024 * 1024) throw new Error('Native channel frame exceeds the supported limit')
      for (;;) {
        const end = this.buffer.indexOf('\n')
        if (end < 0) break
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        if (!line.trim()) continue
        const envelope = JSON.parse(line)
        if (envelope.type === 'exit' || envelope.type === 'error') throw new Error('Native input outcome is unknown')
        if (envelope.type !== 'stdout') continue
        const event = JSON.parse(envelope.line)
        if (event.type === 'hello') this.emit('hello', event)
        if (['input_delivery_receipt', 'input_delivery_reply'].includes(event.type)) {
          const pending = this.pending.get(event.requestId)
          if (pending) { this.pending.delete(event.requestId); clearTimeout(pending.timer); pending.resolve(event) }
        }
        this.emit('application', event)
      }
    } catch (error) { this.onError(error) }
  }

  private fail(error: Error): void {
    if (this.isClosed) return
    this.isClosed = true
    for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(error) }
    this.pending.clear()
    this.emit('closed', error)
  }

  async request(request: Record<string, unknown>): Promise<any> {
    await this.ready
    if (this.isClosed) throw new Error('Native channel closed')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Native input outcome is unknown; do not resubmit')) }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.channel.write(JSON.stringify({ type: 'stdin', data: JSON.stringify({ type: 'control_request', request_id: id, request }) }), error => { if (error) this.onError(error) })
    })
  }

  async receipt(clientId: string): Promise<Receipt> {
    const response = await this.request({ subtype: 'input_receipt', clientId })
    const value = response.receipt
    if (response.isSupported !== true || !value || !['pending', 'unknown', 'complete'].includes(value.state)
      || (value.state === 'complete' && (typeof value.text !== 'string' || (value.error !== undefined && typeof value.error !== 'string')))) {
      throw new Error('Invalid native input receipt')
    }
    return value
  }

  dispose(): void {
    this.fail(new Error('Native review channel closed'))
    this.channel.off('data', this.onData); this.channel.off('error', this.onError); this.channel.off('close', this.onClose)
    this.channel.destroy()
  }
}

/** Current owner/model access is mandatory at the existing runtime boundary. */
export function createNativeConversationReview(runtime: Pick<RuntimeService, 'connectInternalChannel'>, authorize: (sessionId: string) => Promise<void>) {
  const channels = new Set<ReviewChannel>()
  let isClosed = false
  const withChannel = async <T>(sessionId: string, operation: (channel: ReviewChannel) => Promise<T>): Promise<T> => {
    if (isClosed) throw new Error('Native review delivery is closed')
    await authorize(sessionId)
    const connection = await runtime.connectInternalChannel(sessionId)
    if (isClosed) { connection.destroy(); throw new Error('Native review delivery is closed') }
    const channel = new ReviewChannel(connection, sessionId)
    channels.add(channel)
    try {
      await channel.ready
      if (isClosed) throw new Error('Native review delivery is closed')
      return await operation(channel)
    } finally { channels.delete(channel); channel.dispose() }
  }
  const recover = (input: { conversationId: string; messageId: string }) => withChannel(input.conversationId, async channel => {
    const receipt = await channel.receipt(input.messageId)
    await authorize(input.conversationId)
    return receipt
  })
  return {
    recover,
    messageExists: async (conversationId: string, messageId: string) => (await recover({ conversationId, messageId })).state !== 'unknown',
    deliver: (input: { conversationId: string; messageId: string; content: string; agentContent: string }, hooks: Hooks) => withChannel(input.conversationId, async channel => {
      let isStarted = false
      let progress = Promise.resolve()
      let onApplication!: (event: any) => void
      let onClosed!: (error: Error) => void
      const completed = new Promise<void>((resolve, reject) => {
        onClosed = reject
        onApplication = event => {
          if (event.type === 'input_delivery_update' && event.update?.kind === 'committed' && event.update.clientId === input.messageId && !isStarted) {
            isStarted = true
            progress = progress.then(() => hooks.onStarted())
            void progress.catch(reject)
          }
          if (event.type === 'input_delivery_persisted' && event.nativeInput?.clientIds?.includes(input.messageId)) {
            if (event.error) reject(new Error('Native transcript did not confirm completion'))
            else resolve()
          }
        }
        channel.on('application', onApplication); channel.once('closed', onClosed)
      })
      // Admission can fail before the completion wait is reached.
      void completed.catch(() => {})
      try {
        await authorize(input.conversationId)
        const admission = await channel.request({ subtype: 'input', action: { action: 'submit', clientId: input.messageId,
          delivery: 'queue', display: input.content, content: [{ type: 'text', text: input.agentContent }] } })
        if (admission.isSupported !== true || admission.error) throw new Error('Native input admission was not confirmed')
        await completed
        await progress
        const receipt = await channel.receipt(input.messageId)
        await authorize(input.conversationId)
        if (receipt.state !== 'complete') throw new Error('Native completion requires recovery from the original conversation')
        await hooks.onCompleted(receipt.text, receipt.error)
        return { success: true }
      } finally { channel.off('application', onApplication); channel.off('closed', onClosed) }
    }),
    close: () => { isClosed = true; for (const channel of channels) channel.dispose() },
  }
}
