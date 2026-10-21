import type net from 'node:net'
import { HttpError } from '../httpRespond.js'
import type { RuntimeService } from '../runtimeService.js'
import { PARK_PUBLIC_SESSION_SOURCE } from './mossSessions.js'

export interface ParkAgentChannel {
  /** Create a host-runtime agent session bound to the park public assistant. */
  createSession(input: { orgId: string; assistantId: string; anonymousSessionId: string }): Promise<string>
  /** Send one user turn and stream assistant text deltas until the turn's result frame. */
  sendAndStream(mossSessionId: string, question: string, uuid: string, onDelta: (text: string) => void): Promise<{ answer: string }>
  /** Terminate the agent session and release its pool slot. */
  terminate(mossSessionId: string): Promise<void>
  /** Whether the session record is still usable (not terminated). */
  isAlive(mossSessionId: string): Promise<boolean>
}

const TURN_TIMEOUT_MS = 120_000

/**
 * Production channel driving real moss agent sessions over the internal
 * runner socket (same pattern as WikiJobExecutor): ensureSessionReady
 * respawns an idle-reaped attempt, connectToAttempt attaches to its socket,
 * stdin carries the user turn and stdout carries transcript JSON events.
 */
export class ParkRuntimeAgentChannel implements ParkAgentChannel {
  constructor(private readonly runtime: RuntimeService) {}

  async createSession(input: { orgId: string; assistantId: string; anonymousSessionId: string }): Promise<string> {
    const created = await this.runtime.createSession({
      cwd: process.cwd(),
      dangerouslySkipPermissions: false,
      userId: 'park-public-consultation',
      orgId: input.orgId,
      role: 'public',
      scopes: [],
      source: PARK_PUBLIC_SESSION_SOURCE,
      channelChatId: input.anonymousSessionId,
      assistantName: input.assistantId,
      enabledSkills: [],
      runtime: { hostMode: 'session' },
    })
    return created.sessionId
  }

  async sendAndStream(mossSessionId: string, question: string, uuid: string, onDelta: (text: string) => void): Promise<{ answer: string }> {
    const ready = await this.runtime.ensureSessionReady(mossSessionId)
    const socket = await this.runtime.connectToAttempt(ready.attempt)
    try {
      return await new Promise<{ answer: string }>((resolve, reject) => {
        let buffer = ''
        let answer = ''
        let settled = false
        const timer = setTimeout(() => finish(new HttpError(504, 'Public Assistant response timed out')), TURN_TIMEOUT_MS)
        const finish = (outcome: { answer: string } | HttpError): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          socket.removeAllListeners('data')
          socket.removeAllListeners('error')
          socket.removeAllListeners('close')
          if (outcome instanceof HttpError) reject(outcome)
          else resolve(outcome)
        }
        socket.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8')
          let separator = buffer.indexOf('\n')
          while (separator >= 0) {
            const line = buffer.slice(0, separator)
            buffer = buffer.slice(separator + 1)
            if (line.trim()) handleLine(line)
            separator = buffer.indexOf('\n')
          }
        })
        socket.on('error', () => finish(new HttpError(502, 'Public Assistant session failed')))
        socket.on('close', () => {
          if (!settled) finish(answer ? { answer } : new HttpError(502, 'Public Assistant session closed'))
        })
        const handleLine = (line: string): void => {
          let frame: { type?: string; line?: string; code?: number | null; message?: { content?: unknown }; delta?: { text?: string } }
          try {
            frame = JSON.parse(line) as typeof frame
          } catch {
            return
          }
          if (frame.type === 'stdout' && typeof frame.line === 'string') {
            for (const agentLine of frame.line.split(/\r?\n/)) {
              if (agentLine.trim()) handleAgentEvent(agentLine)
            }
            return
          }
          if (frame.type === 'exit') {
            if (frame.code !== null && frame.code !== undefined && frame.code !== 0) {
              finish(new HttpError(502, 'Public Assistant session failed'))
            } else {
              finish(answer ? { answer } : new HttpError(502, 'Public Assistant session ended without a response'))
            }
            return
          }
          handleAgentEvent(line)
        }
        const handleAgentEvent = (line: string): void => {
          let event: { type?: string; message?: { content?: unknown }; delta?: { text?: string } }
          try {
            event = JSON.parse(line) as typeof event
          } catch {
            return
          }
          if (event.type === 'assistant' && event.message) {
            const content = Array.isArray(event.message.content) ? event.message.content : [event.message.content]
            for (const block of content) {
              if (block && typeof block === 'object' && 'text' in block && typeof (block as { text?: unknown }).text === 'string') {
                const text = (block as { text: string }).text
                if (text) {
                  answer += text
                  onDelta(text)
                }
              }
            }
          } else if (event.type === 'content_block_delta' && typeof event.delta?.text === 'string') {
            answer += event.delta.text
            onDelta(event.delta.text)
          } else if (event.type === 'text' && typeof (event as { text?: unknown }).text === 'string') {
            answer += (event as { text: string }).text
            onDelta((event as { text: string }).text)
          } else if (event.type === 'result' || event.type === 'finish') {
            finish({ answer })
          } else if (event.type === 'error') {
            finish(new HttpError(502, 'Public Assistant response failed'))
          }
        }
        socket.write(JSON.stringify({ type: 'stdin', data: `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: question }] }, session_id: mossSessionId, uuid })}\n` }) + '\n')
      })
    } finally {
      socket.destroy()
    }
  }

  async terminate(mossSessionId: string): Promise<void> {
    await this.runtime.terminateSession(mossSessionId)
  }

  async isAlive(mossSessionId: string): Promise<boolean> {
    // 'ended' sessions (idle-reaped, desired active) respawn on the next send;
    // only explicit termination retires the mapping.
    const session = await this.runtime.getSession(mossSessionId)
    return Boolean(session && session.status !== 'terminated')
  }
}

export type ParkAgentSocket = net.Socket
