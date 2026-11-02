/**
 * Run one prompt in an agent session from the server side and return the
 * agent's reply. Mirrors EventTriggerService.driveSession (same runner socket
 * protocol, same idle-nudge watchdog) and then reads the reply from the
 * session transcript, which is the durable record of what the agent said.
 */
import { readFile } from 'fs/promises'
import type net from 'net'
import type { RuntimeService } from '../runtimeService.js'
import { parseTranscript } from './transcriptDigest.js'

export interface CreateAgentSessionInput {
  orgId: string
  userId: string
  role: string
  scopes: string[]
  /** Display name the runtime injects as the agent's identity. */
  assistantName: string
  cwd: string
  source: string
}

export interface SessionDriver {
  createAgentSession(input: CreateAgentSessionInput): Promise<string>
  /** Send `prompt`, wait for the turn to finish, return the agent's reply. */
  run(sessionId: string, prompt: string, timeoutMs: number): Promise<{ reply: string }>
  terminate(sessionId: string): Promise<void>
  transcriptPath(sessionId: string): string | null
}

const IDLE_NUDGE_MS = Number(process.env.MOSS_AGENTIFY_IDLE_NUDGE_MS) || 3 * 60 * 1000
const MAX_UNPRODUCTIVE_NUDGES = 3

/** Replies after the last user turn whose text matches what we sent. */
export function replyAfterPrompt(jsonl: string, prompt: string): string | null {
  const conv = parseTranscript(jsonl)
  const marker = prompt.trim().slice(0, 200)
  let start = -1
  conv.turns.forEach((t, i) => {
    if (t.role === 'user' && t.text.trim().startsWith(marker)) start = i
  })
  if (start < 0) return null
  const replies = conv.turns.slice(start + 1).filter(t => t.role === 'assistant').map(t => t.text)
  return replies.length > 0 ? replies[replies.length - 1]! : null
}

export class RuntimeSessionDriver implements SessionDriver {
  constructor(private readonly runtime: RuntimeService) {}

  async createAgentSession(input: CreateAgentSessionInput): Promise<string> {
    const session = await this.runtime.createSession({
      cwd: input.cwd,
      dangerouslySkipPermissions: false,
      userId: input.userId,
      orgId: input.orgId,
      role: input.role,
      scopes: input.scopes,
      assistantName: input.assistantName,
      source: input.source,
    })
    return session.sessionId
  }

  transcriptPath(sessionId: string): string | null {
    return this.runtime.getSession(sessionId)?.transcriptPath ?? null
  }

  async terminate(sessionId: string): Promise<void> {
    try {
      await this.runtime.terminateSession(sessionId)
    } catch (err) {
      console.warn(`[agentify] failed to retire session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async run(sessionId: string, prompt: string, timeoutMs: number): Promise<{ reply: string }> {
    await this.drive(sessionId, prompt, timeoutMs)
    const path = this.transcriptPath(sessionId)
    if (!path) throw new Error('session has no transcript')
    // The bridge appends the reply to the transcript without awaiting before it
    // emits `result`; give the write a moment to land.
    for (let i = 0; i < 20; i++) {
      try {
        const reply = replyAfterPrompt(await readFile(path, 'utf8'), prompt)
        if (reply) return { reply }
      } catch {
        // transcript not there yet
      }
      await new Promise(r => setTimeout(r, 250))
    }
    throw new Error('the agent finished without a written reply')
  }

  private async drive(sessionId: string, prompt: string, timeoutMs: number): Promise<void> {
    const ready = await this.runtime.ensureSessionReady(sessionId)
    const socket: net.Socket = await this.runtime.connectToAttempt(ready.attempt)
    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      let settled = false
      let acknowledged = false
      let sawActivity = false
      let nudges = 0
      let lastActivityAt = Date.now()

      const hard = setTimeout(() => finish(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
      const idle = setInterval(() => {
        if (settled || Date.now() - lastActivityAt < IDLE_NUDGE_MS) return
        if (nudges >= MAX_UNPRODUCTIVE_NUDGES) {
          finish(new Error('the agent stopped responding'))
          return
        }
        nudges += 1
        lastActivityAt = Date.now()
        try {
          socket.write(`${JSON.stringify({ type: 'stdin', data: 'continue\n' })}\n`)
        } catch {
          // surfaced by the error handler
        }
      }, Math.max(1000, Math.floor(IDLE_NUDGE_MS / 2)))

      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(hard)
        clearInterval(idle)
        socket.off('data', onData)
        socket.off('error', onError)
        socket.off('close', onClose)
        if (err) {
          socket.destroy()
          reject(err)
        } else {
          socket.end()
          resolve()
        }
      }
      const progress = () => {
        sawActivity = true
        nudges = 0
        lastActivityAt = Date.now()
      }
      const onError = (e: Error) => finish(e)
      const onClose = () => {
        if (settled) return
        if (!acknowledged) finish(new Error('runner closed before accepting the message'))
        else if (!sawActivity) finish(new Error('runner exited without any agent output'))
        else finish(new Error('runner closed before the turn finished'))
      }
      const onEvent = (event: { type?: string; line?: string; message?: string }) => {
        if (event.type === 'stdin_ack') {
          acknowledged = true
          lastActivityAt = Date.now()
          return
        }
        if (event.type === 'error') {
          finish(new Error(event.message || 'runner error'))
          return
        }
        if (event.type !== 'stdout' || typeof event.line !== 'string') return
        try {
          const inner = JSON.parse(event.line) as { type?: string; status?: string; error?: string }
          if (inner.type === 'result') {
            progress()
            if (inner.status === 'success') finish()
            else finish(new Error(inner.error || 'agent run failed'))
            return
          }
          progress()
        } catch {
          progress()
        }
      }
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        for (;;) {
          const idx = buffer.indexOf('\n')
          if (idx < 0) return
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (!line.trim()) continue
          try {
            onEvent(JSON.parse(line) as { type?: string; line?: string; message?: string })
          } catch {
            // ignore
          }
        }
      }
      socket.on('data', onData)
      socket.on('error', onError)
      socket.on('close', onClose)
      socket.write(`${JSON.stringify({ type: 'stdin', data: prompt.endsWith('\n') ? prompt : `${prompt}\n` })}\n`, e => {
        if (e) finish(e)
      })
    })
  }
}
