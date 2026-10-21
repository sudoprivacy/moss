import type { ParkAgentChannel } from '../agentChannel.js'

/**
 * Deterministic in-memory channel for tests: replays a scripted delta
 * sequence per turn, records create/terminate calls, and lets tests flip
 * liveness to exercise the 401 recovery path.
 */
export class FakeAgentChannel implements ParkAgentChannel {
  private nextId = 0
  readonly created: Array<{ orgId: string; assistantId: string; anonymousSessionId: string }> = []
  readonly terminated: string[] = []
  readonly sent: Array<{ mossSessionId: string; question: string }> = []
  readonly deadSessions = new Set<string>()
  script: string[] = []
  /** Optional gate invoked before each scripted turn (concurrency tests suspend here). */
  beforeSend?: () => Promise<void>

  async createSession(input: { orgId: string; assistantId: string; anonymousSessionId: string }): Promise<string> {
    this.created.push(input)
    this.nextId += 1
    return `fake-agent-${this.nextId}`
  }

  async sendAndStream(mossSessionId: string, question: string, _uuid: string, onDelta: (text: string) => void): Promise<{ answer: string }> {
    this.sent.push({ mossSessionId, question })
    await this.beforeSend?.()
    let answer = ''
    for (const delta of this.script) {
      answer += delta
      onDelta(delta)
    }
    return { answer }
  }

  async terminate(mossSessionId: string): Promise<void> {
    this.terminated.push(mossSessionId)
  }

  async isAlive(mossSessionId: string): Promise<boolean> {
    return !this.deadSessions.has(mossSessionId)
  }
}
