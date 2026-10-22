import type net from 'node:net'
import { HttpError } from '../httpRespond.js'
import type { RuntimeService } from '../runtimeService.js'
import { PARK_PUBLIC_SESSION_SOURCE } from './mossSessions.js'

export interface PreparedParkTurn {
  send(question: string, uuid: string, onDelta: (text: string) => void): Promise<{ answer: string }>
  abandon?(): Promise<void>
  dispose(): void
}

export interface ParkAgentChannel {
  retireVisitor(orgId: string, anonymousSessionId: string): Promise<void>
  runningCount(orgId: string): Promise<number>
  isRunning(mossSessionId: string): Promise<boolean>
  prepareTurn(mossSessionId: string, allowRecovery?: boolean): Promise<PreparedParkTurn>
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
    try {
      const created = await this.runtime.createSession({
        cwd: process.env.PARK_BOX_WORKSPACE_DIR || process.cwd(),
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
    } catch (error) {
      // createSession can write a failed runtime row before rejecting.
      await this.retireVisitor(input.orgId, input.anonymousSessionId)
      throw error
    }
  }

  async retireVisitor(orgId: string, anonymousSessionId: string): Promise<void> {
    for (const session of await this.runtime.listSessionRecords({ orgId })) {
      if (session.source === PARK_PUBLIC_SESSION_SOURCE && session.channelChatId === anonymousSessionId && session.status !== 'terminated') {
        await this.runtime.terminateSession(session.sessionId)
      }
    }
  }

  async runningCount(orgId: string): Promise<number> {
    return (await this.runtime.listSessionRecords({ orgId, activeOnly: true }))
      .filter(session => session.source === PARK_PUBLIC_SESSION_SOURCE).length
  }

  async isRunning(mossSessionId: string): Promise<boolean> {
    const session = await this.runtime.getSession(mossSessionId)
    return Boolean(session && ['creating', 'active', 'detached'].includes(session.status))
  }

  async prepareTurn(mossSessionId: string, allowRecovery = true): Promise<PreparedParkTurn> {
    // An already-counted runtime must not silently respawn after the capacity snapshot.
    const attempt = allowRecovery === false
      ? await this.runtime.store.getCurrentAttempt(mossSessionId)
      : (await this.runtime.ensureSessionReady(mossSessionId)).attempt
    if (!attempt) throw new HttpError(502, 'Public Assistant runtime is unavailable')
    const socket = await this.runtime.connectToAttempt(attempt)
    // Retain an error listener between preparation and sending.
    socket.on('error', () => {})
    return {
      send: (question, uuid, onDelta) => this.stream(socket, mossSessionId, question, uuid, onDelta),
      dispose: () => socket.destroy(),
    }
  }

  async sendAndStream(mossSessionId: string, question: string, uuid: string, onDelta: (text: string) => void): Promise<{ answer: string }> {
    const prepared = await this.prepareTurn(mossSessionId)
    try { return await prepared.send(question, uuid, onDelta) }
    finally { prepared.dispose() }
  }

  private async stream(socket: net.Socket, mossSessionId: string, question: string, uuid: string, onDelta: (text: string) => void): Promise<{ answer: string }> {
    if (socket.destroyed) throw new HttpError(502, 'Public Assistant session closed')
    try {
      return await new Promise<{ answer: string }>((resolve, reject) => {
        let buffer = ''
        let answer = ''
        let streamedBlock = ''
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
          if (!settled) finish(new HttpError(502, 'Public Assistant session closed without a successful result'))
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
              finish(new HttpError(502, 'Public Assistant session ended without a successful result'))
            }
            return
          }
          handleAgentEvent(line)
        }
        const handleAgentEvent = (line: string): void => {
          let event: { type?: string; status?: string; subtype?: string; is_error?: boolean; errors?: unknown[];
            uuid?: string; request_id?: string; stop_reason?: string; session_id?: string; message?: { content?: unknown; is_error?: boolean }; delta?: { text?: string } }
          try {
            event = JSON.parse(line) as typeof event
          } catch {
            return
          }
          if (event.type === 'assistant' && event.message) {
            if (event.message.is_error) { finish(new HttpError(502, 'Public Assistant response failed')); return }
            const content = Array.isArray(event.message.content) ? event.message.content : [event.message.content]
            for (const block of content) {
              if (block && typeof block === 'object' && 'text' in block && typeof (block as { text?: unknown }).text === 'string') {
                const text = (block as { text: string }).text
                if (text && text !== streamedBlock) {
                  const remainder = streamedBlock && text.startsWith(streamedBlock) ? text.slice(streamedBlock.length) : text
                  answer += remainder
                  if (remainder) onDelta(remainder)
                }
              }
            }
            streamedBlock = ''
          } else if (event.type === 'content_block_delta' && typeof event.delta?.text === 'string') {
            answer += event.delta.text
            streamedBlock += event.delta.text
            onDelta(event.delta.text)
          } else if (event.type === 'text' && typeof (event as { text?: unknown }).text === 'string') {
            answer += (event as { text: string }).text
            onDelta((event as { text: string }).text)
          } else if (event.type === 'result' || event.type === 'finish') {
            if (event.session_id && event.session_id !== mossSessionId) return
            if (event.request_id && event.request_id !== uuid) return
            const isSuccess = event.status === 'success' || event.subtype === 'success'
            finish(isSuccess && (!event.stop_reason || event.stop_reason === 'end_turn') && !event.is_error && !(event.errors?.length) && answer.trim()
              ? { answer } : new HttpError(502, 'Public Assistant response ended without success'))
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
