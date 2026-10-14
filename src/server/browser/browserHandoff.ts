import { openInternalSessionChannel, type ChannelDeps } from '../internalSessionChannel.js'

/** Resume through the existing authenticated owner route, never a raw socket.
 * Only the runner acknowledgement is awaited; the model turn continues through
 * the conversation's normal stream. A lost acknowledgement is never replayed.
 */
export async function notifyBrowserReturn(deps: ChannelDeps, sessionId: string, note: unknown): Promise<void> {
  const channel = await openInternalSessionChannel(deps, sessionId, { maxAttempts: 1, handshakeTimeoutMs: 8_000 })
  const text = 'The user has explicitly returned control of the shared browser. ' +
    'First call sudowork-browser browser_observe to read the current page and control epochs. ' +
    'Discard browser coordinates and pending inputs from before takeover. Check any uncertain previous action before repeating it. ' +
    'Continue the original task from the current page when appropriate. ' +
    (typeof note === 'string' && note.trim() ? `The user left this handoff note: ${note.trim().slice(0, 2000)}` : '')
  try {
    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        channel.removeAllListeners('data')
        channel.removeAllListeners('error')
        channel.removeAllListeners('close')
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => finish(new Error('Browser returned; agent notification was not acknowledged. Send a message to continue.')), 5_000)
      channel.on('error', error => finish(error instanceof Error ? error : new Error('Browser return notification failed')))
      channel.on('close', () => finish(new Error('Browser returned; agent connection closed before acknowledging the notification')))
      channel.on('data', chunk => {
        buffer += String(chunk)
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n')
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          try {
            const event = JSON.parse(line) as { type?: string }
            if (event.type === 'stdin_ack') finish()
            else if (event.type === 'error') finish(new Error('Browser return notification was rejected'))
          } catch { /* ignore unrelated output */ }
        }
      })
      const data = JSON.stringify({ type: 'user', source: 'browser_handoff', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n'
      channel.write(JSON.stringify({ type: 'stdin', data }) + '\n', error => { if (error) finish(new Error('Browser return notification could not be sent')) })
    })
  } finally {
    channel.destroy()
  }
}
